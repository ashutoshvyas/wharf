/**
 * Auth + the RBAC visibility matrix as actually rendered.
 *
 * The role matrix is unit-tested in lib/rbac.test.ts; what cannot be unit
 * tested is whether the UI honours it — design §6 requires forbidden actions
 * to be HIDDEN, not disabled, so a viewer sees a clean read-only panel.
 */
import { test, expect, ensureUsers, cleanup, login, USERS, PASSWORD } from "./fixtures";

test.beforeAll(async () => {
  await cleanup();
  await ensureUsers();
});

test.afterAll(async () => {
  await cleanup();
});

test.describe("authentication", () => {
  test("unauthenticated visits are redirected to login with returnTo", async ({ page }) => {
    await page.goto("/servers");
    await expect(page).toHaveURL(/\/login\?returnTo=%2Fservers/);
  });

  test("wrong password shows a generic error and does not sign in", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill(USERS.admin);
    await page.getByLabel(/password/i).fill("definitely-not-the-password");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("a valid login lands in the panel and shows the role badge", async ({ page }) => {
    await login(page, "admin");
    await expect(page.getByText("admin", { exact: true }).first()).toBeVisible();
  });

  test("signing out returns to login and re-protects the app", async ({ page }) => {
    await login(page, "admin");
    // Sign-out is a server-action form: clicking before React hydrates is a
    // no-op, so wait for the page to settle rather than racing it.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /sign out/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await page.goto("/servers");
    await expect(page).toHaveURL(/\/login/);
  });

  test("an unknown email fails exactly like a wrong password", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel(/email/i).fill("nobody-here@example.test");
    await page.getByLabel(/password/i).fill(PASSWORD);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Same message — no user-existence leak.
    await expect(page.getByText(/invalid email or password/i)).toBeVisible();
  });
});

test.describe("RBAC visibility", () => {
  test("admin sees the Users nav and can add servers", async ({ page }) => {
    await login(page, "admin");
    await expect(page.getByRole("link", { name: /users/i })).toBeVisible();
    await page.goto("/servers");
    await expect(page.getByRole("button", { name: /add server/i })).toBeVisible();
  });

  test("operator has no Users nav and no Add server", async ({ page }) => {
    await login(page, "operator");
    await expect(page.getByRole("link", { name: /users/i })).toHaveCount(0);
    await page.goto("/servers");
    await expect(page.getByRole("button", { name: /add server/i })).toHaveCount(0);
  });

  test("viewer sees a read-only panel — no write affordances anywhere", async ({ page }) => {
    await login(page, "viewer");
    await expect(page.getByRole("link", { name: /users/i })).toHaveCount(0);

    await page.goto("/servers");
    await expect(page.getByRole("button", { name: /add server/i })).toHaveCount(0);

    await page.goto("/websites");
    await expect(page.getByRole("button", { name: /add website/i })).toHaveCount(0);

    await page.goto("/databases");
    await expect(page.getByRole("button", { name: /new instance/i })).toHaveCount(0);
  });

  test("operator is redirected away from /users", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/users");
    await expect(page).not.toHaveURL(/\/users/);
  });
});

test.describe("API role enforcement (server-side, not just UI)", () => {
  test("viewer cannot create a server even by calling the API directly", async ({ page }) => {
    await login(page, "viewer");
    const res = await page.request.post("/api/servers", {
      data: {
        name: "should-not-exist",
        host: "203.0.113.99",
        sshUser: "root",
        authMethod: "password",
        sshPassword: "x",
      },
    });
    expect(res.status()).toBe(403);
  });

  test("operator cannot create a server (admin-only action)", async ({ page }) => {
    await login(page, "operator");
    const res = await page.request.post("/api/servers", {
      data: {
        name: "should-not-exist",
        host: "203.0.113.99",
        sshUser: "root",
        authMethod: "password",
        sshPassword: "x",
      },
    });
    expect(res.status()).toBe(403);
  });

  test("viewer can still read", async ({ page }) => {
    await login(page, "viewer");
    const res = await page.request.get("/api/servers");
    expect(res.ok()).toBeTruthy();
  });
});
