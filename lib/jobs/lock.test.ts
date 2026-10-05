import { describe, expect, it } from "vitest";
import { serverLockHolder, tryAcquireServerLock } from "./lock";

describe("per-server single-flight lock", () => {
  it("second acquisition fails until released; release is idempotent", () => {
    const id = `srv-${Math.random()}`;
    const release = tryAcquireServerLock(id, "bootstrap");
    expect(release).not.toBeNull();
    expect(serverLockHolder(id)).toBe("bootstrap");
    expect(tryAcquireServerLock(id, "provision")).toBeNull();

    release!();
    expect(serverLockHolder(id)).toBeNull();
    release!(); // double release must not free someone else's lock
    const release2 = tryAcquireServerLock(id, "provision");
    expect(release2).not.toBeNull();
    release!(); // stale release from the first holder — still a no-op
    expect(serverLockHolder(id)).toBe("provision");
    release2!();
  });

  it("locks are per server id", () => {
    const a = tryAcquireServerLock("srv-a", "bootstrap");
    const b = tryAcquireServerLock("srv-b", "provision");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    a!();
    b!();
  });
});
