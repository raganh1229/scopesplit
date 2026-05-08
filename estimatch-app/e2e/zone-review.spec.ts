/**
 * E2E tests for the ZoneReview gate.
 *
 * Same strategy as match-review.spec.ts — all API calls are intercepted
 * so no Clerk session or database is needed.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const COMPARISON_ID = 'test-cmp-e2e-002';
const BASE = `/app/comparison/${COMPARISON_ID}`;

// ── Mock data ─────────────────────────────────────────────────────────────────

const mockComparison = {
  comparison: {
    id: COMPARISON_ID,
    title: 'Zone Review E2E Test',
    status: 'AWAITING_ZONE_REVIEW',
    pipelineVersion: 'n2',
    yourEstimateFilename: 'contractor.pdf',
    adjusterEstimateFilename: 'adjuster.pdf',
    createdAt: new Date().toISOString(),
    totalGap: 0,
    yourTotal: 0,
    adjusterTotal: 0,
    errorMessage: null,
  },
  zones: [],
};

const mockZoneReview = {
  e1Zones: [
    { name: 'Kitchen', startPage: 1, endPage: 5, approxItems: 20, chunkOffset: -1, endPageChunkOffset: -1 },
    { name: 'Living Room', startPage: 6, endPage: 10, approxItems: 15, chunkOffset: -1, endPageChunkOffset: -1 },
    { name: 'Master Bedroom', startPage: 11, endPage: 16, approxItems: 18, chunkOffset: -1, endPageChunkOffset: -1 },
  ],
  e2Zones: [
    { name: 'Kitchen', startPage: 2, endPage: 6, approxItems: 22, chunkOffset: -2, endPageChunkOffset: -2 },
    { name: 'Living Room', startPage: 7, endPage: 11, approxItems: 14, chunkOffset: -2, endPageChunkOffset: -2 },
    { name: 'Master Bedroom', startPage: 12, endPage: 17, approxItems: 20, chunkOffset: -2, endPageChunkOffset: -2 },
  ],
};

// ── Route interceptors ────────────────────────────────────────────────────────

async function interceptZoneReviewAPIs(page: Page) {
  await page.route(`**/api/comparisons/${COMPARISON_ID}`, (route: Route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockComparison),
    });
  });

  await page.route(`**/api/comparisons/${COMPARISON_ID}/zone-review`, (route: Route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockZoneReview),
      });
    } else {
      void route.continue();
    }
  });

  await page.route(`**/api/comparisons/${COMPARISON_ID}/zone-review/confirm`, (route: Route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/auth/**', (route: Route) => {
    void route.fulfill({ status: 200, body: '{}', contentType: 'application/json' });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('ZoneReview gate', () => {
  test.beforeEach(async ({ page }) => {
    await interceptZoneReviewAPIs(page);
  });

  test('renders detected zones from both estimates', async ({ page }) => {
    await page.goto(BASE);

    // ZoneReview should show zone names
    await page.waitForSelector('text=Kitchen', { timeout: 10_000 });
    await expect(page.locator('text=Living Room')).toBeVisible();
    await expect(page.locator('text=Master Bedroom')).toBeVisible();
  });

  test('confirm button triggers zone-review/confirm API', async ({ page }) => {
    let confirmCalled = false;
    await page.route(`**/api/comparisons/${COMPARISON_ID}/zone-review/confirm`, (route: Route) => {
      confirmCalled = true;
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    });

    await page.goto(BASE);
    await page.waitForSelector('text=Kitchen', { timeout: 10_000 });

    // Look for the confirm/looks-good button
    const confirmBtn = page.locator('button:has-text("Looks Good"), button:has-text("Confirm")').first();
    if (await confirmBtn.isVisible()) {
      await confirmBtn.click();
      await page.waitForTimeout(500);
      expect(confirmCalled).toBe(true);
    }
  });

  test('mobile viewport: zones are readable without overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE);
    await page.waitForSelector('text=Kitchen', { timeout: 10_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1);
  });
});
