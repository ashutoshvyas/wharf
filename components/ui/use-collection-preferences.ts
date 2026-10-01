"use client";

import { useEffect, useState } from "react";
import type { CollectionDirection, CollectionOption, CollectionView } from "./collection-toolbar";

interface Preferences {
  view: CollectionView;
  sort: string;
  direction: CollectionDirection;
  group: string;
}

/** Keep preferences per screen on this browser; unavailable storage is harmless. */
export function useCollectionPreferences(
  screen: string,
  defaults: Preferences,
  sortOptions: CollectionOption[],
  groupOptions: CollectionOption[],
) {
  const [preferences, setPreferences] = useState(defaults);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`wharf.collection.${screen}`) ?? "null");
      if (!saved || typeof saved !== "object") return;
      setPreferences((current) => ({
        view: saved.view === "list" || saved.view === "cards" ? saved.view : current.view,
        sort: sortOptions.some((option) => option.value === saved.sort) ? saved.sort : current.sort,
        direction: saved.direction === "asc" || saved.direction === "desc" ? saved.direction : current.direction,
        group: groupOptions.some((option) => option.value === saved.group) ? saved.group : current.group,
      }));
    } catch { /* Browser storage may be disabled or contain an older format. */ }
  }, [screen, sortOptions, groupOptions]);

  function update(patch: Partial<Preferences>) {
    const next = { ...preferences, ...patch };
    setPreferences(next);
    try { localStorage.setItem(`wharf.collection.${screen}`, JSON.stringify(next)); }
    catch { /* Preferences still work for this visit. */ }
  }
  return {
    ...preferences,
    sortOptions, groupOptions,
    onViewChange: (view: CollectionView) => update({ view }),
    onSortChange: (sort: string) => update({ sort }),
    onDirectionChange: (direction: CollectionDirection) => update({ direction }),
    onGroupChange: (group: string) => update({ group }),
    tableSort: {
      key: preferences.sort,
      direction: preferences.direction,
      onChange: (sort: string) => update({ sort, direction: sort === preferences.sort && preferences.direction === "asc" ? "desc" : "asc" }),
    },
  };
}
