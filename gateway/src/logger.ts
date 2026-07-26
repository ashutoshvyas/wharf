/**
 * Gateway logger (pino, JSON to stdout).
 *
 * LOGGING POLICY — enforced by discipline, not by redaction:
 * nothing sensitive is ever passed to the logger, so there is nothing to
 * redact. Concretely, the following must NEVER appear in a log call:
 *   - session cookies / JWTs (auth.ts logs only the failure reason)
 *   - decrypted SSH credentials (passwords, private keys)
 *   - the WHARF master key
 *   - terminal bytes in either direction (keystrokes / output — spec §4)
 * Log only ids (userId, serverId, sessionId), close codes, durations and
 * error *messages* (never error objects that might embed credentials).
 */
import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "wharf-gateway" },
});
