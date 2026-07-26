/**
 * Upgrade-time authentication (, protocol §Authentication).
 *
 * Everything here happens on the raw HTTP `upgrade` event, BEFORE any
 * WebSocket handshake completes: an unauthenticated client never sees a
 * single WS frame (architecture §6 "Gateway refuses unauthenticated upgrades
 * pre-handshake"). Refusals are raw HTTP responses written to the socket,
 * then the socket is destroyed.
 *
 * The session cookie is an Auth.js v5 JWE (`wharf.session`, see
 * auth.config.ts). It is decoded — not merely parsed — with the shared
 * NEXTAUTH_SECRET; Auth.js derives the encryption key from (secret, salt)
 * where the salt is the cookie NAME, so we must pass whichever name the
 * token actually came from ('wharf.session' in dev, '__Secure-wharf.session'
 * behind https).
 *
 * NEVER log the cookie value or decoded token — only ids and refusal reasons.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { WebSocket, WebSocketServer } from "ws";
import { decode } from "@auth/core/jwt";
import { logger } from "./logger.js";

export interface UpgradeContext {
  userId: string;
  email: string;
  role: "admin" | "operator";
  serverId: string;
  /** Initial PTY size from ?cols=&rows= (defaults 80x24). */
  cols: number;
  rows: number;
}

const PATH_RE = /^\/ws\/terminal\/([^/?#]+)$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Accept both the dev name and the __Secure- prefixed name used over https. */
const COOKIE_NAMES = ["wharf.session", "__Secure-wharf.session"] as const;

/** Write a raw HTTP refusal and destroy the socket — no WS handshake ever ran. */
function refuse(socket: Duplex, statusLine: string): void {
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n`);
  } catch {
    // socket already gone — nothing to do
  }
  socket.destroy();
}

/** Minimal Cookie-header parser (name=value; name2=value2). */
function parseCookies(header: string | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (!header) return jar;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) jar.set(name, decodeURIComponent(value));
  }
  return jar;
}

function parseDimension(raw: string | null, fallback: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 9999) return fallback;
  return n;
}

/**
 * Handle an HTTP `upgrade` event for GET /ws/terminal/:serverId.
 *
 * On success the WS handshake is completed via wss.handleUpgrade and
 * `onAuthenticated(ws, ctx)` is invoked. On any failure the socket receives
 * a raw HTTP error response and is destroyed before the handshake.
 */
export async function handleUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  onAuthenticated: (ws: WebSocket, ctx: UpgradeContext) => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://gateway.internal");

  const pathMatch = PATH_RE.exec(url.pathname);
  if (req.method !== "GET" || !pathMatch) {
    refuse(socket, "404 Not Found");
    return;
  }
  const serverId = pathMatch[1] ?? "";
  if (!UUID_RE.test(serverId)) {
    refuse(socket, "400 Bad Request");
    return;
  }

  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    // Boot validation makes this unreachable; refuse defensively anyway.
    refuse(socket, "401 Unauthorized");
    return;
  }

  // Find the session token under either cookie name; the name it came from
  // is the decode salt (Auth.js keys the JWE per cookie name).
  const jar = parseCookies(req.headers.cookie);
  let token: string | undefined;
  let salt: string | undefined;
  for (const name of COOKIE_NAMES) {
    const value = jar.get(name);
    if (value) {
      token = value;
      salt = name;
      break;
    }
  }
  if (!token || !salt) {
    logger.info({ serverId }, "upgrade refused: no session cookie");
    refuse(socket, "401 Unauthorized");
    return;
  }

  let session: { userId: string; email: string; role: "admin" | "operator" } | null = null;
  try {
    const jwt = await decode({ token, secret, salt });
    if (jwt) {
      const role = typeof jwt.role === "string" ? jwt.role : "";
      const userId =
        typeof jwt.id === "string" ? jwt.id : typeof jwt.sub === "string" ? jwt.sub : "";
      const email = typeof jwt.email === "string" ? jwt.email : "";
      // Protocol: role must be admin or operator; viewer (or anything else)
      // is refused identically to a missing/invalid session.
      if ((role === "admin" || role === "operator") && userId && email) {
        session = { userId, email, role };
      }
    }
  } catch {
    // Bad/expired/foreign JWE — treated exactly like no session.
    session = null;
  }

  if (!session) {
    logger.info({ serverId }, "upgrade refused: invalid session or insufficient role");
    refuse(socket, "401 Unauthorized");
    return;
  }

  const ctx: UpgradeContext = {
    ...session,
    serverId,
    cols: parseDimension(url.searchParams.get("cols"), 80),
    rows: parseDimension(url.searchParams.get("rows"), 24),
  };

  wss.handleUpgrade(req, socket, head, (ws) => {
    onAuthenticated(ws, ctx);
  });
}
