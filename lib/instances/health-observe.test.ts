import { describe, expect, it } from "vitest";
import {
  healthLog,
  nextStatus,
  observeInstance,
  parseDockerPs,
  type ContainerState,
} from "./health-observe";

const SERVICES = { core: ["db", "kong", "auth"], optional: ["minio"] };
const c = (service: string, state: string, status = state === "running" ? "Up 2 hours (healthy)" : ""): ContainerState =>
  ({ project: "sb_4f2a", service, state, status });

describe("parseDockerPs", () => {
  it("reads tab-separated lines and skips blanks and non-compose rows", () => {
    expect(parseDockerPs("sb_4f2a\tdb\trunning\tUp 2 hours (healthy)\n\n\t\texited\tExited (0)\n")).toEqual([
      { project: "sb_4f2a", service: "db", state: "running", status: "Up 2 hours (healthy)" },
    ]);
  });
});

describe("observeInstance", () => {
  it("is running when every core service is up and healthy", () => {
    expect(observeInstance([c("db", "running"), c("kong", "running"), c("auth", "running")], SERVICES))
      .toEqual({ state: "running", detail: "all services running" });
  });

  it("is stopped when every container was stopped by hand", () => {
    const all = ["db", "kong", "auth"].map((s) => c(s, "exited", "Exited (0) 3 minutes ago"));
    expect(observeInstance(all, SERVICES)).toEqual({ state: "stopped", detail: "all 3 containers are stopped" });
  });

  it("is degraded, naming each problem, when only part of the stack runs", () => {
    const obs = observeInstance(
      [c("db", "running"), c("kong", "exited", "Exited (137) 1 minute ago"), c("auth", "running", "Up 5 minutes (unhealthy)")],
      SERVICES,
    );
    expect(obs).toEqual({ state: "degraded", detail: "auth unhealthy; kong exited (code 137)" });
  });

  it("flags crash loops and core services that are gone entirely", () => {
    expect(observeInstance([c("db", "running"), c("kong", "restarting", "Restarting (1) 4 seconds ago")], SERVICES))
      .toEqual({ state: "degraded", detail: "auth missing; kong restarting repeatedly" });
  });

  it("treats a still-starting health check as running", () => {
    const starting = ["db", "kong", "auth"].map((s) => c(s, "running", "Up 10 seconds (health: starting)"));
    expect(observeInstance(starting, SERVICES).state).toBe("running");
  });

  it("is missing when the server has no containers for the instance", () => {
    expect(observeInstance([], SERVICES).state).toBe("missing");
  });

  it("checks optional services only when present, and ignores one-shot services", () => {
    const base = [c("db", "running"), c("kong", "running"), c("auth", "running")];
    expect(observeInstance([...base, c("minio-init", "exited", "Exited (1)")], SERVICES).state).toBe("running");
    expect(observeInstance([...base, c("minio", "exited", "Exited (1) now")], SERVICES))
      .toEqual({ state: "degraded", detail: "minio exited (code 1)" });
  });
});

describe("nextStatus", () => {
  const running = { state: "running" as const, detail: "" };
  const stopped = { state: "stopped" as const, detail: "" };
  const degraded = { state: "degraded" as const, detail: "kong exited" };
  const unreachable = { state: "unreachable" as const, detail: "timeout" };

  it("moves settled rows to what the server shows", () => {
    expect(nextStatus({ status: "running", lastActionLog: null }, stopped)).toBe("stopped");
    expect(nextStatus({ status: "running", lastActionLog: null }, degraded)).toBe("error");
    expect(nextStatus({ status: "stopped", lastActionLog: null }, running)).toBe("running");
    expect(nextStatus({ status: "running", lastActionLog: null }, running)).toBeNull();
  });

  it("recovers only errors the health check itself set", () => {
    expect(nextStatus({ status: "error", lastActionLog: "Health check at …: kong exited" }, running)).toBe("running");
    expect(nextStatus({ status: "error", lastActionLog: "✗ pooler: registration failed" }, running)).toBeNull();
    expect(nextStatus({ status: "error", lastActionLog: null }, stopped)).toBeNull();
  });

  it("never touches rows mid-job", () => {
    for (const status of ["provisioning", "removing", "restoring"]) {
      expect(nextStatus({ status, lastActionLog: null }, stopped)).toBeNull();
    }
  });

  it("downgrades only running instances when the server is unreachable", () => {
    expect(nextStatus({ status: "running", lastActionLog: null }, unreachable)).toBe("error");
    expect(nextStatus({ status: "stopped", lastActionLog: null }, unreachable)).toBeNull();
  });
});

describe("healthLog", () => {
  it("prefixes the reason so the card and nextStatus can recognise it", () => {
    const at = new Date("2026-10-09T10:00:00.000Z");
    expect(healthLog(at, { state: "degraded", detail: "kong exited (code 137)" }))
      .toBe("Health check at 2026-10-09T10:00:00.000Z: kong exited (code 137)");
    expect(healthLog(at, { state: "running", detail: "all services running" }))
      .toBe("Health check at 2026-10-09T10:00:00.000Z: all services running again");
  });
});
