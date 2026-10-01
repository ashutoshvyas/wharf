import { readFile } from "node:fs/promises";
import path from "node:path";
import { exec, sftpWrite } from "@/lib/ssh";
import { POOLER_REMOTE_DIR } from "./constants";

type Connection = Parameters<typeof exec>[0];
const SCRIPT = `${POOLER_REMOTE_DIR}/apply-network-firewall.sh`;

/** Called only after every tenant has an explicit, verified access policy. */
export async function installNetworkFirewall(conn: Connection): Promise<void> {
  for (const name of ["apply-network-firewall.sh", "wharf-pooler-firewall.service", "wharf-pooler-firewall.timer"]) {
    const content = await readFile(path.join(process.cwd(), "templates", "pooler", name), "utf8");
    const destination = name.endsWith(".sh") ? SCRIPT : `/etc/systemd/system/${name}`;
    await sftpWrite(conn, destination, content, name.endsWith(".sh") ? 0o700 : 0o644);
  }
  const check = await exec(conn, `bash ${SCRIPT} --check`);
  if (check.code !== 0) throw new Error(check.stderr.trim() || "The server does not support WHARF's managed Docker firewall.");
  const apply = await exec(conn,
    "systemctl daemon-reload && systemctl start wharf-pooler-firewall.service && systemctl enable --now wharf-pooler-firewall.timer",
  );
  if (apply.code !== 0) throw new Error("Could not activate the database firewall. Database policies were saved; retry server setup.");
}
