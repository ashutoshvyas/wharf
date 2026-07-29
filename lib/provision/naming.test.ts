import { describe, expect, it } from "vitest";
import {
  composeProjectName,
  INSTANCES_ROOT,
  isValidSlug,
  poolerDbAlias,
  PROJECT_RE,
  remotePathFor,
  SLUG_MAX_LENGTH,
  SLUG_RE,
  subdomainsFor,
} from "./naming";

describe("composeProjectName", () => {
  it("is sb_ plus exactly 4 hex characters", () => {
    for (let i = 0; i < 200; i += 1) {
      const project = composeProjectName();
      expect(project).toMatch(/^sb_[0-9a-f]{4}$/);
      expect(PROJECT_RE.test(project)).toBe(true);
      expect(project).toHaveLength(7);
    }
  });

  it("varies across calls", () => {
    // 16 bits of entropy: 300 draws should produce many distinct values even
    // though collisions are expected (uniqueness is enforced per server by the
    // caller, not by the entropy).
    const seen = new Set(Array.from({ length: 300 }, composeProjectName));
    expect(seen.size).toBeGreaterThan(200);
  });
});

describe("remotePathFor", () => {
  it("matches the contract §7 path", () => {
    expect(remotePathFor("sb_4f2a")).toBe("/opt/db-instances/sb_4f2a");
    expect(remotePathFor("sb_0000")).toBe(`${INSTANCES_ROOT}/sb_0000`);
  });

  it("rejects anything that is not a valid project name", () => {
    // The path is later fed to `rm -rf` during teardown, so it must never be
    // derivable from unvalidated input.
    for (const bad of ["", "sb_", "sb_zzzz", "sb_4f2ab", "../etc", "sb_4f2a/../..", "SB_4F2A"]) {
      expect(() => remotePathFor(bad)).toThrow(/Invalid compose project name/);
    }
  });
});

describe("subdomainsFor", () => {
  it("builds the api and studio hosts", () => {
    expect(subdomainsFor("clienta", "wharf.example.com")).toEqual({
      apiSubdomain: "clienta.wharf.example.com",
      studioSubdomain: "studio-clienta.wharf.example.com",
    });
  });
});

describe("isValidSlug", () => {
  it("accepts contract-conforming slugs", () => {
    for (const slug of ["a", "0", "clienta", "client-a", "client-a-prod", "a".repeat(40)]) {
      expect(isValidSlug(slug)).toBe(true);
      expect(SLUG_RE.test(slug)).toBe(true);
    }
  });

  it("rejects bad charsets, leading hyphens and over-long slugs", () => {
    for (const slug of [
      "",
      "-leading",
      "Upper",
      "under_score",
      "dot.ted",
      "with space",
      "back`tick",
      "semi;colon",
      "new\nline",
      "$var",
      "a".repeat(SLUG_MAX_LENGTH + 1),
    ]) {
      expect(isValidSlug(slug)).toBe(false);
    }
  });

  it("caps length at 40", () => {
    expect(SLUG_MAX_LENGTH).toBe(40);
    expect(isValidSlug("a".repeat(40))).toBe(true);
    expect(isValidSlug("a".repeat(41))).toBe(false);
  });
});

describe("poolerDbAlias", () => {
  it("hyphenates every underscore in the project name", () => {
    // composeProjectName() is always `sb_` + hex — the underscore must never
    // reach the alias: Erlang's DNS resolver (which Supavisor uses) is known
    // to fail on underscored hostnames.
    expect(poolerDbAlias("sb_4f2a")).toBe("sb-4f2a-db");
    expect(poolerDbAlias("sb_4f2a")).not.toContain("_");
  });

  it("is a pure function of its input", () => {
    expect(poolerDbAlias("sb_dead")).toBe(poolerDbAlias("sb_dead"));
  });
});
