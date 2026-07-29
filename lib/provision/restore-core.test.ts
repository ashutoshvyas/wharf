import { describe, expect, it } from "vitest";
import { looksLikeCustomFormatDump } from "./restore-core";

describe("looksLikeCustomFormatDump", () => {
  it("is true for a buffer starting with the PGDMP magic", () => {
    expect(looksLikeCustomFormatDump(Buffer.from("PGDMP\x01\x0dsome archive bytes"))).toBe(true);
  });

  it("is false for a plain-text SQL dump, regardless of its extension", () => {
    expect(
      looksLikeCustomFormatDump(Buffer.from("-- PostgreSQL database dump\nselect 1;\n")),
    ).toBe(false);
  });

  it("is false for an empty buffer", () => {
    expect(looksLikeCustomFormatDump(Buffer.alloc(0))).toBe(false);
  });

  it("is false when the magic appears anywhere but the start", () => {
    expect(looksLikeCustomFormatDump(Buffer.from("xPGDMP"))).toBe(false);
  });
});
