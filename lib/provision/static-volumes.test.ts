import { describe, expect, it } from "vitest";
import { loadStaticVolumeFiles } from "./static-volumes";

describe("loadStaticVolumeFiles (bugfix: db bind-mounts were never uploaded)", () => {
  it("includes every file the compose service definitions bind-mount", async () => {
    const files = await loadStaticVolumeFiles();
    const relPaths = files.map((f) => f.relPath).sort();

    // db: (required for Postgres to become healthy at all)
    for (const f of [
      "db/realtime.sql",
      "db/jwt.sql",
      "db/_supabase.sql",
      "db/roles.sql",
      "db/webhooks.sql",
      "db/logs.sql",
      "db/pooler.sql",
    ]) {
      expect(relPaths).toContain(f);
    }
    // kong:
    expect(relPaths).toContain("api/kong.yml");
    expect(relPaths).toContain("api/kong-entrypoint.sh");
    // storage / snippets / functions: empty dirs, present via .gitkeep so the
    // directory bind-mounts (storage, studio) have somewhere to land.
    expect(relPaths).toContain("storage/.gitkeep");
    expect(relPaths).toContain("snippets/.gitkeep");
    expect(relPaths).toContain("functions/.gitkeep");
  });

  it("reads every file's real bytes, not empty placeholders", async () => {
    const files = await loadStaticVolumeFiles();
    const jwtSql = files.find((f) => f.relPath === "db/jwt.sql");
    expect(jwtSql?.content.toString("utf8")).toContain("JWT_SECRET");
  });

  it("carries no unsubstituted {{...}} placeholders — these ship verbatim", async () => {
    const files = await loadStaticVolumeFiles();
    for (const f of files) {
      expect(f.content.toString("utf8")).not.toMatch(/\{\{[A-Z_]+\}\}/);
    }
  });

  it("uses posix-style relative paths regardless of host OS", async () => {
    const files = await loadStaticVolumeFiles();
    for (const f of files) {
      expect(f.relPath).not.toContain("\\");
    }
  });
});
