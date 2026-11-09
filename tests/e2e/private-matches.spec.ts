import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Page
} from "@playwright/test";

const runId = Date.now();
let accountSequence = 0;

type Orientation = "portrait" | "landscape";

type PlayerSession = {
  context: BrowserContext;
  page: Page;
  email: string;
  displayName: string;
  playerId: string;
};

type RankingSnapshot = null | {
  rating: number;
  wins: number;
  gamesPlayed: number;
};

type PrivateRoomProjection = {
  roomCode: string;
  invites: Array<{
    seatNumber: number;
    email?: string;
    status: "pending" | "accepted";
  }>;
};

function mobileOptions(orientation: Orientation): BrowserContextOptions {
  const viewport = orientation === "portrait"
    ? { width: 390, height: 844 }
    : { width: 844, height: 390 };
  return {
    viewport,
    screen: viewport,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata"
  };
}

async function authenticatedPlayer(
  browser: Browser,
  label: string,
  options: BrowserContextOptions = {}
): Promise<PlayerSession> {
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const sequence = accountSequence++;
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const email = `${slug}-${runId}-${sequence}@example.test`;
  const displayName = `${label} ${sequence}`.slice(0, 24);

  await page.goto("/");
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit OTP").fill("123456");
  await page.getByRole("button", { name: "Continue to lobby" }).click();
  await expect(page.getByRole("heading", { name: "Choose your table" })).toBeVisible();

  const playerId = await page.evaluate(async () => {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    const body = await response.json() as { player?: { id?: string } };
    if (!response.ok || !body.player?.id) throw new Error("Authenticated session did not expose a player ID.");
    return body.player.id;
  });

  return { context, page, email, displayName, playerId };
}

async function closePlayers(players: readonly PlayerSession[]) {
  await Promise.all(players.map(({ context }) => context.close()));
}

async function verifyAccessibleWithoutPageOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  expect(dimensions.bodyWidth, "body must not create page-level horizontal scrolling")
    .toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.documentWidth, "document must not create page-level horizontal scrolling")
    .toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);
}

async function rankingSnapshot({ page, playerId }: PlayerSession): Promise<RankingSnapshot> {
  return page.evaluate(async (id) => {
    const response = await fetch("/api/rankings", { credentials: "same-origin", cache: "no-store" });
    const body = await response.json() as {
      rankings?: Array<{ playerId: string; rating: number; wins: number; gamesPlayed: number }>;
    };
    if (!response.ok) throw new Error("Could not capture the ranking baseline.");
    const entry = body.rankings?.find(({ playerId: candidate }) => candidate === id);
    return entry
      ? { rating: entry.rating, wins: entry.wins, gamesPlayed: entry.gamesPlayed }
      : null;
  }, playerId);
}

async function privateRoomProjection(page: Page, roomCode: string): Promise<PrivateRoomProjection> {
  return page.evaluate(async (code) => {
    const response = await fetch(`/api/private-matches/${encodeURIComponent(code)}`, {
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Could not read authorized private room (${response.status}).`);
    const body = await response.json() as { room: PrivateRoomProjection };
    return body.room;
  }, roomCode);
}

async function dismissToss(page: Page) {
  const skip = page.getByRole("button", { name: "Skip animation" });
  await skip.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByLabel("Toss result")).toBeHidden({ timeout: 5_000 });
}

async function createPrivateTable(creator: PlayerSession, playerCount: 2 | 6, emails: readonly string[]) {
  await creator.page.getByRole("button", { name: /Private table.*Invite-only/i }).click();
  if (playerCount === 6) await creator.page.getByRole("radio", { name: /Five friends/i }).check();
  for (const [index, email] of emails.entries()) {
    await creator.page.getByRole("textbox", { name: `Invite ${index + 1} email` }).fill(email);
  }
  await creator.page.getByRole("button", { name: `Create ${playerCount}-player private table` }).click();
  await expect(creator.page.getByRole("heading", { name: "Waiting for invited players" })).toBeVisible({ timeout: 10_000 });
  await expect(creator.page.getByText(`Private · Unranked · ${playerCount} players`, { exact: true })).toBeVisible();
  return (await creator.page.locator(".private-room-code code").innerText()).trim();
}

async function acceptInvitation(player: PlayerSession) {
  await expect(player.page.getByRole("heading", { name: "Private tables waiting for you" }))
    .toBeVisible({ timeout: 15_000 });
  await player.page.getByRole("button", { name: "Accept invitation" }).click();
}

async function dropFromGame(player: PlayerSession) {
  await player.page.getByRole("button", { name: "Drop game" }).click();
  await expect(player.page.getByRole("dialog", { name: "Drop this game?" })).toBeVisible();
  await player.page.getByRole("button", { name: "Yes, drop and lose" }).click();
}

async function expectPrivateHistoryAndReplay(player: PlayerSession) {
  await expect(player.page.getByText("Completed game · Private · Unranked", { exact: true }))
    .toBeVisible({ timeout: 20_000 });
  await expect(player.page.getByRole("heading", { name: "Good game, in three messages" })).toBeVisible();
  await player.page.getByRole("button", { name: "Back to match history" }).click();
  await expect(player.page.getByRole("heading", { name: "Match history" })).toBeVisible();
  const historyCard = player.page.locator(".history-card").first();
  await expect(historyCard).toContainText("Private · Unranked");
  await historyCard.getByRole("button", { name: "Replay and chat" }).click();
  await expect(player.page.getByText("Completed game · Private · Unranked", { exact: true })).toBeVisible();
  await expect(player.page.getByText(/Event 1 of \d+/)).toBeVisible();
}

test("two invited mobile players complete a private unranked table without changing rankings", async ({ browser }) => {
  test.setTimeout(120_000);
  const creator = await authenticatedPlayer(browser, "Private Creator", mobileOptions("portrait"));
  const invitee = await authenticatedPlayer(browser, "Private Invitee", mobileOptions("landscape"));
  const outsider = await authenticatedPlayer(browser, "Private Outsider");
  const players = [creator, invitee, outsider];

  try {
    await Promise.all([verifyAccessibleWithoutPageOverflow(creator.page), verifyAccessibleWithoutPageOverflow(invitee.page)]);
    const rankingBefore = await Promise.all([rankingSnapshot(creator), rankingSnapshot(invitee)]);
    const roomCode = await createPrivateTable(creator, 2, [invitee.email]);
    await verifyAccessibleWithoutPageOverflow(creator.page);

    const creatorRoom = await privateRoomProjection(creator.page, roomCode);
    expect(creatorRoom.invites).toEqual([
      expect.objectContaining({ seatNumber: 1, email: invitee.email, status: "pending" })
    ]);

    const outsiderResult = await outsider.page.evaluate(async (code) => {
      const response = await fetch(`/api/private-matches/${encodeURIComponent(code)}`, {
        credentials: "same-origin",
        cache: "no-store"
      });
      return { status: response.status, body: await response.json() as { error?: string } };
    }, roomCode);
    expect(outsiderResult).toEqual({
      status: 404,
      body: { error: "The private invitation was not found." }
    });
    expect(JSON.stringify(outsiderResult)).not.toContain(invitee.email);
    expect(JSON.stringify(outsiderResult)).not.toContain(creator.email);

    await expect(invitee.page.getByRole("heading", { name: "Private tables waiting for you" }))
      .toBeVisible({ timeout: 15_000 });
    await expect(invitee.page.locator("main")).not.toContainText(creator.email);
    const inviteeRoom = await privateRoomProjection(invitee.page, roomCode);
    expect(inviteeRoom.invites).toEqual([
      expect.objectContaining({ seatNumber: 1, email: invitee.email, status: "pending" })
    ]);

    await acceptInvitation(invitee);
    await Promise.all([creator, invitee].map(({ page }) =>
      expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible({ timeout: 20_000 })
    ));
    await Promise.all([dismissToss(creator.page), dismissToss(invitee.page)]);
    const tableIds = await Promise.all([creator, invitee].map(({ page }) => page.locator(".game-header strong").innerText()));
    expect(new Set(tableIds).size, "both invite-only sessions must enter the same table").toBe(1);
    await Promise.all([creator, invitee].map(({ page }) =>
      expect(page.locator(".game-header .eyebrow")).toHaveText("Private · unranked · 2 players")
    ));
    await expect(invitee.page.getByText("Private · unranked · 2 players", { exact: true })).toBeVisible();

    await dropFromGame(invitee);
    await expect(creator.page.getByRole("dialog", { name: "You won!" }))
      .toContainText("Another player dropped", { timeout: 20_000 });
    await creator.page.getByRole("button", { name: "Replay and chat" }).click();

    await Promise.all([expectPrivateHistoryAndReplay(creator), expectPrivateHistoryAndReplay(invitee)]);
    const rankingAfter = await Promise.all([rankingSnapshot(creator), rankingSnapshot(invitee)]);
    expect(rankingAfter, "a private game must not create or mutate ranked statistics").toEqual(rankingBefore);
  } finally {
    await closePlayers(players);
  }
});

test("six exact invitees privately fill one table while other pending seats stay anonymous", async ({ browser }) => {
  test.setTimeout(180_000);
  const creator = await authenticatedPlayer(browser, "Six Seat Creator", mobileOptions("portrait"));
  const invitees: PlayerSession[] = [];
  for (let index = 0; index < 5; index += 1) {
    invitees.push(await authenticatedPlayer(
      browser,
      `Six Seat Guest ${index + 1}`,
      index === 0 ? mobileOptions("landscape") : {}
    ));
  }
  const players = [creator, ...invitees];

  try {
    await verifyAccessibleWithoutPageOverflow(creator.page);
    const roomCode = await createPrivateTable(creator, 6, invitees.map(({ email }) => email));
    await verifyAccessibleWithoutPageOverflow(creator.page);

    for (const invitee of invitees) {
      await expect(invitee.page.getByRole("heading", { name: "Private tables waiting for you" }))
        .toBeVisible({ timeout: 15_000 });
      const projection = await privateRoomProjection(invitee.page, roomCode);
      expect(projection.invites.find(({ email }) => email === invitee.email), "invitee must see their own reserved email")
        .toBeDefined();
      const visibleEmails = projection.invites.flatMap(({ email }) => email ? [email] : []);
      expect(visibleEmails, "invitees must not receive other guests' email addresses").toEqual([invitee.email]);
      for (const other of invitees.filter(({ email }) => email !== invitee.email)) {
        expect(JSON.stringify(projection)).not.toContain(other.email);
      }
    }

    for (const [index, invitee] of invitees.entries()) {
      await acceptInvitation(invitee);
      if (index < invitees.length - 1) {
        await expect(invitee.page.getByRole("heading", { name: "Waiting for invited players" })).toBeVisible();
        const seats = invitee.page.getByRole("list", { name: "Private table seats" });
        await expect(seats).toContainText(invitee.email);
        for (const other of invitees.filter(({ email }) => email !== invitee.email)) {
          await expect(seats).not.toContainText(other.email);
        }
        await expect(seats.getByText(/Invited player \d/).first()).toBeVisible();
        if (index === 0) await verifyAccessibleWithoutPageOverflow(invitee.page);
      }
    }

    await Promise.all(players.map(({ page }) =>
      expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible({ timeout: 25_000 })
    ));
    await Promise.all(players.map(({ page }) => dismissToss(page)));
    const tableIds = await Promise.all(players.map(({ page }) => page.locator(".game-header strong").innerText()));
    expect(new Set(tableIds).size, "all six invited sessions must enter one private table").toBe(1);
    await Promise.all(players.map(({ page }) =>
      expect(page.locator(".game-header .eyebrow")).toHaveText("Private · unranked · 6 players")
    ));
    await expect(invitees[0]!.page.getByText("Private · unranked · 6 players", { exact: true })).toBeVisible();

    const winner = creator;
    for (const [index, dropper] of invitees.entries()) {
      await dropFromGame(dropper);
      await expect(dropper.page.locator("main.game-shell")).toHaveCount(0, { timeout: 15_000 });
      if (index < invitees.length - 1) {
        const observer = invitees[index + 1]!;
        await expect(observer.page.locator(".opponent-list li").filter({ hasText: dropper.displayName }))
          .toContainText("Dropped", { timeout: 10_000 });
      }
    }

    await expect(winner.page.getByRole("dialog", { name: "You won!" }))
      .toContainText("the last active player won", { timeout: 20_000 });
    await winner.page.getByRole("button", { name: "Replay and chat" }).click();
    await expect(winner.page.getByText("Completed game · Private · Unranked", { exact: true })).toBeVisible({ timeout: 20_000 });
    await winner.page.getByRole("button", { name: "Back to match history" }).click();
    await expect(winner.page.locator(".history-card").first()).toContainText("Private · Unranked · 6 players");
  } finally {
    await closePlayers(players);
  }
});
