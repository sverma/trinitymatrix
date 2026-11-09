import { devices, expect, test, type Browser, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

const runId = Date.now();

type Player = {
  context: BrowserContext;
  page: Page;
  displayName: string;
  email: string;
};

type ControlledMobilePlayer = Player & {
  makeSocketStale: () => Promise<void>;
  socketRouteCount: () => number;
};

async function authenticateOnPage(page: Page, playerNumber: number) {
  const displayName = `Chat Player ${playerNumber}`;
  const email = `chat-player-${playerNumber}-${runId}@example.test`;

  await page.goto("/");
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit OTP").fill("123456");
  await page.getByRole("button", { name: "Continue to lobby" }).click();
  await expect(page.getByRole("heading", { name: "Make every meld count." })).toBeVisible();

  return { displayName, email };
}

async function authenticatePlayer(browser: Browser, playerNumber: number): Promise<Player> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { displayName, email } = await authenticateOnPage(page, playerNumber);

  return { context, page, displayName, email };
}

async function authenticateControlledMobilePlayer(browser: Browser, playerNumber: number): Promise<ControlledMobilePlayer> {
  const context = await browser.newContext({ ...devices["Pixel 7"] });
  const page = await context.newPage();
  let socketToStale: WebSocketRoute | null = null;
  let dropStaleSocketFrames = false;
  let socketRoutes = 0;

  await page.routeWebSocket(/\/ws$/, (socket) => {
    socketRoutes += 1;
    if (socketToStale === null) socketToStale = socket;
    const server = socket.connectToServer();
    server.onMessage((message) => {
      if (socket === socketToStale && dropStaleSocketFrames) return;
      socket.send(message);
    });
  });

  const { displayName, email } = await authenticateOnPage(page, playerNumber);

  return {
    context,
    page,
    displayName,
    email,
    socketRouteCount: () => socketRoutes,
    makeSocketStale: async () => {
      await expect.poll(() => socketToStale !== null, {
        message: "the receiver should have an authenticated socket before it becomes stale"
      }).toBe(true);
      dropStaleSocketFrames = true;
    }
  };
}

async function dismissToss(page: Page) {
  const skip = page.getByRole("button", { name: "Skip animation" });
  await skip.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByLabel("Toss result")).toBeHidden({ timeout: 5_000 });
}

function chatMessage(page: Page, message: string) {
  return page.getByRole("list", { name: "Post-game messages" }).getByRole("listitem").filter({
    has: page.getByText(message, { exact: true })
  });
}

async function expectMessageWithTimestamp(page: Page, message: string, author: string, timeout = 5_000) {
  const item = chatMessage(page, message);
  await expect(item, `message \"${message}\" should appear exactly once`).toHaveCount(1, { timeout });
  await expect(item.getByText(author, { exact: true })).toBeVisible();

  const timestamp = item.locator("time");
  await expect(timestamp).toBeVisible();
  await expect(timestamp).not.toHaveText("Time unavailable");
  const machineTime = await timestamp.getAttribute("datetime");
  expect(machineTime, "chat timestamp should include a machine-readable datetime").toBeTruthy();
  expect(Number.isNaN(Date.parse(machineTime!)), `chat timestamp should be valid ISO time: ${machineTime}`).toBe(false);
}

async function sendMessage(page: Page, message: string) {
  await page.getByLabel("Your message").fill(message);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Message sent." })).toBeVisible();
}

test("post-game chat is delivered live between two isolated players without duplicates", async ({ browser }) => {
  test.setTimeout(90_000);
  const players = await Promise.all([
    authenticatePlayer(browser, 1),
    authenticatePlayer(browser, 2)
  ]);

  try {
    expect(players[0]!.email).not.toBe(players[1]!.email);
    await Promise.all(players.map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible({ timeout: 15_000 })));
    await Promise.all(players.map(({ page }) => dismissToss(page)));

    const tableIds = await Promise.all(players.map(({ page }) => page.locator(".game-header strong").innerText()));
    expect(new Set(tableIds).size, "the isolated sessions should share one two-player table").toBe(1);

    const dropper = players[0]!;
    const winner = players[1]!;
    await dropper.page.getByRole("button", { name: "Drop game" }).click();
    await expect(dropper.page.getByRole("dialog", { name: "Drop this game?" }))
      .toContainText(`${winner.displayName} will win immediately`);
    await dropper.page.getByRole("button", { name: "Yes, drop and lose" }).click();

    await expect(dropper.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 20_000 });
    await expect(winner.page.getByRole("dialog", { name: "You won!" })).toBeVisible({ timeout: 20_000 });
    await winner.page.getByRole("button", { name: "Replay and chat" }).click();
    await expect(winner.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 20_000 });

    const replayUrls = await Promise.all(players.map(({ page }) => page.url()));
    const pageOrigins = await Promise.all(players.map(({ page }) => page.evaluate(() => performance.timeOrigin)));
    const firstMessage = `Live hello ${runId}`;
    const reply = `Live reply ${runId}`;

    await sendMessage(dropper.page, firstMessage);
    await expectMessageWithTimestamp(dropper.page, firstMessage, dropper.displayName);
    await expectMessageWithTimestamp(winner.page, firstMessage, dropper.displayName);

    await sendMessage(winner.page, reply);
    await expectMessageWithTimestamp(winner.page, reply, winner.displayName);
    await expectMessageWithTimestamp(dropper.page, reply, winner.displayName);

    for (const [index, { page }] of players.entries()) {
      await expect(chatMessage(page, firstMessage), "first message must not be duplicated").toHaveCount(1);
      await expect(chatMessage(page, reply), "reply must not be duplicated").toHaveCount(1);
      await expect(page.getByRole("list", { name: "Post-game messages" }).getByRole("listitem")).toHaveCount(2);
      expect(page.url(), "live delivery must not require history navigation").toBe(replayUrls[index]);
      expect(await page.evaluate(() => performance.timeOrigin), "live delivery must not reload the page").toBe(pageOrigins[index]);
      await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
    }
  } finally {
    await Promise.all(players.map(({ context }) => context.close()));
  }
});

test("mobile chat reconciles messages missed during a stale WebSocket without navigation", async ({ browser }) => {
  test.setTimeout(120_000);
  const sender = await authenticatePlayer(browser, 10);
  const receiver = await authenticateControlledMobilePlayer(browser, 11);
  const players = [sender, receiver];

  try {
    expect(sender.email).not.toBe(receiver.email);
    await Promise.all(players.map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible({ timeout: 15_000 })));
    await Promise.all(players.map(({ page }) => dismissToss(page)));

    await sender.page.getByRole("button", { name: "Drop game" }).click();
    await expect(sender.page.getByRole("dialog", { name: "Drop this game?" }))
      .toContainText(`${receiver.displayName} will win immediately`);
    await sender.page.getByRole("button", { name: "Yes, drop and lose" }).click();

    await expect(sender.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 20_000 });
    await expect(receiver.page.getByRole("dialog", { name: "You won!" })).toBeVisible({ timeout: 20_000 });
    await receiver.page.getByRole("button", { name: "Replay and chat" }).click();
    await expect(receiver.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 20_000 });

    const receiverUrl = receiver.page.url();
    const receiverTimeOrigin = await receiver.page.evaluate(() => performance.timeOrigin);
    const initialSocketRoutes = receiver.socketRouteCount();
    await receiver.page.bringToFront();
    expect(await receiver.page.evaluate(() => document.visibilityState),
      "the mobile receiver must be visible so heartbeat recovery remains active").toBe("visible");
    await receiver.makeSocketStale();
    expect(receiver.socketRouteCount()).toBe(initialSocketRoutes);
    expect(await receiver.page.evaluate(async () => (await fetch("/readyz")).status),
      "HTTP should stay usable while the receiver WebSocket is stale").toBe(200);

    const firstMissed = `Missed one ${runId}`;
    const secondMissed = `Missed two ${runId}`;
    const liveReply = `Recovered reply ${runId}`;
    await sendMessage(sender.page, firstMissed);
    await sendMessage(sender.page, secondMissed);
    await expectMessageWithTimestamp(sender.page, firstMissed, sender.displayName);
    await expectMessageWithTimestamp(sender.page, secondMissed, sender.displayName);
    await expect(chatMessage(receiver.page, firstMissed), "stale receiver should miss the first socket event").toHaveCount(0);
    await expect(chatMessage(receiver.page, secondMissed), "stale receiver should miss the second socket event").toHaveCount(0);

    await expect.poll(() => receiver.socketRouteCount(), {
      message: "the mobile client should retire its half-open socket and reconnect automatically",
      timeout: 45_000
    }).toBeGreaterThan(initialSocketRoutes);
    await expectMessageWithTimestamp(receiver.page, firstMissed, sender.displayName, 45_000);
    await expectMessageWithTimestamp(receiver.page, secondMissed, sender.displayName, 45_000);

    await sendMessage(receiver.page, liveReply);
    await expectMessageWithTimestamp(receiver.page, liveReply, receiver.displayName);
    await expectMessageWithTimestamp(sender.page, liveReply, receiver.displayName);

    for (const { page } of players) {
      await expect(chatMessage(page, firstMissed), "first reconciled message must not be duplicated").toHaveCount(1);
      await expect(chatMessage(page, secondMissed), "second reconciled message must not be duplicated").toHaveCount(1);
      await expect(chatMessage(page, liveReply), "reverse live reply must not be duplicated").toHaveCount(1);
      await expect(page.getByRole("list", { name: "Post-game messages" }).getByRole("listitem")).toHaveCount(3);
      await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
    }
    expect(receiver.page.url(), "socket recovery must not require history navigation").toBe(receiverUrl);
    expect(await receiver.page.evaluate(() => performance.timeOrigin), "socket recovery must not reload the page")
      .toBe(receiverTimeOrigin);
  } finally {
    await Promise.all(players.map(({ context }) => context.close()));
  }
});
