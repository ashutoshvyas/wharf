import { describe, expect, it } from "vitest";
import {
  formatResourceLimits,
  instanceSliceName,
  sliceProperties,
  updateResourceLimitsSchema,
} from "./resource-limits";

describe("instanceSliceName", () => {
  it("nests the instance under wharf.slice", () => {
    expect(instanceSliceName("sb_4f2a")).toBe("wharf-sb_4f2a.slice");
  });

  it("rejects anything that is not a minted project name", () => {
    for (const bad of ["sb_4f2", "SB_4F2A", "sb_4f2a; reboot", "../x", ""]) {
      expect(() => instanceSliceName(bad)).toThrow(/Invalid compose project name/);
    }
  });
});

describe("sliceProperties", () => {
  it("maps cores to a CPU percentage and sets MemoryHigh below MemoryMax", () => {
    expect(sliceProperties({ cpuLimit: 1.5, memoryLimitMb: 3072 })).toEqual([
      "CPUQuota=150%",
      "MemoryHigh=2764M",
      "MemoryMax=3072M",
    ]);
  });

  it("resets each limit independently when it is unlimited", () => {
    expect(sliceProperties({ cpuLimit: null, memoryLimitMb: null })).toEqual([
      "CPUQuota=",
      "MemoryHigh=infinity",
      "MemoryMax=infinity",
    ]);
    expect(sliceProperties({ cpuLimit: 0.25, memoryLimitMb: null })[0]).toBe("CPUQuota=25%");
  });
});

describe("updateResourceLimitsSchema", () => {
  it("accepts a budget or nulls", () => {
    expect(updateResourceLimitsSchema.parse({ cpuLimit: 0.75, memoryLimitMb: 2048 })).toEqual({
      cpuLimit: 0.75,
      memoryLimitMb: 2048,
    });
    expect(updateResourceLimitsSchema.parse({ cpuLimit: null, memoryLimitMb: null })).toEqual({
      cpuLimit: null,
      memoryLimitMb: null,
    });
  });

  it("rejects budgets too small to boot the stack or not expressible as a CPU percentage", () => {
    for (const body of [
      { cpuLimit: 0.1, memoryLimitMb: 2048 },
      { cpuLimit: 1.005, memoryLimitMb: 2048 },
      { cpuLimit: 1, memoryLimitMb: 512 },
      { cpuLimit: 1, memoryLimitMb: 2048.5 },
      { cpuLimit: 1 },
    ]) {
      expect(updateResourceLimitsSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe("formatResourceLimits", () => {
  it("formats whole gigabytes, megabytes and unlimited", () => {
    expect(formatResourceLimits({ cpuLimit: 1, memoryLimitMb: 3072 })).toBe("1 CPU · 3 GB");
    expect(formatResourceLimits({ cpuLimit: 2, memoryLimitMb: 2500 })).toBe("2 CPU · 2500 MB");
    expect(formatResourceLimits({ cpuLimit: null, memoryLimitMb: 4096 })).toBe("unlimited CPU · 4 GB");
    expect(formatResourceLimits({ cpuLimit: null, memoryLimitMb: null })).toBe("Unlimited");
  });
});
