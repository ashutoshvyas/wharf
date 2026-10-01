/** Run the real reconciliation script against fake Docker/iptables executables.
 * Nothing reaches the host firewall or a Docker daemon. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let directory: string;
const adapter = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const dir = process.env.FIREWALL_TEST_DIR;
const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath)) : { jump: false, rules: '', legacy: 'accept source 198.51.100.10; drop other database clients' };
fs.appendFileSync(path.join(dir, 'calls'), command + ' ' + args.join(' ') + '\n');
const persist = () => fs.writeFileSync(statePath, JSON.stringify(state));
if (command === 'docker') {
  if (args[0] === 'ps') process.stdout.write(process.env.NO_POOLER ? '' : 'a123b456\n');
  if (args[0] === 'port') process.stdout.write('0.0.0.0:' + (process.env.BAD_PORT || args[2].split('/')[0]) + '\n');
  if (args[0] === 'inspect') process.stdout.write(args[2].includes('GlobalIPv6Address') ? '' : (process.env.POOLER_IP || '172.19.0.2') + '\n');
} else if (command === 'iptables') {
  if (args.includes('-S') && process.env.NO_CHAIN) process.exit(1);
  if (args.includes('-C')) process.exit(state.jump ? 0 : 1);
  if (args.includes('-D')) state.jump = false;
  if (args.includes('-I')) state.jump = true;
  if (args.includes('-F')) state.rules = '';
  persist();
} else if (command === 'ip6tables') {
  process.exit(1);
} else if (command === 'iptables-restore') {
  const input = fs.readFileSync(0, 'utf8');
  if (process.env.FAIL_RESTORE) process.exit(1);
  state.rules = input;
  persist();
}
`;

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "wharf-firewall-test-"));
  for (const command of ["docker", "iptables", "ip6tables", "iptables-restore", "flock"]) {
    writeFileSync(path.join(directory, command), `#!${process.execPath}\n${adapter}`, { mode: 0o700 });
  }
  const script = readFileSync("templates/pooler/apply-network-firewall.sh", "utf8")
    .replace("/run/lock/wharf-pooler-firewall.lock", path.join(directory, "firewall.lock"));
  writeFileSync(path.join(directory, "apply.sh"), script);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function run(extra: Record<string, string> = {}, args: string[] = []) {
  return execFileSync("bash", [path.join(directory, "apply.sh"), ...args], {
    env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FIREWALL_TEST_DIR: directory, ...extra },
    stdio: "pipe",
  });
}
function state(): { jump: boolean; rules: string; legacy: string } {
  return JSON.parse(readFileSync(path.join(directory, "state.json"), "utf8"));
}
function accepted(destination: string, port: number, publishedPort = port) {
  return state().rules.split("\n").some((line) => line.startsWith("-A WHARF-POOLER") &&
    line.includes(`-d ${destination}/32 `) && line.includes(`--dport ${port} `) &&
    line.includes(`--ctorigdstport ${publishedPort} `) && line.includes("--ctstate DNAT") && line.endsWith("-j ACCEPT"));
}

describe("Docker firewall reconciliation", () => {
  it("admits only published pooler traffic and retains the administrator's rules", () => {
    run();
    expect(accepted("172.19.0.2", 5432)).toBe(true);
    expect(accepted("172.19.0.2", 6543)).toBe(true);
    expect(accepted("172.19.0.3", 5432)).toBe(false);
    expect(accepted("172.19.0.2", 4000)).toBe(false);
    expect(accepted("172.19.0.2", 5432, 15432)).toBe(false);
    expect(state().legacy).toBe("accept source 198.51.100.10; drop other database clients");
    expect(state().rules).not.toContain("-F DOCKER-USER");
    expect(state().jump).toBe(true);
    expect(state().rules).toContain("-s 172.19.0.2/32 -p tcp --sport 5432 -m conntrack --ctdir REPLY --ctstate DNAT --ctorigdstport 5432 -j ACCEPT");
  });
  it("reconciles idempotently after a pooler IP change without keeping stale destinations", () => {
    run();
    run({ POOLER_IP: "172.19.0.9" });
    expect(accepted("172.19.0.2", 5432)).toBe(false);
    expect(accepted("172.19.0.9", 5432)).toBe(true);
    expect(state().jump).toBe(true);
    expect(state().rules.split("\n").filter((line) => line.startsWith("-A "))).toHaveLength(4);
  });
  it("checks support and mappings without installing rules", () => {
    run({}, ["--check"]);
    expect(state().jump).toBe(false);
    expect(state().rules).toBe("");
    expect(() => run({ BAD_PORT: "54321" })).toThrow();
    expect(state().jump).toBe(false);
  });
  it("does not grant access if the atomic rule update fails", () => {
    expect(() => run({ FAIL_RESTORE: "1" })).toThrow();
    expect(state().jump).toBe(false);
  });
  it("clears its own stale rules when the pooler stops", () => {
    run();
    expect(() => run({ NO_POOLER: "1" })).toThrow();
    expect(state().rules).toBe("");
    expect(state().legacy).toContain("198.51.100.10");
  });
  it("rejects unsupported firewall backends before changing rules", () => {
    expect(() => run({ NO_CHAIN: "1" })).toThrow();
    const calls = readFileSync(path.join(directory, "calls"), "utf8");
    expect(calls).not.toContain("iptables-restore");
  });
});
