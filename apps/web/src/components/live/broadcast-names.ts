import type { LiveBroadcastSummary } from "@trinitymatrix/protocol";
import type { BroadcastTimelineEntry } from "../../api";

type Player = Pick<LiveBroadcastSummary["players"][number], "id" | "displayName" | "actorKind">;
const withoutVersion = (name: string) => name.replace(/ · v\d+(?:\.\d+)*$/, "");

export function broadcastPlayerName(player: { displayName: string; actorKind?: "human" | "ai" | undefined }): string {
  return player.actorKind === "ai" ? withoutVersion(player.displayName) : player.displayName;
}

export function broadcastTitle(broadcast: Pick<LiveBroadcastSummary, "title" | "players">): string {
  return broadcast.title === broadcast.players.map(({ displayName }) => displayName).join(" · ")
    ? broadcast.players.map(broadcastPlayerName).join(" · ") : broadcast.title;
}

export function broadcastMoveSummary(event: BroadcastTimelineEntry["event"], players: readonly Player[]): string {
  const actor = players.find(({ id }) => id === event.actorPlayerId);
  const separator = event.summary.indexOf(": ");
  return actor?.actorKind === "ai" && separator >= 0
    ? withoutVersion(event.summary.slice(0, separator)) + event.summary.slice(separator) : event.summary;
}
