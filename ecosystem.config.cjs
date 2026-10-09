/**
 * pm2 process definitions for WHARF (panel + gateway).
 *
 * WHARF is TWO long-running processes:
 *   - wharf-panel   → the Next.js standalone server (node .next/standalone/server.js)
 *   - wharf-gateway → the SSH Terminal Gateway (node gateway/dist/index.js)
 * The terminal only works when BOTH are up, so pm2 manages them together.
 *
 * The Next standalone server does NOT read .env on its own (unlike `next dev`
 * or the gateway), so this file loads .env here and passes the runtime config
 * into each process explicitly. Config lives in a gitignored `.env` at the repo
 * root on the server — never committed, never overwritten by a deploy.
 *
 * Used by deploy/.github: `pm2 startOrReload ecosystem.config.cjs --update-env`.
 */
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), quiet: true });

// Runtime configuration the panel needs. The standalone server can't see .env,
// so everything it reads at runtime is forwarded here.
const shared = {
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  PANEL_URL: process.env.PANEL_URL,
  COOKIE_DOMAIN: process.env.COOKIE_DOMAIN,
  WHARF_MASTER_KEY: process.env.WHARF_MASTER_KEY,
  INSTANCE_DOMAIN: process.env.INSTANCE_DOMAIN,
  GATEWAY_WS_URL: process.env.GATEWAY_WS_URL,
  LETSENCRYPT_EMAIL: process.env.LETSENCRYPT_EMAIL,
  HEALTH_CHECK_INTERVAL_MS: process.env.HEALTH_CHECK_INTERVAL_MS,
};

const PANEL_PORT = process.env.PANEL_PORT || "3000";
const GATEWAY_PORT = process.env.GATEWAY_PORT || "3001";

module.exports = {
  apps: [
    {
      name: "wharf-panel",
      cwd: __dirname,
      script: ".next/standalone/server.js",
      instances: 1,
      exec_mode: "fork",
      max_restarts: 10,
      env: {
        ...shared,
        NODE_ENV: "production",
        // The standalone server binds these:
        PORT: PANEL_PORT,
        HOSTNAME: "127.0.0.1",
      },
    },
    {
      name: "wharf-gateway",
      cwd: __dirname,
      script: "gateway/dist/index.js",
      instances: 1,
      exec_mode: "fork",
      max_restarts: 10,
      env: {
        ...shared,
        NODE_ENV: "production",
        GATEWAY_PORT,
      },
    },
  ],
};
