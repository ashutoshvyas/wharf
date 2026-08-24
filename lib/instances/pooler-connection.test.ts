import { describe, expect, it } from "vitest";
import { buildPoolerConnectionString } from "./pooler-connection";

describe("buildPoolerConnectionString", () => {
  it.each([
    ["require", 5432],
    ["disable", 6543],
  ] as const)("emits sslmode=%s on port %s", (sslMode, port) => {
    expect(
      buildPoolerConnectionString({
        project: "sb_4f2a",
        password: "p@ss/word",
        host: "db.example.com",
        port,
        sslMode,
      }),
    ).toBe(
      `postgres://postgres.sb_4f2a:p%40ss%2Fword@db.example.com:${port}/postgres?sslmode=${sslMode}`,
    );
  });

  it("brackets an IPv6 host", () => {
    expect(
      buildPoolerConnectionString({
        project: "sb_4f2a",
        password: "secret",
        host: "2001:db8::1",
        port: 5432,
        sslMode: "require",
      }),
    ).toContain("@[2001:db8::1]:5432/");
  });
});
