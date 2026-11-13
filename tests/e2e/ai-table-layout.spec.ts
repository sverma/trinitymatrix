import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { installAiTableFixture } from "./fixtures/ai-table";

async function bounds(locator: Locator) {
  await expect(locator).toBeVisible();
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

async function noPageHorizontalOverflow(page: Page) {
  const sizes = await page.evaluate(() => ({ viewport: innerWidth, body: document.body.scrollWidth, document: document.documentElement.scrollWidth }));
  expect(sizes.body, "the hand may scroll internally, but the page must not scroll sideways").toBeLessThanOrEqual(sizes.viewport + 1);
  expect(sizes.document, "the document must stay within the viewport width").toBeLessThanOrEqual(sizes.viewport + 1);
}

async function fullyVisibleAndUncovered(page: Page, target: Locator) {
  await expect(target).toBeInViewport({ ratio: 1 });
  const box = await bounds(target);
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return hit === element || element.contains(hit);
  }), "the control's centre must not be covered by another game region").toBe(true);
}

async function separatedGameRegions(page: Page) {
  const header = await bounds(page.locator(".game-header"));
  const metadata = await bounds(page.locator(".ai-table-models"));
  expect(metadata.y, "model details must sit below the header rather than behind it").toBeGreaterThanOrEqual(header.y + header.height - 1);
  const deck = await bounds(page.locator(".deck-zone"));
  const hand = await bounds(page.locator(".player-area"));
  expect(deck.y, "the deck must sit below expanded model metadata").toBeGreaterThanOrEqual(metadata.y + metadata.height - 1);
  expect(deck.y + deck.height, "deck controls must not overlap the hand tray").toBeLessThanOrEqual(hand.y + 1);
  for (const opponent of await page.locator(".opponent-list li").all()) {
    const seat = await bounds(opponent);
    expect(seat.y, "opponent identities must sit below the model metadata").toBeGreaterThanOrEqual(metadata.y + metadata.height - 1);
    expect(seat.y + seat.height, "opponent badges must not cover the deck controls").toBeLessThanOrEqual(deck.y + 1);
  }
  const heading = await bounds(page.locator(".hand-heading"));
  const firstCard = await bounds(page.locator(".playing-card").first());
  const actions = await bounds(page.locator(".move-actions"));
  expect(firstCard.y, "cards must not cover the arrangement toolbar").toBeGreaterThanOrEqual(heading.y + heading.height - 1);
  const groupBottoms = await page.locator(".hand-group").evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().bottom));
  expect(Math.max(...groupBottoms), "action buttons must start after the complete card groups").toBeLessThanOrEqual(actions.y + 1);
  await noPageHorizontalOverflow(page);
}

async function reachableMoveControls(page: Page) {
  const lastAction = page.getByRole("button", { name: "Show selected", exact: true });
  await lastAction.scrollIntoViewIfNeeded();
  for (const name of ["Discard", "Show selected"]) {
    const control = page.getByRole("button", { name, exact: true });
    await fullyVisibleAndUncovered(page, control);
    const box = await bounds(control);
    expect(box.height, "move controls must retain usable touch height").toBeGreaterThanOrEqual(44);
    expect(box.width, "move controls must retain usable touch width").toBeGreaterThanOrEqual(44);
  }
}

async function attachLayout(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, { body: await page.screenshot({ animations: "disabled", fullPage: true }), contentType: "image/png" });
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1710, height: 950 }]) {
  for (const playerCount of [2, 6] as const) {
    test(`AI table layout fits ${viewport.width}×${viewport.height}, ${playerCount} seats, thirteen and fourteen cards`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      const fixture = await installAiTableFixture(page, playerCount);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Your hand (13)" })).toBeVisible();
      await expect(page.locator(".opponent-list li")).toHaveCount(playerCount - 1);
      await expect(page.locator(".meld-status").first()).toHaveText("Not grouped yet");
      await fullyVisibleAndUncovered(page, page.getByRole("button", { name: "Discard", exact: true }));
      await fullyVisibleAndUncovered(page, page.getByRole("button", { name: "Show selected", exact: true }));
      await separatedGameRegions(page);

      await page.locator(".ai-table-models summary").click();
      await expect(page.locator(".ai-table-models")).toHaveAttribute("open", "");
      await expect(page.locator(".ai-table-models code")).toHaveCount(playerCount - 1);
      if (playerCount === 6) {
        fixture.addTechnicalNotice();
        await expect(page.getByRole("status", { name: "AI player availability" })).toContainText("selected model was unavailable");
      }
      await separatedGameRegions(page);
      await reachableMoveControls(page);
      await attachLayout(page, testInfo, "expanded-ai-details-13-cards");

      const deck = page.getByRole("button", { name: /Closed deck/ });
      await deck.scrollIntoViewIfNeeded();
      await fullyVisibleAndUncovered(page, deck);
      await deck.click();
      await expect(page.getByRole("heading", { name: "Your hand (14)" })).toBeVisible();
      const selectedCard = page.locator(".playing-card").last();
      await selectedCard.click();
      await expect(selectedCard).toHaveAttribute("aria-pressed", "true");
      await fullyVisibleAndUncovered(page, selectedCard);
      await expect(page.getByRole("button", { name: "Discard", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Show selected", exact: true })).toBeEnabled();
      await separatedGameRegions(page);
      await reachableMoveControls(page);
      await attachLayout(page, testInfo, "expanded-ai-details-14-cards-selected");
    });
  }
}

for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
  test(`AI table layout keeps mobile controls reachable at ${viewport.width}×${viewport.height}`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport, screen: viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const page = await context.newPage();
    try {
      const fixture = await installAiTableFixture(page, 6);
      await page.goto("/");
      await expect(page.getByRole("heading", { name: "Your hand (13)" })).toBeVisible();
      await page.locator(".ai-table-models summary").click();
      fixture.addTechnicalNotice();
      await expect(page.getByRole("status", { name: "AI player availability" })).toBeVisible();
      await separatedGameRegions(page);
      await reachableMoveControls(page);
      const first = await bounds(page.locator(".playing-card").nth(0));
      const second = await bounds(page.locator(".playing-card").nth(1));
      expect(second.x - first.x, "the mobile fan must expose at least a 44px selection strip per card").toBeGreaterThanOrEqual(44);
      const deck = page.getByRole("button", { name: /Closed deck/ });
      await deck.scrollIntoViewIfNeeded();
      await deck.click();
      await expect(page.getByRole("heading", { name: "Your hand (14)" })).toBeVisible();
      const selectedCard = page.locator(".playing-card").last();
      await selectedCard.click();
      // Selection adds a toolbar control; short landscape screens may need
      // another scroll after that layout change to view the entire card.
      await selectedCard.scrollIntoViewIfNeeded();
      await fullyVisibleAndUncovered(page, selectedCard);
      await reachableMoveControls(page);
      await noPageHorizontalOverflow(page);
      await attachLayout(page, testInfo, "mobile-expanded-details-notice-14-cards");
    } finally {
      await context.close();
    }
  });
}
