/**
 * Audit-log guarantees.
 *
 * The audit trail is the product's accountability story, and its two
 * properties are exactly the kind that erode silently: that mutations really
 * do write a row, and that nothing anywhere can rewrite history. The second
 * is enforced by a Postgres trigger, so it is asserted against the real
 * database rather than through the app.
 */
import { test, expect, ensureUsers, cleanup, login, prisma, E2E_MARKER } from "./fixtures";

test.beforeAll(async () => {
  await cleanup();
  await ensureUsers();
});

test.afterAll(async () => {
  await cleanup();
});

test("the audit log is insert-only at the database level", async () => {
  const row = await prisma.auditLog.create({
    data: {
      action: "e2e.trigger_probe",
      targetType: "test",
      userEmail: `${E2E_MARKER}@example.test`,
      metadata: {},
    },
  });

  await expect(
    prisma.$executeRawUnsafe(`UPDATE audit_log SET action='tampered' WHERE id='${row.id}'`),
  ).rejects.toThrow(/insert-only/i);

  await expect(
    prisma.$executeRawUnsafe(`DELETE FROM audit_log WHERE id='${row.id}'`),
  ).rejects.toThrow(/insert-only/i);

  const after = await prisma.auditLog.findUnique({ where: { id: row.id } });
  expect(after?.action).toBe("e2e.trigger_probe");
});

test("a mutation writes an audit row naming the actor", async ({ page }) => {
  await login(page, "admin");

  const name = `${E2E_MARKER}-audited-host`;
  const res = await page.request.post("/api/servers", {
    data: {
      name,
      host: "203.0.113.55",
      sshUser: "root",
      authMethod: "password",
      sshPassword: "throwaway",
      tags: [],
    },
  });
  expect(res.ok()).toBeTruthy();

  const entry = await prisma.auditLog.findFirst({
    where: { action: "server.create" },
    orderBy: { createdAt: "desc" },
  });
  expect(entry).toBeTruthy();
  expect(entry!.userEmail).toContain(E2E_MARKER);
});

test("every role can read the audit log, and it offers no way to alter it", async ({ page }) => {
  await login(page, "viewer");
  await page.goto("/audit");

  // Both the topbar title and the page heading say "Audit log"; assert the
  // page-level one.
  await expect(page.getByRole("heading", { name: /audit log/i, level: 2 })).toBeVisible();
  // Read-only by design: no destructive affordance exists on this screen.
  await expect(page.getByRole("button", { name: /delete|remove|clear/i })).toHaveCount(0);

  const res = await page.request.get("/api/audit");
  expect(res.ok()).toBeTruthy();
});
