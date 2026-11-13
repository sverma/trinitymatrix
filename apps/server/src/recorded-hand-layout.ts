import type { Card } from "@trinitymatrix/protocol";

/** Stored commands may predate current protocol validators. Fail closed on shape. */
export function parseRecordedHandLayout(value: unknown): string[][] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 14) return null;
  const seen = new Set<string>();
  const groups: string[][] = [];
  for (const item of value) {
    if (!Array.isArray(item) || item.length === 0 || item.length > 14) return null;
    const group: string[] = [];
    for (const id of item) {
      if (typeof id !== "string" || !id || seen.has(id)) return null;
      seen.add(id); group.push(id);
    }
    groups.push(group);
  }
  return groups;
}

export function recordedHandLayoutFromCommand(command: unknown): string[][] | null {
  if (!command || typeof command !== "object" || Array.isArray(command)) return null;
  const fields = command as Record<string, unknown>;
  if (fields.type === "game.declare") return parseRecordedHandLayout(fields.melds);
  if (fields.type === "game.submit-hand") return parseRecordedHandLayout(fields.groups);
  if (fields.type === "game.draw" || fields.type === "game.discard" || fields.type === "game.drop") return parseRecordedHandLayout(fields.layout);
  return null;
}

/** Reconcile a past recorded layout after a draw/discard, preserving group order. */
export function reconcileRecordedHandLayout(value: unknown, cards: readonly Card[]): string[][] | null {
  const recorded = parseRecordedHandLayout(value);
  if (!recorded || !cards.length) return null;
  const owned = new Set(cards.map(({ id }) => id));
  const included = new Set<string>();
  const groups = recorded.map((group) => group.filter((id) => {
    if (!owned.has(id) || included.has(id)) return false;
    included.add(id); return true;
  })).filter((group) => group.length > 0);
  // A wholly stale/unrelated layout supplies no recorded arrangement of this hand.
  if (!groups.length) return null;
  const added = cards.filter(({ id }) => !included.has(id)).map(({ id }) => id);
  if (added.length) groups.push(added);
  return groups;
}
