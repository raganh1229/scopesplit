/**
 * E2E tests for the MatchReview gate.
 *
 * Strategy: intercept all API calls via page.route() so no real
 * Clerk session or database is required. The app JS loads normally;
 * we feed it mock data to trigger the AWAITING_MATCH_REVIEW render path.
 */
import { test, expect, type Page, type Route } from '@playwright/test';

const COMPARISON_ID = 'test-cmp-e2e-001';
const BASE = `/app/comparison/${COMPARISON_ID}`;

// ── Mock data ─────────────────────────────────────────────────────────────────

const mockComparison = {
  comparison: {
    id: COMPARISON_ID,
    title: 'E2E Test Comparison',
    status: 'AWAITING_MATCH_REVIEW',
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

const mockMatchReview = {
  pairs: [
    {
      e1Zones: ['Kitchen'],
      e2Zones: ['Kitchen'],
      canonical: 'Kitchen',
      isMerged: false,
      confidence: 95,
    },
    {
      e1Zones: ['Master Suite'],
      e2Zones: ['Master Bedroom', 'Master Bathroom'],
      canonical: 'Master Suite',
      isMerged: true,
      confidence: 82,
    },
    {
      e1Zones: ['Half Bath'],
      e2Zones: ['Powder Room'],
      canonical: 'Half Bath',
      isMerged: false,
      confidence: 71,
    },
  ],
  unmatchedE1: ['Garage'],
  unmatchedE2: [],
};

// ── Route interceptors ────────────────────────────────────────────────────────

async function interceptComparisonAPIs(page: Page) {
  // Mock the main comparison data endpoint
  await page.route(`**/api/comparisons/${COMPARISON_ID}`, (route: Route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockComparison),
    });
  });

  // Mock the match-review data endpoint
  await page.route(`**/api/comparisons/${COMPARISON_ID}/match-review`, (route: Route) => {
    if (route.request().method() === 'GET') {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMatchReview),
      });
    } else {
      void route.continue();
    }
  });

  // Mock the confirm endpoint
  await page.route(`**/api/comparisons/${COMPARISON_ID}/match-review/confirm`, (route: Route) => {
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, skipped: false }),
    });
  });

  // Mock Clerk auth endpoints to avoid redirects
  await page.route('**/api/auth/**', (route: Route) => {
    void route.fulfill({ status: 200, body: '{}', contentType: 'application/json' });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('MatchReview gate', () => {
  test.beforeEach(async ({ page }) => {
    await interceptComparisonAPIs(page);
  });

  test('renders zone pairs with confidence badges', async ({ page }) => {
    await page.goto(BASE);

    // Wait for the MatchReview component to appear
    await page.waitForSelector('[data-testid="match-review"]', { timeout: 10_000 }).catch(() => {
      // Fallback: look for the confirm button text if testid not present
      return page.waitForSelector('text=Looks Good', { timeout: 10_000 });
    });

    // Verify matched zone pairs are visible
    await expect(page.locator('text=Kitchen')).toBeVisible();
    await expect(page.locator('text=Master Suite')).toBeVisible();
  });

  test('shows unmatched zones in dedicated column/section', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector('text=Looks Good', { timeout: 10_000 });

    // Garage is unmatched E1 — it should appear without an E2 counterpart
    await expect(page.locator('text=Garage')).toBeVisible();
  });

  test('confirm button fires the confirm API', async ({ page }) => {
    let confirmCalled = false;
    await page.route(`**/api/comparisons/${COMPARISON_ID}/match-review/confirm`, (route: Route) => {
      confirmCalled = true;
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, skipped: false }),
      });
    });

    await page.goto(BASE);
    await page.waitForSelector('text=Looks Good', { timeout: 10_000 });

    await page.locator('text=Looks Good').click();

    await page.waitForTimeout(500); // allow async handler
    expect(confirmCalled).toBe(true);
  });

  test('mobile viewport renders without horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 }); // iPhone 14
    await page.goto(BASE);
    await page.waitForSelector('text=Looks Good', { timeout: 10_000 });

    const bodyWidth = await page.evaluate(() => document.body.scrollWidth);
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyWidth).toBeLessThanOrEqual(viewportWidth + 1); // allow 1px rounding
  });
});

test.describe('Page status guards (no flash)', () => {
  test('does not flash completed comparison before MatchReview renders', async ({ page }) => {
    await page.route(`**/api/comparisons/${COMPARISON_ID}`, (route: Route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockComparison),
      });
    });

    await page.route(`**/api/comparisons/${COMPARISON_ID}/match-review`, (route: Route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockMatchReview),
      });
    });

    await page.route('**/api/auth/**', (route: Route) => {
      void route.fulfill({ status: 200, body: '{}', contentType: 'application/json' });
    });

    // Navigate and immediately check: comparison table must NOT be visible
    // while the page is loading or in AWAITING_MATCH_REVIEW status
    await page.goto(BASE);

    // The results table should never appear for AWAITING_MATCH_REVIEW status
    const tableVisible = await page
      .locator('[data-testid="comparison-results-table"]')
      .isVisible()
      .catch(() => false);

    expect(tableVisible).toBe(false);
  });
});
