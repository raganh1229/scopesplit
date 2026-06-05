# ScopeSplit — Production Cutover Checklist

> **Purpose**: Exact checklist of everything that must be changed when moving from localhost/dev to production.
>
> **Status**: ✅ **DEPLOYMENT COMPLETE — Jun 3, 2026.** App is live at **https://scopesplit.com** (Vercel). All §9 go-live items verified. Currently in active testing phase.

---

## 1) What Changes Between Dev and Prod

- **Dev** uses localhost URLs, development Clerk instance keys, and temporary tunnel URLs (ngrok) for webhooks.
- **Prod** uses your real deployed domain, production Clerk instance keys, production webhook secrets, and no tunnel.
- **Dev Stripe webhooks** are forwarded by Stripe CLI (`stripe listen --forward-to ...`).
- **Prod Stripe webhooks** are delivered directly by Stripe to your deployed HTTPS endpoint.

---

## 2) Environment Variables to Replace (Critical)

Update these in your hosting provider env vars (e.g., Vercel), **not** in committed files.

### Clerk

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | `pk_test_...` | `pk_live_...` (or prod instance key) | ✅ |
| `CLERK_SECRET_KEY` | `sk_test_...` | `sk_live_...` (or prod instance key) | ✅ |
| `CLERK_WEBHOOK_SIGNING_SECRET` | `whsec_...` from dev endpoint | `whsec_...` from prod endpoint | ✅ |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/login` | `/login` | ✅ |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/signup` | `/signup` | ✅ |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL` | `/subscribe` | `/subscribe` (or your final destination) | ✅ |
| `NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL` | `/subscribe` | `/subscribe` (or your final destination) | ✅ |

### Supabase

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` | Same (or dedicated prod Supabase project URL) | ✅ |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_...` | prod anon key | ✅ |
| `SUPABASE_SERVICE_ROLE_KEY` | `sb_secret_...` | prod service-role key | ✅ |
| `SUPABASE_STORAGE_BUCKET` (if configurable) | `estimates` | `estimates` (or prod bucket name) | ✅ |

### Prisma / Database

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `DATABASE_URL` | Supabase pooler/session URL | production database connection string | ✅ |
| `DIRECT_URL` | Supabase session pooler URL | production direct/session URL (per migration strategy) | ✅ |

### Anthropic (Claude API)

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` | production API key | ✅ |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-6` | same or updated model | ✅ |
| `SUMMARY_MODEL` | `claude-sonnet-4-6` (or unset — falls back to default) | same or updated model used by `/executive-summary` | Optional |
| `ENABLE_REAL_COMPARISON_PROCESSING` | `true` | `true` | ✅ |
| `MAX_COMPARISON_INPUT_TOKENS_PER_REQUEST` | tuned dev value | production-tuned value | ✅ |
| `MAX_COMPARISON_OUTPUT_TOKENS_PER_REQUEST` | tuned dev value | production-tuned value | ✅ |
| `COMPARISON_PROCESSING_MAX_RETRIES` | `3` (typical) | production-safe retry count | ✅ |

### Stripe

> **Checkout redirect URLs** are derived from the incoming request origin (`x-forwarded-proto` + `x-forwarded-host` on Vercel). The old `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` env vars (full URLs) are no longer used and should be deleted from production env if previously set. Only the path overrides below are honored, and only if the defaults need changing. See Phase 6h in `PROJECT_CONTEXT.md` / N4 in `OUTSTANDING_WORK.md`.

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `STRIPE_SECRET_KEY` | `sk_test_...` | `sk_live_...` | ✅ |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_...` | `pk_live_...` | ✅ |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` (test) | `whsec_...` (live) | ✅ |
| `STRIPE_CHECKOUT_SUCCESS_PATH` | _(unset — default `/app/new-comparison?checkout=success`)_ | override path only if needed | Optional |
| `STRIPE_CHECKOUT_CANCEL_PATH` | _(unset — default `/subscribe?checkout=cancel`)_ | override path only if needed | Optional |
| `STRIPE_PRICE_STARTER_MONTHLY` | `price_...` (test) | `price_...` (live) | ✅ |
| `STRIPE_PRICE_PROFESSIONAL_MONTHLY` | `price_...` (test) | `price_...` (live) | ✅ |
| `STRIPE_PRICE_BUSINESS_MONTHLY` | `price_...` (test) | `price_...` (live) | ✅ |
| `STRIPE_PRICE_STARTER_ADDON_5` | `price_...` (test) | `price_...` (live) | ✅ |
| `STRIPE_PRICE_PROFESSIONAL_ADDON_10` | `price_...` (test) | `price_...` (live) | ✅ |
| `STRIPE_PRICE_BUSINESS_ADDON_10` | `price_...` (test) | `price_...` (live) | ✅ |

### Resend (Bug Reports + Contact Form)

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `RESEND_API_KEY` | `re_...` | production Resend key | ✅ |

The single `RESEND_API_KEY` powers both transactional email routes:
- `POST /api/bug-report` (in-app, auth required, screenshot attachments)
- `POST /api/contact` (public marketing-page contact form, no auth)

### Inngest (Comparison Processing Worker — N1 Conversion)

Production comparison processing runs as a multi-step Inngest function (see `N1_INNGEST_CONVERSION.md` for the full architecture). The webhook endpoint is `/api/inngest` (made public in `proxy.ts`).

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `INNGEST_DEV` | `http://127.0.0.1:8288` (URL form forces dev mode + IPv4 on Windows) | **must be unset / removed** | dev only |
| `INNGEST_EVENT_KEY` | unset | from Inngest Cloud dashboard → "Event Keys" | ✅ prod |
| `INNGEST_SIGNING_KEY` | unset | from Inngest Cloud dashboard → "Signing Keys" | ✅ prod |

Notes:
- The SDK auto-selects dev vs cloud mode based on these variables. **In production, `INNGEST_DEV` must be removed entirely** — if it's set, the SDK will try to reach a non-existent local dev server.
- The Inngest Cloud webhook URL `https://<your-domain>/api/inngest` must be registered in the Inngest Cloud dashboard → Apps → Sync.
- See `N1_INNGEST_CONVERSION.md` §3 Phase 5 for full env-var rationale and the dev-mode failure modes encountered during scaffolding.

### Twilio Verify + Trial Abuse Controls

| Variable | Dev Value Pattern | Prod Value Pattern | Required |
|----------|-------------------|--------------------|----------|
| `TWILIO_ACCOUNT_SID` | `AC...` | production account SID | ✅ |
| `TWILIO_AUTH_TOKEN` | Twilio auth token | production auth token | ✅ |
| `TWILIO_VERIFY_SERVICE_SID` | `VA...` | production Verify service SID | ✅ |
| `TRIAL_IP_HASH_SALT` | long random string | long random string | ✅ |
| `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED` | `true` (recommended) | `true` (recommended) | ✅ |
| `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED` | `true` or `false` | `true` (recommended) | ✅ |
| `UNVERIFIED_ACCOUNT_CLEANUP_SECRET` | long random string | long random string | ✅ |
| `CRON_SECRET` | long random string | long random string | ✅ (for Vercel Cron) |
| `UNVERIFIED_ACCOUNT_MAX_AGE_HOURS` | `24` | `24` | ✅ |
| `UNVERIFIED_ACCOUNT_CLEANUP_BATCH_SIZE` | `100` | `100` (or tuned) | Optional |

**Important temporary testing override (must be reverted before production):**

- `POST /api/stripe/checkout` currently enforces only Clerk phone verification for trial eligibility.
- Stripe metadata-based trial reuse checks (`trial_phone_number`, `trial_ip_hash`) and metadata writes are temporarily disabled to allow repeated local testing.
- Before production, re-enable Stripe trial-abuse enforcement in `app/api/stripe/checkout/route.ts`:
  - restore phone reuse check against Stripe customer metadata
  - restore IP hash reuse check (`TRIAL_IP_HASH_SALT`)
  - restore metadata writes for `trial_phone_number` and `trial_ip_hash`

---

## 3) Clerk Dashboard Changes Required for Production

## 3.1 Webhook Endpoint

In Clerk Dashboard → Webhooks:

1. Create/update endpoint URL:
   - `https://<your-production-domain>/api/webhooks/clerk`
2. Events enabled:
   - `user.created`
   - `user.updated`
   - `user.deleted`
3. Copy the endpoint signing secret and set:
   - `CLERK_WEBHOOK_SIGNING_SECRET` in production env vars.

**Do not use ngrok URL in production.**

## 3.2 Allowed Domains / Redirects

In Clerk Dashboard settings:

- Add production domain(s):
  - `https://<your-production-domain>`
- Ensure auth redirects and callback URLs include production paths:
  - `/login`, `/signup`, `/verify`, `/sso-callback`, etc.
- Remove stale localhost-only entries if not needed.

## 3.3 Phone Verification Metadata Contract

The phone verification flow stores metadata in Clerk and production behavior depends on these keys:

- `publicMetadata.phoneVerifiedForTrial = true`
- `privateMetadata.trialPhoneNumber = "+1..."` (E.164)
- `privateMetadata.phoneVerifiedAt = ISO timestamp`

Related app routes:

- `POST /api/verification/phone/start`
- `POST /api/verification/phone/confirm`
- `/verify-phone`
- `POST /api/internal/cleanup-unverified-users`

---

## 4) Hosting Platform (Vercel or equivalent)

Before first production deploy:

1. Add all required production env vars.
2. Confirm env var scope is correct (Production vs Preview vs Development).
3. Trigger fresh deploy.
4. Verify logs show env vars loaded (without printing secret values).

---

## 4.1 Stripe Dashboard Production Setup

Before billing go-live, configure Stripe Dashboard (live mode):

1. Confirm all live products/prices exist for:
   - Starter monthly
   - Professional monthly
   - Business monthly
   - Starter add-on
   - Professional add-on
   - Business add-on
2. Verify all `STRIPE_PRICE_*` env values point to **live-mode** prices from the **same Stripe account** and correct currency/billing interval.
   - Monthly plans: recurring monthly prices
   - Add-ons: one-time prices
3. Create production webhook endpoint:
   - `https://<your-production-domain>/api/webhooks/stripe`
4. Enable events:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`
5. Copy webhook signing secret and set:
   - `STRIPE_WEBHOOK_SECRET` in production environment.
6. Stripe Billing Portal configuration is **not required** — ScopeSplit's plan management is fully in-app via the tier-selector modal in Settings (`POST /api/stripe/change-plan`). The Stripe-hosted portal is not used.

---

## 4.2 Supabase Production Hardening

Before go-live:

1. Confirm production storage bucket exists (`estimates`) and is private.
2. Confirm service role key is server-only (never exposed client-side).
3. Apply/verify Row Level Security policies for production tables.
4. Validate storage/object cleanup paths still work for failed comparison creates/deletes.
5. Verify production DB pooler/direct URLs match your migration/runtime strategy.

---

## 4.3 Anthropic Production Readiness

Before enabling real customer traffic:

1. Confirm `ENABLE_REAL_COMPARISON_PROCESSING=true` in production env.
2. Confirm `ANTHROPIC_API_KEY` has sufficient rate limits for expected load — traffic now spans the 5-stage pipeline **and** post-processing endpoints (`/versions/apply-edits`, `/executive-summary`).
3. Validate model and token caps (`ANTHROPIC_MODEL`, `SUMMARY_MODEL`, max input/output token envs) against latency/cost targets.
4. ~~Add rate limiting / billing protection on post-processing AI endpoints before launch.~~ **RESOLVED Apr 27 2026**: per-tier flat monthly caps implemented \u2014 see step 7 below for details.
5. Run at least one production smoke comparison and verify:
   - status transitions (`PROCESSING` → `COMPLETED`)
   - `line_items` persist correctly
   - failures are captured with `error_message` when API/provider errors occur
6. Set operational alerts for repeated `429 rate_limit_error` or elevated failure rates.
7. **AI tool usage caps** (Phase 6f): per-tier monthly limits enforced server-side on `apply-edits` and `executive-summary`. Caps: Starter 20/10, Professional 100/50, Business 400/200 (LLM edits / exec summaries). Reset on existing `periodResetDate` billing anchor. No add-on purchase path — flat caps only. Smoke-test by submitting until the 429 fires, then advancing the period to confirm reset.
8. **AI fetch timeouts** (Phase 6h / N5): both AI routes now wrap Anthropic `fetch` in `AbortController` — 45s in `apply-edits`, 55s in `executive-summary`. `try/finally { clearTimeout(...) }` guarantees cleanup. Timeout response is `504 "AI service timed out. Please try again."`. Both routes also export `maxDuration = 60` (see §4.6 below).

---

## 4.4 Resend Production Setup (Bug Reports + Contact Form)

There are **two** Resend-powered routes that share the same API key and sender domain:

| Route | Auth | Origin | Sender (`from`) | Subject |
|-------|------|--------|-----------------|---------|
| `POST /api/bug-report` | Clerk auth required | In-app `/app/help` Contact Us tab | `ScopeSplit Bug Reports <bugs@scopesplit.com>` | `[Bug Report] from <name>` |
| `POST /api/contact` | **Public** (no auth) | Marketing `/contact` page | `ScopeSplit Contact <bugs@scopesplit.com>` | `[Contact Form] from <name>` |

Both currently send to `raganharrison97@gmail.com` (hardcoded constant in each route).

Before go-live:

1. Verify sender domain `scopesplit.com` in Resend so both `from` addresses can deliver.
2. Set `RESEND_API_KEY` in production environment.
3. Confirm destination inbox is correct and monitored.
4. Run end-to-end tests:
   - **Bug report** (`/app/help` while signed in): no attachment, then with 1–3 screenshots.
   - **Contact form** (`/contact` signed out): submit a basic message, confirm receipt with `reply_to` set to the submitter.
5. Confirm validation behavior:
   - **Bug report**: auth required; max 3 images; max 5MB each; allowed MIME `image/jpeg|png|gif|webp`.
   - **Contact**: no auth; name ≤ 120 chars; email RFC-lite + ≤ 254 chars; message ≤ 5000 chars; rejects malformed JSON.
6. **Recommended hardening (not yet implemented)**: add per-IP rate limiting and/or a CAPTCHA to `/api/contact` since it is publicly reachable. Tracked in `OUTSTANDING_WORK.md` item #1 (deferred follow-up).

---

## 4.5 Unverified Account Cleanup Scheduling (Required)

`/api/internal/cleanup-unverified-users` is implemented but **must be triggered by a scheduler** in production.

Route behavior:

- Method: `POST`
- Header: `x-cleanup-secret: <UNVERIFIED_ACCOUNT_CLEANUP_SECRET>`
- Deletes Clerk users older than `UNVERIFIED_ACCOUNT_MAX_AGE_HOURS` when `privateMetadata.trialPhoneNumber` is missing
- Deletes matching Supabase `users` row by `clerk_id`

Production trigger options (pick one before launch):

1. **Vercel Cron** (recommended if hosted on Vercel)
   - Implemented via `estimatch-app/vercel.json`
   - Current schedule: `0 4 * * *` (once daily, 04:00 UTC)
   - Set `CRON_SECRET` in production env; Vercel sends this as bearer auth
2. **GitHub Actions Scheduled Workflow**
   - `schedule` trigger (cron syntax)
   - `curl`/HTTP POST to deployed route with secret header
3. **External scheduler** (Cloudflare Cron Triggers, Render cron, UptimeRobot, etc.)
   - Any reliable daily HTTP POST job

Pre-go-live verification:

- Run one manual POST against production endpoint with valid header
- Confirm response is not `cleanup_disabled`
- Confirm expected deletes in Clerk Dashboard for stale unverified test users

---

## 4.6 Vercel Serverless Configuration (Phase 6h)

The April 27, 2026 evening hardening pass added several Vercel-specific protections. Verify all of the following before the first production deploy:

1. **`maxDuration` exports** — confirmed present in these four routes (`grep -R "export const maxDuration" app/api`):
   - `app/api/comparisons/route.ts`
   - `app/api/comparisons/[id]/versions/apply-edits/route.ts`
   - `app/api/comparisons/[id]/executive-summary/route.ts`
   - `app/api/internal/cleanup-unverified-users/route.ts`

   All four are set to **`60`** (Vercel Hobby plan maximum). If deploying on Pro, these can be raised up to `300` if a specific route needs more headroom.

2. **Debug filesystem env vars** — `DUMP_PIPELINE_TRACE` and `DUMP_HAIKU_ZONES` are now hard-guarded against production via `NODE_ENV === 'production'` checks inside `lib/debug-trace.ts` and `lib/pdf-vision-extract.ts`. They can remain `true` in dev; the code is structurally incapable of writing to Vercel's read-only filesystem in prod. Recommend still setting them to `false` in production env for clarity.

3. **Stripe webhook signature** — verified implemented at `app/api/webhooks/stripe/route.ts:250–265`. `STRIPE_WEBHOOK_SECRET` is required; requests without a valid `stripe-signature` are rejected 400. No action needed; listed here so it doesn't get broken in a future change.

4. **Stripe unmapped-price alert** — if the webhook encounters a price ID that doesn't map to any known plan (typically: a new Stripe price was created but the corresponding `STRIPE_PRICE_*` env var wasn't deployed), a structured log is emitted: `event: "STRIPE_WEBHOOK_UNMAPPED_PRICE"`, `severity: "critical"`, full context (priceId, subscriptionId, stripeCustomerId, userClerkId, userId). Recommend wiring a Vercel log drain (Datadog, Axiom, etc.) with an alert on this exact event string — fires only when a paying user fails to get plan access.

### ✅ P0 blocker resolved — comparison processing (N1) — **COMPLETE**

**Resolved.**  `POST /api/comparisons` no longer fire-and-forgets; it `await inngest.send(...)` and returns `202 Accepted`. The durable Inngest worker `processComparison` runs the 4-stage pipeline independent of the originating request's lifecycle, so Vercel terminating the serverless function on response no longer interrupts the pipeline.

**Tracked in detail in `N1_INNGEST_CONVERSION.md`.** As of Apr 28 2026 evening:

- ✅ Phase 1 — baseline snapshots captured for behavior-preservation diffing.
- ✅ Phase 2 — Prisma migrations baselined; `ComparisonProcessingState` intermediate-state table added; build script runs `prisma migrate deploy && next build`; state helpers shipped + smoke-tested.
- ✅ Phase 3 — `runRealProcessing` refactored into 4 stage functions (`extractStage`, `reconcileAndPrematchStage`, `pairStage`, `finalizeAndPersistStage`) with JSON-serializable boundaries. All 3 baselines re-verified.
- ✅ Phase 4 — stages wired through the intermediate-state table; signatures simplified to `(comparisonId)` only — the contract Inngest needs. Two baselines re-verified exact-match.
- ✅ Phase 5 — `inngest@^4.2.5` installed, `lib/inngest/client.ts` + `app/api/inngest/route.ts` scaffolded, Clerk middleware exempts `/api/inngest(.*)`, dev-mode SDK handshake verified.
- ✅ Phase 6 — `processComparison` worker (4 durable `step.run()` invocations + per-`comparisonId` concurrency cap + default 4-retry policy + terminal `mark-failed` step) defined in `lib/inngest/functions/process-comparison.ts` and registered. Mode gate mirrors legacy `runComparisonProcessing` precedence exactly. End-to-end verified against `small-set8` baseline through `inngest.send()` in 41s (5% overhead vs in-process); aggregates within Sonnet stochasticity tolerance.
- ✅ Phase 7 — `POST /api/comparisons` now `await inngest.send({ name: 'comparison/process.requested', … })` and returns `202 Accepted`. Fire-and-forget pattern removed from production code. Frontend polling unaffected. `tsc --noEmit` clean. **UI smoke test confirmed by user**: two independent upload pairs through the new pipeline produced results 100% identical to their pre-implementation outputs. Dev-mode wall-clock is ~5s slower than legacy in-process orchestration (architectural overhead from durability + Inngest CLI polling); ~3s of that disappears under Inngest Cloud. **N1 is functionally resolved.**
- ✅ Phase 8 — retry / concurrency / idempotency / stress testing complete.
- ✅ Phase 9 — final docs sweep complete.

**Production env vars required** when N1 lands: `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` (see §2 Inngest table above). `INNGEST_DEV` must be removed in prod.

**Launched.** The plan-upgrade workaround (Vercel Pro + `waitUntil`) was rejected because the current `COMPARISON_PROCESSING_TOTAL_TIMEOUT_MS=480000` (8 min) exceeds even the Pro `maxDuration` ceiling of 300s, and the user's stated capacity target (5,000 line items) requires durable multi-step execution that `waitUntil` cannot provide. Inngest Cloud used for production.

---

## 4.7 N1 / Inngest Production Cutover Playbook

This subsection is the operational reference for the *act* of moving N1 from local-dev (Inngest CLI in a terminal) to production (Inngest Cloud + Vercel). It assumes the architectural blocker in §4.6 above has already been resolved (i.e., Phase 8 is closed out in `N1_INNGEST_CONVERSION.md`).

### 4.7.1 Monitoring Capabilities — Production vs Local Dev

Production monitoring is **strictly better** than what the dev CLI provides. The Inngest Cloud dashboard is the primary tool; Vercel logs are secondary.

| Capability | Local dev (Inngest CLI in terminal) | Production (Inngest Cloud + Vercel) |
|---|---|---|
| **Real-time function execution view** | CLI terminal output | Inngest Cloud dashboard with timelines, step graphs, retry history, replay button |
| **Per-step logs** | `console.log` in Next.js terminal | Vercel Functions logs — searchable, real-time tail via `vercel logs --follow` |
| **Step replay** | Manually re-trigger via script | One-click replay from Inngest dashboard, including pinning to a specific failure point |
| **Step output inspection** | Read terminal scrollback | Inngest dashboard shows full input/output JSON for every step |
| **Error grouping** | grep terminal output | Inngest groups by error type with per-error run counts |
| **Search / filter** | `Select-String` / `grep` | Full UI filters by event ID, comparison ID, status, time range |
| **Concurrency / queue depth** | Not visible | Inngest dashboard shows live queue depth + concurrency-key state |

The Inngest Cloud "Runs" view is the equivalent of the dev CLI's terminal output, but with full searchability, persistence, and a UI for step replay. Pair it with `vercel logs --follow` to see the underlying `console.log` output from inside each step.

### 4.7.2 Pre-Cutover Verification Checklist

Confirm each item before the first production deploy that includes the Inngest worker:

- [ ] **`maxDuration` on the Inngest route handler** — `app/api/inngest/route.ts` should export `export const maxDuration = 800` (or similar high value) **and** the Vercel project must be on a plan that allows it. Vercel Hobby caps at 10s, Pro at 60s, Pro+Fluid at 800s, Enterprise at 900s. **Each Inngest step is a separate function invocation**, so any single step (especially Stage A extraction) that takes longer than `maxDuration` will be killed mid-run. Verify the value matches the longest expected step.
- [ ] **`ANTHROPIC_EXTRACTION_TIMEOUT_MS` env var set in Vercel** — recommend `600000` (10 min) for prod. Default in code is 180s which will fail on any PDF >250 items. See `lib/pdf-vision-extract.ts` `getExtractionTimeoutMs()`.
- [ ] **Undici dispatcher patch verified** — the `pdf-vision-extract.ts` patch (memoized `Agent` with `headersTimeout`/`bodyTimeout` matching `ANTHROPIC_EXTRACTION_TIMEOUT_MS`) must take effect in Vercel's runtime, not just locally. Verify by deploying and inspecting Vercel function logs for any `UND_ERR_HEADERS_TIMEOUT` errors during the first real comparison.
- [ ] **`INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` set in Vercel env vars** — from Inngest Cloud dashboard. See §2 Inngest table.
- [ ] **`INNGEST_DEV` is NOT set in Vercel** — if present, the SDK will try to reach a non-existent local dev server. See §2 Inngest table.
- [ ] **Inngest Cloud webhook URL registered** — `https://<your-domain>/api/inngest` must be added in Inngest Cloud dashboard → Apps → Sync. The first deploy auto-triggers a sync attempt; verify the dashboard shows the function `Process comparison (4-stage pipeline)` as registered with all 5 step IDs (`check-already-terminal`, `extract`, `reconcile-and-prematch`, `pair`, `finalize-and-persist`).
- [ ] **Vercel project plan supports the worker's longest step** — confirm the plan allows `maxDuration = 800` (Pro+Fluid required). If not, the longest single step (Stage A extraction at ~5 min for 500-item PDFs, longer for bigger inputs) will be killed.
- [ ] **Comparison processing flag is set correctly** — `ENABLE_REAL_COMPARISON_PROCESSING=true` in Vercel for real processing, otherwise the worker enters stub mode (still durably, but does not call Anthropic).

### 4.7.3 Staged Rollout Sequence

A safe four-stage rollout. Total elapsed time ~1 day, ~3 hours of active work.

| Stage | Action | Risk | Rollback |
|---|---|---|---|
| **1. Inngest Cloud setup** | Sign up at inngest.com, create a "Production" environment, copy `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` to Vercel env vars (set scope = Production) | None — no app code is live yet | N/A |
| **2. Preview branch deploy** | Push N1 changes to a non-main branch. Vercel auto-deploys to a preview URL. Create a separate Inngest "Staging" environment, register the preview URL as its app, run a real comparison through it end-to-end, verify dashboard shows the full pipeline | Isolated to preview URL — no impact on prod traffic | Delete the preview deployment in Vercel UI |
| **3. Production promotion** | Merge to `main`. Vercel auto-deploys to prod domain. Inngest Cloud "Production" env auto-syncs the new app version on first event | Low — the worker is dormant until first event arrives | Vercel UI → Deployments → "Promote to Production" on previous build (~30 sec) |
| **4. First prod comparison + monitoring** | Create the first real prod comparison. Live-tail in Inngest Cloud dashboard + `vercel logs --follow`. Watch for `maxDuration` issues, env-var typos, undici-fix not taking effect, or any retry storms. Confirm full pipeline `extract → reconcile-and-prematch → pair → finalize-and-persist` completes with `lineItemCount > 0` | Caught fast (visible in dashboard within seconds) | Disable Inngest function via dashboard ("Pause function") to stop new event processing while debugging |

### 4.7.4 Hotfix Iteration Cycle

When a prod bug is discovered:

1. Reproduce locally (run the failing comparison through the local Inngest CLI by replaying the production event ID — `event.json` is downloadable from the prod Inngest dashboard).
2. Make the fix. Verify against any relevant Phase 1 baseline via `npx tsx scripts/n1-baseline-smoke.ts`.
3. Push to a hotfix branch → Vercel preview URL → run the prod-replayed event against the preview URL via Inngest's "Run on" target selector (Inngest dashboard → Run details → "Replay on…").
4. If the preview replay succeeds, merge to `main`. ~90 seconds later the new version is live.
5. Click "Replay" on the original failed run in the production Inngest dashboard. It executes against the new code.

**Total time from "I see the bug" to "fix is live and re-tested": ~3–5 minutes for small fixes, ~15 min for non-trivial ones.**

For risky fixes (e.g. extraction prompt changes per OUTSTANDING_WORK #30/#31): always use the Stage 2 staging-environment path before merging to main.

### 4.7.5 First-Week Production Watch List

For the first week after cutover, monitor these specifically (Inngest Cloud + Vercel logs):

- **Retry storms** — any function with `>4 retries in 24h` is a signal of a non-transient bug. The default retry policy is 4 attempts with exponential backoff. If it's hitting that ceiling, look at the failure reason.
- **`UND_ERR_HEADERS_TIMEOUT`** anywhere in Vercel logs → undici dispatcher patch didn't take effect. Critical to fix; revert to a previous deploy and investigate.
- **`520` or `502` errors from `api.anthropic.com`** → matches the local-dev finding that single-call extraction has an upstream Anthropic ceiling. Track frequency to validate when the page-chunking redesign (OUTSTANDING_WORK #32) is needed.
- **Idempotency-guard short-circuits** (`process-comparison short-circuited (already terminal)`) → expected if a user re-clicks "Process" or if Inngest replays a delivered event. Should be visible but not alarming. Spike means something is double-firing events.
- **`maxDuration` exceeded on any single step** → step needs splitting OR Vercel plan needs upgrading. Stage A is the only realistic candidate today.
- **`ComparisonProcessingState` row count growth** — these rows are intermediate-state for in-flight runs. Should stay near zero in steady state. Persistent growth means rows aren't being cleaned up post-finalize (or runs are getting orphaned).

---

## 5) Database / Prisma Production Checks

1. Confirm production DB is reachable from hosting environment.
2. Run schema migration/deploy strategy appropriate for production.
3. Regenerate Prisma client if schema changed.
4. Validate tables/enums exist and match schema.

Recommended validation queries/tests:

- Sign up user in production, complete `/verify-phone`, then verify row in `users`.
- Update profile in Clerk and verify `users` sync update.
- Delete user in Clerk and verify row deletion.

---

## 6) Webhook Runtime Validation (Post-Deploy)

After deployment:

1. In Clerk Webhook logs, confirm delivery status is `2xx`.
2. In Stripe Webhook logs, confirm delivery status is `2xx`.
3. In app logs, confirm no signature verification errors.
4. In Supabase, confirm `users` rows are created/updated/deleted correctly.
5. In Supabase, confirm billing fields update after checkout (`stripe_customer_id`, `subscription_tier`, `subscription_status`, period dates).
6. In Clerk Dashboard, confirm `publicMetadata.plan` updates after successful Stripe subscription events.

If failures occur:

- `400` likely means wrong `CLERK_WEBHOOK_SIGNING_SECRET`.
- `400` on Stripe webhook likely means wrong `STRIPE_WEBHOOK_SECRET`.
- `401/403` may indicate middleware/auth blockage (ensure `/api/webhooks/clerk` remains public).
- `500` indicates app/database logic error — inspect server logs.

---

## 7) Dev-Only Items to Remove Before Production

- ngrok tunnel URLs in Clerk webhook config.
- Stripe CLI forwarding assumptions (`stripe listen --forward-to ...`) in runtime operations.
- Any temporary tunnel URLs for Stripe webhooks.
- Test secrets/tokens shared during local setup.
- Localhost-only assumptions in docs or env vars.

---

## 8) Secret Rotation & Security Hygiene

Rotate/reissue any secrets accidentally exposed during development (chat, screenshots, logs), including:

- `CLERK_WEBHOOK_SIGNING_SECRET`
- `CLERK_SECRET_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- Supabase service role key
- ngrok authtoken

Then update env vars accordingly and redeploy.

---

## 9) Final Go-Live Signoff Checklist — ✅ COMPLETE (Jun 3, 2026)

> **All items verified. App deployed to https://scopesplit.com.**

- [x] Production domain configured in Clerk.
- [x] Production webhook endpoint active and healthy.
- [x] Production signing secret set in host env vars.
- [x] All required keys/secrets present in production env.
- [x] No test/dev keys in production environment.
- [x] Stripe live prices are mapped to all `STRIPE_PRICE_*` env vars.
- [x] Each `STRIPE_PRICE_*` value is confirmed to come from the same live Stripe account and expected billing type (monthly recurring vs one-time add-on).
- [x] Twilio Verify env vars are set (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`).
- [x] Trial abuse env vars are set (`TRIAL_IP_HASH_SALT`, `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED`).
- [x] Stripe trial-abuse enforcement is re-enabled in `app/api/stripe/checkout/route.ts` (phone + IP metadata checks/writes restored before production).
- [x] Unverified cleanup env vars are set and enabled (`UNVERIFIED_ACCOUNT_CLEANUP_*`).
- [x] Production scheduler is configured to call `POST /api/internal/cleanup-unverified-users` every 24 hours.
- [x] `CRON_SECRET` is set in production env (when using Vercel Cron).
- [x] Manual cleanup route smoke test with secret header succeeds.
- [x] Signup (Google + email/password) reaches `/verify-phone`, and successful phone verification syncs to Supabase `users`.
- [x] User update in Clerk syncs to Supabase.
- [x] User delete in Clerk syncs to Supabase.
- [x] Supabase production bucket/privacy/RLS checks are complete.
- [x] Anthropic production env + smoke comparison validation are complete.
- [x] LLM Edit smoke test: open a completed comparison, run an `apply-edits` prompt, verify a new version is created and is_active swaps correctly.
- [x] Inline Edit smoke test: edit a row, click `Save N changes as new version`, verify a new version is created with correct `diffAmount` and `matchStatus` recomputation.
- [x] Executive Summary smoke test: generate a report, verify rendered tables, Print button opens new window, Regenerate triggers a fresh call.
- [x] AI tool usage caps verified end-to-end: Starter/Pro/Business plans hit 429 at the documented thresholds for `/versions/apply-edits` and `/executive-summary`; counters reset on `periodResetDate`; Settings page shows accurate usage bars.
- [x] One full production Stripe checkout updates DB and grants app access.
- [x] In-app Manage Subscription modal opens from Settings → Plan & Billing and successfully drives plan change via `/api/stripe/change-plan` (no Stripe-hosted portal involved).
- [x] Cancel + resume subscription flows work end-to-end.
- [x] Add-on purchase checkout → webhook → credit grant verified (check `addon_purchases` table).
- [x] Billing summary (`GET /api/billing/summary`) returns correct plan, usage, and add-on data.
- [x] Email opt-in toast appears for new users and persists preference correctly.
- [x] Resend domain/sender is verified; both `/api/bug-report` (in-app, with and without screenshots) and `/api/contact` (public marketing page) test emails succeed and arrive at the configured inbox with proper `reply_to` headers.
- [x] Secrets exposed during dev rotated and replaced.
- [x] **N1 resolved**: comparison processing no longer fire-and-forget. Inngest Cloud wired. Verified end-to-end: `PENDING` → `PROCESSING` → `COMPLETED` without manual intervention.
- [x] `maxDuration = 60` exports present in `comparisons/route.ts`, `apply-edits/route.ts`, `executive-summary/route.ts`, `cleanup-unverified-users/route.ts`.
- [x] Old `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` env vars removed from production env.
- [x] Log drain configured with alert on `"STRIPE_WEBHOOK_UNMAPPED_PRICE"` event string.
- [x] Documentation updated with final production values/notes.

---

## 10) Quick Reference: URL Swap

- **Dev webhook URL**: `https://<ngrok-or-tunnel>/api/webhooks/clerk`
- **Prod webhook URL**: `https://<your-production-domain>/api/webhooks/clerk`
- **Dev Stripe webhook URL (forwarded)**: `http://localhost:3000/api/webhooks/stripe`
- **Prod Stripe webhook URL**: `https://<your-production-domain>/api/webhooks/stripe`
- **Dev-only tunnel/forwarding tools**: ngrok + Stripe CLI listener

Webhook URL swaps are the most important cutover step.

---

## 11) Post-Launch Release Workflow (GitHub + Vercel)

**To be set up after the initial production deployment is verified working.** This section establishes the ongoing version control discipline so every future release is safely tracked, previewable, and instantly rollbackable.

### 11.1 One-Time Setup

1. **Create a private GitHub repository** for `estimatch-app`. Private is required — committing publicly would leak code patterns even with `.env.local` excluded.
2. **Verify `.env.local` is ignored** before the first push:
   ```bash
   git check-ignore .env.local
   ```
   The command must echo the file path. If it doesn't, stop and add `.env.local` to `.gitignore` first.
3. **Push the code** (assuming git is already initialized locally):
   ```bash
   git remote add origin git@github.com:<youruser>/scopesplit.git
   git push -u origin main
   ```
4. **Connect Vercel to the GitHub repo**: Vercel Dashboard → Project → Settings → Git → connect to the GitHub repository. From this point forward, every push to `main` triggers an automatic production deploy; every push to a non-`main` branch creates a preview deployment.
5. **Confirm preview deploys work**: push a trivial change on a throwaway branch (e.g., a comment edit), confirm Vercel posts a preview URL on the PR or in the dashboard, then delete the branch.

### 11.2 Per-Release Workflow

For every code change going to production:

```
1. Create a feature branch
   git checkout -b feat/<short-description>          # or fix/<...>, chore/<...>

2. Make changes, commit incrementally with descriptive messages
   git add .
   git commit -m "concise description of what + why"

3. Push the branch
   git push origin feat/<short-description>

4. Vercel automatically creates a preview deployment.
   URL pattern: scopesplit-git-<branch-name>-<org>.vercel.app
   Test the change against the preview URL exactly as you would test prod.

5. Open a Pull Request on GitHub (even working solo).
   Read the diff one more time before merging — it's a free sanity check.

6. Merge to main (via GitHub UI, or CLI):
   git checkout main
   git pull origin main
   git merge feat/<short-description>
   git push origin main

7. Vercel auto-deploys main to scopesplit.com.

8. Tag the release (semver: MAJOR.MINOR.PATCH):
   git tag v1.x.y
   git push origin v1.x.y

9. Delete the feature branch — its purpose is served:
   git branch -d feat/<short-description>
   git push origin --delete feat/<short-description>
```

Keep `main` always-deployable. Never commit work-in-progress directly to `main`.

### 11.3 Rollback Procedure

**Two paths, both valid. Use whichever is faster for the situation.**

**Option A — Vercel one-click rollback (fastest, ~10 seconds):**
1. Vercel Dashboard → Deployments tab
2. Find the last known-good deployment (timestamp and commit SHA shown)
3. Click the `…` menu → **Promote to Production**
4. Production traffic switches to that deployment immediately; zero downtime
5. Investigate the bad deployment afterward at your own pace

**Option B — Git revert (when the bug is in the code, not just the deploy):**
```bash
git revert <bad-commit-sha>
git push origin main
```
Vercel auto-deploys the revert. Tag a new patch version (e.g., `v1.2.1`) afterward.

**Use Option A for emergencies.** It's faster and doesn't touch git history. Option B is for cleaning up after.

### 11.4 Branch Naming Conventions

Suggested prefixes (not enforced, just for clarity):

- `feat/` — new features (`feat/inngest-integration`, `feat/csv-export`)
- `fix/` — bug fixes (`fix/n7-burned-sms`, `fix/safari-modal-z-index`)
- `chore/` — maintenance (`chore/upgrade-prisma`, `chore/cleanup-deps`)
- `docs/` — doc-only changes (`docs/update-cutover-checklist`)

### 11.5 Tag / Versioning Strategy

Use **semantic versioning**: `vMAJOR.MINOR.PATCH`

- **MAJOR** — breaking change for users (rare; most SaaS apps stay at v1.x for years)
- **MINOR** — new feature, backward-compatible (Inngest integration, new dashboard, etc.)
- **PATCH** — bug fix, no behavior change (the N7 / N6 / N10 fixes)

Tag every production deploy. Tags are immutable and serve as the durable history of what shipped when.

### 11.6 Footguns to Avoid

- **Never commit `.env.local`, `.env`, or anything with `_KEY` / `_SECRET` in the contents.** Run `git status` before every commit; if any env file appears, stop. If a secret is accidentally pushed, rotate it immediately (see §8 Secret Rotation).
- **Never `git push --force` to `main`.** This rewrites public history and can destroy work. Force-push only on your own feature branches if you must (e.g., to fix a bad commit message before opening a PR).
- **Never develop directly on `main`.** Always branch first. Even one-line typo fixes — branch, commit, PR, merge.
- **Never commit `node_modules/`, `.next/`, or build artifacts.** `.gitignore` should already cover these; confirm with `git status` after a fresh build.
- **Never commit large binary files** (PDF samples, video, etc.) without using Git LFS. They bloat the repo permanently.

### 11.7 Pre-Launch Validation — ✅ COMPLETE (Jun 3, 2026)

- [x] Push a trivial change to a feature branch and verify the preview deploy succeeds.
- [x] Merge the trivial change to `main` and verify the production deploy succeeds.
- [x] Tag `v1.0.0` to mark the launch state.
- [x] Test the Vercel rollback procedure by promoting an older deployment, confirming the site flips, then promoting the latest one back.
- [x] Confirm `.gitignore` is correctly excluding `.env.local`, `node_modules/`, and `.next/` by running `git status` after a fresh build — only intentional source files should appear.

After these five checks pass, the workflow is verified and safe to use for real changes.
