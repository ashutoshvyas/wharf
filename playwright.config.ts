import { defineConfig, devices } from "@playwright/test";

// Check before starting the application or importing fixtures. Never inherit a
// remote connection from .env: the suite creates and deletes database records.
for (const name of ["DATABASE_URL", "DIRECT_URL"] as const) {
  const value = process.env[name];
  if (!value || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname)) {
    throw new Error(`E2E requires an explicit local ${name} pointing to a disposable test database.`);
  }
}
if (process.env.E2E_BASE_URL && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(process.env.E2E_BASE_URL).hostname)) {
  throw new Error("E2E_BASE_URL must point to the isolated local test application.");
}

/**
 * E2E configuration.
 *
 * These specs drive a real browser against a real panel process talking to a
 * real Postgres — the layer unit tests cannot reach: session cookies, the RBAC
 * visibility matrix as actually rendered, and multi-step flows.
 *
 * SSH is NOT exercised here. Provisioning and bootstrap reach real machines,
 * and this project's standing rule is that nothing mutates a live server
 * without explicit permission. Those paths are covered by the mocked-SSH unit
 * suites (lib/provision, lib/bootstrap) and, ultimately, by the manual
 * verification checklist in docs/deployment.md.
 *
 * Requires explicit local DATABASE_URL and DIRECT_URL values. The suite seeds and cleans up
 * its own users via tests/e2e/fixtures.ts.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false, // shared database
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "list" : [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:3210",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  // Runs the standalone bundle — the exact artifact systemd runs in
  // production. `next start` is NOT compatible with output:"standalone" and
  // silently breaks the instrumentation hook, so it must not be used here.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "node .next/standalone/server.js",
        // NEXTAUTH_URL/PANEL_URL must match the address the browser uses:
        // Auth.js builds its post-login redirect from NEXTAUTH_URL, so a
        // mismatch sends the browser to a different origin, where the freshly
        // set session cookie does not apply and it bounces back to /login.
        env: {
          PORT: "3210",
          HOSTNAME: "127.0.0.1",
          NEXTAUTH_URL: "http://127.0.0.1:3210",
          PANEL_URL: "http://127.0.0.1:3210",
        },
        url: "http://127.0.0.1:3210/api/healthz",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
