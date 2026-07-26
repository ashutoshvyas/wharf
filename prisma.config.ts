/**
 * Prisma config (replaces the deprecated `package.json#prisma` block —
 * removed entirely in Prisma 7: https://pris.ly/prisma-config).
 *
 * `import "dotenv/config"` is required here on purpose: adopting this file
 * does NOT disable Prisma's env("DATABASE_URL")/env("DIRECT_URL") resolution
 * in schema.prisma (that reads process.env directly, unrelated to this
 * config's own loading), but scripts run standalone (locally, or by hand on
 * the VPS — exactly how the DIRECT_URL-not-found error happened) rely on
 * something populating process.env from .env first. This line preserves
 * that convenience so `npx prisma migrate deploy` keeps working without
 * requiring `.env` to be sourced into the shell beforehand.
 */
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
