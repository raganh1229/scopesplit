# E2E Tests (Playwright)

## Prerequisites

1. Install browsers (one-time):
   ```bash
   npx playwright install --with-deps chromium
   ```

2. Start the dev server in a separate terminal:
   ```bash
   npm run dev
   ```

## Running tests

```bash
# All E2E tests (headless)
npm run test:e2e

# Interactive UI mode
npm run test:e2e:ui

# Debug a specific test
npx playwright test e2e/match-review.spec.ts --debug
```

## Auth notes

Tests in `match-review.spec.ts` and `zone-review.spec.ts` use `page.route()` to
intercept all comparison + pipeline API calls and return mock data. **No real
Clerk session is required** — the app JS is loaded but all API responses are
mocked before the page makes them.

If you need a real end-to-end flow with a live DB, set these env vars before
running:

```
PLAYWRIGHT_BASE_URL=http://localhost:3000
PLAYWRIGHT_TEST_USER_EMAIL=...
PLAYWRIGHT_TEST_USER_PASSWORD=...
```

Then use the `authenticateUser` helper in `e2e/helpers/auth.ts` (once implemented).
