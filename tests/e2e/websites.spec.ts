/**
 * Websites CRUD + the audited credential reveal.
 *
 * This is the one module that exercises a full create → read → reveal →
 * delete cycle without touching a real server, which makes it the natural
 * end-to-end check on the metadata layer: zod validation, encryption at rest,
 * the allowlist serializer, and the reveal audit trail.
 */
import { test, expect, ensureUsers, cleanup, login, prisma, E2E_MARKER } from "./fixtures";

const DOMAIN = `${E2E_MARKER}-site.example.test`;
const CRED_USER = "cms_admin";
const CRED_PASS = "s3cr3t-value-9x";

test.beforeAll(async () => {
  await cleanup();
  await ensureUsers();
  // A server to attach the website to — metadata only, never contacted.
  await prisma.server.create({
    data: {
      name: `${E2E_MARKER}-host`,
      host: "203.0.113.77",
      sshUser: "root",
      authMethod: "password",
      tags: [],
    },
  });
});

test.afterAll(async () => {
  await cleanup();
});

test("website lifecycle: create → encrypted at rest → audited reveal → delete", async ({ page }) => {
  await login(page, "operator");

  // Creation goes through the real HTTP API rather than the modal: the
  // assertions that matter here are about encryption, payload hygiene and the
  // audit trail, and driving them through form markup would couple this spec
  // to the modal's internals without testing anything extra. The modal itself
  // is covered by the unit suite around its schema.
  const server = await prisma.server.findFirst({
    where: { name: { contains: E2E_MARKER } },
  });
  const created = await page.request.post("/api/websites", {
    data: {
      domain: DOMAIN,
      serverId: server!.id,
      path: "/var/www/e2e",
      credentialLabel: "CMS admin",
      accessUsername: CRED_USER,
      accessPassword: CRED_PASS,
    },
  });
  expect(created.ok()).toBeTruthy();

  // ---- it renders in the UI ---------------------------------------------
  await page.goto("/websites");
  await expect(page.getByText(DOMAIN)).toBeVisible({ timeout: 15_000 });

  // ---- the password is encrypted at rest, not stored in the clear --------
  const row = await prisma.website.findFirst({ where: { domain: DOMAIN } });
  expect(row).toBeTruthy();
  expect(row!.accessPasswordEnc).toBeTruthy();
  const asText = Buffer.from(row!.accessPasswordEnc!).toString("utf8");
  expect(asText).not.toContain(CRED_PASS);

  // ---- the list payload must not leak it either --------------------------
  const list = await page.request.get("/api/websites");
  const body = await list.text();
  expect(body).not.toContain(CRED_PASS);
  expect(body).not.toContain("accessPasswordEnc");

  // ---- reveal returns the plaintext AND writes an audit row --------------
  const before = await prisma.auditLog.count({
    where: { action: "website.credential_reveal" },
  });
  const reveal = await page.request.get(`/api/websites/${row!.id}/credential`);
  expect(reveal.ok()).toBeTruthy();
  expect(await reveal.json()).toMatchObject({ password: CRED_PASS });
  expect(reveal.headers()["cache-control"]).toContain("no-store");
  const after = await prisma.auditLog.count({
    where: { action: "website.credential_reveal" },
  });
  expect(after).toBe(before + 1);

  // ---- delete removes the record ----------------------------------------
  const del = await page.request.delete(`/api/websites/${row!.id}`);
  expect(del.ok()).toBeTruthy();
  expect(await prisma.website.count({ where: { domain: DOMAIN } })).toBe(0);
  await page.goto("/websites");
  await expect(page.getByText(DOMAIN)).toHaveCount(0);
});

test("a viewer cannot reveal a stored credential", async ({ page }) => {
  const server = await prisma.server.findFirst({ where: { name: { contains: E2E_MARKER } } });
  const site = await prisma.website.create({
    data: {
      domain: `${E2E_MARKER}-viewer-check.example.test`,
      serverId: server!.id,
      path: "/var/www/x",
      credentialLabel: "Admin login",
      accessUsername: "u",
    },
  });

  await login(page, "viewer");
  const res = await page.request.get(`/api/websites/${site.id}/credential`);
  expect(res.status()).toBe(403);
});

test("invalid input is rejected with a readable message", async ({ page }) => {
  await login(page, "operator");
  const res = await page.request.post("/api/websites", {
    data: { domain: "https://not-a-bare-hostname", serverId: "not-a-uuid", path: "relative" },
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).error).toMatch(/invalid request/i);
});
