# ScopeSplit — Unit Tests

## Cron / Cleanup (N6, N10)

### N6 — `cleanup-unverified-users` error handling

**Endpoint**: `POST|GET /api/internal/cleanup-unverified-users`  
**Auth**: Bearer token with `CRON_SECRET` or `UNVERIFIED_ACCOUNT_CLEANUP_SECRET`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Happy path — stale users exist | Create 2 test Clerk users >24h old, no verified phone; set `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED=true` | Response shows `deleted: 2`, `deletedUserIds` contains both, DB rows removed, Clerk users deleted |
| DB fails mid-batch | Mock Prisma to throw on first delete | `dbOrphanCount: 1`, `dbOrphanIds` includes that user, `[CLEANUP-ORPHAN]` log present, other users still processed via `Promise.allSettled` |
| Clerk fails after DB delete | Mock Clerk to throw on delete | `clerkFailedCount: 1`, user removed from DB but still exists in Clerk (orphan), `ok` count still increments for others |
| Pagination edge — partial page | Ensure total stale users = `batchSize + 5` | Both pages scanned, all 5 extra users processed, no offset drift |
| Cleanup disabled | `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED=false` | `skipped: true`, no deletes performed |
| Unauthorized | Omit auth header | 401 Unauthorized |

### N10 — `cleanup-failed-comparison-assets` orphan file removal

**Endpoint**: `POST|GET /api/internal/cleanup-failed-comparison-assets`  
**Auth**: Bearer token with `CRON_SECRET` or `FAILED_ASSETS_CLEANUP_SECRET`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Happy path — old FAILED comparison | Create comparison with status `FAILED`, `createdAt: 8 days ago`, valid storage paths in Supabase | POST returns `filesRemoved` with both paths, Supabase objects actually deleted |
| Dry run mode | Same setup as above, use GET | `dryRun: true`, `comparisons` array shows what would be cleaned, no actual Supabase deletes |
| Recent FAILED comparison (not old enough) | Comparison with status `FAILED`, `createdAt: 2 days ago` | POST returns `failedComparisonsFound: 0`, nothing removed |
| Non-FAILED status | Comparison with status `COMPLETED`, old creation date | Not included in cleanup |
| Missing storage paths | Comparison with `yourEstimateStoragePath: null` | Only attempts to remove `adjusterEstimateStoragePath`, no error for null path |
| Supabase storage error | Mock Supabase to return error | `errors` array contains error message, logged to console, other comparisons still processed |
| Cleanup disabled | `FAILED_ASSETS_CLEANUP_ENABLED=false`, POST | `skipped: true` |
| Unauthorized | Omit auth header | 401 Unauthorized |

---

## Phone Verification (N7)

### N7 — Duplicate phone check before code burn

**Endpoint**: `POST /api/verification/phone/confirm`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Duplicate detected — no code burned | User A verified with phone +15551234567; User B tries to verify same number | 409 Conflict, error "already associated with an account", Twilio VerifyCheck NOT called (check Twilio dashboard logs) |
| Unique phone — code verified | Phone not in DB, valid Twilio code | 200 OK, code verified, user updated |
| Invalid code — unique phone | Phone not in DB, invalid Twilio code | 400 Bad Request, Twilio error returned, phone not saved |
| DB query fails during duplicate check | Force Prisma connection error | 500 Internal Server Error, `[PHONE-CONFIRM] Duplicate check query failed` log present, Twilio code NOT burned |

---

## P2 — Cleanup / Tech Debt

### 16 — `PLAN_MONTHLY_PRICES_CENTS` hardcoded in `change-plan` route

**File**: `estimatch-app/app/api/stripe/change-plan/route.ts`  
**Fix**: Move to `lib/stripe.ts` as single source of truth

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Price change in one place | Change value in `lib/stripe.ts` | `change-plan` route uses new value without file modification |
| No drift between checkout and change-plan | Verify both `checkout/route.ts` and `change-plan/route.ts` | Both import from same `lib/stripe.ts` export |
| Type safety | Attempt to pass invalid price | TypeScript error at build time |

---

### 17 — DELETE comparison doesn't refund usage counter

**File**: `estimatch-app/app/api/comparisons/[id]/route.ts`  
**Decision**: Document behavior (don't refund) or implement refund

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Delete shows warning | User with 1/5 comparisons used deletes a comparison | UI shows: "Deleting will not restore your monthly comparison count." |
| Counter unchanged after delete | `comparisonsUsedThisPeriod: 3`, delete 1 comparison | After delete, `comparisonsUsedThisPeriod` still 3 (if no refund implemented) |
| Counter decremented (if refund implemented) | Same setup | After delete, `comparisonsUsedThisPeriod: 2` |
| Abuse prevention (if refund implemented) | Create + delete + create + delete in same period | Counter correctly tracks net creations, no unlimited loophole |

---

### 22 — `executive-summary` Claude input window overflow

**File**: `estimatch-app/app/api/comparisons/[id]/executive-summary/route.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Small comparison (<150 items) | 50 line items | All items sent to Claude, full summary returned |
| Large comparison (>150 items) | 200 line items | Only top-N by `abs(diffAmount)` sent (e.g., top 100), aggregate stats included |
| Chunking boundary | Exactly 150 items | Verify threshold logic — should include all or truncate based on implementation |
| Summary quality | Large comparison with pruning | Summary still coherent, mentions "top differences" or "significant items" |

---

### 23 — `recalculateMatchStatus` stale status when both sides blank

**File**: `estimatch-app/app/api/comparisons/[id]/versions/inline-edits/route.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Both sides blank after edit | Row had `MATCHED`, user clears both yourQty and adjusterQty | Status becomes `CANDIDATE_DELETE` (or filtered out), not `MATCHED` |
| One side blank | `yourQty: 5`, `adjusterQty: null` | Status recalculates correctly (e.g., `ADDED` or `MODIFIED`) |
| Both sides restored | Both quantities re-entered | Status recalculates to appropriate match state |
| Persist behavior documented | Both sides blank | If filtering out, row not persisted; if persisting, status field documented |

---

### 24 — Marketing footer / middleware allow-list drift risk

**File**: `estimatch-app/proxy.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| New marketing page works | Add `/new-feature` page, don't touch proxy | Page accessible without auth (if invert implemented) |
| Protected route still protected | Access `/app/comparison/123` without session | Redirects to sign-in |
| Subscribe route protected | Access `/subscribe` without session | Redirects to sign-in (if private-route matcher) |
| API routes protected | Access `/api/comparisons` without Bearer | 401 Unauthorized |
| Public assets work | `/logo.svg`, `/favicon.ico` | Served without auth check |

---

### N3-3 — Phase 10 extraction validation (`N3ExtractionWarning`)

**File**: `lib/n3/passes/extraction-validation.ts` (to be created)

| Test | Setup | Expected Result |
|------|-------|-----------------|
| No warnings — good extraction | Zone extracted 45 items, `approxItems: 45` | No `N3ExtractionWarning` rows written |
| Under-extraction warning | Zone extracted 30 items, `approxItems: 50` (delta > threshold) | `N3ExtractionWarning` row created with type `UNDER_EXTRACTION` |
| Over-extraction warning | Zone extracted 70 items, `approxItems: 50` (delta > threshold) | `N3ExtractionWarning` row created with type `OVER_EXTRACTION` |
| Threshold respect | Delta = 4 items, threshold = 5 | No warning (delta within tolerance) |
| Threshold breach | Delta = 6 items, threshold = 5 | Warning created |
| UI visibility | Warnings exist | Review gate shows "extraction warnings" alert |

---

### N3-4 — Prisma migration history schema drift

**Files**: `prisma/schema.prisma`, migration files

| Test | Setup | Expected Result |
|------|-------|-----------------|
| No drift detected | Run `prisma migrate status` | Shows "Database schema is up to date" |
| Dev environment | `prisma migrate dev` | Does NOT prompt to reset database |
| CI build | `prisma migrate deploy` | Succeeds without error |
| New developer clone | Fresh clone, `prisma migrate deploy` | Schema matches production |

---

### N11 — `trialPhoneHash: null` placeholder

**File**: `estimatch-app/app/api/verification/phone/confirm/route.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Placeholder removed | Code review | No `trialPhoneHash: null` in metadata update |
| Hash implemented (if chosen) | Phone +15551234567 verified | `trialPhoneHash` contains SHA-256 of normalized phone |
| Duplicate detection (if hash implemented) | Same phone tries to verify on new account | Hash collision detected, duplicate rejected even if DB row deleted |

---

### N12 — Offset-based pagination drift in cleanup cron

**File**: `estimatch-app/app/api/internal/cleanup-unverified-users/route.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Cursor-based pagination | 1000+ users in Clerk | Uses `startingAfter` or similar cursor, not `offset` |
| Partial page handling | Page returns 95 users (not 100) | Next page correctly fetched, no users skipped |
| Large scale (10K+ users) | Stress test | All pages processed, runtime within 60s limit |
| Offset fallback (if kept) | Document behavior | Comment explains risk: "Assumes full pages; revisit at 10K+ users" |

---

### N13 — `findFirst` → `findUnique` on `stripeCustomerId`

**Files**: `prisma/schema.prisma`, `webhooks/stripe/route.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Unique constraint exists | Check schema | `stripeCustomerId String? @unique` in `User` model |
| Migration applied | `prisma migrate deploy` | Succeeds, no unique constraint violations |
| No duplicates in DB | Query `SELECT stripe_customer_id, COUNT(*) FROM users GROUP BY stripe_customer_id HAVING COUNT(*) > 1` | Returns 0 rows |
| Code uses `findUnique` | `webhooks/stripe/route.ts:87` | `prisma.user.findUnique({ where: { stripeCustomerId } })` |
| Type safety | Build | `tsc --noEmit` passes, no type errors |
| Duplicate prevention | Attempt to create user with duplicate `stripeCustomerId` | Prisma throws unique constraint violation |

---

### N15 — `debug-trace.ts` trace file race under concurrent dev runs

**File**: `estimatch-app/lib/debug-trace.ts`

| Test | Setup | Expected Result |
|------|-------|-----------------|
| Comparison-specific trace files | Two comparisons run concurrently | Two files created: `pipeline-trace-abc123.txt`, `pipeline-trace-def456.txt` |
| No cross-contamination | Concurrent runs | File A only has trace for comparison A, no interleaved logs |
| Cleanup | After processing | Files remain for debugging (dev-only), or auto-cleanup per policy |
| Production safety | `NODE_ENV=production` | No filesystem writes, N3 guard active |
| Filename uniqueness | Check implementation | Uses `comparisonId` (UUID) in filename, no collisions |

---

# ScopeSplit — Unit Tests (Original)

> **Purpose**: Tracks test scenarios that should be written and verified before launch or before a specific change ships. Grouped by domain. Add items here when a fix is deferred or when a code path has no coverage.

---

## Payment / Stripe

### #28 — Stripe API version migration (`2025-03-31.basil` → `2025-08-27.basil`)

**File**: `estimatch-app/lib/stripe.ts`
**Status**: Blocked on changelog audit — `as Stripe.LatestApiVersion` cast in place as temporary shim

**What needs to be verified before bumping the API version string:**

| Scenario | Route / Handler | What to check |
|---|---|---|
| New subscription via checkout | `app/api/stripe/checkout/route.ts` | `checkout.session.completed` webhook shape; `client_reference_id`, `metadata.clerkId`, `subscription_data` fields intact |
| Plan upgrade (immediate charge) | `app/api/stripe/change-plan/route.ts` | `subscriptions.update` response shape; `latest_invoice.amount_due` still present on expanded invoice |
| Plan downgrade | `app/api/stripe/change-plan/route.ts` | `proration_behavior: 'none'` still accepted; `current_period_end` readable on response |
| Cancel at period end | `app/api/stripe/cancel/route.ts` | `cancel_at` and `current_period_end` still present on subscription response |
| Resume cancelled subscription | `app/api/stripe/resume/route.ts` | `cancel_at_period_end: false` update still works; `current_period_end` readable |
| Finalize checkout (sync) | `app/api/stripe/finalize-checkout/route.ts` | `subscriptions.list` response shape; `items.data[0].price.id` path still valid |
| Webhook: subscription updated | `app/api/webhooks/stripe/route.ts` — `customer.subscription.updated` | `syncSubscription` fields: `status`, `items.data[0].price.id`, `current_period_end`, `trial_end` |
| Webhook: subscription deleted | `app/api/webhooks/stripe/route.ts` — `customer.subscription.deleted` | Same fields as above |
| Webhook: invoice payment failed | `app/api/webhooks/stripe/route.ts` — `invoice.payment_failed` | `customer` field (string ID) still present |
| Webhook: checkout completed | `app/api/webhooks/stripe/route.ts` — `checkout.session.completed` | `client_reference_id`, `metadata.clerkId`, `subscription` field still present |
| Add-on purchase | `app/api/stripe/checkout/route.ts` (mode: payment) | `checkout.session.completed` → `metadata.checkoutKind === 'addon'` path |

**How to test:**
1. Read [Stripe API changelog](https://docs.stripe.com/upgrades) entries between `2025-03-31` and `2025-08-27` for: Customers, Subscriptions, PaymentIntents, Checkout Sessions, Invoices, Webhooks
2. Cross-reference every field in the table above against the changelog
3. Update `apiVersion` in `lib/stripe.ts`, remove the `as Stripe.LatestApiVersion` cast
4. Run `npx tsc --noEmit` — confirm zero type errors
5. Test each scenario above against Stripe test mode
6. Confirm all webhook events fire and are handled correctly in Stripe dashboard event log
