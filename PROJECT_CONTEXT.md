# ScopeSplit — Full Project Context Document

> **Purpose**: This document captures the entire development context for the ScopeSplit application. It should be referenced at the start of every new AI conversation to restore full project awareness.
>
> **Last Updated**: Jun 3, 2026 — **APP LIVE AT https://scopesplit.com (Vercel).** All P0 blockers resolved. N4 multi-format pipeline complete (Xactimate/Symbility/CSV). All pre-deploy checklist items done. Currently in active testing phase. Previous: April 28, 2026 (N1 Inngest conversion complete).
>
> **Related Documents**:
> - `DATABASE_TECHNICAL_DOCS.md` — Deep technical reference for Supabase + Prisma (connection details, schema, client usage, troubleshooting)
> - `PRODUCTION_CUTOVER_CHECKLIST.md` — All required key/secret/URL changes for localhost → production deployment
> - `Spec Documentation/mvp-product-spec.md` — Full MVP product specification
> - `Spec Documentation/credentials.md` — API keys and passwords (NEVER commit to git)
> - `API_CALL_FLOW.md` — Detailed technical flow for the Claude API comparison pipeline
> - `OUTSTANDING_WORK.md` — Live tracker of P0/P1/P2 follow-ups from the latest full-app code review

---

## 1. Project Overview

**ScopeSplit** is a SaaS web application that allows users to upload two Xactimate PDF estimates and receive a detailed, line-by-line comparison. It targets insurance adjusters and contractors who need to reconcile competing estimates quickly.

### Business Model
- Tiered subscription plans: Starter ($49.99/mo, 10 comparisons), Professional ($99/mo, 50 comparisons), Business ($249/mo, 200 comparisons)
- Add-on comparison packs: Starter 5 for $34.99, Professional 10 for $39.99, Business 10 for $34.99 (one-time purchases, no expiration)
- 7-day free trial (3 comparisons, no card required)
- No free tier — hard block at cap with upgrade prompt
- Payment gate enforced before app access

---

## 2. Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16.2.3 (App Router, Turbopack) |
| Language | TypeScript |
| Auth | Clerk v7 (`@clerk/nextjs`) with legacy hooks (`@clerk/nextjs/legacy`) |
| Styling | CSS Modules (no Tailwind, no component library) |
| Database | Supabase (PostgreSQL) via Prisma ORM v7 |
| File Storage | Supabase Storage (for PDF uploads) |
| Hosting | Vercel — **live at https://scopesplit.com** (deployed Jun 3, 2026) |
| Payment | Stripe Checkout + Webhooks + in-app plan-change modal (**production live** — live keys, webhooks, and all billing flows verified) |
| Background jobs | Inngest v4 (`inngest@^4.2.5`) — multi-step worker for the comparison-processing pipeline. See `N1_INNGEST_CONVERSION.md`. **All 9 phases complete.** `POST /api/comparisons` enqueues `comparison/process.requested`; the durable `processComparison` worker (4 `step.run()` invocations + per-`comparisonId` concurrency cap + 4-retry policy + terminal `mark-failed` step) executes the 4-stage pipeline independent of the request lifecycle. Running in Inngest Cloud in production. |

### Why Legacy Clerk Hooks
Clerk v7 introduced a Signal-based API. The classic `useSignIn`/`useSignUp` hooks with `.create()`, `.prepareEmailAddressVerification()`, etc. are only available via `@clerk/nextjs/legacy`. All auth pages import from there.

---

## 3. Repository Structure

```
Application Comparrison/
├── Primary Repository/
│   ├── PROJECT_CONTEXT.md          ← This file
│   ├── OUTSTANDING_WORK.md         ← Tracked findings (P0/P1/P2 + N1–N15)
│   ├── PRODUCTION_CUTOVER_CHECKLIST.md ← Pre-launch env / config / dashboard steps
│   ├── N1_INNGEST_CONVERSION.md    ← Durable plan + ledger for the multi-step Inngest conversion (active)
│   ├── n1-baselines/               ← Captured baseline snapshots used to verify behavior preservation across the N1 refactor (small/medium/large)
│   ├── Initial Claude HTML Development/   ← Original static HTML prototypes
│   │   ├── new_comparison.html
│   │   ├── mobile_comparison.html
│   │   └── ...
│   └── estimatch-app/              ← The actual Next.js application (pkg name: scopesplit-app)
│       ├── app/
│       │   ├── layout.tsx          ← Root layout with ClerkProvider
│       │   ├── globals.css
│       │   ├── page.tsx            ← Marketing home page (/)
│       │   ├── (auth)/
│       │   │   ├── layout.tsx      ← Auth route group layout
│       │   │   ├── login/page.tsx
│       │   │   ├── signup/page.tsx
│       │   │   ├── verify/page.tsx
│       │   │   ├── forgot-password/page.tsx
│       │   │   ├── reset-password/page.tsx
│       │   │   ├── sso-callback/page.tsx
│       │   │   └── subscribe/page.tsx
│       │   ├── app/                ← Protected app pages
│       │   │   ├── layout.tsx      ← App layout with Sidebar
│       │   │   ├── new-comparison/page.tsx
│       │   │   ├── comparisons/page.tsx
│       │   │   ├── comparison/[id]/page.tsx
│       │   │   ├── settings/page.tsx
│       │   │   ├── settings/cancel/page.tsx
│       │   │   └── help/page.tsx
│       │   ├── (marketing)/
│       │   │   ├── privacy/page.tsx
│       │   │   ├── privacy-choices/page.tsx
│       │   │   ├── terms/page.tsx
│       │   │   ├── cookies/page.tsx
│       │   │   ├── acceptable-use/page.tsx
│       │   │   ├── security/page.tsx
│       │   │   ├── billing-refunds/page.tsx
│       │   │   └── data-processing-addendum/page.tsx
│       ├── api/
│       │   ├── billing/summary/route.ts      ← Billing/usage dashboard aggregation
│       │   ├── bug-report/route.ts            ← Bug report email via Resend API (auth required)
│       │   ├── contact/route.ts               ← Public marketing contact-form email via Resend (no auth)
│       │   ├── comparisons/[id]/notes/route.ts ← Notes list/create for a comparison
│       │   ├── comparisons/[id]/notes/[noteId]/route.ts ← Note edit/delete
│       │   ├── comparisons/[id]/versions/route.ts ← List versions / create v1 snapshot
│       │   ├── comparisons/[id]/versions/[versionId]/route.ts ← Load version zones
│       │   ├── comparisons/[id]/versions/[versionId]/activate/route.ts ← Activate a version
│       │   ├── comparisons/[id]/versions/[versionId]/delete/route.ts ← Delete a version
│       │   ├── comparisons/[id]/versions/apply-edits/route.ts ← LLM-driven edit → new version
│       │   ├── comparisons/[id]/versions/inline-edits/route.ts ← Manual inline edits → new version
│       │   ├── comparisons/[id]/executive-summary/route.ts ← LLM-generated comparison report
│       │   ├── comparisons/[id]/estimate/route.ts          ← Authenticated download of the original PDF (`?side=your|adjuster`)
│       │   ├── comparisons/[id]/pair-edits/preview/route.ts ← Validation-only preview for draft pair operations (no mutation)
│       │   ├── user/trial-eligibility/route.ts             ← Returns whether the user is eligible to start a free trial
│       │   ├── stripe/checkout/route.ts       ← Stripe Checkout session creation
│       │   ├── stripe/change-plan/route.ts    ← Plan upgrade/downgrade
│       │   ├── stripe/cancel/route.ts         ← Schedule cancellation at period end
│       │   ├── stripe/resume/route.ts         ← Reverse pending cancellation
│       │   ├── stripe/cancel-downgrade/route.ts ← Clear pending tier downgrade
│       │   ├── stripe/finalize-checkout/route.ts ← Client-side checkout completion sync
│       │   ├── user/email-opt-in/route.ts     ← Email opt-in preference read/write
│       │   └── webhooks/stripe/route.ts       ← Stripe webhook sync to DB + Clerk
│       ├── components/
│       │   ├── marketing/
│       │   │   ├── TopNav.tsx       ← Shared header (auth-aware)
│       │   │   └── TopNav.module.css
│       │   ├── auth/
│       │   │   ├── AuthShell.tsx    ← Auth page wrapper (includes TopNav)
│       │   │   └── AuthShell.module.css
│       │   └── app/
│       │       ├── Sidebar.tsx      ← In-app sidebar with user menu/logout
│       │       ├── Sidebar.module.css
│       │       ├── MobileAppBar.tsx
│       │       ├── EmailOptInToast.tsx  ← Email opt-in popup
│       │       ├── TrialBanner.tsx      ← Trial status banner
│       │       └── NotesPanel.tsx       ← Comparison notes drawer (line-item + general)
│       ├── DELETED CHANGES/         ← Archived obsolete files (backups, debug scripts, old tests)
│       ├── lib/
│       │   ├── prisma.ts            ← Prisma singleton client
│       │   ├── supabase.ts          ← Supabase client (anon + admin)
│       │   ├── theme-context.tsx     ← Dark mode ThemeProvider + useTheme hook
│       │   ├── stripe.ts            ← Stripe client + plan/add-on price mapping
│       │   ├── comparison-processing.ts      ← Decomposed into 4 stage functions (`extractStage`, `reconcileAndPrematchStage`, `pairStage`, `finalizeAndPersistStage`) wired through the comparison_processing_state table. Production code path no longer calls `runComparisonProcessing` directly — `POST /api/comparisons` enqueues an Inngest event and the `processComparison` worker invokes the 4 stages durably. `runComparisonProcessing` is retained as the in-process baseline reference used by the Phase 3 verifier script. See `N1_INNGEST_CONVERSION.md`.
│       │   ├── comparison-processing-state.ts ← Intermediate-state helpers (`writeStage`, `readStage`, `hasStage`, `clearStage`) backing the 4-stage pipeline. (N1 Phase 2D)
│       │   ├── comparison-processing-stub.ts ← Dev stub fallback
│       │   ├── comparison-line-filter.ts     ← Pre-filter for non-scope lines
│       │   ├── comparison-line-filter.test.ts ← Tests for line filter
│       │   ├── deterministic-prematch.ts     ← Prematch engine (DISABLED — utility functions still imported)
│       │   ├── zone-reconciliation.ts        ← Zone reconciliation fallback module
│       │   └── inngest/
│       │       ├── client.ts                  ← Inngest singleton + documented `ComparisonProcessRequestedEvent` payload type (N1 Phase 5)
│       │       └── functions/
│       │           └── process-comparison.ts ← `processComparison` Inngest worker: 4 durable `step.run()` invocations, per-comparisonId concurrency cap, 4-retry policy, terminal `mark-failed` step, mode gate mirrors legacy precedence (real → stub → disabled). (N1 Phase 6)
│       ├── app/api/inngest/route.ts          ← Inngest webhook endpoint via `serve()`; registers `processComparison`. (N1 Phase 5+6)
│       ├── scripts/                          ← N1 baseline-capture + verification utilities (`n1-list-baseline-candidates`, `n1-capture-baseline`, `n1-verify-state-helpers`, `n1-verify-phase3-refactor`, `n1-check-state-clear`, `n1-verify-phase6-inngest`)
│       ├── prisma/
│       │   ├── schema.prisma        ← Database schema (users, comparisons, line_items, comparison_processing_state)
│       │   └── migrations/          ← Prisma migration history (added in N1 Phase 2A; baseline + `add_comparison_processing_state`)
│       ├── prisma.config.ts         ← Prisma config (loads .env.local)
│       ├── app/generated/prisma/    ← Auto-generated Prisma client (gitignored)
│       ├── styles/
│       │   └── auth.module.css      ← Shared auth form styles
│       ├── proxy.ts                 ← Clerk middleware (route protection + paywall)
│       ├── .env.local               ← Clerk + Supabase keys and config
│       └── package.json
```

---

## 4. Development Phases Completed

### Phase 1: Static HTML Prototypes
- Built initial HTML/CSS mockups for all pages in `Initial Claude HTML Development/`
- Established the visual design language (warm tones, card-based layouts, clean typography)

### Phase 2: Next.js Application Scaffold
- Converted static HTML into Next.js App Router pages
- Created all marketing pages (Home, FAQ, Contact)
- Created all app pages (New Comparison, Comparisons list, Comparison detail, Settings, Help)
- Built responsive Sidebar and MobileAppBar components
- Built TopNav for marketing/auth pages

### Phase 3: Clerk Authentication Integration
- Installed `@clerk/nextjs`
- Wrapped root layout in `ClerkProvider`
- Wired login page with `useSignIn` hook (email/password + Google OAuth)
- Wired signup page with `useSignUp` hook (email/password + Google OAuth + captcha)
- Created email verification page (`/verify`) with 6-digit code input, auto-advance, paste support, resend cooldown
- Created forgot password flow (`/forgot-password` → `/reset-password`)
- Created SSO callback page (`/sso-callback`) with manual `handleRedirectCallback`
- Set up route protection via `proxy.ts` middleware
- Added paywall enforcement in middleware (checks `publicMetadata.plan` via Clerk backend API)

### Phase 4: Auth UX Polish
- TopNav is auth-aware: shows avatar+logout when signed in, login/signup buttons when not
- Sidebar logout popup with 1-second hover-off delay
- Login page auto-redirects signed-in users to `/subscribe`
- `session_exists` errors handled gracefully (auto-redirect instead of error display)
- Reset password auto-logs in and redirects to `/subscribe`
- Subscribe page auto-redirects paid users (`publicMetadata.plan`) to `/app/new-comparison`

### Phase 5: Dark Mode & UI Polish (April 20, 2026)
- **Dark mode toggle** in Settings → Appearance (Light / Dark only, no System option)
- Theme persisted in `localStorage` (`scopesplit-theme`), applied via `data-theme="dark"` on `<html>`
- `ThemeProvider` context wraps app layout — only affects authenticated app pages, not marketing site
- **Dark palette**: Dark grays (not solid black): page `#171717`, surface `#1E1E1E`, cards `#252525`
- **All semantic row colors preserved**: Match (green tint), Contradicting (amber), Missing (red), Adjuster Added (blue) — each with dark-mode variants
- **CSS variable system**: 100+ variables in `globals.css` with `[data-theme="dark"]` overrides covering backgrounds, text, borders, status indicators, pills, diffs, errors, buttons
- **Button contrast fix**: Dedicated `--btn-primary-bg`/`--btn-primary-text` variables (dark bg + white text in light mode; light bg + dark text in dark mode)
- **Hardcoded colors replaced**: ~60+ hardcoded hex/rgba values across 8 CSS module files replaced with CSS variables
- Theme preview cards show SVG illustrations of two overlapping PDF documents
- Settings page: removed "Comparisons" tab, updated notification option to "Product updates"
- Bug report feature: image upload (up to 3), email via Resend API to `bugs@scopesplit.com`

### Phase 6: Stripe Billing Integration (April 20-22, 2026)
- Added Stripe SDK and server helper (`lib/stripe.ts`) with env-guarded price mapping for 3 monthly plans + 3 add-ons
- Added `POST /api/stripe/checkout` for plan/add-on Checkout session creation (creates Stripe customer if missing)
- Added `POST /api/webhooks/stripe` for subscription lifecycle sync to DB + Clerk metadata
- Updated middleware allowlist to keep `/api/webhooks/stripe` public
- Wired `/subscribe` plan buttons to live checkout route (Starter/Professional/Business pricing)
- Settings → Plan & Billing → Manage Subscription opens an in-app tier-selector modal that calls `POST /api/stripe/change-plan` (no Stripe-hosted portal). A stub `/api/stripe/portal` route was initially scaffolded but never wired to UI; it was deleted in the Apr 27 2026 cleanup pass — see `OUTSTANDING_WORK.md` #3.
- Fixed webhook timestamp handling to avoid invalid Date crashes when `current_period_end` is missing/variant-shaped
- Local test flow verified: checkout success → webhook 200s → Clerk `publicMetadata.plan` set → access to `/app/*`
- Known local-dev requirement: Stripe listener must run in separate terminal (`stripe listen --forward-to localhost:3000/api/webhooks/stripe`) and `STRIPE_WEBHOOK_SECRET` must match current listener secret

### Phase 6d: Extended Subscription Management (April 21-22, 2026)
- Added `POST /api/stripe/change-plan` — upgrades (immediate proration) and downgrades (deferred to next billing cycle) with plan rank comparison
- Added `POST /api/stripe/cancel` — schedules cancellation at period end with optional feedback; persists `SubscriptionCancellationFeedback` record
- Added `POST /api/stripe/resume` — reverses a pending cancellation by clearing `cancel_at_period_end`
- Added `POST /api/stripe/cancel-downgrade` — clears `pendingTierDowngrade` and `pendingTierEffectiveAt` fields in user record
- Added `POST /api/stripe/finalize-checkout` — client-side checkout completion sync that polls Stripe for subscription status and updates DB + Clerk metadata
- Added `GET /api/billing/summary` — aggregated billing/usage dashboard data: plan, usage, limits, downgrade status, add-on info, Stripe subscription state
- Settings page: full plan tier selector (change, upgrade/downgrade), cancel subscription flow, resume subscription, scheduled downgrade indicator with cancel downgrade button
- Billing summary forced cache-bypass reload after plan changes, resume, and cancel-downgrade actions
- Settings cancel page (`/app/settings/cancel`): dedicated cancellation page with optional feedback textarea and confirmation flow

### Phase 6e: Add-on Comparison Credit System (April 22, 2026)
- Extended `users` table with `addon_comparisons_this_period` field for per-period add-on credit tracking
- Added `addon_purchases` table for idempotent tracking of Stripe add-on purchases (unique `stripe_session_id`)
- Stripe webhook grants add-on credits only after verified payment (`checkout.session.completed` with `payment_status === 'paid'` and `checkoutKind === 'addon'`)
- Usage enforcement (`POST /api/comparisons`) now includes add-on credits in effective comparison limit: `planLimit + addonComparisonsThisPeriod`
- Billing summary includes add-on credits in `comparisonLimit` and returns `addonComparisonsThisPeriod`
- All period rollover paths (comparisons, billing summary, webhook, finalize-checkout) reset `addon_comparisons_this_period` to 0
- Abandoned/unpaid checkout sessions do not grant credits

### Phase 6f: Email Opt-In System (April 21-22, 2026)
- Added `EmailOptInToast` component (`components/app/EmailOptInToast.tsx`) — popup asking users to opt in to product update emails
- Added `GET/POST /api/user/email-opt-in` route for reading and updating email preferences
- User model extended with `email_opt_in` (string) and `email_opt_in_prompt_dismissed_at` (datetime) fields
- Toast shows once per session, only on desktop, only when not already opted in or dismissed
- "Yes" enrolls user; "Never show again" permanently dismisses the prompt
- Settings page syncs email opt-in toggle with backend via `CustomEvent` dispatch

### Phase 6g: Trial Banner & Downgrade Indicator Polish (April 21-22, 2026)
- Removed subscribe button from trial banner; replaced with centered trial status + enrollment tier/date message
- Added universal visual indicator in Settings plan card for scheduled downgrades (shows current → target tier with arrow and explanatory message)
- Added "Cancel downgrade" button inside downgrade notice, wired to `POST /api/stripe/cancel-downgrade`

### Phase 6b: Bug Report Email (Resend) — Implemented
- API route: `POST /api/bug-report`
- Requires authenticated user and multipart form data (`name`, `email`, `message`, optional `images[]`)
- Attachment limits enforced server-side:
  - max 3 images
  - max 5MB each
  - MIME: JPEG/PNG/GIF/WebP
- Sends structured HTML email through Resend API, includes Clerk user ID and optional screenshots
- Sender: `ScopeSplit Bug Reports <bugs@scopesplit.com>`
- Recipient is a fixed constant (`raganharrison97@gmail.com`); future cleanup is to move to a `SUPPORT_INBOX` env var (tracked in `OUTSTANDING_WORK.md` #2)

### Phase 6h: Vercel / Production-Readiness Hardening (April 27, 2026 — evening pass)
- Second deep review focused on behavior under **Vercel serverless constraints** (function lifecycle, `maxDuration`, read-only filesystem, origin derivation). Findings tagged N1–N15 in `OUTSTANDING_WORK.md`.
- **Resolved in this pass** (all `tsc`-validated; N4, N5 additionally validated with standalone runtime scripts):
  - **N2** — Added `export const maxDuration = 60` to `comparisons/route.ts`, `versions/apply-edits/route.ts`, `executive-summary/route.ts`, and `internal/cleanup-unverified-users/route.ts`. Lifts the default 10s Vercel cap to the Hobby-plan maximum.
  - **N3** — Hard-guarded filesystem writes in `lib/debug-trace.ts` and `lib/pdf-vision-extract.ts` with `NODE_ENV === 'production'` checks. Vercel's `EROFS` (read-only filesystem outside `/tmp`) is now structurally impossible in prod regardless of `DUMP_PIPELINE_TRACE` / `DUMP_HAIKU_ZONES` env values.
  - **N4** — Refactored `lib/stripe.ts:getCheckoutUrls()` to derive origin from `request.headers` (`x-forwarded-proto` + `x-forwarded-host` → `Origin` → `request.url` fallback chain). Old `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` env vars are no longer referenced; paths are overrideable via new `STRIPE_CHECKOUT_SUCCESS_PATH` / `STRIPE_CHECKOUT_CANCEL_PATH` with safe defaults. Localhost cannot leak into production URLs.
  - **N5 (= #8)** — Added `AbortController` timeouts to both Anthropic fetches: 45s in `apply-edits`, 55s in `executive-summary`. `try/finally { clearTimeout(...) }` pattern; returns `504 "AI service timed out. Please try again."` on abort.
  - **N14** — Replaced plain `console.error` in the Stripe webhook's unmapped-price branch with a structured JSON log (`event: "STRIPE_WEBHOOK_UNMAPPED_PRICE"`, `severity: "critical"`, full context). Grep-able in Vercel logs / log drains.
- **Verified, no change needed**:
  - **N8** — Stripe webhook signature verification is correctly implemented at `app/api/webhooks/stripe/route.ts:250–265` (`stripe.webhooks.constructEvent` with `STRIPE_WEBHOOK_SECRET` inside try/catch). Webhook forgery is not possible.
  - **N9** — Retracted as a false positive. The two `clerkClient.users.getUser` calls in `proxy.ts` are in mutually exclusive matchers; no request triggers both.
- **Still OPEN (critical)**:
  - **N1 (P0)** — `POST /api/comparisons:354–358` starts `runComparisonProcessing()` as fire-and-forget **after** returning the 201 response. Under Vercel's serverless lifecycle, the lambda is terminated as soon as the response is sent, so the pipeline never completes in production. Fix requires a job queue (recommended: Inngest or QStash) or, with a plan upgrade, `waitUntil` bounded by `maxDuration`. This is the single remaining P0.
- **Still OPEN (other)**:
  - **P1**: N6 (Clerk/DB cleanup ordering), N7 (burned SMS codes on dupe-phone conflict), N10 (orphan Supabase storage on failed comparisons)
  - **P2**: N11 (hashed-phone placeholder), N12 (offset pagination drift at 10K+ scale), N13 (`findFirst`→`findUnique` — needs schema migration), N15 (dev trace file race)

### Phase 6g: Dead Code & Asset Cleanup (April 27, 2026)
- Comprehensive dead-code review with full reference-graph verification. All items with zero callers in active source were archived to `estimatch-app/DELETED CHANGES/2026-04-27-cleanup/` (will be deleted entirely in a final cleanup pass).
- **Removed from active source**:
  - `app/api/comparisons/[id]/pair-edits/preview/route.ts` and parent dirs (closes `OUTSTANDING_WORK.md` #18).
  - `lib/pair-edits/operations.ts` and parent dir.
  - `app/api/comparisons/[id]/process/route.ts` and parent dir — dev-only manual re-trigger endpoint with no UI callers; standard creation flow bypasses it via direct `runComparisonProcessing()` call from `app/api/comparisons/route.ts`.
  - 6 unused public images (`HomeApps.png`, `HomeApps2.png`, `Screenshot 2026-04-22 194754.png`, `icon_logo_black.png`, `logo_white.png`, `text_logo_black.png`) — recovered ~3 MB of static asset bloat.
  - `isPrematchEnabled()` and `runDeterministicPrematch()` from `lib/deterministic-prematch.ts` — superseded by `runVisionPrematch()` when the pipeline moved to Haiku-based vision extraction. Helper functions used by both stay in place. The `COMPARISON_PROCESSING_PREMATCH` env var is now a no-op.
- **Verified zero impact** on: comparison creation + processing pipeline, LLM Bulk Edit, Executive Summary, Stripe (all 6 routes + webhook), Supabase Storage, Clerk, Resend, Twilio, Anthropic.

### Phase 6f: AI Tool Usage Caps (April 27, 2026)
- Added flat per-tier monthly caps for the two paid AI features (LLM Bulk Edit, Executive Summary), enforced server-side and surfaced in Settings.
- **Caps**:
  | Tier | Comparisons | LLM Bulk Edits | Exec Summaries |
  |---|---|---|---|
  | Starter | 10 | 20 | 10 |
  | Professional | 50 | 100 | 50 |
  | Business | 200 | 400 | 200 |
- **Architecture**:
  - Schema: added `llm_edits_used_this_period` and `executive_summaries_used_this_period` columns to `users` table. Both reset together with `comparisons_used_this_period` on every billing-cycle anchor (`period_reset_date`).
  - `lib/stripe.ts` is the single source of truth for all caps (`PLAN_COMPARISON_LIMITS`, `PLAN_LLM_EDIT_LIMITS`, `PLAN_EXECUTIVE_SUMMARY_LIMITS`, `ADDON_COMPARISON_GRANTS`). The dedicated `app/api/billing/summary/route.ts` and `app/api/comparisons/route.ts` were refactored to import from this module instead of redefining the limits locally (closes the duplication called out in `OUTSTANDING_WORK.md` #14, #15).
  - `lib/usage.ts` provides the gating helpers (`UsageKind`, `UsageLimitError`, `rolloverPeriodIfNeeded`, `assertWithinLimit`, `tryIncrementUsage`). Used by both AI route gates.
  - `POST /api/comparisons/[id]/versions/apply-edits` and `POST /api/comparisons/[id]/executive-summary` both run a pre-call rollover + cap check, then perform a race-safe atomic increment AFTER the Anthropic call succeeds (UPDATE…WHERE used < limit predicate). Failing the post-call increment race returns 429 honestly — the Anthropic call has already been billed but no version is persisted.
  - 429 response shape: `{ error, code: 'USAGE_LIMIT_REACHED', kind: 'llmEdit' | 'executiveSummary', used, limit, refreshDate }`.
- **No add-on extension path**: Per design decision (Apr 27 2026), AI tools are flat per-tier caps with NO purchase-more-quota path. Comparison add-ons (existing) remain comparison-only — they do not grant additional AI-tool quota.
- **Frontend**:
  - Settings → Plan & Billing → Usage section now shows three rows: Comparisons used, LLM bulk edits used, Executive summaries used. All three reset on the same date (already shown by the existing "Usage refresh date" row).
  - Comparison detail page LLM Edit modal and Executive Summary modal both detect the structured 429 response and append "Your quota resets on [date]." to the user-facing error.
- **Cost-of-goods analysis at max usage** (typical $0.12 per call): Starter 7% COGS, Professional 18% COGS, Business 29% COGS. Sized as safety rails, not normal-use targets.

### Phase 6e: Public Contact Form (Resend) — Implemented (April 27, 2026)
- API route: `POST /api/contact` (public, **no Clerk auth** — added to public-routes allow-list in `proxy.ts`)
- Accepts JSON body `{ name, email, message }` (no attachments)
- Server-side validation:
  - `name` ≤ 120 chars
  - `email` matches `^[^\s@]+@[^\s@]+\.[^\s@]+$` and ≤ 254 chars
  - `message` ≤ 5000 chars
- Sends HTML email via Resend with `reply_to` set to the submitter, so Gmail's reply lands directly in their inbox
- Sender: `ScopeSplit Contact <bugs@scopesplit.com>` (reuses the verified bug-report domain)
- Wired from `app/(marketing)/contact/page.tsx` with `submitting` / `submitError` state, success panel reused from prior copy
- In-app `/app/help` Contact Us tab continues to post to `/api/bug-report` (with screenshot support); copy was updated in this session from "Describe the bug" / "Submit another report" to "Your message" / "Send another message" so the in-app form reads as generic Contact Us rather than bug-only
- **Verified end-to-end Apr 27 2026**: both forms successfully delivered email to `raganharrison97@gmail.com`
- **Deferred follow-ups** (in `OUTSTANDING_WORK.md` #1): per-IP rate limiting / CAPTCHA on the public `/api/contact` endpoint to prevent abuse

### Phase 6c: Phone Verification + Trial Abuse Controls (Twilio) — Implemented
- Added mandatory phone verification gate before `/subscribe` and `/app/*` for unverified/no-plan users.
- Added Twilio Verify routes:
  - `POST /api/verification/phone/start` (send SMS OTP)
  - `POST /api/verification/phone/confirm` (verify OTP)
- Added auth page: `/verify-phone` with:
  - Twilio-style card UI aligned to app theme
  - SMS-only send flow
  - US/CA input masking `(XXX) XXX-XXXX`
  - 15-second resend cooldown and dynamic resend button states
- Added duplicate-phone prevention:
  - early check at send-time (`start` route)
  - race-safety re-check at confirm-time (`confirm` route)
  - clear `409` error when phone already belongs to another account
- Metadata contract in Clerk:
  - `publicMetadata.phoneVerifiedForTrial = true`
  - `privateMetadata.trialPhoneNumber = +E164`
  - `privateMetadata.phoneVerifiedAt = ISO timestamp`
- Trial abuse status (current):
  - Clerk phone verification gating remains enabled for trial eligibility (`publicMetadata.phoneVerifiedForTrial` + `privateMetadata.trialPhoneNumber`)
  - Stripe metadata-based trial reuse checks are temporarily disabled for local testing (`trial_phone_number`, `trial_ip_hash`)
  - Stripe metadata writes for `trial_phone_number` and `trial_ip_hash` are temporarily disabled
  - Must be re-enabled before production cutover in `app/api/stripe/checkout/route.ts`
- Added strict user-sync mode:
  - `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED` defaults to strict behavior unless explicitly set to `false`
  - Supabase user row can be deferred until successful phone verification
- Added cleanup endpoint:
  - `POST /api/internal/cleanup-unverified-users`
  - deletes Clerk accounts older than configured age if no `privateMetadata.trialPhoneNumber`
  - also deletes matching Supabase `users` row
- Added scheduler config for production automation:
  - `estimatch-app/vercel.json` includes daily cron trigger for cleanup route

### Phase 7a: Comparison Notes System (April 25, 2026)
- Added `ComparisonNote` data model and CRUD API for comparison-level and line-item-level notes.
- Added slide-out `NotesPanel` drawer with thread-style cards, inline edit/delete, and composer.
- Notes can target either:
  - the whole comparison (`lineItemId = null`), or
  - a specific comparison line item (`lineItemId` set).
- Desktop comparison table behavior:
  - note actions are opened by **right-clicking a row** (context menu) and selecting `Make a note`.
  - a help tooltip next to the `Notes` button explains the right-click behavior.
  - clicking a line-item note card in the drawer keeps notes open, scrolls to the matching row, and applies row selection highlight.
- Mobile behavior remains explicit buttons (`Add note` / `Notes`) on cards and list footer.

### Phase 7b: Marketing Legal & Privacy Pages (April 25, 2026)
- Added/maintained dedicated marketing legal pages under `app/(marketing)`:
  - `/privacy`
  - `/privacy-choices`
  - `/terms`
  - `/cookies`
  - `/acceptable-use`
  - `/security`
  - `/billing-refunds`
  - `/data-processing-addendum`
- Legal links are surfaced in the marketing footer for direct access.

### Phase 7c: Comparison Versioning & Editing (April 26, 2026)
- Added a parallel-version layer (`comparison_versions` + `comparison_version_line_items`) so the original AI pipeline output is never mutated. Every edit creates a new immutable version; one version is `is_active` at a time.
- **LLM Edit (`POST /api/comparisons/[id]/versions/apply-edits`)** — natural-language edits against the active version. Sends compact line-item JSON to Claude Sonnet 4.6 with a hardened system prompt (refuses non-editing requests). Server-side prompt-safety regex gate (`BLOCKED_PATTERNS`) rejects injection-shaped prompts before any API call. Frontend sends `displayItemIds` in user-visible order so Claude's "row N" maps to the user's view.
- **Manual Inline Edit (`POST /api/comparisons/[id]/versions/inline-edits`)** — non-AI per-cell edits committed as drafts in the comparison page (yellow "drafted row" highlight), with `Save N changes as new version` button. Recalculates `diffAmount` and `matchStatus` server-side. Drafts are tracked client-side in a `Map<itemId, EditValues>` with a `beforeunload` guard and unsaved-navigation modal.
- **Version management endpoints**:
  - `GET /api/comparisons/[id]/versions` — list versions (newest first)
  - `POST /api/comparisons/[id]/versions` — idempotent v1 snapshot from canonical `line_items`
  - `GET /api/comparisons/[id]/versions/[versionId]` — load a version's zones (same shape as the main comparison GET so the UI swaps without transformation)
  - `POST /api/comparisons/[id]/versions/[versionId]/activate` — atomic active-flag swap in a transaction
  - `DELETE /api/comparisons/[id]/versions/[versionId]/delete` — delete a version; reactivates the highest remaining version if the deleted one was active; refuses to delete the last remaining version
- Version History dropdown in the comparison page toolbar lets users switch versions, view the edit prompt for AI versions, and delete unwanted versions (with a confirmation overlay).
- All version routes enforce ownership via Clerk + Prisma user lookup; line-item writes happen inside a `prisma.$transaction` to ensure atomicity (deactivate prior + create new + insert items).

### Phase 7d: Executive Summary Generation (April 27, 2026)
- **`POST /api/comparisons/[id]/executive-summary`** — generates a structured Markdown report from the active version's data (or canonical `line_items`) using Claude Sonnet 4.6.
- **No PII sent to the model.** The route assembles a sanitized payload containing only: comparison name, file names, aggregate stats, zone summaries, line-item descriptions/qtys/costs, and note content. No user IDs, emails, full names, timestamps, or DB row IDs are included.
- **Prompt-injection defense-in-depth**:
  - All text fields run through `sanitize()` (strips HTML tags, `{{...}}` and `[[...]]` template syntax, caps at 500 chars per field).
  - Note content uses a dedicated `sanitizeNote()` (same stripping rules, 4000-char cap so legitimate user notes aren't truncated mid-sentence).
  - The data payload is wrapped in an `<comparison_data>` XML envelope and the system prompt explicitly instructs Claude to treat anything inside that envelope as data, never instructions.
  - System prompt enumerates refusal rules and a fallback response if the model can't generate a valid report.
- **Report structure**: Overall Assessment → Financial Summary table → Key Discrepancies (top 5 by $ impact, table) → Missing Items table → Adjuster-Added Items table → Zone-by-Zone Breakdown table → Cost Category Patterns → Notes from User (only if notes exist) → Recommended Next Steps (3-5 actionable bullets).
- **Frontend (`app/app/comparison/[id]/page.tsx`)**: "Executive Summary" buttons in both desktop toolbar and mobile toolbar; modal dialog with toolbar (Print / Regenerate / Close); loading state with spinner and 15-30s wait copy; error banner with retry; rendered Markdown via `lib/markdown-to-html.ts` with `dangerouslySetInnerHTML` (HTML entities are escaped before parsing to prevent XSS).
- **Markdown renderer (`lib/markdown-to-html.ts`)**: line-by-line parser supporting `##`/`###`/`#` headers, GFM tables (preserves empty cells), bold/italic/inline-code, horizontal rules, and ordered/unordered lists. Pure function, zero dependencies.
- **Print export**: opens a new window with inline-styled HTML (deliberately self-contained — no app CSS dependencies), then invokes `window.print()`.
- **Configuration**: `SUMMARY_MODEL` env var overrides the model (default `claude-sonnet-4-6`). Reuses `ANTHROPIC_API_KEY`; returns 500 if missing.
- **Known follow-ups**: no per-user rate limit yet on this endpoint (gated only by Clerk auth + ownership). Production should add a per-minute throttle and/or count toward usage caps to prevent cost runaway.

---

## 5. Authentication Flow Details

### Email/Password Signup
1. `/signup` → fill form → `signUp.create()` → `prepareEmailAddressVerification()`
2. → redirect to `/verify` → enter 6-digit code → `attemptEmailAddressVerification()`
3. → `setActive()` → middleware redirects to `/verify-phone?returnTo=/subscribe` until phone verification is complete

### Google OAuth Signup/Login
1. Click "Continue with Google" → `authenticateWithRedirect()` → Google account picker
2. → redirect to `/sso-callback` → `handleRedirectCallback()` with custom `router.replace()`
3. → redirect target is `/subscribe`, then middleware enforces `/verify-phone` until phone verification is complete

### Login (Email/Password)
1. `/login` → `signIn.create()` → `setActive()` → redirect to `/subscribe`
2. If `session_exists` error → auto-redirect to `/subscribe`
3. Middleware enforces `/verify-phone` if `publicMetadata.phoneVerifiedForTrial !== true`

### Forgot/Reset Password
1. `/forgot-password` → `signIn.create({ strategy: 'reset_password_email_code' })`
2. → enter code → `attemptFirstFactor()`
3. → redirect to `/reset-password` → `signIn.resetPassword()` → `setActive()` → `/subscribe`

### Paywall Enforcement (proxy.ts)
- Uses `clerkClient().users.getUser(userId)` to read `publicMetadata.plan` and `publicMetadata.phoneVerifiedForTrial`
- `/app/*` or `/subscribe` without verified phone and without plan → redirect to `/verify-phone?returnTo=<original>`
- `/verify-phone` with verified phone (or active plan) → redirect to `/subscribe` (or `/app/new-comparison` when paid)
- `/app/*` without plan (but verified phone) → redirect to `/subscribe`
- `/subscribe` with plan → redirect to `/app/new-comparison`
- Unauthenticated users on `/app/*` → redirect to `/login`

---

## 6. Clerk Configuration

### Environment Variables (.env.local)
```
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_aW5maW5pdGUtcmFtLTU0LmNsZXJrLmFjY291bnRzLmRldiQ
CLERK_SECRET_KEY=sk_test_CxtSU05r2rRtVBAKckdqbRMk8gqv4lvudGb4BhPOja
NEXT_PUBLIC_CLERK_SIGN_IN_URL=/login
NEXT_PUBLIC_CLERK_SIGN_UP_URL=/signup
NEXT_PUBLIC_CLERK_AFTER_SIGN_IN_URL=/subscribe
NEXT_PUBLIC_CLERK_AFTER_SIGN_UP_URL=/subscribe
CLERK_WEBHOOK_SIGNING_SECRET=whsec_...
```

### Clerk Dashboard Settings
- Google OAuth enabled
- Bot protection / CAPTCHA enabled (requires `<div id="clerk-captcha" />` in signup form)
- User metadata field used: `publicMetadata.plan` (string, e.g. "starter", "professional", "business")
- Phone-verification metadata fields used:
  - `publicMetadata.phoneVerifiedForTrial` (boolean)
  - `privateMetadata.trialPhoneNumber` (string, E.164)
  - `privateMetadata.phoneVerifiedAt` (ISO timestamp)

### Public Routes (no auth required)
`/`, `/login`, `/signup`, `/verify`, `/forgot-password`, `/reset-password`, `/faq`, `/contact`, `/subscribe`, `/error`, `/sso-callback`, `/privacy`, `/privacy-choices`, `/terms`, `/cookies`, `/acceptable-use`, `/security`, `/billing-refunds`, `/data-processing-addendum`, `/api/webhooks/clerk`, `/api/webhooks/stripe`, `/api/internal/cleanup-unverified-users`

---

## 7. Key Design Decisions

1. **Preserve existing UI** — Clerk pre-built components are NOT used; all auth pages use custom forms with Clerk hooks
2. **Legacy hooks** — Must use `@clerk/nextjs/legacy` for `useSignIn`/`useSignUp` (v7 Signal API incompatible)
3. **Middleware file is `proxy.ts`** — Next.js 16 renamed `middleware.ts` to `proxy.ts`
4. **All auth flows route through `/subscribe`** — Even returning users hit subscribe first; paid users are auto-forwarded by middleware
5. **Paywall uses Clerk backend API** — Not session claims (which can be stale), but `clerkClient().users.getUser()` for reliable metadata reads
6. **TopNav is shared** — Used on marketing pages, auth pages (via AuthShell), and subscribe page; auth-aware with avatar/logout dropdown
7. **Sidebar overflow: visible** — Required so the logout popup renders outside the collapsed 52px rail

---

## 8. Testing Status (as of April 16, 2026)

| Test | Status |
|------|--------|
| A) Header links everywhere | PASS |
| A) Signed-out header state | PASS |
| A) Signed-in header state | PASS |
| A) Logout from header | PASS |
| B) Email signup happy path | PASS |
| B) Email verification | PASS |
| B) Verification invalid code | PASS |
| B) Resend cooldown | PASS |
| B) Password mismatch | PASS |
| C) Email login happy path | PASS |
| C) Login wrong password | PASS |
| C) Forgot/reset password flow | PASS |
| C) Reset invalid code | PASS |
| D) New Google user signup | PASS |
| D) Existing Google user login | PASS |
| D) Abandoned OAuth recovery | PASS |
| E) Unauthenticated route block | PASS |
| E) Unpaid user route block | PASS |
| E) Paid user bypass | PASS (via publicMetadata.plan) |
| F) Manual email display (no name) | PASS |
| F) Google account display | PASS |
| G) In-app sidebar logout | PASS |

---

## 9. Known Issues / Deferred Items

1. **Brief flash to home page during Google OAuth** — After Google account selection, there's a very brief flash of `/` before landing on `/subscribe`. Deferred for now; does not block functionality.
2. **Clerk rate limiting** — Development instance has strict rate limits. Avoid rapid repeated auth attempts during testing.
3. **TopNav auth state on fresh login** — Avatar may not appear immediately after login without a page refresh in some cases. Minor UX issue, deferred.

---

## 10. Database Layer (Phase 5)

### Supabase Project
- **Project**: `scopesplit` on Supabase (US East 1)
- **Connection**: Session pooler via `aws-1-us-east-1.pooler.supabase.com:5432` (IPv4 compatible)
- **ORM**: Prisma v7 with generated client at `app/generated/prisma/`

### Schema (7 tables + 4 enums)
- **users** — Synced from Clerk via webhook. Stores `clerk_id`, `email`, `full_name`, `company_name`, Stripe fields, subscription tier/status, usage tracking.
- **comparisons** — Each PDF comparison job. Stores filenames, storage paths, totals, match counts, processing status.
- **line_items** — Individual line item matches within a comparison. Stores both sides (yours/adjuster) for every cost column, diff amounts, match status.
- **comparison_notes** — Notes attached to a comparison or specific line item (`line_item_id` nullable), with ownership and timestamps.
- **comparison_versions** — Immutable edit snapshots of a comparison. One row per version per comparison; exactly one is `is_active = true` at a time. Stores `version_number`, `label`, optional `edit_prompt` (LLM-edit only), and `created_at`.
- **comparison_version_line_items** — Per-version line items, structurally identical to `line_items` (same cost columns, zone fields, match status). Each row carries an optional `original_line_item_id` pointer back to the canonical row it was derived from.
- **addon_purchases** — Stripe add-on purchase ledger for idempotent credit grants.
- **subscription_cancellation_feedback** — Optional cancellation feedback records.

### Enums
- `SubscriptionTier`: STARTER, PROFESSIONAL, ENTERPRISE
- `SubscriptionStatus`: TRIALING, ACTIVE, CANCELED, PAST_DUE, EXPIRED
- `ComparisonStatus`: PROCESSING, COMPLETED, FAILED
- `MatchStatus`: MATCH, MODIFIED, MISSING_FROM_ADJUSTER, ADDED_BY_ADJUSTER, GROUPED

### UI Status Labels (user-facing)
| Internal (DB) | UI Label |
|--------------|----------|
| MATCH | Matching |
| MODIFIED | Contradicting |
| MISSING_FROM_ADJUSTER | Missing |
| ADDED_BY_ADJUSTER | Adjuster Added |

Defined in `statusLabel` map in `app/app/comparison/[id]/page.tsx`. Internal enum values are unchanged in DB/API.

### Utility Files
- `lib/prisma.ts` — Singleton PrismaClient (hot-reload safe)
- `lib/supabase.ts` — Supabase clients (anon for client-side, admin for server-side)
- `lib/comparison-processing.ts` — Shared processing orchestrator (real LLM path with extracted-text chunking + retry when enabled, otherwise stub fallback)
- `lib/comparison-processing-stub.ts` — Development processing stub that transitions comparisons from PROCESSING to COMPLETED/FAILED for UI/testing
- `app/api/webhooks/clerk/route.ts` — Clerk webhook handler syncing users table (`user.created`, `user.updated`, `user.deleted`)
- `app/api/uploads/estimates/route.ts` — Deprecated upload-only endpoint (returns 410; use `/api/comparisons` POST)
- `app/api/comparisons/route.ts` — Authenticated upload + comparison creation API (`POST`) and user comparison listing (`GET`), triggers processing orchestrator
- `app/api/comparisons/[id]/route.ts` — Authenticated single-comparison detail API (`GET`) with ownership checks and grouped line-item payload
- `app/api/comparisons/[id]/process/route.ts` — Authenticated dev/testing trigger for processing orchestrator (`POST`, mode `success`/`failed` supported)
- `app/api/comparisons/[id]/notes/route.ts` — Authenticated notes list/create API (`GET`/`POST`)
- `app/api/comparisons/[id]/notes/[noteId]/route.ts` — Authenticated note update/delete API (`PATCH`/`DELETE`)
- `app/api/comparisons/[id]/versions/route.ts` — Authenticated version list (`GET`) and v1 snapshot creation (`POST`, idempotent)
- `app/api/comparisons/[id]/versions/[versionId]/route.ts` — Authenticated version detail (`GET`) returning zone-grouped payload
- `app/api/comparisons/[id]/versions/[versionId]/activate/route.ts` — Authenticated version activation (`POST`, atomic active-flag swap)
- `app/api/comparisons/[id]/versions/[versionId]/delete/route.ts` — Authenticated version delete (`DELETE`, refuses last remaining version, reactivates highest remaining if needed)
- `app/api/comparisons/[id]/versions/apply-edits/route.ts` — LLM-driven edit endpoint (`POST`); prompt-safety regex gate + Claude Sonnet 4.6 call → new version
- `app/api/comparisons/[id]/versions/inline-edits/route.ts` — Manual inline-edit endpoint (`POST`); applies field overrides → new version, recomputes match status + diff
- `app/api/comparisons/[id]/executive-summary/route.ts` — Executive summary generator (`POST`); sanitized payload + Claude Sonnet 4.6 → Markdown report
- `app/api/comparisons/[id]/estimate/route.ts` — Authenticated PDF download (`GET ?side=your|adjuster`); streams the original Supabase Storage PDF as a Content-Disposition attachment
- `app/api/comparisons/[id]/pair-edits/preview/route.ts` — Preview-only pair-edit validation (`POST`); accepts an `operations[]` array, returns accepted/rejected per row, never mutates state. Currently scaffolding for a future pair-management UI; flagged for finish-or-remove decision in `OUTSTANDING_WORK.md` #18
- `app/api/comparisons/[id]/route.ts` (`DELETE`) — Owner-only delete that removes Supabase storage objects (both PDFs) and cascades through line items, notes, versions, and version line items via the Prisma schema
- `app/api/user/trial-eligibility/route.ts` — Lightweight `GET` returning `{ eligible: boolean }` (true if `hasUsedTrial=false` and status is null/EXPIRED/CANCELED). Used by the subscribe page to gate trial offers
- `lib/pair-edits/operations.ts` — Pure validation helpers for pair-edit operations: `swap_adjuster_side`, `swap_yours_side`, `pair_rows`, `unpair_row`. Re-uses snapshot of yours/adjuster sides to enforce operation invariants.
- `lib/markdown-to-html.ts` — Pure-function Markdown → HTML renderer used by the executive summary modal (headers, GFM tables, lists, bold/italic, code, hr)
- `components/app/NotesPanel.tsx` — Notes drawer UI (thread list, edit/delete, composer, line-item navigation)
- `app/api/verification/phone/start/route.ts` — Twilio SMS verification start API (`POST`)
- `app/api/verification/phone/confirm/route.ts` — Twilio SMS verification confirm API (`POST`)
- `app/api/internal/cleanup-unverified-users/route.ts` — Cleanup endpoint for unverified users (`POST`)

### Validation Completed
- Prisma + Supabase connectivity verified (`prisma generate`, `prisma db push`, runtime queries)
- Clerk webhook verified end-to-end:
  - Signup behavior follows strict/legacy defer flag (`DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED`)
  - Clerk profile update syncs row updates
  - Clerk user delete removes row
- Signature verification tested:
  - Unsigned/fake webhook request rejected (`400`)
  - Invalid signing secret causes webhook failures as expected
- Twilio SMS verification flow tested:
  - Phone number validation
  - SMS send cooldown
  - OTP verification
  - Duplicate phone prevention
- Deferred user sync tested:
  - `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED` flag honored
  - Supabase user row creation deferred until phone verification
- Cleanup route tested:
  - Unverified users deleted after configured age
  - Matching Supabase `users` row deleted
- Cascade deletes verified:
  - Deleting a user cascades deletion to `comparisons` and `line_items`

---

## 11. Comparison Engine Architecture (as of April 19, 2026; N4 complete Jun 3, 2026)

### Pipeline Generations
- **N1** — Direct Claude pass on full PDF text (legacy, Inngest-wrapped, complete)
- **N2** — Zone-aware multi-pass + deterministic prematch (paused, `N2_PAUSED_FOR_N3=true`)
- **N3** — Active production pipeline: 18-phase pipeline with global-candidate retrieval + scored assignment, Voyage AI embeddings, LLM adjudication. Controlled by `N3_ENABLED=true`. Fully built and production-verified.
- **N4** — **COMPLETE (Jun 3, 2026).** Multi-format pipeline supporting **Xactimate, Symbility, and CSV** comparison. Resolves P0 blockers #36, #37, #38. Lives in `lib/n4/`.

### Current State: Claude-Only Processing

The comparison engine sends **all line items to Claude in a single API call**. Claude handles:
- **Zone detection** from `[ZONE?]` header markers in the document
- **Item pairing** between the two estimates
- **Zone reconciliation** across both estimates (canonical zone naming)

> **Prematch is DISABLED** — `lib/deterministic-prematch.ts` is preserved but bypassed. Its utility functions (`parseLineToFields`, `costsAllMatch`, `quantitiesEqual`, `parseAllLinesWithZones`, `isZoneCandidate`) are still actively imported for server-side cost resolution.

> **Scope**: Xactimate, Symbility, and CSV formats supported via N4. N3 handles Xactimate PDF comparisons.

### Architecture

```
PDF A (Contractor) ─┐
                     ├─→ Text Extraction (pdf-parse)
PDF B (Adjuster) ───┘         │
                              ▼
                    Pre-Filter (comparison-line-filter.ts)
                    Drops headers, totals, summaries
                              │
                              ▼
                    Zone Candidate Detection (isZoneCandidate)
                    Zone headers tagged as [ZONE?] markers
                              │
                              ▼
                    Field Parsing (parseAllLinesWithZones)
                    Extracts description, qty, costs per line
                              │
                              ▼
                    Format for Claude (formatCompactLine)
                    Each line: lineNumber|description|qty unit|$totalCost
                              │
                              ▼
                    ┌─────────────────────────────────┐
                    │   Claude API (Single Call)        │
                    │   - Receives ALL lines from both  │
                    │     estimates + [ZONE?] markers    │
                    │   - Returns:                      │
                    │     pairs: [{y:lineNum, a:lineNum}]│
                    │     zoneMappings: [{yours, adj,    │
                    │       canonical}]                  │
                    └─────────────────────────────────┘
                              │
                              ▼
                    Server-Side Resolution
                    - Costs from ParsedScopeFields maps
                    - MATCH vs MODIFIED via costsAllMatch() + quantitiesEqual()
                    - Zone names applied from zoneMappings
                              │
                              ▼
                    Persist to Database (line_items table)
```

**Pipeline stages:**
1. **Text extraction** — Raw lines from each PDF via `pdf-parse`
2. **Pre-filter** (`lib/comparison-line-filter.ts`) — Drops headers, totals, summary lines, non-scope content
3. **Zone candidate detection** — Identifies potential zone headers using `isZoneCandidate()`, tags them as `[ZONE?]` markers for Claude
4. **Field parsing** — `parseAllLinesWithZones()` extracts description, quantity, unit, costs from each scope line
5. **Claude API call** — All lines sent in a single request with comprehensive system prompt covering zone detection, pairing rules, and reconciliation
6. **Server-side resolution** — Claude's pair mappings resolved against parsed fields; costs compared deterministically
7. **Zone name application** — Claude's `zoneMappings` applied to set `zoneCanonical`, `zoneYours`, `zoneAdjuster` on each item
8. **Database persistence** — Normalized line items saved to `line_items` table

### Key Files

| File | Purpose |
|------|---------|
| `lib/comparison-processing.ts` | Main processing engine — Claude API calls, pairing resolution, zone application |
| `lib/comparison-line-filter.ts` | Pre-filter that drops non-scope lines before Claude |
| `lib/deterministic-prematch.ts` | Prematch engine (DISABLED) — utility functions still imported for field parsing and cost comparison |
| `lib/zone-reconciliation.ts` | Zone reconciliation fallback (used when Claude doesn't provide inline zone mappings) |
| `lib/comparison-processing-stub.ts` | Development stub fallback for status transitions |

### Lookup Tables (in `deterministic-prematch.ts`)

The engine depends on five vocabulary-based lookup tables that directly affect matching quality:

| Table | Size | Purpose |
|-------|------|---------|
| `KNOWN_ZONE_PREFIXES` | ~120 patterns | Detect room/zone headers for zone-aware matching. Covers 16 categories: living spaces (including standalone `living` for "Living Area" variants), kitchens, bedrooms, bathrooms, hallways, storage, basement/attic, garage, outdoor (incl. lanai), outbuildings, specialty rooms, roofing, exterior, floor levels, damage/services, primary suite. Does NOT include trade categories (plumbing, electrical, demolition) — these are section labels, not room zones. |
| `ABBREVIATIONS` | ~120 entries | Expand Xactimate shorthand to full words (e.g., `dw`→`drywall`, `ceil`→`ceiling`, `shgl`→`shingle`). Covers management, size/grade, materials, rooms, trades, building components, roofing, finishes, measurements. |
| `ACTION_SYNONYMS` | ~45 entries | Normalize action verbs to canonical forms across 8 families: install, remove, detach, reset, seal, repair, build. (e.g., `hang`→`install`, `demo`→`remove`, `patch`→`repair`) |
| `STOPWORDS` | ~60 entries | Filter noise words that dilute token overlap scores. Includes standard English stopwords plus estimate filler (e.g., `new`, `existing`, `style`, `grade`, `type`). |
| `AREA_TERMS` | ~13 entries | Identify dimension annotation lines (tokens like `walls`, `ceiling`, `floor`, `perimeter`) to exclude them from matching. |
| `ZONE_REMAINDER_WORDS` | ~40 entries | Allowlist for compound zone headers. Words like `room`, `hallway`, `den`, `mechanical`, `charges` are allowed in the remainder after the regex match, enabling detection of compound zones like "Utility / Mechanical Room", "2nd Floor Hallway", "Office / Den". |

### Tokenization Pipeline (`descriptionToTokens`)

```
Raw description
→ lowercase
→ expand R&R ("r&r" → "remove replace")
→ preserve measurements ("3.5\"" → "dim3p5in", "8'" → "dim8ft")
→ split on / and -
→ strip punctuation
→ drop single chars and pure numbers
→ remove stopwords
→ expand abbreviations
→ normalize action verb synonyms
→ normalize suffixes (-ing, -s, -ies, -ches, -shes, -xes)
```

### Scoring

- **Description score**: `max(Jaccard, Containment)` on token sets. Minimum 0.80.
- **Overall confidence**: `descScore × 0.70 + qtyBonus + unitBonus + categoryBonus + costBonus`. Minimum 0.82.
- **Token overlap**: Minimum 2 tokens (relaxed to 1 for single-token descriptions).
- Zone-aware: items only match within the same detected zone.

### Test Results (as of April 18, 2026)

| Set | Author | Matches | False Pairings | Reduction |
|-----|--------|---------|----------------|----------|
| Set 1 | Claude | 86 | 0 | 55.3% |
| Set 2 | ChatGPT | 37 | 0 | 32.2% |
| Set 3 | ChatGPT | 146 | 0 | 75.6% |
| Set 4 | Claude | 71 | 0 | 44.2% |
| Set 5 | ChatGPT | 17 | 0 | 10.3% |
| Set 6 | Claude | 30 | 0 | 19.8% |
| Set 7 | Claude | 16 | 0 | 10.4% |
| Set 8 | Claude | 42 | 0 | 25.5% |
| Set 9 | Claude | 37 | 0 | 24.5% |
| **Total** | — | **482** | **0** | **~33% avg** |

Test PDFs stored in `../../PDFS/Accurate Comparisons/Set{1-9}/`. Cheat sheet: `Test_Sets567_Cheat_Sheet.md` (in Set 7-9 folders).

### Full Pipeline Accuracy (Claude-Only, as of April 19, 2026)

**Set 5 (Plumbing/Water Damage Townhouse) — 101 items:**

| Metric | Result | Cheat Sheet | Match |
|--------|--------|-------------|-------|
| MATCH | 36 | — | ✅ |
| MODIFIED | 44 | — | ✅ |
| ADDED_BY_ADJUSTER | 4 | — | ✅ |
| MISSING_FROM_ADJUSTER | 17 | — | ✅ |
| Contractor items | 97 | 97 | ✅ Exact |
| Adjuster items | 84 | 84 | ✅ Exact |
| Zones | 6 | 6 | ✅ All correct |
| Unzoned items | 0 | — | ✅ |
| Per-side zone names | All 6 populated | — | ✅ |
| **Overall accuracy** | **100%** | — | ✅ All pairings verified correct |

**Set 11 (Commercial Office — 263 items):**

| Metric | Result |
|--------|--------|
| MATCH | 89 |
| MODIFIED | 84 |
| ADDED_BY_ADJUSTER | 73 |
| MISSING_FROM_ADJUSTER | 17 |
| Zones | 16 |
| Unzoned items | 0 |
| **Overall accuracy** | **~96-97%** (3 status edge cases, ~4 restroom cross-zone swaps) |

### Claude API Configuration (as of April 19, 2026)

The AI (Claude) pipeline sends **all lines in a single API call** with Claude performing zone detection, item pairing, and zone reconciliation:

- **Input to Claude**: Each line sent as `lineNumber|description|qty unit|$totalCost`. Zone candidate lines prefixed with `[ZONE?]` for Claude to evaluate as potential room/area headers.
- **System prompt**: Comprehensive prompt covering Xactimate domain expertise, zone detection rules (identify real zone headers from `[ZONE?]` markers), item pairing rules (zone-first → description similarity → one-to-one → unmatched), zone reconciliation rules, and strict JSON output format.
- **Output from Claude**: `{"pairs":[{"y":lineNum,"a":lineNum,"zone":"canonical zone"}], "zoneMappings":[{"yours":"...", "adjuster":"...", "canonical":"..."}]}`
- **Server-side resolution**: Pairs resolved against pre-computed `ParsedScopeFields` maps. Costs extracted deterministically via `extractCosts()`. MATCH vs MODIFIED determined by `costsAllMatch()` + `quantitiesEqual()`.
- **Zone name wiring**: Claude's `zoneMappings` used to populate `zoneYours`, `zoneAdjuster`, and `zoneCanonical` on each line item for display in UI.
- **Fallback safety**: If Claude returns legacy `{lineItems:[...]}` format, the old `ensurePayloadShape()` parser still works.
- **Null-safe costs**: If `extractCosts()` can't parse cost columns, fields are `null` (not `0`), preventing false cost data in the UI.

**Token settings** (as of April 19, 2026):
- `DEFAULT_MAX_INPUT_TOKENS_PER_REQUEST`: 160,000 (code default)
- `DEFAULT_MAX_TOKENS_OUTPUT`: 64,000 (code default)
- `.env.local` overrides: `MAX_COMPARISON_INPUT_TOKENS_PER_REQUEST=200000`, `MAX_COMPARISON_OUTPUT_TOKENS_PER_REQUEST=64000`
- `temperature`: 0 (deterministic output)
- Anthropic Tier 2: 450,000 input tokens/min, 90,000 output tokens/min
- Claude Sonnet 4.x pricing: $3/1M input tokens, $15/1M output tokens

**Prematch disabled**: All items sent to Claude. Prematch code preserved in `lib/deterministic-prematch.ts` but bypassed in `lib/comparison-processing.ts`.

**Exported utilities from prematch** (still actively used): `parseLineToFields()`, `parseAllLinesWithZones()`, `costsAllMatch()`, `quantitiesEqual()`, `isZoneCandidate()`, `ExtractedCosts` type, `ParsedScopeFields` type.

### Key Design Constraints

1. **Zero false pairings** is the #1 priority. Conservative thresholds ensure no incorrect matches.
2. **Dynamic and pattern-based** — No hardcoded file paths or line numbers. All logic adapts to any Xactimate PDF.
3. **Missed matches are acceptable** — Items the prematch can't confidently match are forwarded to the AI layer, which handles semantic/contextual matching.
4. **Zone normalization** — `normalizeZoneName()` canonicalizes zone names so variants match:
   - "bathroom" → "bath" ("Master Bathroom" = "Master Bath")
   - Trailing "room" stripped ("Living Room" → "living", "Utility Room" → "utility")
   - Trailing "items" / "area" stripped ("General Items" → "general", "Living Area" → "living")
   - Compound zones: primary name before first "/" or "&" ("Office / Den" → "office")
   - Height annotations stripped ("KitchenHeight: 8'" → "kitchen")
5. **Trade categories are NOT zones** — Section headers like "Plumbing & HVAC", "Finish Carpentry", "Demolition" are trade groupings, not room zones. Adding them as zone prefixes causes items to be locked to a zone that may not exist on the other estimate. Items under unrecognized trade headers go to `__UNZONED__` and can match freely.

---

## 12. TODO — Engine Improvements

### Near-Term
1. **Re-enable prematch as optimization** — Prematch is disabled but preserved. If API costs become a concern, prematch can be re-enabled to reduce the number of lines sent to Claude (~33% savings).
2. **Two-pass AI strategy** — First pass: fast/cheap model (Haiku) for easy matches. Second pass: full model (Sonnet) for remaining items. Cuts cost on medium-difficulty items.
3. **Prompt tuning for edge cases** — Improve Claude's handling of identical items in numbered rooms (e.g., Restroom 1 vs Restroom 2 with same fixtures but different quantities).

### Deferred
4. **Cross-platform support** — Symbility, CoreLogic, and handwritten estimate formats require completely separate parsing logic.

---

## 13. What Comes Next

1. ~~**End-to-end test of compact prompt pipeline**~~ — ✅ **DONE** (April 18, 2026).
2. ~~**Zone detection refactor**~~ — ✅ **DONE** (April 19, 2026). Claude handles all zone detection, pairing, and reconciliation. Prematch disabled. 100% accuracy on Set 5, ~97% on Set 11.
3. ~~**Codebase cleanup**~~ — ✅ **DONE** (April 19, 2026). Obsolete files moved to `DELETED CHANGES/`.
4. **Rotate Exposed Development Secrets** — Reissue any tokens/secrets exposed during setup/testing.
5. ~~**Stripe Integration**~~ — ✅ **DONE (local)**: Checkout + webhooks + Customer Portal wired and tested in test mode.
6. ~~**Usage Limit Enforcement**~~ — ✅ **DONE** (April 22, 2026). Usage enforcement includes base plan limit + add-on credits, with period rollover resets.
7. ~~**Add-on Credit Ledger**~~ — ✅ **DONE** (April 22, 2026). `addon_purchases` table for idempotent tracking; `addon_comparisons_this_period` field for per-period credits; grants only on verified Stripe payment.
8. ~~**Production Billing Cutover**~~ — ✅ **DONE** (Jun 3, 2026). Live Stripe keys, webhooks, and all billing flows verified in production.
9. ~~**Deployment**~~ — ✅ **DONE** (Jun 3, 2026). App deployed to https://scopesplit.com on Vercel. All production env vars, webhooks, and smoke tests complete per `PRODUCTION_CUTOVER_CHECKLIST.md`.
10. ~~**Unverified Account Cleanup Scheduling**~~ — ✅ **DONE** (Jun 3, 2026). Vercel Cron configured via `vercel.json`, fires daily at 04:00 UTC.

### Production-Launch Actions (Stripe/Clerk/Supabase/Anthropic/Resend)
Before go-live, complete all of the following:

1. Replace all test keys/secrets with production values (`pk_live`, `sk_live`, live `whsec`, live price IDs).
2. In Stripe Dashboard, create production webhook endpoint `https://<domain>/api/webhooks/stripe` and enable required events.
3. In Clerk Dashboard, set production webhook endpoint `https://<domain>/api/webhooks/clerk` and production allowed domains/redirects.
4. Verify `users` row sync on signup/update/delete in production.
5. Verify one full real-money subscription flow end-to-end (checkout, webhook sync, Clerk metadata update, app access).
6. Verify in-app Manage Subscription modal (Settings → Plan & Billing) opens and that plan changes via `POST /api/stripe/change-plan` succeed end-to-end.
7. Confirm Supabase production hardening: private `estimates` bucket, service-role key server-only, and RLS policy coverage.
8. Confirm Anthropic production readiness: `ENABLE_REAL_COMPARISON_PROCESSING=true`, production API key/rate limits, and one successful production smoke comparison.
9. Confirm Resend production readiness: verified sender/domain, `RESEND_API_KEY` set, successful bug-report email tests (with and without screenshots), and successful public contact-form (`/api/contact`) email test.
10. Remove dev tunnel assumptions from operations (ngrok + Stripe CLI forwarding are dev-only).
11. Rotate any exposed development secrets before launch.
12. Configure and validate daily cleanup trigger for unverified Clerk accounts (`/api/internal/cleanup-unverified-users`).
13. Set `CRON_SECRET` in production for scheduler-authenticated cleanup execution.

---

## 14. Commands Reference

```bash
# Start dev server (folder is still named estimatch-app/ on disk)
cd estimatch-app
npm run dev
# → http://localhost:3000

# Production build check
npm run build

# Prisma commands (run from estimatch-app/ directory)
powershell -ExecutionPolicy Bypass -Command "npx prisma db push"      # Push schema to Supabase
powershell -ExecutionPolicy Bypass -Command "npx prisma generate"      # Regenerate Prisma client
powershell -ExecutionPolicy Bypass -Command "npx prisma studio"        # Open DB GUI

# Clerk test user management
# → https://dashboard.clerk.com → Users
# To simulate paid user: set publicMetadata.plan = "starter" on user

# Supabase dashboard
# → https://supabase.com/dashboard/project/pkoyyojellmangswrczj
```

---

## 15. Important File Quick Reference

| File | Purpose |
|------|---------|
| `proxy.ts` | Clerk middleware — route protection + paywall |
| `app/layout.tsx` | Root layout with ClerkProvider |
| `app/(auth)/login/page.tsx` | Login with email/password + Google |
| `app/(auth)/signup/page.tsx` | Signup with email/password + Google + captcha |
| `app/(auth)/verify/page.tsx` | 6-digit email verification |
| `app/(auth)/forgot-password/page.tsx` | Send reset code |
| `app/(auth)/reset-password/page.tsx` | Enter new password |
| `app/(auth)/sso-callback/page.tsx` | OAuth redirect handler |
| `app/(auth)/subscribe/page.tsx` | Plan selection (paywall) |
| `components/marketing/TopNav.tsx` | Shared header (auth-aware) |
| `components/app/Sidebar.tsx` | In-app sidebar with logout |
| `components/auth/AuthShell.tsx` | Auth page wrapper |
| `styles/auth.module.css` | Shared auth form styles |
| `lib/prisma.ts` | Singleton Prisma client (safe for hot reload in dev) |
| `lib/supabase.ts` | Supabase clients (anon + admin) |
| `lib/comparison-processing.ts` | Main processing engine — Claude API, zone detection, pairing, cost resolution, DB persistence |
| `lib/comparison-processing-stub.ts` | Development stub fallback for status transitions |
| `lib/comparison-line-filter.ts` | Pre-filter pipeline — drops non-scope lines (totals, headers, summaries) |
| `lib/comparison-line-filter.test.ts` | Tests for line filter |
| `lib/deterministic-prematch.ts` | Prematch engine (DISABLED) — utility functions still imported; dead exports archived to `DELETED CHANGES/2026-04-27-cleanup/` |
| `lib/zone-reconciliation.ts` | Zone reconciliation fallback module |
| `lib/theme-context.tsx` | Dark mode ThemeProvider + useTheme hook |
| `lib/stripe.ts` | Stripe helper + canonical plan caps (`PLAN_COMPARISON_LIMITS`, `PLAN_LLM_EDIT_LIMITS`, `PLAN_EXECUTIVE_SUMMARY_LIMITS`, `ADDON_COMPARISON_GRANTS`) + `getCheckoutUrls(request)` for origin-derived Stripe redirect URLs |
| `lib/usage.ts` | AI-tool usage gate helpers (`UsageKind`, `UsageLimitError`, `rolloverPeriodIfNeeded`, `assertWithinLimit`, `tryIncrementUsage`) |
| `app/api/bug-report/route.ts` | Bug report email with image attachments via Resend |
| `app/api/stripe/checkout/route.ts` | Create Stripe Checkout sessions for subscriptions and add-ons |
| `app/api/webhooks/clerk/route.ts` | Clerk webhook syncing users to DB |
| `app/api/webhooks/stripe/route.ts` | Stripe webhook syncing subscription data to DB + Clerk metadata |
| `app/api/verification/phone/start/route.ts` | Starts Twilio Verify SMS flow; blocks duplicate phone numbers |
| `app/api/verification/phone/confirm/route.ts` | Confirms Twilio OTP, writes Clerk metadata, and persists `users.phone_number` |
| `app/api/internal/cleanup-unverified-users/route.ts` | Secret-protected cleanup endpoint for stale unverified Clerk accounts |
| `app/api/uploads/estimates/route.ts` | Deprecated upload-only endpoint (`410`) |
| `app/api/comparisons/route.ts` | Create/list comparisons; triggers processing |
| `app/api/comparisons/[id]/route.ts` | Load single comparison with grouped line items and zone info |
| `app/api/comparisons/[id]/notes/route.ts` | Comparison notes list/create API |
| `app/api/comparisons/[id]/notes/[noteId]/route.ts` | Comparison note edit/delete API |
| `app/api/comparisons/[id]/versions/route.ts` | Version list + v1 snapshot creation |
| `app/api/comparisons/[id]/versions/[versionId]/route.ts` | Load a version's zones (UI-ready format) |
| `app/api/comparisons/[id]/versions/[versionId]/activate/route.ts` | Activate a specific version |
| `app/api/comparisons/[id]/versions/[versionId]/delete/route.ts` | Delete a version with active-version reassignment |
| `app/api/comparisons/[id]/versions/apply-edits/route.ts` | LLM-driven edits → new version (Claude Sonnet 4.6) |
| `app/api/comparisons/[id]/versions/inline-edits/route.ts` | Manual inline edits → new version (no AI) |
| `app/api/comparisons/[id]/executive-summary/route.ts` | LLM-generated executive summary report |
| `app/api/contact/route.ts` | Public marketing-page contact form → Resend email |
| `app/api/comparisons/[id]/estimate/route.ts` | Authenticated download of the original Supabase-stored PDF (`?side=your|adjuster`) |
| `app/api/user/trial-eligibility/route.ts` | Whether the user can start a free trial |
| `lib/markdown-to-html.ts` | Markdown → HTML renderer (used by exec summary modal) |
| `app/(marketing)/privacy/page.tsx` | Public privacy policy page |
| `app/(marketing)/privacy-choices/page.tsx` | Public privacy choices page |
| `app/(marketing)/terms/page.tsx` | Public terms of service page |
| `app/(marketing)/cookies/page.tsx` | Public cookie policy page |
| `app/api/stripe/change-plan/route.ts` | Plan upgrade/downgrade with proration logic |
| `app/api/stripe/cancel/route.ts` | Schedule subscription cancellation with feedback |
| `app/api/stripe/resume/route.ts` | Reverse pending cancellation |
| `app/api/stripe/cancel-downgrade/route.ts` | Clear pending tier downgrade |
| `app/api/stripe/finalize-checkout/route.ts` | Client-side checkout completion sync |
| `app/api/billing/summary/route.ts` | Billing/usage dashboard aggregation |
| `app/api/user/email-opt-in/route.ts` | Email opt-in preference read/write |
| `components/app/EmailOptInToast.tsx` | Email opt-in popup component |
| `components/app/TrialBanner.tsx` | Trial status banner with enrollment info |
| `components/app/NotesPanel.tsx` | Comparison notes drawer (general + line-item notes) |
| `app/app/settings/cancel/page.tsx` | Subscription cancellation page with feedback |
| `app/api/test-db/route.ts` | Database connectivity test endpoint |
| `prisma/schema.prisma` | Database schema (users, comparisons, line_items, comparison_notes, comparison_versions, comparison_version_line_items, add-ons, cancellation feedback) |
| `prisma.config.ts` | Prisma config (loads .env.local) |
| `vercel.json` | Production cron schedule for unverified-account cleanup route |
| `.env.local` | Clerk + Supabase + Anthropic + Stripe + Resend + Twilio + cleanup scheduler config |
| `DELETED CHANGES/` | Archived obsolete files (see `DELETED CHANGES/README.md`) |
