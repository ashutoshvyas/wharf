/**
 * Browser coverage for the per-instance resource-limits modal. The fleet and
 * the PATCH are intercepted — nothing here reaches a server.
 */
import type { Page } from "@playwright/test";
import type { InstanceDto } from "../../components/databases/api";
import { test, expect, ensureUsers, cleanup, login } from "./fixtures";

const SERVER_ID = "00000000-0000-4000-8000-000000000001";
const INSTANCE: InstanceDto = {
  id: "20000000-0000-4000-8000-000000000001",
  name: "Limits database", slug: "limits-1", serverId: SERVER_ID,
  server: { id: SERVER_ID, name: "Production host", host: "192.0.2.10" },
  composeProjectName: "sb_4f2a", remotePath: "/unused/limits",
  apiSubdomain: "limits.example.test", studioSubdomain: "limits-studio.example.test",
  sslMode: "require", status: "running", activeJob: null, lastActionLog: null, healthCheckedAt: null,
  cpuLimit: 1, memoryLimitMb: 3072, resourceLimitsAppliedAt: null, resourceLimitsError: null,
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
};

async function openLimits(page: Page, row: InstanceDto = INSTANCE) {
  await page.route(/\/api\/db-instances(?:\?.*)?$/, (route) => route.fulfill({ json: [row] }));
  await page.goto("/databases");
  await page.getByRole("button", { name: `Actions for ${row.name}` }).click();
  await page.getByRole("menuitem", { name: "Resource limits…" }).click();
  return page.getByRole("dialog", { name: `Resource limits — ${row.name}` });
}

test.beforeAll(async () => {
  await cleanup();
  await ensureUsers();
});
test.afterAll(cleanup);

test("a never-applied instance warns about the one-time restart and submits the budget in MB", async ({ page }) => {
  await login(page, "admin");
  let patched: unknown;
  await page.route(`**/api/db-instances/${INSTANCE.id}/resource-limits`, async (route) => {
    patched = route.request().postDataJSON();
    await route.fulfill({ json: { ...INSTANCE, cpuLimit: 1.5, memoryLimitMb: 2048, resourceLimitsAppliedAt: "2026-10-09T00:00:00.000Z", recreated: true } });
  });

  const dialog = await openLimits(page);
  await expect(dialog.getByText("First apply may restart this instance")).toBeVisible();
  await expect(dialog.getByLabel("CPU (cores)")).toHaveValue("1");
  await expect(dialog.getByLabel("Memory (GB)")).toHaveValue("3");

  await dialog.getByLabel("Memory (GB)").fill("0.5");
  await expect(dialog.getByText(/Memory must be between/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Apply limits" })).toBeDisabled();

  await dialog.getByLabel("CPU (cores)").fill("1.5");
  await dialog.getByLabel("Memory (GB)").fill("2");
  await dialog.getByRole("button", { name: "Apply limits" }).click();
  await expect(dialog).toBeHidden();
  expect(patched).toEqual({ cpuLimit: 1.5, memoryLimitMb: 2048 });
});

test("empty fields mean unlimited, and a failed apply shows the server's reason", async ({ page }) => {
  await login(page, "admin");
  let patched: unknown;
  await page.route(`**/api/db-instances/${INSTANCE.id}/resource-limits`, async (route) => {
    patched = route.request().postDataJSON();
    await route.fulfill({ status: 502, json: { error: "Limits saved but not applied — this server reports driver=cgroupfs cgroup=v1." } });
  });

  const dialog = await openLimits(page, { ...INSTANCE, resourceLimitsAppliedAt: "2026-10-01T00:00:00.000Z" });
  await expect(dialog.getByText("First apply may restart this instance")).toHaveCount(0);
  await expect(dialog.getByText("Applied: 1 CPU · 3 GB.", { exact: false })).toBeVisible();
  await dialog.getByLabel("CPU (cores)").fill("");
  await dialog.getByLabel("Memory (GB)").fill("");
  await dialog.getByRole("button", { name: "Apply limits" }).click();
  await expect(dialog.getByText(/driver=cgroupfs/)).toBeVisible();
  expect(patched).toEqual({ cpuLimit: null, memoryLimitMb: null });
});

test("operators do not see the resource-limits action", async ({ page }) => {
  await page.route(/\/api\/db-instances(?:\?.*)?$/, (route) => route.fulfill({ json: [INSTANCE] }));
  await login(page, "operator");
  await page.goto("/databases");
  await page.getByRole("button", { name: `Actions for ${INSTANCE.name}` }).click();
  await expect(page.getByRole("menuitem", { name: "Resource limits…" })).toHaveCount(0);
});
