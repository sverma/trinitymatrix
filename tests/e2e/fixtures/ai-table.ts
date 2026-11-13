import type { Page, WebSocketRoute } from "@playwright/test";
import { parseServerMessage, type Card, type ClientMessage, type GamePublicState, type PlayerCount, type ServerMessage } from "@trinitymatrix/protocol";

const humanId = "11111111-1111-4111-8111-111111111111";
const suits = ["clubs", "diamonds", "hearts", "spades"] as const;
const modelIds = ["google/gemini-3.8-flash", "anthropic/claude-haiku-5.5", "mistralai/mistral-small-2603", "qwen/qwen3.8-flash", "deepseek/deepseek-v3.2"];

/** Only browser fixtures: every API request and the game socket stay synthetic. */
export async function installAiTableFixture(page: Page, playerCount: PlayerCount) {
  const gameId = playerCount === 2 ? "00000000-0000-4000-8000-000000000102" : "00000000-0000-4000-8000-000000000106";
  const initialHand: Card[] = Array.from({ length: 13 }, (_, index) => ({
    id: `layout-card-${index + 1}`, deck: 1, suit: suits[index % suits.length]!, rank: index + 1, printedJoker: false
  }));
  const drawnCard: Card = { id: "layout-drawn-card", deck: 1, suit: "clubs", rank: 8, printedJoker: false };
  let hand = [...initialHand];
  let socket: WebSocketRoute | null = null;
  let state: GamePublicState = {
    gameId,
    gameName: "layout-fixture-00000001",
    playerCount,
    matchType: "general",
    players: [{ id: humanId, displayName: "Layout Player", badgeId: "rookie", connected: true, cardCount: 13, status: "playing", actorKind: "human" },
      ...Array.from({ length: playerCount - 1 }, (_, index) => ({
        id: `22222222-2222-4222-8222-00000000000${index + 1}`,
        displayName: `${["Gemini", "Haiku", "Mistral", "Qwen", "DeepSeek"][index]} Fixture AI`,
        badgeId: "strategist" as const,
        connected: true,
        cardCount: 13,
        status: "playing" as const,
        actorKind: "ai" as const,
        aiModelId: modelIds[index]!
      }))],
    currentPlayerId: humanId,
    topDiscard: { id: "layout-open-card", deck: 1, suit: "clubs", rank: 10, printedJoker: false },
    wildRank: 13,
    stockCount: playerCount === 2 ? 26 : 90,
    turnEndsAt: Date.now() + 120_000,
    phase: "playing",
    showdown: null,
    revision: 1,
    toss: null
  };

  const send = (message: ServerMessage) => {
    if (!socket) throw new Error("Synthetic game socket has not opened.");
    socket.send(JSON.stringify(parseServerMessage(message)));
  };

  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/session") return route.fulfill({ json: {
      authenticated: true,
      isAdmin: false,
      player: { id: humanId, email: "layout-player@example.test", displayName: "Layout Player", badgeId: "rookie", phone: null, createdAt: 1, updatedAt: 1 }
    } });
    if (pathname === "/api/private-matches") return route.fulfill({ json: { invitations: [], createdRooms: [] } });
    // A layout test must never enroll real players or initiate inference.
    return route.fulfill({ status: 503, json: { error: "API operations are disabled in the synthetic layout fixture." } });
  });

  await page.routeWebSocket(/\/ws$/, (route) => {
    socket = route;
    route.onMessage((raw) => {
      const command = JSON.parse(String(raw)) as ClientMessage;
      if (command.type === "ping") { send({ type: "pong", at: command.at }); return; }
      if (command.type === "game.draw" && hand.length === 13) {
        hand = [...initialHand, drawnCard];
        state = { ...state, revision: state.revision + 1, stockCount: state.stockCount - 1,
          players: state.players.map((player) => player.id === humanId ? { ...player, cardCount: 14 } : player) };
        send({ type: "game.hand", hand, drawnCardId: drawnCard.id });
        send({ type: "game.state", ...state });
      } else if (command.type === "game.discard" && hand.length === 14) {
        hand = hand.filter((card) => card.id !== command.cardId);
        state = { ...state, revision: state.revision + 1, currentPlayerId: state.players[1]!.id,
          players: state.players.map((player) => player.id === humanId ? { ...player, cardCount: 13 } : player) };
        send({ type: "game.hand", hand });
        send({ type: "game.state", ...state });
      }
    });
    send({ type: "session.ready", playerId: humanId, displayName: "Layout Player" });
    send({ type: "game.started", ...state, hand });
  });

  return {
    gameId,
    addTechnicalNotice: () => {
      if (playerCount !== 6) throw new Error("The ongoing-game notice fixture requires other active AI seats.");
      const dropped = state.players.at(-1)!;
      state = { ...state, revision: state.revision + 1,
        players: state.players.map((player) => player.id === dropped.id ? { ...player, status: "dropped", cardCount: 0 } : player) };
      send({ type: "game.state", ...state });
      send({ type: "game.player-dropped", playerId: dropped.id, playerName: dropped.displayName,
        reasonCode: "AI_UNAVAILABLE", reason: "This fixture AI could not continue because its selected model was unavailable." });
    }
  };
}
