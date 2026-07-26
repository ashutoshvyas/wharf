import { describe, expect, it } from "vitest";
import {
  LAST_ADMIN_DELETE_MESSAGE,
  LAST_ADMIN_DEMOTE_MESSAGE,
  SELF_DELETE_MESSAGE,
  SELF_ROLE_MESSAGE,
  deleteUserConflict,
  updateRoleConflict,
} from "./guards";

const ME = "usr-me";
const OTHER = "usr-other";

describe("deleteUserConflict", () => {
  it("refuses deleting yourself", () => {
    expect(deleteUserConflict(ME, { id: ME, role: "admin" }, 5)).toBe(
      SELF_DELETE_MESSAGE,
    );
    // Self-check wins even when the last-admin rule would also fire.
    expect(deleteUserConflict(ME, { id: ME, role: "admin" }, 1)).toBe(
      SELF_DELETE_MESSAGE,
    );
  });

  it("refuses deleting the last admin", () => {
    expect(deleteUserConflict(ME, { id: OTHER, role: "admin" }, 1)).toBe(
      LAST_ADMIN_DELETE_MESSAGE,
    );
  });

  it("allows deleting an admin while another remains", () => {
    expect(deleteUserConflict(ME, { id: OTHER, role: "admin" }, 2)).toBeNull();
  });

  it("allows deleting non-admins regardless of the admin count", () => {
    expect(deleteUserConflict(ME, { id: OTHER, role: "operator" }, 1)).toBeNull();
    expect(deleteUserConflict(ME, { id: OTHER, role: "viewer" }, 1)).toBeNull();
  });

  it("treats a zero admin count as still protecting an admin row", () => {
    // Defensive: a miscounted 0 must not open the door to deleting an admin.
    expect(deleteUserConflict(ME, { id: OTHER, role: "admin" }, 0)).toBe(
      LAST_ADMIN_DELETE_MESSAGE,
    );
  });
});

describe("updateRoleConflict", () => {
  it("refuses changing your own role", () => {
    expect(updateRoleConflict(ME, { id: ME, role: "admin" }, "viewer", 5)).toBe(
      SELF_ROLE_MESSAGE,
    );
    // …including a self-promotion that is otherwise harmless.
    expect(
      updateRoleConflict(ME, { id: ME, role: "viewer" }, "admin", 5),
    ).toBe(SELF_ROLE_MESSAGE);
  });

  it("refuses demoting the last admin", () => {
    for (const next of ["operator", "viewer"] as const) {
      expect(
        updateRoleConflict(ME, { id: OTHER, role: "admin" }, next, 1),
      ).toBe(LAST_ADMIN_DEMOTE_MESSAGE);
    }
  });

  it("allows demoting an admin while another remains", () => {
    expect(
      updateRoleConflict(ME, { id: OTHER, role: "admin" }, "viewer", 2),
    ).toBeNull();
  });

  it("allows a no-op admin→admin update even at count 1", () => {
    expect(
      updateRoleConflict(ME, { id: OTHER, role: "admin" }, "admin", 1),
    ).toBeNull();
  });

  it("allows promoting a non-admin at any count", () => {
    expect(
      updateRoleConflict(ME, { id: OTHER, role: "viewer" }, "admin", 1),
    ).toBeNull();
    expect(
      updateRoleConflict(ME, { id: OTHER, role: "operator" }, "viewer", 1),
    ).toBeNull();
  });
});
