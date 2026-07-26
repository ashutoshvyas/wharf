import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearFailures,
  isLocked,
  recordFailure,
  remainingMs,
  resetRateLimiter,
} from "./rate-limit";

const KEY = "user@example.com";
const MIN = 60 * 1000;

describe("rate-limit", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-24T12:00:00Z"));
    resetRateLimiter();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not lock below the threshold", () => {
    for (let i = 0; i < 4; i++) {
      const res = recordFailure(KEY);
      expect(res.locked).toBe(false);
      expect(res.lockoutTriggered).toBe(false);
    }
    expect(isLocked(KEY)).toBe(false);
    expect(remainingMs(KEY)).toBe(0);
  });

  it("locks on the 5th failure and blocks the 6th attempt", () => {
    for (let i = 0; i < 4; i++) recordFailure(KEY);
    const fifth = recordFailure(KEY);
    expect(fifth.locked).toBe(true);
    expect(fifth.lockoutTriggered).toBe(true);

    // 6th attempt: caller checks isLocked() before comparing credentials.
    expect(isLocked(KEY)).toBe(true);
    expect(remainingMs(KEY)).toBe(15 * MIN);
  });

  it("triggers the lockout signal only once per episode", () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY);
    // Further failures while already locked must not re-trigger.
    const again = recordFailure(KEY);
    expect(again.locked).toBe(true);
    expect(again.lockoutTriggered).toBe(false);
  });

  it("clears failures and lock on success", () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY);
    expect(isLocked(KEY)).toBe(true);
    clearFailures(KEY);
    expect(isLocked(KEY)).toBe(false);
    expect(remainingMs(KEY)).toBe(0);
    // Fresh episode: 1 failure does not lock.
    expect(recordFailure(KEY).locked).toBe(false);
  });

  it("unlocks after the lockout period expires", () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY);
    expect(isLocked(KEY)).toBe(true);

    vi.advanceTimersByTime(15 * MIN - 1);
    expect(isLocked(KEY)).toBe(true);

    vi.advanceTimersByTime(2);
    expect(isLocked(KEY)).toBe(false);
    expect(remainingMs(KEY)).toBe(0);
  });

  it("extends the lock from the last failure", () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY);
    vi.advanceTimersByTime(10 * MIN);
    recordFailure(KEY); // still within window — lock renews from now
    expect(remainingMs(KEY)).toBe(15 * MIN);
  });

  it("uses a sliding window — stale failures do not count", () => {
    for (let i = 0; i < 4; i++) recordFailure(KEY);
    vi.advanceTimersByTime(16 * MIN); // all 4 fall out of the window
    const res = recordFailure(KEY);
    expect(res.locked).toBe(false);
    expect(isLocked(KEY)).toBe(false);
  });

  it("locks when 5 failures accumulate within the sliding window", () => {
    recordFailure(KEY);
    vi.advanceTimersByTime(5 * MIN);
    for (let i = 0; i < 3; i++) recordFailure(KEY);
    vi.advanceTimersByTime(5 * MIN); // first failure is now 10 min old — in window
    const res = recordFailure(KEY);
    expect(res.locked).toBe(true);
    expect(res.lockoutTriggered).toBe(true);
  });

  it("normalizes keys (case + whitespace)", () => {
    for (let i = 0; i < 5; i++) recordFailure("  User@Example.COM ");
    expect(isLocked("user@example.com")).toBe(true);
    clearFailures("USER@EXAMPLE.COM");
    expect(isLocked("user@example.com")).toBe(false);
  });

  it("tracks keys independently", () => {
    for (let i = 0; i < 5; i++) recordFailure(KEY);
    expect(isLocked(KEY)).toBe(true);
    expect(isLocked("other@example.com")).toBe(false);
  });
});
