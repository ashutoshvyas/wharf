/**
 * Seed script — run with `npm run db:seed` (tsx prisma/seed.ts).
 *
 * Required env: ADMIN_EMAIL, ADMIN_PASSWORD (initial admin panel user).
 * Optional: SEED_DEMO=1 to upsert demo servers/websites (no real secrets).
 * Idempotent: safe to run multiple times.
 */
import bcrypt from "bcryptjs";
import { prisma } from "../lib/db";
import { adminSeedConfig } from "../scripts/admin-seed-config";

// Fixed ids so demo seeding stays idempotent across runs.
const DEMO_SERVER_1_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_SERVER_2_ID = "00000000-0000-4000-8000-000000000002";
const DEMO_WEBSITE_1_ID = "00000000-0000-4000-8000-000000000101";
const DEMO_WEBSITE_2_ID = "00000000-0000-4000-8000-000000000102";

async function main() {
  const { adminEmail, adminPassword } = adminSeedConfig(process.env);

  const passwordHash = await bcrypt.hash(adminPassword, 12);

  const admin = await prisma.panelUser.upsert({
    where: { email: adminEmail },
    update: { passwordHash, role: "admin" },
    create: { email: adminEmail, passwordHash, role: "admin" },
  });
  console.log(`Admin user ready (role: ${admin.role}).`);

  if (process.env.SEED_DEMO === "1") {
    await seedDemoData();
  }
}

async function seedDemoData() {
  const server1 = await prisma.server.upsert({
    where: { id: DEMO_SERVER_1_ID },
    update: {},
    create: {
      id: DEMO_SERVER_1_ID,
      name: "demo-web-01",
      host: "203.0.113.10",
      sshPort: 22,
      sshUser: "root",
      authMethod: "private_key",
      bootstrapped: true,
      reachable: true,
      tags: ["demo", "web"],
    },
  });

  const server2 = await prisma.server.upsert({
    where: { id: DEMO_SERVER_2_ID },
    update: {},
    create: {
      id: DEMO_SERVER_2_ID,
      name: "demo-db-01",
      host: "203.0.113.20",
      sshPort: 2222,
      sshUser: "wharf",
      authMethod: "password",
      linkedPanelUrl: "https://cockpit.demo-db-01.example.com",
      bootstrapped: false,
      reachable: true,
      tags: ["demo", "database"],
    },
  });

  await prisma.website.upsert({
    where: { id: DEMO_WEBSITE_1_ID },
    update: {},
    create: {
      id: DEMO_WEBSITE_1_ID,
      domain: "clienta.example.com",
      serverId: server1.id,
      path: "/var/www/clienta",
      credentialLabel: "WordPress admin",
      accessUsername: "clienta-admin",
      notes: "Demo website seeded by SEED_DEMO=1.",
    },
  });

  await prisma.website.upsert({
    where: { id: DEMO_WEBSITE_2_ID },
    update: {},
    create: {
      id: DEMO_WEBSITE_2_ID,
      domain: "clientb.example.com",
      serverId: server2.id,
      path: "/var/www/clientb",
      credentialLabel: "FTP login",
      notes: "Demo website seeded by SEED_DEMO=1.",
    },
  });

  console.log("Demo data ready: 2 servers, 2 websites (no secrets stored).");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
