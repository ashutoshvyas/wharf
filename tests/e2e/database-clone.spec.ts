/**
 * Real browser/session coverage for WHARF-to-WHARF cloning. Fleet, clone start
 * and progress responses are intercepted: these tests never contact a server
 * or overwrite a database. The API and engine have separate integration tests.
 */
import type { Page } from "@playwright/test";
import type { InstanceDto } from "../../components/databases/api";
import { test, expect, ensureUsers, cleanup, login } from "./fixtures";

function instance(index: number, name: string, status: InstanceDto["status"] = "running"): InstanceDto {
  const serverId = `00000000-0000-4000-8000-${String(index === 1 ? 1 : 2).padStart(12, "0")}`;
  return {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name, slug: `clone-${index}`, serverId,
    server: { id: serverId, name: index === 1 ? "Production host" : "Staging host" },
    composeProjectName: `sb_clone_${index}`, remotePath: `/unused/clone-${index}`,
    apiSubdomain: `clone-${index}.example.test`, studioSubdomain: `clone-${index}-studio.example.test`,
    sslMode: "require", status, activeJob: null, lastActionLog: null, healthCheckedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z",
  };
}

const SOURCE = instance(1, "Production database");
const TARGET = instance(2, "Staging database");
const OTHER = instance(3, "Preview database");
const STOPPED = instance(4, "Stopped database", "stopped");
const FAILED = instance(5, "Failed database", "error");

async function mockFleet(page: Page, rows: InstanceDto[] = [SOURCE, TARGET, OTHER, STOPPED, FAILED]) {
  await page.route(/\/api\/db-instances(?:\?.*)?$/, (route) => route.fulfill({ json: rows }));
}

async function openClone(page: Page) {
  await page.goto("/databases");
  await page.getByRole("button", { name: `Actions for ${SOURCE.name}` }).click();
  await page.getByRole("menuitem", { name: "Clone database…" }).click();
  return page.getByRole("dialog", { name: `Clone database — ${SOURCE.name}` });
}

function stream(status: "ok" | "error") {
  const phases = ["preflight", "dump", "transfer", "snapshot", "restore", "verify", "cleanup"];
  const events = status === "ok"
    ? phases.map((phase) => ({ kind: "ok", line: `✓ ${phase}` }))
    : [{ kind: "ok", line: "✓ preflight" }, { kind: "err", line: "✗ dump: source connection failed" }];
  return [...events, { done: true, status }].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test.beforeAll(async () => {
  await cleanup();
  await ensureUsers();
});
test.afterAll(cleanup);

test("clone shows source/destination identity, excludes unavailable targets and requires the destination name", async ({ page }) => {
  await mockFleet(page);
  await login(page, "admin");
  const dialog = await openClone(page);
  await expect(dialog.getByText("Production host", { exact: true })).toBeVisible();
  await expect(dialog.getByText(`https://${SOURCE.apiSubdomain}`, { exact: true })).toBeVisible();
  const destination = dialog.getByLabel("Destination database", { exact: true });
  await expect(destination.locator("option")).toHaveCount(3);
  await expect(destination).not.toContainText(SOURCE.name);
  await expect(destination).not.toContainText(STOPPED.name);
  await expect(destination).not.toContainText(FAILED.name);
  await destination.selectOption(TARGET.id);
  await expect(dialog.getByText("Staging host", { exact: true })).toBeVisible();
  await expect(dialog.getByText(`https://${TARGET.apiSubdomain}`, { exact: true })).toBeVisible();
  await expect(dialog.getByText("The destination database will be overwritten.")).toBeVisible();
  await expect(dialog.getByText(/Uploaded Storage files are not copied/)).toBeVisible();
  const submit = dialog.getByRole("button", { name: "Overwrite & clone database" });
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(`Type ${TARGET.name} to confirm`).fill(SOURCE.name);
  await expect(submit).toBeDisabled();
  await dialog.getByLabel(`Type ${TARGET.name} to confirm`).fill(TARGET.name);
  await expect(submit).toBeEnabled();
  await destination.selectOption(OTHER.id);
  await expect(dialog.getByLabel(`Type ${OTHER.name} to confirm`)).toHaveValue("");
  await expect(submit).toBeDisabled();
});

test("confirmed clone submits one source-to-target request and follows destination progress to completion", async ({ page }) => {
  await mockFleet(page);
  let requests = 0;
  let posted: unknown;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`**/api/db-instances/${SOURCE.id}/clone`, async (route) => {
    requests += 1;
    posted = route.request().postDataJSON();
    await hold;
    await route.fulfill({ status: 202, json: { jobId: `clone:${TARGET.id}`, targetInstanceId: TARGET.id } });
  });
  await page.route(`**/api/db-instances/${TARGET.id}/clone-log`, (route) => route.fulfill({
    contentType: "text/event-stream", body: stream("ok"),
  }));
  await login(page, "admin");
  const dialog = await openClone(page);
  await dialog.getByLabel("Destination database", { exact: true }).selectOption(TARGET.id);
  await dialog.getByLabel(`Type ${TARGET.name} to confirm`).fill(TARGET.name);
  await dialog.getByRole("button", { name: "Overwrite & clone database" }).click();
  await expect(dialog.getByRole("button", { name: "Starting clone…" })).toBeDisabled();
  await expect(dialog.getByLabel("Destination database", { exact: true })).toBeDisabled();
  release();
  const completed = page.getByRole("dialog", { name: `Clone complete — ${TARGET.name}` });
  await expect(completed.getByText("Database cloned successfully.")).toBeVisible();
  await expect(completed.getByText("Verify cloned database", { exact: true })).toBeVisible();
  await expect(completed.getByText(/Connect using the destination’s own URL and credentials/)).toBeVisible();
  expect(requests).toBe(1);
  expect(posted).toEqual({ targetInstanceId: TARGET.id, confirmName: TARGET.name });
  await completed.getByRole("button", { name: "Done — back to fleet" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("clone start errors preserve the chosen destination and confirmation for recovery", async ({ page }) => {
  await mockFleet(page);
  await page.route(`**/api/db-instances/${SOURCE.id}/clone`, (route) => route.fulfill({
    status: 409, json: { error: "Destination server is busy. Try again when its current job finishes." },
  }));
  await login(page, "admin");
  const dialog = await openClone(page);
  await dialog.getByLabel("Destination database", { exact: true }).selectOption(TARGET.id);
  await dialog.getByLabel(`Type ${TARGET.name} to confirm`).fill(TARGET.name);
  await dialog.getByRole("button", { name: "Overwrite & clone database" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Destination server is busy");
  await expect(dialog.getByLabel(`Type ${TARGET.name} to confirm`)).toHaveValue(TARGET.name);
  await expect(dialog.getByRole("button", { name: "Overwrite & clone database" })).toBeEnabled();
});

test("clone stream failure has a visible failed outcome and retained diagnostic details", async ({ page }) => {
  await mockFleet(page);
  await page.route(`**/api/db-instances/${SOURCE.id}/clone`, (route) => route.fulfill({
    status: 202, json: { jobId: `clone:${TARGET.id}`, targetInstanceId: TARGET.id },
  }));
  await page.route(`**/api/db-instances/${TARGET.id}/clone-log`, (route) => route.fulfill({
    contentType: "text/event-stream", body: stream("error"),
  }));
  await login(page, "admin");
  const dialog = await openClone(page);
  await dialog.getByLabel("Destination database", { exact: true }).selectOption(TARGET.id);
  await dialog.getByLabel(`Type ${TARGET.name} to confirm`).fill(TARGET.name);
  await dialog.getByRole("button", { name: "Overwrite & clone database" }).click();
  const failed = page.getByRole("dialog", { name: `Clone failed — ${TARGET.name}` });
  await expect(failed.getByRole("alert")).toContainText("Database clone failed.");
  await expect(failed.getByText(/dump: source connection failed/)).toBeVisible();
});

test("empty destination state explains how to prepare another instance", async ({ page }) => {
  await mockFleet(page, [SOURCE, STOPPED]);
  await login(page, "admin");
  const dialog = await openClone(page);
  await expect(dialog.getByText("No destination available")).toBeVisible();
  await expect(dialog.getByText(/Create or start another database instance/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Overwrite & clone database" })).toBeDisabled();
  await dialog.getByRole("button", { name: "New instance", exact: true }).click();
  await expect(page.getByRole("heading", { name: "New Supabase instance", exact: true })).toBeVisible();
});

test("a clone already in progress can be followed from the destination card", async ({ page }) => {
  await mockFleet(page, [SOURCE, { ...TARGET, status: "restoring", activeJob: "clone" }]);
  await page.route(`**/api/db-instances/${TARGET.id}/clone-log`, (route) => route.fulfill({
    contentType: "text/event-stream", body: stream("ok"),
  }));
  await login(page, "admin");
  await page.goto("/databases");
  await expect(page.getByText("Back up source database", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Expand log" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: `Cloning — ${TARGET.name}` })).toBeVisible();
  await expect(dialog.getByText("Verify cloned database", { exact: true })).toBeVisible();
});

for (const role of ["operator", "viewer"] as const) {
  test(`${role} cannot access the clone action or endpoint`, async ({ page }) => {
    await mockFleet(page, [SOURCE, TARGET]);
    await login(page, role);
    await page.goto("/databases");
    await page.getByRole("button", { name: `Actions for ${SOURCE.name}` }).click();
    await expect(page.getByRole("menuitem", { name: "Clone database…" })).toHaveCount(0);
    const response = await page.request.post(`/api/db-instances/${SOURCE.id}/clone`, {
      data: { targetInstanceId: TARGET.id, confirmName: TARGET.name },
    });
    expect(response.status()).toBe(403);
  });
}

test("clone form fits a small viewport and can be cancelled using the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await mockFleet(page, [SOURCE, TARGET]);
  await login(page, "admin");
  const dialog = await openClone(page);
  await dialog.getByLabel("Destination database", { exact: true }).selectOption(TARGET.id);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(375);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
