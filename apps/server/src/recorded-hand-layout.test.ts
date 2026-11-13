import { describe, expect, it } from "vitest";
import type { Card } from "@trinitymatrix/protocol";
import { parseRecordedHandLayout, recordedHandLayoutFromCommand, reconcileRecordedHandLayout } from "./recorded-hand-layout";

const cards: Card[] = ["a", "b", "c", "new-draw"].map((id) => ({ id, deck: 1, suit: "clubs", rank: 7, printedJoker: false }));
describe("recorded hand layout projection", () => {
  it.each(["game.draw", "game.discard", "game.drop"])("reads only the stored layout for %s", (type) => {
    expect(recordedHandLayoutFromCommand({ type, layout: [["a", "b"], ["c"]], memory: "private", token: "private" })).toEqual([["a", "b"], ["c"]]);
  });
  it("reads declaration and showdown groupings without inventing a layout for other commands", () => {
    expect(recordedHandLayoutFromCommand({ type: "game.declare", melds: [["a", "b", "c"]] })).toEqual([["a", "b", "c"]]);
    expect(recordedHandLayoutFromCommand({ type: "game.submit-hand", groups: [["b"], ["a", "c"]] })).toEqual([["b"], ["a", "c"]]);
    expect(recordedHandLayoutFromCommand({ type: "game.started", layout: [["a"]] })).toBeNull();
  });
  it.each([undefined, null, [], [[]], [["a"], ["a"]], [[1]], ["a"], [[""]], Array.from({ length: 15 }, (_, index) => [String(index)])])(
    "omits malformed recorded layouts: %j", (value) => {
      expect(parseRecordedHandLayout(value)).toBeNull();
      expect(reconcileRecordedHandLayout(value, cards)).toBeNull();
    }
  );
  it("preserves group/card order, removes discarded or foreign IDs and appends newly drawn cards", () => {
    const groups = [["b", "discarded", "a"], ["foreign"], ["c"]];
    expect(reconcileRecordedHandLayout(groups, cards)).toEqual([["b", "a"], ["c"], ["new-draw"]]);
    expect(groups).toEqual([["b", "discarded", "a"], ["foreign"], ["c"]]);
  });
  it("does not label a wholly stale or unrelated arrangement as recorded", () => {
    expect(reconcileRecordedHandLayout([["foreign"], ["discarded"]], cards)).toBeNull();
    expect(reconcileRecordedHandLayout([["a"]], [])).toBeNull();
  });
});
