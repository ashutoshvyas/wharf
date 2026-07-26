/**
 * E2E fixtures — real panel users, created and torn down per run.
 *
 * Users are created directly through Prisma rather than the API so a broken
 * users endpoint cannot prevent the rest of the suite from running.
 */
import { config } from "dotenv";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { test as base, type Page } from "@playwright/test";

config({ quiet: true });

export const prisma = new PrismaClient();

/** Every fixture email carries this marker so cleanup can find them. */
export const E2E_MARKER = "e2e-wharf";
export const PASSWORD = "e2e-password-12345";

export const USERS = {
  admin: `${E2E_MARKER}-admin@example.test`,
  operator: `${E2E_MARKER}-operator@example.test`,
  viewer: `${E2E_MARKER}-viewer@example.test`,
} as const;

export type RoleName = keyof typeof USERS;

export async function ensureUsers(): Promise<void> {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  for (const [role, email] of Object.entries(USERS)) {
    await prisma.panelUser.upsert({
      where: { email },
      update: { passwordHash, role: role as RoleName },
      create: { email, passwordHash, role: role as RoleName },
    });
  }
}

/** Remove everything this suite created. Safe to call repeatedly. */
export async function cleanup(): Promise<void> {
  await prisma.website.deleteMany({ where: { domain: { contains: E2E_MARKER } } });
  await prisma.server.deleteMany({ where: { name: { contains: E2E_MARKER } } });
  await prisma.panelUser.deleteMany({ where: { email: { contains: E2E_MARKER } } });
}

/** Sign in through the real login form so the session cookie is genuine. */
export async function login(page: Page, role: RoleName): Promise<void> {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(USERS[role]);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL(/\/(databases|servers|websites)/, { timeout: 15_000 });
}

export const test = base;
export { expect } from "@playwright/test";
