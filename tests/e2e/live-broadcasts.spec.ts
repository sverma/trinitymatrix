import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { BroadcastFrame, LiveBroadcastSummary } from "@trinitymatrix/protocol";

test.skip(process.env.TRINITY_E2E_BROADCASTS !== "true", "Requires the real local broadcast app, PostgreSQL, Redis and private media worker.");

const runId = Date.now();
let sequence = 0;
type Player = { context: BrowserContext; page: Page; name: string; playerId: string };
type Detail = { broadcast: LiveBroadcastSummary; frame: BroadcastFrame | null; comments: Array<{ id: string; message: string; deleted: boolean }>; serverNow: number };

async function player(browser: Browser, label: string): Promise<Player> {
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const page = await context.newPage();
  const id = sequence++;
  const name = `${label} ${id}`;
  await page.goto("/");
  await page.getByLabel("Display name").fill(name);
  await page.getByLabel("Email address").fill(`live-${runId}-${id}@example.test`);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit OTP").fill("123456");
  await page.getByRole("button", { name: "Continue to lobby" }).click();
  await expect(page.getByRole("heading", { name: "Make every meld count." })).toBeVisible();
  const session = await (await context.request.get("/api/session")).json() as { player: { id: string } };
  return { context, page, name, playerId: session.player.id };
}

async function dismissToss(page: Page) {
  const skip = page.getByRole("button", { name: "Skip animation" });
  await skip.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByLabel("Toss result")).toBeHidden({ timeout: 5_000 });
}

async function joinBroadcast(players: Player[], playerCount: 2 | 6) {
  await Promise.all(players.map(async ({ page }) => {
    if (playerCount === 6) await page.getByRole("radio", { name: /6 Full table/ }).check();
    await page.getByRole("checkbox", { name: /Broadcast this match/ }).check();
    await page.getByRole("button", { name: `Find a ${playerCount}-player match` }).click();
  }));
  await Promise.all(players.map(async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Your hand (13)" })).toBeVisible({ timeout: 15_000 });
    await dismissToss(page);
  }));
  const link = players[0]!.page.getByRole("link", { name: "Open spectator view" });
  await players[0]!.page.locator(".broadcast-controls summary").click();
  const path = await link.getAttribute("href");
  expect(path).toMatch(/^\/watch\/[a-z0-9-]+$/);
  return { path: path!, gameName: path!.slice("/watch/".length) };
}

async function detail(page: Page, name: string): Promise<Detail> {
  const response = await page.request.get(`/api/live/${name}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<Detail>;
}

async function noOverflow(page: Page) {
  const size = await page.evaluate(() => ({ width: innerWidth, body: document.body.scrollWidth, root: document.documentElement.scrollWidth }));
  expect(size.body, "revealed hands scroll inside the board, not the page").toBeLessThanOrEqual(size.width + 1);
  expect(size.root).toBeLessThanOrEqual(size.width + 1);
}

async function screenshot(page: Page, info: TestInfo, name: string) {
  await noOverflow(page);
  await info.attach(name, { body: await page.screenshot({ fullPage: true, animations: "disabled" }), contentType: "image/png" });
}

/** Only substitutes the browser's permission source. Recording, encoding and uploads stay real. */
async function installCanvasCapture(page: Page) {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices;
    Object.defineProperty(devices, "getDisplayMedia", { configurable: true, value: async () => {
      const canvas = document.createElement("canvas"); canvas.width = 854; canvas.height = 480;
      const paint = canvas.getContext("2d")!;
      let frame = 0;
      const draw = () => {
        frame += 1;
        paint.fillStyle = frame % 2 ? "#164c64" : "#15526b"; paint.fillRect(0, 0, 854, 480);
        paint.fillStyle = "#ffe29c"; paint.font = "36px sans-serif"; paint.fillText("TrinityMatrix synthetic broadcast", 35, 150);
        paint.fillRect(35 + frame % 500, 210, 80, 80); paint.font = "24px sans-serif"; paint.fillText(String(frame), 35, 360);
      };
      draw(); const timer = window.setInterval(draw, 66);
      const stream = canvas.captureStream(15);
      for (const track of stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(timer); stop(); };
      }
      return stream;
    } });
    Object.defineProperty(devices, "getUserMedia", { configurable: true, value: () => Promise.reject(new Error("This test does not request real camera or microphone hardware.")) });
  });
}

test("live broadcasts enforce a real two-minute release for hands and video, preserve game sessions, and support replay, moderation and withdrawal", async ({ browser, request }, testInfo) => {
  test.setTimeout(300_000);
  const accounts: Player[] = [];
  const extraPages: Page[] = [];
  // All identities and games are created through real authentication and matchmaking below.
  const first = await Promise.all([player(browser, "Broadcast Host"), player(browser, "Broadcast Rival"), player(browser, "Spectator")]);
  accounts.push(...first);
  const [host, rival, spectator] = first as [Player, Player, Player];
  try {
    const document = await request.get("/");
    const permissions = document.headers()["permissions-policy"];
    expect(permissions).toContain("camera=(self)");
    expect(permissions).toContain("microphone=(self)");
    expect(permissions).toContain("display-capture=(self)");
    expect((await request.get("/api/live")).status()).toBe(401);
    const capabilityResponse = await host.page.request.get("/api/live/capabilities");
    expect(await capabilityResponse.json()).toEqual({ enabled: true, videoEnabled: true, delayMs: 120_000 });
    await expect(host.page.getByRole("checkbox", { name: /Broadcast this match/ })).not.toBeChecked();
    await expect(rival.page.getByRole("checkbox", { name: /Broadcast this match/ })).not.toBeChecked();

    // A non-consenting player must never be pulled into the broadcast queue.
    await host.page.getByRole("checkbox", { name: /Broadcast this match/ }).check();
    await Promise.all([host, rival].map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all([host, rival].map(async ({ page }) => {
      await expect(page.getByRole("heading", { name: "Finding your table" })).toBeVisible();
      await expect(page.getByText("1 of 2 players are ready.", { exact: true })).toBeVisible();
    }));
    await expect(host.page.getByText(/Broadcast table · Everyone agrees/)).toBeVisible();
    await expect(rival.page.getByText(/Broadcast table · Everyone agrees/)).toHaveCount(0);
    for (const { page } of [host, rival]) {
      await page.getByRole("button", { name: "Leave queue" }).click();
      await expect(page.getByRole("heading", { name: "Make every meld count." })).toBeVisible();
    }

    await installCanvasCapture(host.page);
    // Init scripts run on navigation; keep the same authenticated session while installing the synthetic source.
    await host.page.reload();
    await expect(host.page.getByRole("heading", { name: "Make every meld count." })).toBeVisible();
    const table = await joinBroadcast([host, rival], 2);
    const sameAccountWatch = await host.context.newPage(); extraPages.push(sameAccountWatch);
    const spectatorWatch = spectator.page;
    let watchSocketCount = 0;
    sameAccountWatch.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") watchSocketCount += 1; });
    spectatorWatch.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/ws") watchSocketCount += 1; });
    await Promise.all([sameAccountWatch.goto(table.path), spectatorWatch.goto(table.path)]);
    await Promise.all([sameAccountWatch, spectatorWatch].map((page) => expect(page.getByRole("heading", { name: "The table is warming up" })).toBeVisible()));
    expect(watchSocketCount).toBe(0);
    await expect(host.page.getByRole("heading", { name: "Game open in another window" })).toHaveCount(0);

    const initial = await detail(spectatorWatch, table.gameName);
    expect(initial.frame).toBeNull(); expect(initial.broadcast.status).toBe("buffering");
    expect((await spectatorWatch.request.get(`/api/live/${table.gameName}/frames/1`)).status()).toBe(404);
    expect(await (await spectatorWatch.request.get(`/api/live/${table.gameName}/timeline`)).json()).toEqual({ frames: [], nextCursor: null });
    const duplicateWatch = await host.context.newPage(); extraPages.push(duplicateWatch);
    await duplicateWatch.goto(table.path);
    await expect(duplicateWatch.getByRole("heading", { name: "The table is warming up" })).toBeVisible();
    await expect.poll(async () => (await detail(spectatorWatch, table.gameName)).broadcast.viewerCount).toBe(2);
    await duplicateWatch.close();

    // A real recorder and FFmpeg ingest receive an animated canvas, never a user's screen or camera.
    const videoStarted = host.page.waitForResponse((response) => response.url().endsWith(`/api/live/${table.gameName}/video/start`) && response.request().method() === "POST");
    await host.page.getByRole("button", { name: "Start video sharing" }).click();
    const video = await (await videoStarted).json() as { id: string; availableAt: number };
    await expect(host.page.getByRole("button", { name: "Stop video sharing" })).toBeVisible();
    const playlistPath = `/api/live/${table.gameName}/video/${video.id}/index.m3u8`;
    const segmentPath = `/api/live/${table.gameName}/video/${video.id}/segments/segment-000000.ts`;
    await expect.poll(async () => {
      const response = await host.page.request.get(`/api/live/${table.gameName}/video`);
      return (await response.json() as { video: { status: string } }).video?.status;
    }, { timeout: 15_000 }).toMatch(/buffering|live/);
    const earlyPlaylist = await spectatorWatch.request.get(playlistPath);
    expect([404, 425, 503]).toContain(earlyPlaylist.status());
    expect(await earlyPlaylist.text()).not.toContain("#EXTM3U");
    expect([404, 425, 503]).toContain((await spectatorWatch.request.get(segmentPath)).status());

    // Opening a spectator tab leaves the original account's game connection usable.
    const active = await host.page.getByRole("button", { name: /Closed deck/ }).isEnabled() ? host : rival;
    await active.page.getByRole("button", { name: /Closed deck/ }).click();
    await expect(active.page.getByRole("heading", { name: "Your hand (14)" })).toBeVisible();
    await active.page.locator(".playing-card").last().click();
    await active.page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(active.page.getByRole("heading", { name: "Your hand (13)" })).toBeVisible();

    const spectatorMessage = `<img src=x onerror="window.__broadcastXss=true"> hello ${runId}`;
    await spectatorWatch.getByLabel("Your spectator message").fill(spectatorMessage);
    await spectatorWatch.getByRole("button", { name: "Send message" }).click();
    await expect(sameAccountWatch.getByText(spectatorMessage, { exact: true })).toBeVisible();
    expect(await sameAccountWatch.evaluate(() => (window as unknown as { __broadcastXss?: boolean }).__broadcastXss)).toBeUndefined();
    const message = sameAccountWatch.locator(".watch-comment-list > li").filter({ hasText: spectatorMessage });
    await message.getByRole("button", { name: "Report", exact: true }).click();
    await message.getByLabel("Reason for report").fill("E2E moderation review");
    await message.getByRole("button", { name: "Submit report" }).click();
    await expect(sameAccountWatch.getByText("Report submitted for review.")).toBeVisible();
    await message.getByRole("button", { name: "Remove", exact: true }).click();
    await message.getByRole("button", { name: "Confirm removal" }).click();
    await expect(spectatorWatch.getByText("Message removed by a moderator.")).toBeVisible();
    const participantMessage = `Participant message released after two minutes ${runId}`;
    await sameAccountWatch.getByLabel("Your spectator message").fill(participantMessage);
    await sameAccountWatch.getByRole("button", { name: "Send message" }).click();
    await expect(sameAccountWatch.getByText(/Message queued/)).toBeVisible();
    await expect(spectatorWatch.getByText(participantMessage, { exact: true })).toHaveCount(0);

    // Finish promptly, so the same real delay also verifies that the outcome stays private.
    await host.page.getByRole("button", { name: "Drop game" }).click();
    await host.page.getByRole("button", { name: "Yes, drop and lose" }).click();
    await expect(host.page.getByRole("heading", { name: "Good game, in three messages" })).toBeVisible({ timeout: 15_000 });
    const stillPrivate = await detail(spectatorWatch, table.gameName);
    expect(stillPrivate.frame).toBeNull(); expect(stillPrivate.broadcast.status).toBe("buffering");
    expect(JSON.stringify(stillPrivate)).not.toContain('"winner"');

    // Start the six-seat broadcast during the same wait, using six fresh consenting humans.
    const sixPlayers = await Promise.all(Array.from({ length: 6 }, (_, index) => player(browser, `Six-seat ${index + 1}`)));
    accounts.push(...sixPlayers);
    const sixTable = await joinBroadcast(sixPlayers, 6);
    const sixWatch = await spectator.context.newPage(); extraPages.push(sixWatch);
    await sixWatch.goto(sixTable.path);
    await expect(sixWatch.getByRole("heading", { name: "The table is warming up" })).toBeVisible();
    await screenshot(spectatorWatch, testInfo, "broadcast-buffering-desktop");

    // This intentionally waits on the actual server and worker clocks. No fake timers or backdated rows.
    await expect.poll(async () => {
      const [two, six] = await Promise.all([detail(spectatorWatch, table.gameName), detail(sixWatch, sixTable.gameName)]);
      return { ended: two.broadcast.status, sixReady: six.frame !== null, comment: two.comments.some((entry) => entry.message === participantMessage), videoStatus: (await spectatorWatch.request.get(playlistPath)).status() };
    }, { timeout: 165_000, intervals: [1_000, 2_000, 3_000], message: "Only physically released hands, outcome, participant comment and HLS can become available after120 seconds" }).toEqual({ ended: "ended", sixReady: true, comment: true, videoStatus: 200 });
    expect(Date.now()).toBeGreaterThanOrEqual(initial.broadcast.availableAt);
    const released = await detail(spectatorWatch, table.gameName);
    expect(released.serverNow - released.frame!.capturedAt).toBeGreaterThanOrEqual(120_000);
    expect(released.frame!.hands).toHaveLength(2);
    expect(released.frame!.hands.every(({ cards }) => cards.length === 13)).toBe(true);
    expect(released.frame!.winner?.id).toBe(rival.playerId);
    const safe = JSON.stringify(released.frame);
    for (const privateField of ["seenCommands", "discardHistory", "agentMemory", "password", "email", '"stock":']) expect(safe).not.toContain(privateField);
    await expect(spectatorWatch.locator(".watch-player-hand")).toHaveCount(2);
    await expect(spectatorWatch.locator(".watch-cards img")).toHaveCount(26);
    await expect(spectatorWatch.locator(".watch-winner")).toContainText(`${rival.name} won.`);
    await expect(spectatorWatch.getByText(participantMessage, { exact: true })).toBeVisible();
    await expect(sixWatch.locator(".watch-player-hand")).toHaveCount(6);
    await expect(sixWatch.locator(".watch-cards img")).toHaveCount(78);

    const playlist = await (await spectatorWatch.request.get(playlistPath)).text();
    expect(playlist).toContain("#EXTM3U");
    const firstSegment = playlist.split(/\r?\n/).find((line) => line.startsWith("segments/"));
    expect(firstSegment).toBeTruthy();
    expect((await spectatorWatch.request.get(new URL(firstSegment!, new URL(playlistPath, spectatorWatch.url())).href)).status()).toBe(200);
    await expect(spectatorWatch.getByLabel("Delayed broadcast video")).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => spectatorWatch.getByLabel("Delayed broadcast video").evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

    await spectatorWatch.getByRole("button", { name: "Pause table", exact: true }).click();
    await spectatorWatch.getByRole("button", { name: "Previous move", exact: true }).click();
    await expect(spectatorWatch.locator(".watch-winner")).toHaveCount(0);
    await expect(spectatorWatch.getByRole("button", { name: "Play recording", exact: true })).toBeVisible();
    await spectatorWatch.getByRole("button", { name: "Go to delayed live", exact: true }).click();
    await expect(spectatorWatch.locator(".watch-winner")).toBeVisible();
    await screenshot(spectatorWatch, testInfo, "broadcast-ended-replay-desktop");
    await screenshot(sixWatch, testInfo, "broadcast-six-seat-desktop");
    await spectatorWatch.setViewportSize({ width: 390, height: 844 });
    await screenshot(spectatorWatch, testInfo, "broadcast-ended-replay-mobile");
    await sixWatch.setViewportSize({ width: 390, height: 844 });
    await screenshot(sixWatch, testInfo, "broadcast-six-seat-mobile");

    // Withdrawal must revoke every native/media watch path while keeping the game playable.
    await sixPlayers[0]!.page.getByRole("button", { name: "Stop table broadcast" }).click();
    await sixPlayers[0]!.page.getByRole("button", { name: "Yes, stop broadcasting" }).click();
    await expect(sixPlayers[0]!.page.getByText("Broadcast sharing stopped. This game continues privately.")).toBeVisible();
    await expect(sixWatch.getByRole("heading", { name: "Broadcast closed" })).toBeVisible({ timeout: 15_000 });
    await expect(sixWatch.locator(".watch-cards img")).toHaveCount(0);
    for (const resource of ["", "/frames/1", "/timeline", "/video"]) expect((await sixWatch.request.get(`/api/live/${sixTable.gameName}${resource}`)).status()).toBe(404);
    await expect(sixPlayers[0]!.page.getByRole("button", { name: "Drop game" })).toBeVisible();
    const directory = await (await spectatorWatch.request.get("/api/live")).json() as { broadcasts: LiveBroadcastSummary[] };
    expect(directory.broadcasts.some(({ gameName }) => gameName === sixTable.gameName)).toBe(false);
    expect(directory.broadcasts.some(({ gameName }) => gameName === table.gameName)).toBe(true);
    expect(watchSocketCount).toBe(0);
  } finally {
    await Promise.allSettled(extraPages.map((page) => page.close()));
    await Promise.allSettled(accounts.map(({ context }) => context.close()));
  }
});
