/** Real page/session + mocked remote operations. Never contacts a managed server. */
import type { Page } from "@playwright/test";
import type { NetworkAccessDto, NetworkAccessPolicy } from "../../lib/instances/network-access";
import { test, expect, prisma, ensureUsers, cleanup, login, E2E_MARKER } from "./fixtures";

const SERVER_ID = "01230000-0000-4000-8000-000000000001";
const INSTANCE_ID = "01230000-0000-4000-8000-000000000002";
const SERVER_NAME = `${E2E_MARKER}-network-host`;

async function clear() {
  await prisma.dbInstance.deleteMany({ where: { id: INSTANCE_ID } });
  await cleanup();
}
test.beforeAll(async () => {
  await clear();
  await ensureUsers();
  await prisma.server.create({ data: {
    id: SERVER_ID, name: SERVER_NAME, host: "192.0.2.100", sshUser: "test", authMethod: "password", tags: [],
  } });
  await prisma.dbInstance.create({ data: {
    id: INSTANCE_ID, serverId: SERVER_ID, name: "Network policy database", slug: `${E2E_MARKER}-network`,
    composeProjectName: "sb_4f2a", remotePath: "/unused/sb_4f2a", apiSubdomain: "network.example.test",
    studioSubdomain: "studio-network.example.test", status: "stopped",
  } });
});
test.afterAll(clear);

async function mockNetwork(page: Page, fail = false) {
  let data: NetworkAccessDto = {
    policy: { mode: "all" }, appliedAt: null, applyError: null,
    server: { id: SERVER_ID, name: SERVER_NAME, firewallManaged: false, unconfiguredInstances: [{ id: INSTANCE_ID, name: "Network policy database" }] },
  };
  const submissions: NetworkAccessPolicy[] = [];
  await page.route(`**/api/db-instances/${INSTANCE_ID}/network-access`, async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: data });
    const policy = route.request().postDataJSON() as NetworkAccessPolicy;
    submissions.push(policy);
    data = { ...data, policy, appliedAt: fail ? null : new Date().toISOString(), applyError: fail ? "Server unreachable. Retry apply." : null };
    return route.fulfill({ json: { applied: !fail, applyError: data.applyError } });
  });
  return submissions;
}

test("a stopped database's network page validates IPs, saves normalized allowlists and shows failures", async ({ page }) => {
  const submissions = await mockNetwork(page, true);
  await login(page, "admin");
  await page.goto(`/databases/${INSTANCE_ID}/network-access`);
  await page.getByLabel("Database connections", { exact: true }).selectOption("restricted");
  await page.getByRole("button", { name: "Save and apply" }).click();
  await expect(page.locator("#database-network-error")).toContainText("Add at least one");
  expect(submissions).toHaveLength(0);
  await page.getByLabel("Allowed IP addresses or ranges").fill("198.51.100.10\n198.51.100.0/24");
  await page.getByRole("button", { name: "Save and apply" }).click();
  await expect(page.getByText("Saved settings are not confirmed active")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry apply" })).toBeVisible();
  expect(submissions).toEqual([{ mode: "restricted", allowedCidrs: ["198.51.100.10/32", "198.51.100.0/24"] }]);
});

test("host adoption requires its server name and sends the reviewed baseline", async ({ page }) => {
  await mockNetwork(page);
  let submitted: unknown;
  await page.route(`**/api/servers/${SERVER_ID}/database-network-access`, (route) => {
    submitted = route.request().postDataJSON();
    return route.fulfill({ json: { applied: false, applyError: "An unmanaged tenant needs review." } });
  });
  await login(page, "admin");
  await page.goto(`/databases/${INSTANCE_ID}/network-access`);
  await page.getByLabel("Existing allowed addresses", { exact: true }).fill("198.51.100.10");
  const submit = page.getByRole("button", { name: "Enable server network access" });
  await expect(submit).toBeDisabled();
  await page.getByLabel(`Type ${SERVER_NAME} to confirm server setup`).fill(SERVER_NAME);
  await submit.click();
  await expect(page.getByText("An unmanaged tenant needs review.")).toBeVisible();
  expect(submitted).toEqual({ confirmName: SERVER_NAME, baselineAllowedCidrs: ["198.51.100.10/32"] });
});

test("viewers can inspect network access but cannot edit or enable the firewall", async ({ page }) => {
  await mockNetwork(page);
  await login(page, "viewer");
  await page.goto(`/databases/${INSTANCE_ID}/network-access`);
  await expect(page.getByLabel("Database connections", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Save and apply" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Enable server network access" })).toHaveCount(0);
});
