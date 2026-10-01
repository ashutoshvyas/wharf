/** Natural ordering keeps IP octets and numbered names in a useful order. */
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function sortCollection<T>(rows: T[], value: (row: T) => string | number, direction: "asc" | "desc"): T[] {
  return [...rows].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const comparison = typeof left === "number" && typeof right === "number"
      ? left - right : collator.compare(String(left), String(right));
    return direction === "asc" ? comparison : -comparison;
  });
}

export function groupCollection<T>(rows: T[], groupBy?: (row: T) => string): [string, T[]][] {
  if (!groupBy) return [["", rows]];
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const label = groupBy(row) || "Unknown server";
    const group = groups.get(label) ?? [];
    group.push(row);
    groups.set(label, group);
  }
  return [...groups.entries()].sort(([a], [b]) => collator.compare(a, b));
}
