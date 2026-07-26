/**
 * WHARF Terminal Gateway — service entry point.
 *
 * Standalone long-lived Node service (architecture §4.2): plain HTTP server
 * exposing /healthz, plus the WebSocket upgrade route /ws/terminal/:serverId
 * (auth in auth.ts, SSH bridge in bridge.ts, audit in audit.ts).
 *
 * Env is validated here at boot. All sibling modules read env LAZILY (the
 * Prisma client, master key and NEXTAUTH_SECRET are touched on first use),
 * which is what makes calling dotenv from the module body — after the hoisted
 * ESM imports have evaluated — safe, and keeps /healthz working without a
 * reachable database (no $connect at boot).
 */
import http from "node:http";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { WebSocketServer } from "ws";
import { handleUpgrade } from "./auth.js";
import { handleConnection } from "./bridge.js";
import { logger } from "./logger.js";

// Load .env whether the process is started from the repo root or gateway/.
// Values already present in the environment always win (dotenv never overrides).
loadDotenv({
  path: [resolve(process.cwd(), ".env"), resolve(process.cwd(), "../.env")],
  quiet: true,
});

// ---- boot-time env validation ----
const problems: string[] = [];
for (const name of ["DATABASE_URL", "NEXTAUTH_SECRET", "WHARF_MASTER_KEY"] as const) {
  if (!process.env[name]) problems.push(`${name} is not set`);
}
if (process.env.WHARF_MASTER_KEY) {
  const decoded = Buffer.from(process.env.WHARF_MASTER_KEY, "base64");
  if (decoded.length !== 32) {
    problems.push(
      `WHARF_MASTER_KEY must be a base64-encoded 32-byte key (decoded to ${decoded.length} bytes)`,
    );
  }
}
const rawPort = process.env.GATEWAY_PORT;
const PORT = rawPort === undefined || rawPort === "" ? 3001 : Number(rawPort);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  problems.push(`GATEWAY_PORT must be a port number 1-65535 (got "${rawPort}")`);
}
if (problems.length > 0) {
  // eslint-disable-next-line no-console -- logger may not be safe to assume here; keep the failure loud and plain
  console.error(
    `wharf-gateway: refusing to start — fix the following environment problems:\n` +
      problems.map((p) => `  - ${p}`).join("\n"),
  );
  process.exit(1);
}

const started = Date.now();

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ ok: true, uptimeSec: Math.floor((Date.now() - started) / 1000) }),
    );
    return;
  }
  // Plain HTTP requests to /ws/terminal/* (no Upgrade header) land here → 404.
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

// noServer: the handshake is completed manually in auth.ts only AFTER the
// session cookie has been verified (refusals never reach WebSocket land).
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  handleUpgrade(req, socket, head, wss, handleConnection).catch((err: unknown) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "upgrade handling failed",
    );
    socket.destroy();
  });
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, "gateway listening");
});

// ---- graceful shutdown ----
function shutdown(signal: string): void {
  logger.info({ signal }, "shutting down");
  server.close(() => process.exit(0));
  // Live WS/SSH sessions keep the loop busy; don't hang forever.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
