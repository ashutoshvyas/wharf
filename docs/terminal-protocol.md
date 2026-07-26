# Terminal Gateway wire protocol (protocol contract)

Both the gateway (server) and `components/terminal.tsx` (client) implement exactly
this. Change it only by editing this file first.

## Endpoint

```
ws(s)://<gateway>/ws/terminal/:serverId
```

- Dev: `ws://localhost:3001/ws/terminal/:id` (`NEXT_PUBLIC_GATEWAY_WS_URL=ws://localhost:3001`)
- Prod: proxied at `wss://panel.<domain>/ws/terminal/:id` (Caddy/nginx WebSocket passthrough → localhost:3001)

## Authentication (before the upgrade completes)

- Session cookie `wharf.session` (Auth.js v5 JWE). Gateway decodes with
  `decode({ token, secret: NEXTAUTH_SECRET, salt: "wharf.session" })` from `@auth/core/jwt`.
- Role must be `admin` or `operator`. Anything else → HTTP 401 response and socket
  destroyed **before** the WebSocket handshake completes; no frames are ever exchanged.

## Frames

- **Binary frames** (both directions): raw terminal bytes (stdin client→server,
  stdout/stderr server→client). No framing inside.
- **Text frames**: single JSON object, discriminated by `t`:

| Direction | Frame | Meaning |
|---|---|---|
| client→server | `{"t":"resize","cols":number,"rows":number}` | PTY resize |
| client→server | `{"t":"ping"}` | keepalive |
| server→client | `{"t":"pong"}` | keepalive reply |
| server→client | `{"t":"ready"}` | SSH shell established — terminal is live |
| server→client | `{"t":"error","message":string}` | human-readable failure (sent before close) |
| server→client | `{"t":"exit","code":number\|null}` | remote shell exited |

## Close codes

| Code | Meaning |
|---|---|
| 1000 | normal close (client disconnect or shell exit) |
| 4001 | authentication failed |
| 4002 | server id unknown / deleted |
| 4003 | SSH connection error (error frame precedes) |
| 4008 | idle timeout (30 min) or absolute timeout (8 h) |
| 4009 | concurrent-session limit (3 per user) |

## Limits & audit

- Idle timeout 30 min (no client frames), absolute cap 8 h, max 3 concurrent
  sessions per user.
- Gateway writes `terminal.open` / `terminal.close` audit rows (sessionId, serverId,
  durationSec, reason). Keystrokes are never recorded (spec §4).
