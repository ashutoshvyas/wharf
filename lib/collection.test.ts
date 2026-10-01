import { describe, expect, it } from "vitest";
import { groupCollection, sortCollection } from "./collection";

describe("collection ordering and grouping", () => {
  const rows = [
    { name: "Database 10", host: "192.0.2.10", count: 10 },
    { name: "Database 2", host: "192.0.2.2", count: 2 },
    { name: "Database 1", host: "192.0.2.10", count: 1 },
  ];
  it("sorts IPs and numbered names naturally without changing the query cache", () => {
    expect(sortCollection(rows, (row) => row.host, "asc").map((row) => row.host))
      .toEqual(["192.0.2.2", "192.0.2.10", "192.0.2.10"]);
    expect(sortCollection(rows, (row) => row.name, "asc").map((row) => row.name))
      .toEqual(["Database 1", "Database 2", "Database 10"]);
    expect(rows[0]!.name).toBe("Database 10");
  });
  it("supports descending counts", () => {
    expect(sortCollection(rows, (row) => row.count, "desc").map((row) => row.count)).toEqual([10, 2, 1]);
  });
  it("collects nonadjacent rows with the same host while preserving their selected order", () => {
    const groups = groupCollection(sortCollection(rows, (row) => row.name, "asc"), (row) => row.host);
    expect(groups.map(([host, members]) => [host, members.map((row) => row.name)])).toEqual([
      ["192.0.2.2", ["Database 2"]],
      ["192.0.2.10", ["Database 1", "Database 10"]],
    ]);
    expect(groups.flatMap(([, members]) => members)).toHaveLength(rows.length);
  });
});
