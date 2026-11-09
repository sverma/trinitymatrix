import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type TestInfo } from "@playwright/test";

const runId = Date.now();
let accountSequence = 0;

async function authenticatedPlayer(browser: Browser, index: number): Promise<{ context: BrowserContext; page: Page; email: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const email = `player${index}-${runId}-${accountSequence++}@example.test`;
  await page.goto("/");
  await page.getByLabel("Display name").fill(`Player ${index}`);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit OTP").fill("123456");
  await page.getByRole("button", { name: "Continue to lobby" }).click();
  await expect(page.getByRole("heading", { name: "Make every meld count." })).toBeVisible();
  return { context, page, email };
}

async function closePlayers(players: Array<{ context: BrowserContext }>) {
  await Promise.all(players.map(({ context }) => context.close()));
}

type MobilePlayer = {
  context: BrowserContext;
  page: Page;
  email: string;
  displayName: string;
  orientation: "portrait" | "landscape";
};

async function authenticatedMobilePlayer(
  browser: Browser,
  orientation: MobilePlayer["orientation"]
): Promise<MobilePlayer> {
  const viewport = orientation === "portrait"
    ? { width: 390, height: 844 }
    : { width: 844, height: 390 };
  const options: BrowserContextOptions = {
    viewport,
    screen: viewport,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata"
  };
  const context = await browser.newContext(options);
  const page = await context.newPage();
  const identity = `${runId}-${accountSequence++}`;
  const displayName = orientation === "portrait" ? "Portrait Player" : "Landscape Player";
  const email = `mobile-${orientation}-${identity}@example.test`;

  await page.goto("/");
  await page.getByLabel("Display name").fill(displayName);
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit OTP").fill("123456");
  await page.getByRole("button", { name: "Continue to lobby" }).click();
  await expect(page.getByRole("heading", { name: "Make every meld count." })).toBeVisible();

  return { context, page, email, displayName, orientation };
}

async function dismissToss(page: Page) {
  const skip = page.getByRole("button", { name: "Skip animation" });
  await skip.waitFor({ state: "visible", timeout: 2_000 }).catch(() => undefined);
  if (await skip.isVisible()) await skip.click();
  await expect(page.getByLabel("Toss result")).toBeHidden({ timeout: 5_000 });
}

async function verifyMobilePage(page: Page) {
  const dimensions = await page.evaluate(() => ({
    bodyWidth: document.body.scrollWidth,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  expect(dimensions.bodyWidth, "body must not create page-level horizontal scrolling").toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  expect(dimensions.documentWidth, "document must not create page-level horizontal scrolling").toBeLessThanOrEqual(dimensions.viewportWidth + 1);

  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  expect(accessibility.violations, JSON.stringify(accessibility.violations, null, 2)).toEqual([]);
}

async function verifyMeldStatusIsNotColorOnly(page: Page) {
  const statuses = page.locator(".hand-group .meld-status");
  await expect(statuses.first()).toBeVisible();
  const labels = (await statuses.allTextContents()).map((label) => label.trim());
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.every((label) => /^(Incomplete · need 3\+|Invalid meld|Trinity · 21|Valid · (3|6|9|12|15|18|24|27))$/.test(label)),
    "every colored meld marker must also carry an explicit visible status label").toBe(true);
}

async function verifyGameplayGeometry(page: Page) {
  const header = await page.locator(".game-header").boundingBox();
  const opponent = await page.locator(".opponent-list li").first().boundingBox();
  expect(header).not.toBeNull();
  expect(opponent).not.toBeNull();
  expect(opponent!.y, "opponent identity must start below the game header").toBeGreaterThanOrEqual(header!.y + header!.height - 1);

  for (const selector of [".sound-toggle", ".drop-game-button"]) {
    const target = await page.locator(selector).boundingBox();
    expect(target, `${selector} must be visible`).not.toBeNull();
    expect(target!.width, `${selector} must be at least 44 CSS pixels wide`).toBeGreaterThanOrEqual(44);
    expect(target!.height, `${selector} must be at least 44 CSS pixels high`).toBeGreaterThanOrEqual(44);
  }

  const cards = page.locator(".hand-group").first().locator(".playing-card");
  if (await cards.count() > 1) {
    const first = await cards.nth(0).boundingBox();
    const second = await cards.nth(1).boundingBox();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(Math.abs(second!.x - first!.x), "overlapped cards must expose a reliable touch strip").toBeGreaterThanOrEqual(40);
  }
}

async function attachMobileScreenshots(testInfo: TestInfo, players: MobilePlayer[], state: string) {
  await Promise.all(players.map(async ({ page, orientation }) => {
    await testInfo.attach(`${orientation}-${state}`, {
      body: await page.screenshot({ animations: "disabled" }),
      contentType: "image/png"
    });
  }));
}

test("two isolated mobile players complete a portrait-to-landscape match journey", async ({ browser }, testInfo) => {
  test.setTimeout(120_000);
  const players = await Promise.all([
    authenticatedMobilePlayer(browser, "portrait"),
    authenticatedMobilePlayer(browser, "landscape")
  ]);

  try {
    expect(players[0]!.email).not.toBe(players[1]!.email);
    await Promise.all(players.map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible({ timeout: 15_000 })));
    await Promise.all(players.map(({ page }) => dismissToss(page)));

    const tableIds = await Promise.all(players.map(({ page }) => page.locator(".game-header strong").innerText()));
    expect(new Set(tableIds).size, "both isolated sessions must join the same table").toBe(1);
    await Promise.all(players.map(async ({ page }) => {
      await verifyMeldStatusIsNotColorOnly(page);
      await verifyGameplayGeometry(page);
      await verifyMobilePage(page);
    }));
    await attachMobileScreenshots(testInfo, players, "matched-table");

    await expect.poll(async () => {
      const enabled = await Promise.all(players.map(({ page }) => page.getByRole("button", { name: /Closed deck/ }).isEnabled()));
      return enabled.filter(Boolean).length;
    }, { message: "exactly one player should own the turn", timeout: 10_000 }).toBe(1);

    const activeIndex = (await players[0]!.page.getByRole("button", { name: /Closed deck/ }).isEnabled()) ? 0 : 1;
    const active = players[activeIndex]!;
    const waiting = players[activeIndex === 0 ? 1 : 0]!;
    await active.page.getByRole("button", { name: /Closed deck/ }).click();
    await expect(active.page.getByRole("heading", { name: /Your hand \(14\)/ })).toBeVisible();
    const discardCard = active.page.locator(".playing-card").last();
    await discardCard.click();
    await expect(discardCard).toHaveAttribute("aria-pressed", "true");
    await active.page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(active.page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible();
    await expect(waiting.page.getByText("Your turn", { exact: true })).toBeVisible({ timeout: 10_000 });

    await Promise.all(players.map(({ page }) => verifyMobilePage(page)));
    await attachMobileScreenshots(testInfo, players, "after-draw-discard");

    const dropper = players[0]!;
    const winner = players[1]!;
    await dropper.page.getByRole("button", { name: "Drop game" }).click();
    await expect(dropper.page.getByRole("dialog", { name: "Drop this game?" }))
      .toContainText(`${winner.displayName} will win immediately`);
    await dropper.page.getByRole("button", { name: "Yes, drop and lose" }).click();

    await expect(dropper.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 20_000 });
    await expect(winner.page.getByRole("dialog", { name: "You won!" }))
      .toContainText("Another player dropped", { timeout: 20_000 });
    await winner.page.getByRole("button", { name: "Replay and chat" }).click();
    await expect(winner.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 20_000 });

    await Promise.all(players.map(async ({ page }) => {
      await expect(page.getByText(/Event 1 of \d+/)).toBeVisible();
      await expect(page.locator(".replay-card").first()).toBeVisible();
      await verifyMobilePage(page);
    }));
    await attachMobileScreenshots(testInfo, players, "replay-and-chat");

    await Promise.all(players.map(async ({ page }) => {
      await page.getByRole("button", { name: "Back to match history" }).click();
      await expect(page.getByRole("heading", { name: "Match history" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Replay and chat" }).first()).toBeVisible();
      await verifyMobilePage(page);
    }));
    await attachMobileScreenshots(testInfo, players, "match-history");
  } finally {
    await closePlayers(players);
  }
});

test("two human players match and complete a draw-discard turn", async ({ browser }) => {
  const players = await Promise.all([authenticatedPlayer(browser, 1), authenticatedPlayer(browser, 2)]);
  try {
    await Promise.all(players.map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand/ })).toBeVisible()));
    await Promise.all(players.map(async ({ page }) => {
      const skip = page.getByRole("button", { name: "Skip animation" });
      if (await skip.isVisible()) await skip.click();
    }));
    const tableIds = await Promise.all(players.map(({ page }) => page.locator(".game-header strong").innerText()));
    expect(new Set(tableIds).size).toBe(1);

    const active = (await players[0]!.page.getByRole("button", { name: /Closed deck/ }).isEnabled()) ? players[0]! : players[1]!;
    await active.page.getByRole("button", { name: /Closed deck/ }).click();
    await expect(active.page.getByRole("heading", { name: /Your hand \(14\)/ })).toBeVisible();
    await active.page.getByRole("button", { name: "Sort by suit" }).click();
    await active.page.locator(".playing-card").last().click();
    await active.page.getByRole("button", { name: "Show selected" }).click();
    await expect(active.page.getByRole("dialog", { name: /use this as your final discard/i })).toBeVisible();
    await active.page.getByRole("button", { name: "Yes, prepare show" }).click();
    await active.page.getByRole("button", { name: "Cancel show" }).click();
    await active.page.locator(".playing-card").last().click();
    await active.page.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(active.page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible();

    const accessibility = await new AxeBuilder({ page: active.page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await closePlayers(players);
  }
});

test("a player can drop, concede the round, and open the replay", async ({ browser }) => {
  const players = await Promise.all([authenticatedPlayer(browser, 30), authenticatedPlayer(browser, 31)]);
  try {
    await Promise.all(players.map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand/ })).toBeVisible()));
    await Promise.all(players.map(async ({ page }) => {
      const skip = page.getByRole("button", { name: "Skip animation" });
      if (await skip.isVisible()) await skip.click();
    }));

    await players[0]!.page.getByRole("button", { name: "Drop game" }).click();
    await expect(players[0]!.page.getByRole("dialog", { name: "Drop this game?" })).toContainText("Player 31 will win immediately");
    await players[0]!.page.getByRole("button", { name: "Yes, drop and lose" }).click();

    await expect(players[0]!.page.getByRole("heading", { name: "Good game, in three messages" })).toBeVisible();
    await expect(players[1]!.page.getByRole("dialog", { name: "You won!" })).toContainText("Another player dropped");
    await players[1]!.page.getByRole("button", { name: "Replay and chat" }).click();
    await expect(players[1]!.page.getByRole("heading", { name: "Good game, in three messages" })).toBeVisible();

    const winner = players[1]!.page;
    await expect(winner.getByText(/Event 1 of \d+/)).toBeVisible();
    await expect(winner.getByLabel("Winner: Player 31")).toBeVisible();
    await expect(winner.locator(".replay-meld").first()).toBeVisible();
    await expect(winner.getByText(/Best meld view reconstructed|Recorded player layout/).first()).toBeVisible();
    await expect(winner.locator(".replay-card").first()).toBeVisible();
    for (const message of ["Good game!", "Well played.", "See you at the next table."]) {
      await winner.getByLabel("Your message").fill(message);
      await winner.getByRole("button", { name: "Send message" }).click();
      await expect(winner.getByLabel("Post-game messages").getByText(message, { exact: true })).toBeVisible();
    }
    await expect(winner.getByRole("button", { name: "Message limit reached" })).toBeDisabled();
  } finally {
    await closePlayers(players);
  }
});

test("six human players complete one isolated match after five sequential drops", async ({ browser }) => {
  const players = await Promise.all(Array.from({ length: 6 }, (_, index) => authenticatedPlayer(browser, index + 10)));
  try {
    await Promise.all(players.map(async ({ page }) => {
      await page.getByRole("radio", { name: /Full table/ }).check();
      await page.getByRole("button", { name: "Find a 6-player match" }).click();
    }));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible({ timeout: 20_000 })));
    const tableIds = await Promise.all(players.map(({ page }) => page.locator(".game-header strong").innerText()));
    expect(new Set(tableIds).size).toBe(1);

    // The heading behind the toss can become visible before the overlay's
    // effect runs. Wait briefly for that effect, dismiss it when present, and
    // always wait for the overlay to stop intercepting controls.
    await Promise.all(players.map(async ({ page }) => {
      const skip = page.getByRole("button", { name: "Skip animation" });
      await skip.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
      if (await skip.isVisible()) await skip.click();
      await expect(page.getByLabel("Toss result")).toBeHidden({ timeout: 5_000 });
    }));

    const droppers = players.slice(0, 5);
    const winner = players[5]!;
    for (const [index, dropper] of droppers.entries()) {
      const playerName = `Player ${index + 10}`;
      const nextActivePlayer = players[index + 1]!;

      await expect(dropper.page.getByRole("button", { name: "Drop game" })).toBeVisible();
      await dropper.page.getByRole("button", { name: "Drop game" }).click();
      await expect(dropper.page.getByRole("dialog", { name: "Drop this game?" }))
        .toContainText("The remaining players will continue");
      await dropper.page.getByRole("button", { name: "Yes, drop and lose" }).click();

      // A dropped client navigates away immediately. Waiting for the table to
      // unmount avoids relying on whether its active-game history request won
      // or lost the race with the final archival transaction.
      await expect(dropper.page.locator("main.game-shell")).toHaveCount(0, { timeout: 15_000 });

      // Observe the authoritative dropped state on the next still-active
      // client before issuing another command, so its expected revision is
      // current and the sequence cannot collapse into concurrent drops.
      if (index < droppers.length - 1) {
        await expect(nextActivePlayer.page.locator(".opponent-list li").filter({ hasText: playerName }))
          .toContainText("Dropped", { timeout: 10_000 });
      }
    }

    await expect(winner.page.getByRole("dialog", { name: "You won!" }))
      .toContainText("the last active player won", { timeout: 20_000 });
    await winner.page.getByRole("button", { name: "Replay and chat" }).click();
    await expect(winner.page.locator("main.game-shell")).toHaveCount(0);
    await expect(winner.page.getByRole("heading", { name: "Good game, in three messages" }))
      .toBeVisible({ timeout: 15_000 });
  } finally {
    await closePlayers(players);
  }
});

test("responsive game table remains usable without page-level horizontal overflow", async ({ browser }) => {
  const players = await Promise.all([authenticatedPlayer(browser, 70), authenticatedPlayer(browser, 71)]);
  try {
    await Promise.all(players.map(({ page }) => page.getByRole("button", { name: "Find a 2-player match" }).click()));
    await Promise.all(players.map(({ page }) => expect(page.getByRole("heading", { name: /Your hand \(13\)/ })).toBeVisible()));
    await Promise.all(players.map(async ({ page }) => {
      const skip = page.getByRole("button", { name: "Skip animation" });
      if (await skip.isVisible()) await skip.click();
    }));

    const page = players[0]!.page;
    await expect(page.getByRole("button", { name: "Sort by suit" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Closed deck/ })).toBeVisible();
    const turnSounds = page.getByRole("button", { name: "Turn sounds" });
    await expect(turnSounds).toHaveAttribute("aria-pressed", "true");
    await turnSounds.click();
    await expect(turnSounds).toHaveAttribute("aria-pressed", "false");
    await turnSounds.click();
    await expect(turnSounds).toHaveAttribute("aria-pressed", "true");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await closePlayers(players);
  }
});

test("responsive lobby remains usable in a narrow viewport", async ({ browser }) => {
  const player = await authenticatedPlayer(browser, 99);
  try {
    await expect(player.page.getByRole("button", { name: "Find a 2-player match" })).toBeVisible();
    const accessibility = await new AxeBuilder({ page: player.page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await player.context.close();
  }
});

test("profile changes persist across a reload", async ({ browser }) => {
  const player = await authenticatedPlayer(browser, 120);
  try {
    await player.page.getByRole("button", { name: "Open profile for Player 120" }).click();
    await expect(player.page.getByRole("dialog", { name: "Make the table yours" })).toBeVisible();
    await player.page.getByLabel("Display name").fill("Player OneTwenty");
    await player.page.getByRole("radio", { name: /Strategist/i }).check();
    await player.page.getByLabel("ISD code").fill("+91");
    await player.page.getByLabel("National number").fill("9876543210");
    await player.page.getByRole("button", { name: "Save profile" }).click();

    await expect(player.page.getByRole("button", { name: "Open profile for Player OneTwenty" })).toContainText("Strategist");
    await player.page.reload();
    await expect(player.page.getByRole("button", { name: "Open profile for Player OneTwenty" })).toContainText("Strategist");
    await player.page.getByRole("button", { name: "Open profile for Player OneTwenty" }).click();
    await expect(player.page.getByLabel("Email address")).toHaveValue(player.email);
    await expect(player.page.getByLabel("ISD code")).toHaveValue("+91");
    await expect(player.page.getByLabel("National number")).toHaveValue("9876543210");
    const accessibility = await new AxeBuilder({ page: player.page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await player.context.close();
  }
});

test("the admin portal requires an allowlisted email and a verified passkey", async ({ browser }) => {
  const adminEmail = process.env.TRINITY_E2E_ADMIN_EMAIL;
  const bootstrapSecret = process.env.TRINITY_E2E_ADMIN_BOOTSTRAP_SECRET;
  test.skip(!adminEmail || !bootstrapSecret,
    "Admin passkey enrollment only runs against an explicitly configured local E2E server.");

  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // Chromium's virtual authenticator performs a real CTAP2/WebAuthn ceremony;
    // the application server still verifies origin, RP ID, challenge, UV,
    // attestation and the generated assertion instead of accepting a stub DTO.
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true
      }
    });

    await page.goto("/admin");
    await page.getByLabel("Display name").fill("E2E Admin");
    await page.getByLabel("Email address").fill(adminEmail!);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.getByLabel("Six-digit OTP").fill("123456");
    await page.getByRole("button", { name: "Continue to lobby" }).click();
    await expect(page.getByRole("heading", { name: "Create your administrator passkey" })).toBeVisible();
    await page.getByLabel("Device label").fill("Playwright virtual authenticator");
    await page.getByLabel("One-time bootstrap code").fill(bootstrapSecret!);
    await page.getByRole("button", { name: "Create passkey" }).click();

    await expect(page.getByRole("heading", { name: "Save your recovery codes" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Administrator recovery codes" }).getByRole("listitem"))
      .toHaveCount(10);
    await page.getByRole("button", { name: "I stored these codes safely" }).click();
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await page.getByRole("button", { name: "users" }).click();
    await expect(page.getByRole("table", { name: "Registered player accounts" })).toBeVisible();
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    expect(accessibility.violations).toEqual([]);
  } finally {
    await context.close();
  }
});
