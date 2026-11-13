import { expect, test, type Page } from "@playwright/test";
import { join } from "node:path";
import type { BroadcastFrame, Card, LiveBroadcastSummary, PlayerCount } from "@trinitymatrix/protocol";

const gameName = "meld-fixture-12345678";
const gameId = "00000000-0000-4000-8000-000000000099";
const viewerId = "11111111-1111-4111-8111-111111111111";

function fixtureCards(owner: string): Card[] {
  const faces: Array<[Card["suit"], number]> = [
    ["hearts", 6], ["hearts", 7], ["hearts", 8],
    ["clubs", 2], ["clubs", 4], ["clubs", 6],
    ["diamonds", 10], ["diamonds", 11],
    ["spades", 3], ["spades", 5], ["hearts", 10], ["clubs", 9], ["diamonds", 1]
  ];
  return faces.map(([suit, rank], index) => ({ id: `${owner}-card-${index}`, deck: 1, suit, rank, printedJoker: false }));
}

async function installFixture(page: Page, playerCount: PlayerCount) {
  const now = Date.now();
  const players = Array.from({ length: playerCount }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    displayName: index === 0 ? "Recorded Player" : `Model ${index}`,
    badgeId: "rookie" as const, actorKind: index === 0 ? "human" as const : "ai" as const,
    connected: true, status: "playing" as const, cardCount: 13
  }));
  const summary: LiveBroadcastSummary = {
    gameId, gameName, title: "Grouped live table", playerCount, composition: "mixed", players,
    status: "live", delayMs: 120_000, availableAt: now - 10_000, viewerCount: 1
  };
  const hands = players.map((player, index) => {
    const cards = fixtureCards(player.id);
    return { playerId: player.id, cards, ...(index === 0 ? {
      layout: { source: "recorded" as const, groups: [cards.slice(0, 3), cards.slice(3, 6), cards.slice(6, 8), cards.slice(8)].map(group => group.map(card => card.id)) }
    } : {}) };
  });
  const frame: BroadcastFrame = {
    sequence: 2, capturedAt: now - 130_000, releasedAt: now - 10_000,
    game: { gameId, gameName, playerCount, matchType: "general", players, currentPlayerId: players[0]!.id,
      topDiscard: null, wildRank: 13, stockCount: 20, turnEndsAt: now - 90_000, phase: "playing", showdown: null, revision: 2, toss: null },
    hands, event: { type: "game.discard", summary: "Recorded grouping released" }
  };
  const previous: BroadcastFrame = { ...frame, sequence: 1, game: { ...frame.game, revision: 1, wildRank: 7 },
    event: { type: "game.draw", summary: "Earlier released hand" } };
  await page.addInitScript(() => {
    class FixtureEventSource extends EventTarget {
      onopen: (() => void) | null = null;
      onerror = null;
      constructor(_url: string) { super(); queueMicrotask(() => this.onopen?.()); }
      close() {}
    }
    Object.defineProperty(window, "EventSource", { value: FixtureEventSource });
  });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { authenticated: true, player: { id: viewerId, email: "spectator@example.test", displayName: "Viewer", badgeId: "rookie", phone: null, createdAt: 1, updatedAt: 1 } } });
    if (path === `/api/live/${gameName}`) return route.fulfill({ json: { broadcast: summary, frame, comments: [], serverNow: now, canModerate: false } });
    if (path.endsWith("/timeline")) return route.fulfill({ json: { frames: [frame, previous].map(({ sequence, capturedAt, event }) => ({ sequence, capturedAt, event })), nextCursor: null } });
    if (path.endsWith("/frames/1")) return route.fulfill({ json: { frame: previous } });
    if (path.endsWith("/frames/2")) return route.fulfill({ json: { frame } });
    if (path.endsWith("/video")) return route.fulfill({ json: { enabled: false, canPublish: false, video: null, limits: { width: 854, height: 480, frameRate: 15, maxDurationSeconds: 7200 }, serverNow: now } });
    return route.fulfill({ status: 503, json: { error: "This visual fixture cannot start games or model calls." } });
  });
}

for (const playerCount of [2, 6] as const) {
  for (const viewport of [{ width: 1366, height: 768 }, { width: 390, height: 844 }]) {
    test(`live meld grouping shows totals and valid/invalid counts for ${playerCount} seats at ${viewport.width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await installFixture(page, playerCount);
      await page.goto(`/watch/${gameName}`);
      await expect(page.locator(".watch-player-hand")).toHaveCount(playerCount);
      const hand = page.getByRole("region", { name: "Recorded Player's revealed hand" });
      await expect(hand).toContainText(/recorded/i);
      await expect(hand.locator(".watch-cards img")).toHaveCount(13);
      // Expectations below use fixed rule examples, independent of the grouping implementation.
      await expect(hand).toContainText(/21/);
      await expect(hand).toContainText(/12/);
      await expect(hand).toContainText(/2 valid/i);
      await expect(hand).toContainText(/2 invalid/i);
      const groupBounds = await hand.locator(".watch-meld-heading").evaluateAll(headings => headings.map(heading => {
        const box = heading.getBoundingClientRect();
        const handBox = heading.closest(".watch-player-hand")!.getBoundingClientRect();
        return { left: box.left, right: box.right, handLeft: handBox.left, handRight: handBox.right };
      }));
      expect(groupBounds).toHaveLength(4);
      for (const box of groupBounds) {
        expect(box.left).toBeGreaterThanOrEqual(box.handLeft);
        expect(box.right).toBeLessThanOrEqual(box.handRight);
      }
      await expect(page.getByRole("region", { name: "Model 1's revealed hand" })).toContainText(/suggested grouping/i);
      await page.getByRole("button", { name: "Pause table", exact: true }).click();
      await page.getByRole("button", { name: "Previous move", exact: true }).click();
      await expect(page.locator(".watch-playback")).toContainText("Move 1");
      await expect(hand).toContainText(/24/);
      await page.getByRole("button", { name: "Go to delayed live", exact: true }).click();
      await expect(page.locator(".watch-playback")).toContainText("Move 2");
      const width = await page.evaluate(() => ({ viewport: innerWidth, page: document.documentElement.scrollWidth }));
      expect(width.page).toBeLessThanOrEqual(width.viewport + 1);
      await page.locator(".watch-cards img").evaluateAll(async images => { await Promise.all(images.map(async node => { const image = node as HTMLImageElement; image.loading = "eager"; await image.decode(); })); });
      await page.evaluate(() => scrollTo(0, 0));
      const output = process.env.TRINITY_E2E_SCREENSHOT_DIR;
      const name = `meld-groups-${playerCount}-${viewport.width}.png`;
      const path = output ? join(output, name) : testInfo.outputPath(name);
      await page.screenshot({ path, fullPage: true, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    });
  }
}
