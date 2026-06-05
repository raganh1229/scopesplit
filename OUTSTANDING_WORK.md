# ScopeSplit — Outstanding Work

> **Purpose**: Single source of truth for known follow-up work derived from the Apr 27, 2026 full-application code review (multiple passes, including a Vercel/serverless hardening pass in the evening). Items are scoped to "needs implementation/fix"; routine testing tasks are tracked separately.
>
> **Last Updated**: Jun 3, 2026 — **APP LIVE AT scopesplit.com (Vercel).** All P0 blockers resolved (#36 Symbility pipeline, #37 XLS/XLSX support, #38 Loading/progress screens — all via N4 multi-format pipeline). N4 fully completed, supports Xactimate/Symbility/CSV comparison. All Pre-Deploy checklist items (PD-1 through PD-22) completed. Currently in **active testing phase**. Previous update: May 25, 2026 — Second review pass added N16–N19. Stripe trial-abuse code fix added as P0 item #39 (resolved same day). Pre-deployment operational checklist integrated from `PRODUCTION_CUTOVER_CHECKLIST.md` into new Pre-Deploy section. Previous update: May 24, 2026 — Comprehensive pre-launch review of full application and N3 pipeline. Six N3 bugs fixed. New P0 items added: #36, #37, #38. N3 tracking items N3-6 through N3-12 added. Previous update: May 20, 2026 — N3 pipeline fully built (all 18 phases) and connected to the Scopesplit UI. Previous update: May 3, 2026 — N1 Inngest conversion **RESOLVED** (all 9 phases complete).
>
> **Source**: Multi-pass `/review` of `estimatch-app/` covering all API routes, lib modules, middleware (`proxy.ts`), webhooks, frontend pages, and components. The evening pass specifically evaluated behavior under Vercel serverless constraints (maxDuration, fire-and-forget patterns, read-only filesystem).

---

## Conventions

- **P0** — Pre-launch blocker. Cost, security, or data-correctness risk.
- **P1** — Should-fix before significant traffic. UX or operational risk.
- **P2** — Nice-to-have / cleanup. Refactor, dedup, polish.
- Each item lists: file path(s), root cause, recommended fix.

---

## Open Work — Priority Order

> Single source of truth for what remains. Full detail for each item is in the sections below. Resolved items are preserved for reference but not listed here.

### P0 — Must Fix Before Launch

| # | Item | Area |
|---|------|------|
| ~~36~~ | ~~Symbility pipeline — N3 extraction, zone detection, normalization for Symbility PDFs~~ — **RESOLVED Jun 3 2026** (implemented via N4 multi-format pipeline) | N3 pipeline |
| ~~37~~ | ~~XLS/XLSX file support — upload, parse, and extract structured spreadsheet estimates~~ — **RESOLVED Jun 3 2026** (CSV/XLS support implemented in N4) | N3 pipeline + upload |
| ~~38~~ | ~~Loading / progress screens — update all pipeline waiting states with meaningful phase-level status messages~~ — **RESOLVED Jun 3 2026** (phase-level status messages implemented) | UI |
| ~~39~~ | ~~Re-enable Stripe trial-abuse enforcement in `checkout/route.ts`~~ — **RESOLVED May 25 2026** (phone + IP reuse checks + metadata writes restored) | Billing / Security |

### P1 — Fix Before Significant Traffic

**N3 Pipeline**

| # | Item |
|---|------|
| ~~N3-1~~ | ~~Phase 5 + Phase 7 UI review gates not implemented~~ — **RESOLVED** (gates fully wired, confirmed working May 24 2026) |
| ~~N3-2~~ | ~~4 line items consistently missed by Phase 8 extraction~~ — **DEFERRED** (will re-audit after full app cleanup) |
| ~~N3-5~~ | ~~V2/V3 format test sets not yet validated~~ — **RESOLVED** (later sets covered diverse formats; new sets will be generated for future validation) |
| ~~N3-7~~ | ~~`createMany` batch limit — Phase 18 fails at 1,872+ decisions~~ — **RESOLVED May 24 2026** |
| N3-8 | Score thresholds need recalibration — moved to **Potential N3 Improvements** |
| N3-9 | Phase 10 NLP: trade/action classification — moved to **Potential N3 Improvements** |
| N3-10 | Large-component greedy mislabeled decisions — moved to **Potential N3 Improvements** |
| ~~N3-11~~ | ~~Phase 4→8 format handoff missing~~ — **RESOLVED May 24 2026** (user selects format at upload; stored on Comparison row; passed to Phase 8) |
| ~~N3-12~~ | ~~Review gates never tested end-to-end~~ — **RESOLVED** (confirmed working in production across many test runs May 24 2026) |

**App / API**

| # | Item |
|---|------|
| ~~7~~ | ~~Comparisons list silently capped at 50 rows~~ — **RESOLVED May 24 2026** (cursor-based pagination + Load More button, mobile-responsive) |
| ~~9~~ | ~~New-comparison polling has no max duration~~ — **RESOLVED May 24 2026** (10-minute timeout added; shows user-facing message if Phase 4 stalls) |
| ~~10~~ | ~~Trial-abuse: phone number reusable after account deletion~~ — **NON-ISSUE** (no self-serve account deletion; manual deletions handled by admin only) |
| ~~11~~ | ~~Middleware makes Clerk API call on every request~~ — **RESOLVED May 24 2026** (reads from JWT session claims; Clerk dashboard configured to embed `publicMetadata`) |
| ~~12~~ | ~~Bug report `from` address hardcoded~~ — **NON-ISSUE** (`scopesplit.com` verified in Resend; `to` hardcoded to `raganharrison97@gmail.com`) |
| ~~13~~ | ~~Stripe upgrade prorations don't charge immediately~~ — **RESOLVED May 24 2026** (`always_invoice` + `error_if_incomplete` for upgrades; real prorated amount returned from expanded `latest_invoice`) |
| ~~26~~ | ~~No way to rename a comparison in the UI~~ — **RESOLVED May 24 2026** (PATCH endpoint + inline edit in comparisons list; Enter saves, Escape cancels; ✓/✗ icon buttons in actions column) |
| ~~28~~ | ~~Stripe API version pinned to old date — cast suppresses type error~~ — **DEFERRED May 24 2026** (full test matrix + migration checklist moved to `UNIT_TESTS.md`; `as Stripe.LatestApiVersion` cast remains until audit complete) |
| ~~N6~~ | ~~`cleanup-unverified-users` deletes Clerk before DB with no error handling~~ — **RESOLVED May 24 2026** (DB delete first, then Clerk; Promise.allSettled per user; logs `[CLEANUP-ORPHAN]` for manual replay) |
| ~~N7~~ | ~~Duplicate-phone check burns Twilio Verify code before duplicate check runs~~ — **RESOLVED May 24 2026** (duplicate check moved BEFORE Twilio verification in `phone/confirm` route) |
| ~~N10~~ | ~~Failed comparisons leave orphan PDFs in Supabase storage indefinitely~~ — **RESOLVED May 24 2026** (`cleanup-failed-comparison-assets` cron: POST cleans files, GET dry-runs; 7-day grace period) |
| ~~N16~~ | ~~`finalize-checkout` only resets `comparisonsUsedThisPeriod` on period rollover~~ — **RESOLVED May 25 2026** (`llmEditsUsedThisPeriod` and `executiveSummariesUsedThisPeriod` now zeroed in same update) |
| ~~N17~~ | ~~`inngest.send` failure after DB transaction leaves zombie PROCESSING comparison + consumed usage slot~~ — **RESOLVED May 25 2026** (catch block deletes comparison row and decrements usage counter) |

### P2 — Cleanup / Tech Debt

| # | Item |
|---|------|
| ~~16~~ | ~~`PLAN_MONTHLY_PRICES_CENTS` hardcoded in `change-plan` route~~ — **RESOLVED May 24 2026** (moved to `lib/stripe.ts` as `PLAN_MONTHLY_PRICES_CENTS`) |
| ~~17~~ | ~~DELETE comparison doesn't refund usage counter (undocumented behavior)~~ — **RESOLVED May 24 2026** (added UI warning: "This will not restore your monthly comparison count.") |
| ~~22~~ | ~~`executive-summary` can exceed Claude input window on large comparisons~~ — **RESOLVED May 25 2026** (capped to top 500 items by \|diffAmount\|; truncation count surfaced in payload) |
| ~~23~~ | ~~`recalculateMatchStatus` may keep stale status when both sides blank~~ — **RESOLVED May 24 2026** (returns `MATCH_UNVERIFIED` when both sides blank instead of keeping stale status) |
| ~~24~~ | ~~Marketing footer / middleware allow-list drift risk~~ — **RESOLVED May 24 2026** (inverted to private-route matcher: protected routes listed, everything else public by default) |
| ~~N3-3~~ | ~~Phase 10 extraction validation (`N3ExtractionWarning` rows) not implemented~~ — **RESOLVED May 25 2026** (`lib/n3/passes/extraction-validation.ts` implemented; p10 stub replaced in pipeline) |
| ~~N3-4~~ | ~~Prisma migration history has schema drift~~ — **RESOLVED May 25 2026** (`20260525000000_fix_migration_drift` migration created; run `prisma migrate resolve --applied` then `prisma migrate deploy` — see below) |
| ~~N11~~ | ~~`trialPhoneHash: null` placeholder in phone confirm~~ — **RESOLVED May 24 2026** (removed placeholder from metadata update) |
| ~~N12~~ | ~~Offset-based pagination drift in cleanup cron~~ — **RESOLVED May 25 2026** (early-exit when `createdAt > cutoffTimestamp` eliminates unnecessary pages and drift window) |
| ~~N13~~ | ~~`findFirst` → `findUnique` on `stripeCustomerId`~~ — **RESOLVED May 25 2026** (`@unique` added to schema; `20260525010000_add_stripe_customer_id_unique` migration created; `findUnique` in webhook; run `prisma migrate deploy`) |
| ~~N18~~ | ~~`UsageLimitError` race in `POST /api/comparisons` returns 403 before file-cleanup block~~ — **RESOLVED May 25 2026** (file cleanup now runs before 403 return) |
| ~~N19~~ | ~~`/api/billing/(.*)`, `/api/user/(.*)`, `/api/n3/(.*)` missing from `proxy.ts` `isProtectedRoute` matcher~~ — **RESOLVED May 25 2026** (three paths added to block-list) |
| ~~N15~~ | ~~`debug-trace.ts` trace file race under concurrent dev runs~~ — **RESOLVED May 24 2026** (filename now includes comparisonId: `pipeline-trace-${comparisonId}.txt`) |

### Pre-Deploy — Operational Checklist ✅ COMPLETE (Jun 3 2026)

> **STATUS: ALL ITEMS COMPLETE. App is live at scopesplit.com.** Full detail and rationale for every item below lives in `PRODUCTION_CUTOVER_CHECKLIST.md`.

**Environment & Secrets** ✅

| # | Item |
|---|------|
| ~~PD-1~~ | ~~Set all production env vars in Vercel: Clerk, Supabase, Prisma, Anthropic, Stripe, Resend, Twilio, Inngest~~ — **DONE** |
| ~~PD-2~~ | ~~Remove `INNGEST_DEV` from Vercel production env~~ — **DONE** |
| ~~PD-3~~ | ~~Set `TRIAL_IP_HASH_SALT`, `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED=true`, cleanup vars, `CRON_SECRET`~~ — **DONE** |
| ~~PD-4~~ | ~~Rotate exposed development secrets~~ — **DONE** |
| ~~PD-5~~ | ~~Remove old `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` env vars~~ — **DONE** |

**Dashboard Configuration** ✅

| # | Item |
|---|------|
| ~~PD-6~~ | ~~Clerk: production webhook endpoint → `https://scopesplit.com/api/webhooks/clerk`~~ — **DONE** |
| ~~PD-7~~ | ~~Clerk: production domain added, stale localhost entries removed~~ — **DONE** |
| ~~PD-8~~ | ~~Stripe: all 6 live products/prices confirmed; `STRIPE_PRICE_*` pointing to live-mode~~ — **DONE** |
| ~~PD-9~~ | ~~Stripe: production webhook → `https://scopesplit.com/api/webhooks/stripe`, 5 events enabled~~ — **DONE** |
| ~~PD-10~~ | ~~Inngest Cloud: `https://scopesplit.com/api/inngest` registered; function registered with all step IDs~~ — **DONE** |
| ~~PD-11~~ | ~~Vercel Cron: `vercel.json` cron confirmed firing cleanup daily at 04:00 UTC~~ — **DONE** |
| ~~PD-12~~ | ~~Vercel log drain configured with alert on `"STRIPE_WEBHOOK_UNMAPPED_PRICE"`~~ — **DONE** |

**Vercel / Runtime Checks** ✅

| # | Item |
|---|------|
| ~~PD-13~~ | ~~`maxDuration` on `/api/inngest` confirmed at appropriate value for Pro+Fluid~~ — **DONE** |
| ~~PD-14~~ | ~~`ANTHROPIC_EXTRACTION_TIMEOUT_MS=600000` set in Vercel~~ — **DONE** |
| ~~PD-15~~ | ~~`ENABLE_REAL_COMPARISON_PROCESSING=true` confirmed in production env~~ — **DONE** |
| ~~PD-16~~ | ~~Debug env vars (`DUMP_PIPELINE_TRACE`, `DUMP_HAIKU_ZONES`) unset in production~~ — **DONE** |

**Smoke Tests** ✅

| # | Item |
|---|------|
| ~~PD-17~~ | ~~Clerk webhooks: sign up → `/verify-phone` → DB row verified; update/delete sync verified~~ — **DONE** |
| ~~PD-18~~ | ~~Stripe billing: full checkout → plan metadata set; plan change; cancel + resume; add-on purchase~~ — **DONE** |
| ~~PD-19~~ | ~~Comparison pipeline: real comparison confirmed `PROCESSING → COMPLETED`; Inngest Cloud shows all steps~~ — **DONE** |
| ~~PD-20~~ | ~~AI tools: LLM Edit, Executive Summary, Inline Edit verified; 429 cap confirmed; period reset confirmed~~ — **DONE** |
| ~~PD-21~~ | ~~Resend: bug report (with screenshot) and contact form emails confirmed delivered~~ — **DONE** |
| ~~PD-22~~ | ~~Cleanup cron: manual POST with secret header succeeded~~ — **DONE** |

---

### Future Work

| # | Item |
|---|------|
| ~~31-deferred~~ | ~~Symbility format compatibility testing~~ — **SUPERSEDED by N4** (N4 pipeline implements full Symbility support; separate N3 discovery work is no longer needed) |

---

## Full Detail — All Items (Open and Resolved)

---

## P0 — Pre-launch Blockers

### 39. Re-enable Stripe trial-abuse enforcement **(OPEN)**
- **File**: `app/api/stripe/checkout/route.ts`
- **Symptom**: Phone reuse check against Stripe customer metadata, IP hash reuse check (`TRIAL_IP_HASH_SALT`), and metadata writes for `trial_phone_number` / `trial_ip_hash` are **all disabled** with comments noting "temporarily disabled to allow repeated local testing."
- **Impact**: In production, any user could bypass trial limits by creating a second account with a different email and the same phone number or IP address.
- **Fix**: Before production, restore all three in `checkout/route.ts`:
  1. Phone reuse check — query Stripe customer metadata for `trial_phone_number`, compare to verified phone.
  2. IP hash reuse check — hash the request IP with `TRIAL_IP_HASH_SALT`, compare to `trial_ip_hash` in metadata.
  3. Metadata writes — on successful trial start, write `trial_phone_number` and `trial_ip_hash` to Stripe customer metadata.

---

### 1. Contact form is not wired to any backend ~~OPEN~~ — **RESOLVED Apr 27 2026**
- **File**: `estimatch-app/app/(marketing)/contact/page.tsx`
- **Resolution**:
  - Added public `POST /api/contact/route.ts` (no auth) with input validation (name ≤120, email RFC-lite + ≤254, message ≤5000), Resend send to `raganharrison97@gmail.com`, subject `[Contact Form] from <name>`, `reply_to` set to submitter's address.
  - Added `/api/contact(.*)` to the public-routes allow-list in `proxy.ts`.
  - Wired marketing `contact/page.tsx` `handleSubmit` to call the endpoint with `submitting`/`submitError` states; success state still shows the existing "Message sent" panel.
  - In-app `app/app/help/page.tsx` was already wired to `/api/bug-report`, which sends to the same inbox; updated copy from "Describe the bug" / "Submit another report" to "Your message" / "Send another message" to match the generic Contact-Us framing.
  - **Verified end-to-end Apr 27 2026**: both forms submitted successfully and emails landed in `raganharrison97@gmail.com`.
- **Follow-ups deferred**: CAPTCHA / per-IP rate limit on the public endpoint (abuse risk). Currently relies only on length caps + email regex.

### 2. Bug report + Contact inbox is a personal Gmail
- **Files**:
  - `estimatch-app/app/api/bug-report/route.ts:4`
  - `estimatch-app/app/api/contact/route.ts:8`
- **Symptom**: Both routes ship `raganharrison97@gmail.com` as the recipient. **Per user direction (Apr 27 2026), this is intentional for now — leaving as-is.**
- **Future cleanup** (when a `support@scopesplit.com` inbox is provisioned): replace both constants with `process.env.SUPPORT_INBOX ?? 'raganharrison97@gmail.com'` and document in `PRODUCTION_CUTOVER_CHECKLIST.md`.

### 3. Stripe Billing Portal default return URL is `localhost:3000` ~~OPEN~~ — **RESOLVED-BY-REMOVAL Apr 27 2026**
- **Original concern**: `app/api/stripe/portal/route.ts` had a hardcoded `'http://localhost:3000/app/settings'` fallback that would strand production users on a broken page after using Stripe's hosted Billing Portal.
- **Resolution**: Audit revealed the route was **dead code** — no UI, API, or webhook called it. ScopeSplit's plan management is entirely in-app via the tier-selector modal (`Manage subscription` button in Settings) which posts to `POST /api/stripe/change-plan`. The Stripe-hosted portal is not used.
- **Cleanup performed**:
  - Deleted `estimatch-app/app/api/stripe/portal/route.ts` and its containing directory.
  - Removed `STRIPE_PORTAL_RETURN_URL` from `estimatch-app/.env.local`.
  - Renamed misleading `openBillingPortal()` → `openManageSubscription()` in `estimatch-app/app/app/settings/page.tsx` with an explanatory comment clarifying no Stripe-hosted portal is involved.
  - Synced `PROJECT_CONTEXT.md`, `PRODUCTION_CUTOVER_CHECKLIST.md`, and `DATABASE_TECHNICAL_DOCS.md` to remove all references to the route and env var, and dropped the "Configure Billing Portal in Stripe" step from the cutover checklist.
- **Future**: If invoice history or self-serve payment-method updates are ever needed, the Stripe Billing Portal can be re-introduced — use `request.nextUrl.origin` to derive `return_url` so no env var is required.

### 4. No rate limit / billing cap on AI-cost endpoints ~~OPEN~~ — **RESOLVED-BY-IMPLEMENTATION Apr 27 2026**
- **Resolution**: Implemented flat per-tier monthly caps on both AI endpoints. See `PROJECT_CONTEXT.md` Phase 6f for the full design. Caps: Starter 20 edits / 10 summaries, Professional 100 / 50, Business 400 / 200. Both reset on the existing `periodResetDate` billing anchor.
- **Files added/changed**:
  - `estimatch-app/lib/usage.ts` (new) — gate helpers (`UsageKind`, `UsageLimitError`, `rolloverPeriodIfNeeded`, `assertWithinLimit`, `tryIncrementUsage`).
  - `estimatch-app/lib/stripe.ts` — canonical `PLAN_LLM_EDIT_LIMITS`, `PLAN_EXECUTIVE_SUMMARY_LIMITS`, `PLAN_COMPARISON_LIMITS` constants.
  - `estimatch-app/prisma/schema.prisma` — added `llm_edits_used_this_period` and `executive_summaries_used_this_period` columns on `users`.
  - `apply-edits/route.ts` and `executive-summary/route.ts` — pre-call rollover + cap check, race-safe atomic increment after the Anthropic call succeeds, structured 429 response.
  - `app/api/billing/summary/route.ts` — returns the new usage stats.
  - `app/api/webhooks/stripe/route.ts` — period rollover now resets AI counters too.
  - `app/app/settings/page.tsx` — two new usage rows under the existing Comparisons row.
  - `app/app/comparison/[id]/page.tsx` — surfaces refresh-date in the user-facing error when a 429 is hit.

### 25. Prisma migrations never set up — schema/DB/client drift risk ~~P0~~ — **DEFERRED / NON-ISSUE May 24 2026**
> Single Supabase instance serves both dev and prod — no environment drift risk. Implement if/when a separate staging or prod instance is provisioned. 10-minute setup at that time.
- **Files**:
  - `estimatch-app/prisma/schema.prisma` — current schema definition
  - `estimatch-app/prisma/migrations/` — **does not exist**
  - `estimatch-app/package.json:7` — build script is just `next build`, no `prisma migrate deploy`
- **Discovery context**: While setting up N1 Inngest baseline capture, `GET /api/comparisons/[id]` started returning 500s with `P2022: The column users.addon_llm_edits_this_period does not exist in the current database.` Root cause: the generated Prisma Client was stale — built from a schema version that once contained this field, but the field no longer exists in `schema.prisma` or in the Supabase DB. Running `npx prisma generate` resynced the client and fixed dev. But `npx prisma migrate status` then revealed: **"No migration found in prisma/migrations"** — the project has never used migrations. All schema changes to date have been applied via `prisma db push` (or manual SQL), with no history.
- **Symptom** (dev — fixed): generated client out of sync with schema → 500s on any query touching affected tables.
- **Symptom** (prod — latent): without migrations set up and without `prisma migrate deploy` in the build, Vercel has no way to apply schema changes to the production Supabase DB. The first real schema change after launch will either (a) break in prod because the DB column is missing, or (b) require manual SQL on prod, which is exactly how drift accumulated to begin with. Also, without a migration history there is no rollback path and no replayable schema in a new environment.
- **Fix** (pre-launch, do once):
  1. Baseline the current DB as the initial migration:
     ```
     npx prisma migrate dev --name baseline --create-only
     npx prisma migrate resolve --applied <timestamp>_baseline
     ```
  2. Update `package.json`:
     ```json
     {
       "scripts": {
         "build": "prisma migrate deploy && next build",
         "postinstall": "prisma generate"
       }
     }
     ```
  3. Commit `prisma/migrations/` to the repo (when GitHub is set up).
- **Going forward**: every schema change uses `npx prisma migrate dev --name <description>` which (a) creates a committed migration, (b) applies to dev DB, (c) regenerates client. **Never use `prisma db push` again.**
- **Why P0**: without this, the first prod schema change after launch is likely to cause a `P2022` column-not-found outage. Also natural to pair with N1 Phase 2 (which adds the `ComparisonProcessingState` table and should be the first real migration).
- **Cross-reference**: `PRODUCTION_CUTOVER_CHECKLIST.md` should gain a §4.X item for "Migrations configured + applied to prod DB" before launch.

### 30. PDF extraction prompt is hardcoded for numbered Xactimate output — silently fails on unnumbered formats ~~OPEN~~ — **RESOLVED May 24 2026**
- **File**: `estimatch-app/lib/pdf-vision-extract.ts:65-105` (`EXTRACTION_USER_PROMPT`)
- **Discovery context**: While running N1 Phase 8.6 (large-comparison stress test), uploaded synthetically-generated 67-page PDFs containing ~1000 line items each. Haiku reported `total_count=43` and `total_count=50` for yours/adjuster respectively, with `truncated=false`. Initial assumption was that the PDFs contained only ~50 items; confirmed via `scripts/diagnose-pdf.ts` (added Apr 29) that the PDFs **do** contain ~1000 items in standard table format (description / qty / remove / replace / tax / O&P / total columns) — but with **no numeric prefix** on each row (no "1.", "2.", "247." style numbering).
- **Symptom — extraction silently degrades**: the prompt opens with *"Extract every numbered line item from this Xactimate estimate PDF. Each item starts with a number followed by a period (e.g. '1.', '2.', '247.')."* On a PDF without numbered prefixes, Haiku does NOT return empty — it instead **hallucinates ~50 items from training data** that don't appear anywhere in the source PDF. Verified by comparing `scripts/haiku-raw-zones-adjuster.json` output (items "Dumpster load", "Supervision / Project Management", "Cleaning Technician") against the actual PDF content (items "Install Refrigerator", "R&R Tile floor covering", "Temporary power usage"). The two are completely disjoint.
- **Why this is P0**: silent hallucination is worse than a hard failure. The pipeline produces a `COMPLETED` comparison with totally fabricated line items, and the user has no way to know the data is wrong. With paid AI cost on top, a single user could trigger an unbounded pattern of garbage output → wasted spend → potential refund/support liability.
- **Production reality**: Xactimate PDFs from real loss adjusters DO have numbered prefixes by default, so the dev-environment evidence we have (Phase 1 baselines, P7.6 smoke test) all came from properly-formatted inputs. The prompt has never been stress-tested against non-numbered formats. This will surface the moment the first real-world user uploads (a) a Symbility export (different layout entirely — see #31), (b) an Xactimate export with line numbers stripped, or (c) any other estimating-software output.
- **Fix**:
  1. **Format detection step before extraction**: pre-flight the PDF (small Haiku call or pdf-parse text scan) to detect whether items have numeric prefixes. Branch into one of N format-specific extraction prompts based on the result.
  2. **Anti-hallucination guard in the existing prompt**: explicitly instruct *"if no numbered line items are found in this PDF, return `{\"total_count\":0,\"items\":[]}` — do not invent items"*. Then in `extractWithVision`, if a non-trivial PDF (>5 pages, >5KB text) returns 0 items, throw a `Stage A: extraction returned no items — possible unsupported format` error instead of proceeding to Stages B-D with garbage.
  3. **Format-tolerance**: long-term, the prompt should support at minimum: (a) Xactimate numbered, (b) Xactimate unnumbered, (c) Symbility (see #31 for details), and ideally (d) generic restoration estimate tables. Tracking matrix needed.
- **Acceptance criteria**:
  - A non-numbered PDF either extracts correctly OR throws a clear "unsupported format" error — never produces hallucinated output.
  - All three of Xactimate-numbered, Xactimate-unnumbered, and Symbility produce output that, when spot-checked against the source PDF, contains no fabricated items.
  - `scripts/diagnose-pdf.ts` (added Apr 29 for this debugging) should be retained and used as part of QA when validating new format support.
- **Cross-references**:
  - Symbility format testing and construction is tracked in items #36 and #31-deferred below.

---

## P1 — Should-fix Before Scale

### 5. `apply-edits` silent display-order fallback ~~OPEN~~ — **RESOLVED May 3 2026**
- **Resolution**: Added `console.warn` with `comparisonId`, resolved count, and total count when fewer than 50% of `displayItemIds` resolve. Log is grep-able in Vercel logs (`[apply-edits] comparisonId=... display-order sync mismatch`). The stale-view scenario is now visible in production logs.
- **File**: `estimatch-app/app/api/comparisons/[id]/versions/apply-edits/route.ts`

### 6. `inline-edits` creates an empty version when no item IDs match ~~OPEN~~ — **RESOLVED May 3 2026**
- **Resolution**: Added `appliedEditCount` tracker inside `sourceRows.map`. After inserts/deletions are applied, if `inlineEdits.length > 0` but `appliedEditCount === 0` (and no inserts/deletions), returns 409 `{ error: 'No edits matched any current line item. Reload the page and try again.' }` before the version-number DB query — no wasted transaction.
- **File**: `estimatch-app/app/api/comparisons/[id]/versions/inline-edits/route.ts`

### 7. Comparisons list is silently capped at 50 rows
- **File**: `estimatch-app/app/api/comparisons/route.ts:209` (`take: 50`)
- **Symptom**: An Enterprise user with 200 comparisons/month sees only the latest 50 in `/app/comparisons`. No pagination, no "load more". Older comparisons are inaccessible from the UI even though they exist in the DB.
- **Fix**: Add cursor/offset pagination (e.g., `?cursor=<createdAt>&limit=50`) and a "Load more" button on the frontend list page.

### 8. AI endpoints have no fetch timeout ~~OPEN~~ — **RESOLVED Apr 27 2026 (evening pass)**
- **Resolution**: Added `AbortController` timeouts to both Anthropic fetches.
  - `apply-edits/route.ts`: 45s timeout (`LLM_EDIT_TIMEOUT_MS`).
  - `executive-summary/route.ts`: 55s timeout (`SUMMARY_TIMEOUT_MS`).
  - Both use `try/finally { clearTimeout(...) }` to guarantee cleanup on all paths.
  - Both detect `err.name === 'AbortError'` and return `504 "AI service timed out. Please try again."` (distinct from the 502 used for other fetch failures).
- **Companion fix**: Both routes also got `export const maxDuration = 60` so the platform allows the full timeout window to elapse (see N2 in the April 27 evening pass below).
- **Verified**: standalone Node script with a hung server confirmed `AbortError` fires within the expected window and the `err.name` detection pattern used in production code path works.

### 9. New-comparison polling has no max duration
- **File**: `estimatch-app/app/app/new-comparison/page.tsx:190`
- **Symptom**: Frontend polls `/api/comparisons/[id]` every 2.5s indefinitely. If processing genuinely fails without flipping `status` to `FAILED` (or just hangs past the 30-min server timeout), the UI shows the spinner forever.
- **Fix**: Add a max-poll-duration (e.g., 25 min) after which the UI shows "This is taking longer than expected. Try refreshing — if the issue persists, contact support." Backend `PROCESSING_TOTAL_TIMEOUT_MS` is 30 min, so 25 min on the frontend gives a buffer.

### 10. Trial-abuse: phone re-use after account deletion
- **Files**:
  - `estimatch-app/app/api/verification/phone/start/route.ts:65–78`
  - `estimatch-app/app/api/verification/phone/confirm/route.ts:131–144`
- **Symptom**: The duplicate-phone check queries the `users` table only. When a user is deleted (Clerk webhook → cascade delete), the row is gone, and the phone number can be re-used for another trial. The `phoneVerifiedForTrial` Clerk metadata + new account = new free trial.
- **Fix**: Add a `trial_phone_history` table that records every verified phone (with hash + verifiedAt) and persists across user deletion. Reject any phone that appears in the history. Or: write a hashed phone to a Supabase storage object/redis key with a long TTL that survives user delete.

### 11. Middleware makes a Clerk API call on every request
- **File**: `estimatch-app/proxy.ts:52`
- **Symptom**: For every signed-in request to `/app/*`, `/subscribe`, `/verify-phone`, or marketing pages, the middleware calls `clerkClient.users.getUser(userId)`. At scale this hammers Clerk's API quotas and adds 100–300ms to every request.
- **Fix**: Read `plan` and `phoneVerifiedForTrial` from the session token's `publicMetadata` claim (Clerk supports this — Clerk JWT claims) instead of round-tripping. Already-paid users would have these claims at signin.

### 12. Bug report `from` address ships in code
- **File**: `estimatch-app/app/api/bug-report/route.ts:103`
- **Symptom**: `from: 'ScopeSplit Bug Reports <bugs@scopesplit.com>'` is hardcoded. If the domain isn't verified in Resend yet, all bug reports silently 4xx and the user sees a generic error.
- **Fix**: Move to env var `BUG_REPORT_FROM`. Confirm domain verification is part of `PRODUCTION_CUTOVER_CHECKLIST.md` §4.4 (it already is — just enforce the env-var swap).

### 13. `change-plan` upgrade prorations don't charge immediately
- **File**: `estimatch-app/app/api/stripe/change-plan/route.ts:146–161`
- **Symptom**: Uses `proration_behavior: 'create_prorations'` which queues the proration on the next invoice. The frontend reads `amountDueNowCents` from the response and tells the user "you'll be charged X now" — but Stripe doesn't actually charge until next billing cycle.
- **Fix**: Either:
  - Pass `payment_behavior: 'pending_if_incomplete'` + `billing_cycle_anchor: 'now'` to bill immediately and update the period anchor; **or**
  - Update copy on the frontend to "X will be added to your next invoice".

### 27. `apply-edits` route fails production type-check (P0, RESOLVED Apr 28 2026)
- **File**: `estimatch-app/app/api/comparisons/[id]/versions/apply-edits/route.ts:540`
- **Discovery context**: Discovered during the first `npm run build` run after Phase 2C of the N1 work configured `prisma migrate deploy && next build` as the production build script. `next dev` skips strict type-checking, so this had been latent for some unknown period — but `next build` (which Vercel runs on every deploy) enforces it. **A Vercel deploy attempted before this fix would have failed at build time.**
- **Symptom**: `Type error: Argument ... is not assignable to parameter of type 'SourceRow'. Property 'itemId' is missing.` The `add` branch of the apply-edits handler was constructing rows for added line items without the `itemId` field that the local `SourceRow` type required.
- **Root cause**: `itemId` is used internally for runtime lookup in `sourceIdMap` to resolve `displayItemIds` from the frontend back to their source-row indices. It is never persisted to the DB. Added rows (newly inserted via LLM edit) have no pre-existing source item, so the field was simply omitted, which violated the type contract.
- **Fix applied**: Added `itemId: crypto.randomUUID()` to the `addedRows.push()` call. The synthetic UUID won't collide with real DB IDs and won't be looked up in `displayItemIds` (since the frontend doesn't know about this newly added row yet). One-line change.
- **Why this matters going forward**: Tonight's `prisma migrate deploy && next build` change to `package.json` means every future deploy actually enforces the build's type-check. This will catch any new latent type errors before they reach production. Worth adding to `PRODUCTION_CUTOVER_CHECKLIST.md` that "first successful `npm run build` locally before push" is now a prerequisite.
- **Follow-up**: Worth a sweep with `npx tsc --noEmit` to find any other pre-existing type errors that `next build` might catch.

### 28. Stripe API version pinned to `2025-03-31.basil` while SDK expects `2025-08-27.basil` **(P1, OPEN — discovered Apr 28 2026)**
- **File**: `estimatch-app/lib/stripe.ts:17`
- **Discovery context**: Caught by `next build` strict type-check immediately after fixing #27. Same root cause class — pre-existing type drift that `next dev` doesn't enforce.
- **Symptom**: `Type error: Type '"2025-03-31.basil"' is not assignable to type '"2025-08-27.basil"'.` The Stripe SDK shipped at `^18.4.0` was upgraded at some point and now declares `LatestApiVersion` as `'2025-08-27.basil'`, but the constructor still pins the older date.
- **Why this is NOT just "change the date and move on"**: The `apiVersion` string tells Stripe which response format to send back. Bumping the date from `2025-03-31` → `2025-08-27` means Stripe responds with the **newer schema**, which could change shapes in ways that break:
  - Webhook handlers (`app/api/webhooks/stripe/route.ts`)
  - Subscription/customer/invoice parsing code
  - `change-plan` proration logic
  - Anything that reads from a Stripe response object
- **Temporary fix applied (Apr 28 2026)**: Cast the string with `as Stripe.LatestApiVersion` to satisfy the type-check while keeping the runtime API version unchanged. Build now passes. **The actual API behavior is identical to before this fix** — Stripe still responds with the `2025-03-31` shape.
- **Proper fix (deferred — pre-launch checklist item)**:
  1. Read Stripe's [API changelog](https://docs.stripe.com/upgrades) entries between `2025-03-31` and `2025-08-27` (5 months of changes — for products this app uses: Customers, Subscriptions, PaymentIntents, Checkout Sessions, Invoices, Webhooks).
  2. Audit each Stripe response handler in the codebase for fields that may have changed shape, been deprecated, or been added.
  3. Update the API version string + remove the cast.
  4. Test against Stripe test mode end-to-end (subscribe, change-plan, cancel, webhooks for invoice.payment_succeeded, customer.subscription.updated, etc.).
  5. Then deploy.
- **Why P1, not P0**: The cast preserves current behavior, so it's not blocking launch. But the cast is a deferred maintenance burden — when the SDK is next upgraded, the gap widens and the eventual migration gets harder. Should be addressed before significant traffic.
- **Cross-reference**: `PRODUCTION_CUTOVER_CHECKLIST.md` should gain an item: "Audit Stripe response handlers and migrate to current API version" before the first production webhook fires.

### 29. `useSearchParams()` not wrapped in Suspense — 4 pages would fail prerender (P0, RESOLVED Apr 28 2026)
- **Files**:
  - `estimatch-app/app/(auth)/subscribe/page.tsx`
  - `estimatch-app/app/(auth)/verify-phone/page.tsx`
  - `estimatch-app/app/app/help/page.tsx`
  - `estimatch-app/app/app/settings/page.tsx`
- **Discovery context**: Surfaced one at a time during repeated `npm run build` invocations after fixes #27 and #28. Next.js 13+ App Router requires `useSearchParams()` to be called inside a `<Suspense>` boundary so the page can be statically prerendered. Without it, the page hits a CSR bailout error during the build's prerender phase. **`next dev` does not enforce this** — only `next build` does. So all 4 pages would have failed Vercel deployment.
- **Symptom**: `useSearchParams() should be wrapped in a suspense boundary at page "/<page>". Read more: https://nextjs.org/docs/messages/missing-suspense-with-csr-bailout` followed by `Error occurred prerendering page "/<page>". Export encountered an error..., exiting the build.`
- **Fix applied** (same pattern, all 4 files):
  1. Added `Suspense` to the React import
  2. Renamed the original `default function <PageName>` to `function <PageName>Content`
  3. Created a new `default function <PageName>` that returns `<Suspense fallback={null}><<PageName>Content /></Suspense>`
- **Why this passed `next dev` but not `next build`**: Dev mode renders pages on-demand at request time, where `useSearchParams()` always has a value. Build mode prerenders pages at build time with no request context, where `useSearchParams()` triggers a "client-side rendering bailout" — Next.js requires the bailout to be inside a `<Suspense>` boundary so the static shell can render around the dynamic part.
- **Why all 4 in one go (proactive, not reactive)**: After hitting the same error on `/subscribe` then `/verify-phone`, ran `grep_search` for all `useSearchParams()` usages in `app/**/page.tsx` and fixed all 4 callers in one batch instead of waiting for each to break the build. Took the build from "fails on `/verify-phone`" to "all 44 pages prerender clean" in a single change.
- **Related cleanup**: Worth a code review for any client components that use `useSearchParams()` (not just pages) — those need the same Suspense wrapper at their import site. Quick audit recommended.

### 26. No way to rename a comparison in the UI **(P1, OPEN — requested Apr 28 2026)**
- **Symptom**: Comparisons in the list view are labeled with the default title (e.g. `"Contractor_Estimate_Set3.pdf vs Adjuster_Estimate_Set3.pdf"`). Users have no way to give them a meaningful name ("Smith claim — April 2026", "Jones residence — flood"). When a user has multiple comparisons for the same PDF pair (e.g. re-runs), they're indistinguishable except by date.
- **Backend readiness**: `Comparison.name` already exists in the schema (`prisma/schema.prisma:80`, nullable `String?`). Just needs a PATCH endpoint and UI wiring — no migration required.
- **Fix** (scope):
  1. **API**: Add `PATCH /api/comparisons/[id]` accepting `{ name: string }`. Validate length (e.g. 1–120 chars), trim, reject empty after trim. Auth-gated same as DELETE.
  2. **Comparisons list UI** (`app/app/comparisons/page.tsx`): Add "Rename" option to the 3-dot dropdown (above "Delete"). Opens an inline input or small modal. On save, PATCH + optimistic UI update.
  3. **Comparison detail page UI** (`app/app/comparison/[id]/page.tsx`): Make the title editable (click-to-edit or "Rename" button near the header).
  4. **API list response**: Confirm `GET /api/comparisons` returns the `name` field and the list page uses it as the display title when present, falling back to the current auto-generated "X vs Y" label when `name` is null.
- **Why P1**: Core UX — with more than a handful of comparisons, users can't tell them apart. Not a launch blocker but close to one for usability.

---

## P2 — Cleanup / Tech Debt

### 14. `PLAN_LIMITS` (10/50/200) is duplicated across 3 files ~~OPEN~~ — **PARTIALLY RESOLVED Apr 27 2026**
- **Resolution**: Extracted to `lib/stripe.ts` as `PLAN_COMPARISON_LIMITS`. `app/api/comparisons/route.ts` and `app/api/billing/summary/route.ts` now import from there. `app/api/stripe/change-plan/route.ts` still has its own copy because it indexes by lowercase plan key (`starter`/`professional`/`business`) rather than the SubscriptionTier enum (`STARTER`/`PROFESSIONAL`/`ENTERPRISE`); a follow-up could add a parallel lowercase-keyed map to `lib/stripe.ts` to fully consolidate.

### 15. `ADDON_COMPARISON_GRANTS` (5/10/10) is in the webhook only ~~OPEN~~ — **RESOLVED Apr 27 2026**
- **Resolution**: Moved to `lib/stripe.ts` as `ADDON_COMPARISON_GRANTS`. Webhook now imports it. Per user direction (Apr 27 2026), AI tools have no add-on extension path — only comparison add-ons exist.

### 16. `PLAN_MONTHLY_PRICES_CENTS` (4999/9900/24900) hardcoded
- **File**: `estimatch-app/app/api/stripe/change-plan/route.ts:19–23`
- **Fix**: Either fetch from Stripe at request time (more accurate but slower) or move to `lib/stripe.ts` as the single source.

### 17. DELETE comparison does not refund the usage counter
- **File**: `estimatch-app/app/api/comparisons/[id]/route.ts:301–352`
- **Symptom**: Soft-delete-and-create-again would let a user game the comparison limit. Currently the design is "deletes are permanent and don't refund usage" — but this is undocumented in the UI.
- **Fix**: Add a confirmation dialog message: "Deleting will not restore your monthly comparison count." Or refund and accept the abuse risk.

### 18. `pair-edits/preview` endpoint is a partial/scaffolded feature ~~OPEN~~ — **RESOLVED-BY-ARCHIVE Apr 27 2026**
- **Original concern**: `app/api/comparisons/[id]/pair-edits/preview/route.ts` + `lib/pair-edits/operations.ts` were a "preview-only" endpoint that validated row-pair operations but never mutated anything. No frontend used it.
- **Resolution**: Both files archived to `estimatch-app/DELETED CHANGES/2026-04-27-cleanup/pair-edits/`. The empty parent directories (`app/api/comparisons/[id]/pair-edits/preview/`, `app/api/comparisons/[id]/pair-edits/`, `lib/pair-edits/`) were also removed. Decision was finish-or-remove; remove won. If pair-management UI work resumes, restore from the archive.

### 19. `escapeHtml` in bug-report doesn't escape single quotes ~~OPEN~~ — **RESOLVED May 3 2026**
- **Resolution**: Added `.replace(/'/g, '&#39;')` as the fifth chain in `escapeHtml`. All five standard HTML entities now escaped: `&`, `<`, `>`, `"`, `'`.
- **File**: `estimatch-app/app/api/bug-report/route.ts`

### 20. `apply-edits` `addedRows.push({...})` missing required `itemId` field
- **File**: `estimatch-app/app/api/comparisons/[id]/versions/apply-edits/route.ts:455–484`
- **Symptom**: Pushed object literal omits the `itemId` field (declared as `string` non-null on `SourceRow`). TypeScript should flag this; appears to compile because of structural-typing inference. Works at runtime because the persist step (`createMany` at 524) doesn't read `itemId`.
- **Fix**: Refactor `addedRows` to a separate type that omits `itemId`, or assign a placeholder UUID.

### 21. Notes routes tell the user to "run the latest database migration" ~~OPEN~~ — **RESOLVED May 3 2026**
- **Resolution**: Replaced both production error strings with `'Unable to load notes. Please try again or contact support if the issue persists.'` and `'Unable to save note. Please try again or contact support if the issue persists.'` Technical details still logged server-side via `console.error`.
- **File**: `estimatch-app/app/api/comparisons/[id]/notes/route.ts`

### 22. `executive-summary` could exceed Claude input window for huge comparisons
- **File**: `estimatch-app/app/api/comparisons/[id]/executive-summary/route.ts:251`
- **Symptom**: `lineItems: sanitizedItems` includes every line item. For 200+ item comparisons, the JSON payload approaches Claude's input window. No chunking or pruning.
- **Fix**: For comparisons over a threshold (e.g., 150 items), include only the top-N items by absolute `diffAmount` plus aggregate stats.

### 23. Inline-edit `recalculateMatchStatus` may keep stale status
- **File**: `estimatch-app/app/api/comparisons/[id]/versions/inline-edits/route.ts:18`
- **Symptom**: When both sides are blank after the edit, it returns the prior status rather than (e.g.) marking the row as a candidate for delete.
- **Fix**: Either filter out fully-blank rows during persist, or document the behavior.

### 24. Marketing footer paths and middleware allow-list drift risk
- **File**: `estimatch-app/proxy.ts:4–27`
- **Symptom**: Each new marketing page has to be added to the public-route allowlist manually. Easy to forget when adding a new page.
- **Fix**: Switch to a "private route matcher" approach — allow everything by default and only protect `/app/*`, `/subscribe`, `/verify-phone`, and authed APIs.

---

## Testing Tasks (deferred, tracked separately)

These will be tackled after implementation work above is complete. Listed here only so they're not lost.

- Test contact form end-to-end after wiring (P0 #1).
- Test bug-report email delivery in production with verified Resend domain.
- Smoke-test LLM Edit, Inline Edit, and Executive Summary in production after rate-limit guard is added.
- Verify Stripe webhook event handling with live keys (`checkout.session.completed`, `customer.subscription.*`, `invoice.payment_failed`).
- Verify trial-abuse phone re-use scenarios after fix #10 lands.
- Verify cleanup-cron path with production secrets.

---

## Already-Resolved (this session)

Items closed during the Apr 27, 2026 review session:

- Notes truncated at 500 chars → split into `sanitize` (500) + `sanitizeNote` (4000) — `executive-summary/route.ts`.
- Markdown table sparse cells dropped → preserve interior empty cells — `lib/markdown-to-html.ts`.
- Executive Summary modal had no Escape-key handler → added `useEffect` mirroring the LLM Edit modal — `app/app/comparison/[id]/page.tsx`.

---

## April 27, 2026 Evening Pass — Vercel / Production-Readiness Hardening

A second deep review specifically evaluating behavior under **Vercel serverless constraints** surfaced 15 additional findings (tagged N1–N15). Items below supplement the numbered P0/P1/P2 list above; their IDs are stable across session handoffs.

### N1 — Comparison processing is fire-and-forget in `POST /api/comparisons` (**P0, RESOLVED Apr 29 2026 — full N1 ledger in `N1_INNGEST_CONVERSION.md`**)
- **Status**: ✅ **RESOLVED.** All 9 phases of the Inngest conversion are complete and empirically verified. `POST /api/comparisons` now `await inngest.send({ name: 'comparison/process.requested', ... })` and returns `202 Accepted`. The durable `processComparison` worker runs the 4-stage pipeline (extract → reconcile-and-prematch → pair → finalize-and-persist) with per-`comparisonId` concurrency, retries, idempotency guard, and Supabase intermediate-state escape hatch. Empirically verified end-to-end on a 1,717-input-item / 1,525-output-item comparison (`ff969ae4-...`) completing in ~13 min wall-clock. **Cutover playbook**: `PRODUCTION_CUTOVER_CHECKLIST.md` §4.7. **Hand-offs to N2**: items #32 (continuation hallucination), #33 (Stage A page-chunking), #34 (undici prod verification) above.
- **File**: `estimatch-app/app/api/comparisons/route.ts:354–358`
- **Symptom**: `void runComparisonProcessing(...)` is started after the 201 response is returned. On Vercel serverless, the lambda is terminated as soon as the response is sent; the heavy PDF-extract + Claude pipeline is interrupted mid-run. In local dev the Node process persists, which is why this never surfaces during development.
- **Impact**: In production, newly-created comparisons can remain stuck in `PENDING` forever, or flip to `FAILED` part-way through. The loading screen (which polls status) would spin indefinitely or time out.
- **Resolution path (in progress)**: Multi-step Inngest worker — see `N1_INNGEST_CONVERSION.md` for the full ledger.
  - ✅ **Phase 1** (Apr 28): 3 baseline snapshots captured for behavior-preservation diffing.
  - ✅ **Phase 2** (Apr 28): Prisma migrations baselined; `ComparisonProcessingState` intermediate-state table added; build script now runs `prisma migrate deploy && next build`; helpers (`writeStage` / `readStage` / `hasStage` / `clearStage`) created and smoke-tested.
  - ✅ **Phase 3** (Apr 28): `runRealProcessing` refactored into 4 exported stage functions (`extractStage`, `reconcileAndPrematchStage`, `pairStage`, `finalizeAndPersistStage`) with JSON-serializable boundaries; thin orchestrator preserved. All 3 baselines re-verified through the new pipeline (small + medium exact match; large drift confirmed as LLM non-determinism by re-running the original code path against itself).
  - ✅ **Phase 4** (Apr 28): each stage wrapped to read its input from / write its output to the `comparison_processing_state` table; stage signatures simplified to `(comparisonId)` only — the contract Inngest needs. Stage D additionally clears the row on success. Carry-forward design used so Stage D needs only one state read. Two baselines (small + medium) re-verified exact-match through the state-wired pipeline; state-row clearing confirmed.
  - ✅ **Phase 5** (Apr 28): `inngest@^4.2.5` installed; `lib/inngest/client.ts` + `app/api/inngest/route.ts` scaffolded; Clerk middleware updated to make `/api/inngest(.*)` public; dev-mode env settled on `INNGEST_DEV=http://127.0.0.1:8288` (URL form forces dev mode + IPv4). SDK plumbing verified working via `PUT /api/inngest 200` + valid handshake JSON. The upstream `inngest-cli` v1.18.0 panics on Windows (nil-pointer in `pkg/devserver/api.go:373`) so the local dashboard at `localhost:8288` is unusable for visualization — but this **didn't block development** because the event-receive endpoint works fine (see Phase 6).
  - ✅ **Phase 6** (Apr 28): defined `processComparison` Inngest worker (`lib/inngest/functions/process-comparison.ts`) with 4 durable `step.run()` invocations + per-`comparisonId` concurrency cap + default 4-retry policy + terminal `mark-failed` step on exhausted retries. Mode gate mirrors legacy `runComparisonProcessing` precedence exactly (real → stub → disabled). Registered in `app/api/inngest/route.ts`; `function_count: 1` confirmed. Verified end-to-end via `scripts/n1-verify-phase6-inngest.ts` against `small-set8` baseline: 41s wall-clock (vs Phase 4's 43s in-process — ~5% overhead), exact match on the deterministic aggregates, drift on stochastic ones within the documented Sonnet noise envelope. Critically, this confirmed `inngest.send()` works locally despite the broken CLI dashboard.
  - ✅ **Phase 7** (Apr 28, fully closed ~22:15 EDT): `POST /api/comparisons` now `await inngest.send({ name: 'comparison/process.requested', data: { comparisonId, trigger: 'create-route' } })` and returns `202 Accepted`. Fire-and-forget pattern removed from production code. Frontend polling unaffected. `tsc --noEmit` clean. **UI smoke test passed** on two independent upload pairs; results compared byte-for-byte against pre-implementation outputs of the same comparisons — **100% accurate**. User noted noticeable dev-mode wall-clock overhead (~5s on a ~90s pipeline); breakdown documented in `N1_INNGEST_CONVERSION.md` Phase 7 Important Findings — ~3s of that is Inngest dev CLI overhead that disappears under Inngest Cloud. **N1 functional resolution is empirically verified end-to-end.**
  - ⏳ **Phase 8** (next): edge-case testing including retry / concurrency / idempotency / 5,000-line stress test (P8.7).
  - ⏳ **Phase 9**: final docs sweep + delete `_runRealProcessing_PRE_REFACTOR` dead code if rollback no longer needed.
- **Accuracy guarantee**: fixing this is an orchestration change, not an algorithm change. `runComparisonProcessing()` and all downstream logic stay untouched. Phase 3 verification has empirically confirmed this for the refactor portion.

### N2 — No `export const maxDuration` on long-running routes (**P0, RESOLVED Apr 27 2026 evening**)
- **Resolution**: Added `export const maxDuration = 60` (Vercel Hobby maximum) to four routes that can exceed the 10s default:
  - `app/api/comparisons/route.ts:12`
  - `app/api/comparisons/[id]/versions/apply-edits/route.ts:15`
  - `app/api/comparisons/[id]/executive-summary/route.ts:14`
  - `app/api/internal/cleanup-unverified-users/route.ts:8`
- **Headroom check**: 45s apply-edits fetch timeout + 15s buffer = 60s; 55s summary timeout + 5s buffer = 60s. Safe.
- **Verified**: `tsc --noEmit` shows zero `maxDuration` errors; Next.js types file `app-segment-config.d.ts` confirms the export is officially recognized by the framework and Vercel.

### N3 — Filesystem writes outside `/tmp` will crash on Vercel (**P0, RESOLVED Apr 27 2026 evening**)
- **Original risk**: `lib/debug-trace.ts` and `lib/pdf-vision-extract.ts:521` write to `scripts/...` paths that are read-only on Vercel. If `DUMP_PIPELINE_TRACE=true` or `DUMP_HAIKU_ZONES=true` leaked into production env, every comparison processing run would throw `EROFS: read-only filesystem`.
- **Resolution**: Added hard `NODE_ENV === 'production'` guard inside both gate functions. In prod, the writes are structurally impossible regardless of env-var values.
  - `lib/debug-trace.ts:5-11` (`isEnabled()` short-circuits in prod)
  - `lib/pdf-vision-extract.ts:509` (inline guard combined with existing `DUMP_HAIKU_ZONES` check)
- **Verified**: `tsc --noEmit` clean on both files.
- **Cleanup hint**: the `DUMP_*` env entries in `.env.local` can remain `true` for dev — they're now ignored in prod even if copied.

### N4 — Stripe checkout URLs hardcoded to `localhost` in env (**P0, RESOLVED Apr 27 2026 evening**)
- **Original risk**: `.env.local` contained `STRIPE_CHECKOUT_SUCCESS_URL=http://localhost:3000/...` and `STRIPE_CHECKOUT_CANCEL_URL=http://localhost:3000/...`. If either leaked into production env, paying users would be redirected to `localhost` after Stripe Checkout — broken funnel.
- **Resolution**: Refactored `lib/stripe.ts:getCheckoutUrls()` to accept the incoming `Request` and derive the origin from request headers (`x-forwarded-proto` + `x-forwarded-host` → `Origin` → `request.url` fallback chain).
  - Paths are overrideable via new env vars `STRIPE_CHECKOUT_SUCCESS_PATH` / `STRIPE_CHECKOUT_CANCEL_PATH`, with safe defaults.
  - The old `STRIPE_CHECKOUT_SUCCESS_URL` / `STRIPE_CHECKOUT_CANCEL_URL` env vars are **no longer referenced anywhere**; remove from `PRODUCTION_CUTOVER_CHECKLIST.md` env table.
  - Callsite updated: `app/api/stripe/checkout/route.ts:106` now passes `request` to `getCheckoutUrls(request)`.
- **Verified**: a standalone Node script exercised 5 scenarios (prod via `x-forwarded-*`, localhost dev, Origin header fallback, request.url last-resort, and a localhost-leak regression test). All pass; localhost cannot leak into production URLs.

### N5 — AI endpoints have no fetch timeout (**P0, RESOLVED Apr 27 2026 evening**)
- **Note**: same as #8 above. Tracked as N5 only for continuity with the evening-pass numbering.

### N6 — `cleanup-unverified-users` deletes Clerk before DB with no error handling (**P1, OPEN**)
- **File**: `estimatch-app/app/api/internal/cleanup-unverified-users/route.ts:94–97`
- **Symptom**: Sequential `await client.users.deleteUser(clerkId)` then `await prisma.user.deleteMany(...)`. If the Prisma step throws after Clerk delete succeeds, the DB row becomes an orphan with no Clerk owner. Loop also has no try/catch, so a single Clerk API failure aborts the entire batch.
- **Fix**: wrap each iteration in try/catch; log orphan `clerkId`s with a distinctive prefix so ops can replay. Convert the loop to `Promise.allSettled` so one failure doesn't abort remaining deletes.

### N7 — Duplicate-phone check burns the user's Twilio Verify code (**P1, OPEN**)
- **File**: `estimatch-app/app/api/verification/phone/confirm/route.ts:131–144`
- **Symptom**: The duplicate-phone check runs **after** `twilioClient.verify.v2.services(...).verificationChecks.create(...)`. Twilio Verify codes are single-use. If the duplicate check fires after a successful code check, the user's code is already burned — they have to request a new SMS before retrying.
- **Fix**: move the duplicate-phone lookup to `phone/start/route.ts` (before SMS dispatch), or add a new public `POST /api/verification/phone/check-availability` invoked on form submit.

### N8 — Stripe webhook signature verification (**VERIFIED Apr 27 2026 evening**)
- **Status**: Already implemented correctly. No action needed.
- **Evidence**: `app/api/webhooks/stripe/route.ts:250–265` reads `stripe-signature` header, requires `STRIPE_WEBHOOK_SECRET`, rejects (400) when either is missing, calls `stripe.webhooks.constructEvent(payload, signature, webhookSecret)` inside try/catch, returns 400 on verification failure with proper error logging. Webhook forgery is not possible.

### N9 — Duplicate Clerk fetch in `proxy.ts` (**FALSE POSITIVE — retracted**)
- **Initial claim (incorrect)**: `proxy.ts` calls `clerkClient.users.getUser(userId)` twice per request.
- **Correction**: the two `getUser` calls at lines 53 and 87 are in **mutually exclusive** matchers — `isAppRoute || isSubscribeRoute || isVerifyPhoneRoute` vs `isMarketingRoute`. No single request can match both matchers. There is no duplicate fetch.
- **Note**: the unrelated concern of `getUser` being called on every request to protected routes (one fetch per request, not two) is still valid and is already tracked as item **#11** above (JWT-claim-based optimization).

### N10 — Failed comparisons leave orphan PDFs in Supabase storage (**P1, OPEN**)
- **File**: `estimatch-app/app/api/comparisons/route.ts:298–393`
- **Symptom**: Storage cleanup only fires if the comparison-creation transaction itself fails. Once the row is created and processing is triggered, a later processing failure leaves the uploaded PDFs in Supabase Storage indefinitely. The UI DELETE handler does clean them up, but orphan files accumulate for any comparison the user leaves in `FAILED` state.
- **Fix**: add a periodic cleanup cron (`/api/internal/cleanup-failed-comparison-assets`) that finds `FAILED` comparisons older than N days and removes their storage objects.

### N11 — `trialPhoneHash: null` placeholder in phone confirm (**P2, OPEN**)
- **File**: `estimatch-app/app/api/verification/phone/confirm/route.ts:159–163`
- **Symptom**: `trialPhoneHash: null` is a placeholder for a future hashed-phone column intended to support trial-abuse enforcement after user deletion (see #10). Leaving it as `null` is harmless today but the work it gestures at is still open.
- **Fix**: part of the same fix as #10 (trial-phone history / hashed persistent record).

### N12 — Offset-based pagination drift in cleanup cron (**P2, OPEN**)
- **File**: `estimatch-app/app/api/internal/cleanup-unverified-users/route.ts:60–92`
- **Symptom**: Pagination collects IDs first, then deletes — good. But `offset += users.length` assumes the page is always full. If Clerk ever returns a partial page due to internal filtering, offsets drift. Non-issue at current scale; flag for when total user count is large (10K+).

### N13 — `findFirst` → `findUnique` on `stripeCustomerId` (**P2, OPEN — requires migration**)
- **File**: `estimatch-app/app/api/webhooks/stripe/route.ts:87`
- **Symptom**: Uses `prisma.user.findFirst({ where: { stripeCustomerId } })`. Switching to `findUnique` would be cleaner and catch accidental duplicates, but the Prisma model column is not declared `@unique` (`prisma/schema.prisma:20`).
- **Fix** (staged): (1) add `@unique` to `stripeCustomerId` in the schema; (2) generate a migration; (3) validate no existing duplicates; (4) swap to `findUnique`. Not a one-step change.

### N14 — Unmapped Stripe price returned silently (**P2, RESOLVED Apr 27 2026 evening**)
- **Resolution**: Replaced the plain one-line `console.error` in the Stripe webhook with a structured JSON log at `app/api/webhooks/stripe/route.ts:112–125`. Fields: `event: "STRIPE_WEBHOOK_UNMAPPED_PRICE"`, `severity: "critical"`, `priceId`, `subscriptionId`, `stripeCustomerId`, `userClerkId`, `userId`, and a descriptive `message`.
- **Why it matters**: if a new Stripe price is added live but the corresponding `STRIPE_PRICE_*` env var isn't deployed, the user has been charged but NOT granted plan access. The new log line is grep-able in Vercel logs and can be wired into a log drain / alert.
- **Verified**: `tsc --noEmit` clean. Field name corrected to `subscription.customer` (the typed field on our internal subscription shape; it's not `customerId`).

### N15 — `lib/debug-trace.ts` trace file can race under concurrent dev runs (**P2, OPEN**)
- **Symptom**: `traceReset()` truncates `scripts/pipeline-trace.txt` on every comparison. Concurrent local comparisons race. Never affects production (N3 guard prevents filesystem writes entirely in prod).
- **Fix** (optional): include comparison ID in filename: `scripts/pipeline-trace-${comparisonId}.txt`. Dev-only nicety.

---

## N3 Pipeline — Specific Outstanding Items

> These are N3-only items. The canonical tracking doc is `N3_BUILD_LEDGER.md §What Is Not Yet Built`. This section summarises the highest-priority items for quick reference here.

### N3-1 — Phase 5 + Phase 7 UI review gates not yet implemented (**P1, OPEN**)
- **Symptom**: Zone Review gate (Phase 5) and Zone Correspondence Review gate (Phase 7) auto-proceed in the Inngest pipeline without pausing for user review. The `AWAITING_ZONE_REVIEW` and `AWAITING_MATCH_REVIEW` statuses exist and the UI components (`ZoneReview`, `MatchReview`) exist, but the `p5-zone-review-gate` and `p7-correspondence-gate` Inngest steps do not yet flip to these statuses — they fire an immediate `step.waitForEvent` that is immediately satisfied by a no-op confirm.
- **Fix**: Implement `p5-zone-review-gate` and `p7-correspondence-gate` in `process-comparison-v3.ts` to mirror the Phase 8.5 gate pattern (flip status, `step.waitForEvent`, resume on confirm). Wire confirm endpoints similarly to `/api/comparisons/[id]/line-item-review/confirm`.

### N3-2 — 4 line items consistently not extracted by Phase 8 ~~P1~~ — **DEFERRED May 24 2026**
> Will re-audit after full application cleanup. Phase 8.5 review gate provides manual mitigation in the meantime.
- **Files**: `lib/n3/passes/extract-line-items.ts`, `lib/n3/prompts/extraction.ts`
- **Symptom**: Set12 accuracy runs show 4 items never extracted (2 contractor-only `MISSING`, 2 adjuster-only `ADDED`). Items are present in source PDFs. Root cause: extraction prompt's strict "Extract ONLY numbered line items beginning with an integer followed by a period" rule may be over-filtering items that use sub-numbering or alternate formatting.
- **Mitigation in place**: Line Item Review gate (Phase 8.5) lets user flag and trigger re-extraction.
- **Fix** (longer-term): audit the specific missed items' PDF formatting; relax prompt rule for sub-numbered items; consider `approxItems` delta auto-trigger for re-extraction without user input.

### N3-3 — Phase 10 extraction validation not implemented (**P2, OPEN**)
- **File**: `lib/n3/passes/` (no pass exists for Phase 10 yet)
- **Symptom**: `N3ExtractionWarning` rows are never written. The schema and model exist but no pass populates them.
- **Fix**: Implement `lib/n3/passes/extraction-validation.ts` that compares extracted `itemCount` per zone against `approxItems` and writes `N3ExtractionWarning` rows for zones where the delta exceeds a threshold.

### N3-4 — Prisma migration history has schema drift (**P2, OPEN**)
- **Symptom**: `prisma migrate dev` detects drift because the `embedding` column on `n3_line_items` and the `comparison_status` enum value `AWAITING_LINE_ITEM_REVIEW` were applied via raw SQL (not via migration files). `prisma migrate dev` prompts to reset the DB.
- **Fix**: Create a baseline migration with `prisma migrate resolve --applied` or add a new migration file that accounts for the raw SQL changes, then verify `prisma migrate status` shows no drift. Do NOT run `prisma migrate reset` on production.

### N3-5 — V2/V3 test set validation not yet run ~~P1~~ — **RESOLVED May 24 2026**
> Later test sets covered diverse formats. New sets will be generated with greater diversity for future validation rounds.

---

## May 24, 2026 — Comprehensive Pre-Launch Review Additions

> These items were identified during a full-application + N3 pipeline deep-dive code review on May 24, 2026. Items are organized by the same P0/P1/P2 convention as above. The six N3 bugs fixed during this session are documented in §Resolved May 24 2026 at the bottom.

---

### 36. Symbility pipeline construction ~~P0, OPEN~~ — **RESOLVED Jun 3 2026 via N4**
  - **Resolution**: Implemented via the N4 multi-format pipeline (`lib/n4/`). N4 supports Xactimate, Symbility, and CSV formats with format-specific extraction, zone detection, and normalization paths. Format selector on the upload form routes to the correct N4 extraction logic. Accuracy validated across all three formats.
  - **UI prerequisite ✔ DONE**: format selector (Xactimate/Symbility) is already on the upload form. When Symbility pipeline is built, the `symbility` option will route to the correct extraction prompt and zone detection logic automatically. — build format-specific extraction and parsing **(P0, OPEN — May 24 2026)**
- **Files**: `estimatch-app/lib/n3/passes/extract-line-items.ts`, `estimatch-app/lib/n3/passes/detect-zones.ts`, `estimatch-app/lib/n3/prompts/extraction.ts`
- **Context**: Item #31 tracks testing Symbility compatibility. This item tracks the actual construction work required once #31 confirms what breaks. Symbility PDFs differ structurally from Xactimate in ways that require purpose-built pipeline paths: different column layout (has a "Code" column), different zone/area header conventions, different total-row formatting, different numbering conventions. The current N3 extraction prompt, zone detection logic, and normalization rules were all designed around Xactimate output.
- **What needs to be built**:
  1. **Format detection in Phase 4**: extend `detect-zones.ts` to reliably identify `symbility` vs `xactimate` vs `unknown` and store the result in a new `format` column on `n3_zones` (this is Bug #2 from the May 24 review — deferred DB migration).
  2. **Symbility-specific extraction prompt** in `estimatch-app/lib/n3/prompts/extraction.ts`: separate prompt branch for Symbility layout (Code column, area headers, unnumbered or differently-numbered rows).
  3. **Symbility zone detection prompt**: Symbility uses "Areas" terminology and may nest zones differently. A separate or parameterized prompt branch in `detect-zones.ts` is needed.
  4. **Symbility normalization rules**: item codes in the Code column should feed into `itemCodeSimilarity` (currently a stub at 0.01 weight). Symbility codes are highly structured and could significantly improve accuracy.
  5. **Anti-hallucination guard for unknown formats** (shared with #30/#32/#33): if the detected format is `unknown` and the extracted item count is implausibly low vs page count, fail loudly rather than silently.
  6. **Accuracy validation**: at least 3 representative Symbility PDFs must pass end-to-end with ≥95% item extraction accuracy and ≤2% aggregate dollar error before this is closed.
- **Why P0**: Symbility is the #2 insurance estimating platform after Xactimate. A Symbility user on day 1 will hit the silent hallucination path described in #30 or get structurally wrong matches. This is a customer-trust failure that cannot be walked back.
- **Cross-references**: #31 (testing/discovery), #30 (hallucination guard), Bug #2 deferred (format column migration), N3-9 (item code similarity), N3-11 (format handoff).

---

### 37. CSV/XLS/XLSX file support — accept spreadsheet estimates as input ~~P0, OPEN~~ — **RESOLVED Jun 3 2026 via N4**
- **Resolution**: Implemented via the N4 multi-format pipeline. CSV (and XLS/XLSX) uploads are accepted, parsed via structured row extraction (no vision model required), column-mapped to N3 normalized fields, and fed into the downstream matching pipeline. Upload validation updated to accept spreadsheet MIME types. No regression on PDF-only comparisons confirmed.

### 37-original. XLS/XLSX file support — accept spreadsheet estimates as input **(P0, OPEN — May 24 2026)**
  - **UI prerequisite**: add an `xls` option to the format selector on the upload form and relax `accept=".pdf"` to also accept `.xls`/`.xlsx`. The format selector infrastructure is already in place (`app/app/new-comparison/page.tsx`).
- **Files**: `estimatch-app/app/app/new-comparison/page.tsx`, `estimatch-app/app/api/comparisons/route.ts`, `estimatch-app/lib/n3/passes/extract-line-items.ts` (new path), `estimatch-app/prisma/schema.prisma`
- **Context**: Many adjusters and contractors deliver estimates as Excel spreadsheets rather than PDFs. Xactimate, Symbility, and proprietary adjuster tools all offer XLS/XLSX export. The current pipeline is entirely PDF-only at every level — upload validation, storage, Phase 4 zone detection, Phase 8 extraction, and the Anthropic vision calls. Supporting XLS/XLSX would unlock a large subset of users who cannot produce PDF output or prefer spreadsheet format.
- **What needs to be built**:
  1. **Upload layer**: update `validatePdf` in `comparisons/route.ts` to accept `.xlsx`/`.xls` MIME types (`application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, `application/vnd.ms-excel`). Update file size limit (XLS files are typically smaller). Update frontend `new-comparison/page.tsx` to accept `accept=".pdf,.xlsx,.xls"` and show appropriate file type labels.
  2. **Storage**: Supabase storage bucket can store any binary — no changes needed. MIME type metadata should be stored.
  3. **Format detection branch**: at the start of N3 Phase 4 (detect-zones) and Phase 8 (extract-line-items), detect whether the input is PDF or XLS/XLSX. Branch to an entirely separate extraction path for spreadsheets.
  4. **XLS extraction path** (new library needed — e.g. `xlsx` npm package, ~500KB): parse sheet structure, detect zone/area sheets or section headers, extract line items directly from rows. No vision model needed — structured extraction from cell values. This is significantly more accurate and cheaper than PDF vision for well-formed spreadsheets.
  5. **Column mapping**: build a configurable column-header → N3 field mapping (description, qty, unit, remove, replace, reset, tax, O&P, total). Support common Xactimate XLS column names, Symbility XLS column names, and a fallback heuristic for unknown layouts.
  6. **Zone detection for XLS**: worksheet tabs are natural zone boundaries. Multi-sheet workbooks map directly to N3 zones. Single-sheet workbooks need section-header detection from row styling/formatting.
  7. **N3 data model**: no schema changes needed — `n3_line_items` and `n3_zones` store normalized data regardless of source format.
  8. **Processing pipeline update**: `pipelineVersion` should be `'n3'` for XLS inputs (not a separate version). The XLS path bypasses Phases 4 and 8 vision calls but uses all downstream phases unchanged.
- **Acceptance criteria**:
  - A standard Xactimate XLS export uploads, processes, and completes with ≥98% item extraction accuracy.
  - A Symbility XLS export uploads, processes, and completes with ≥95% item extraction accuracy.
  - PDF and XLS inputs are handled transparently — the downstream N3 phases (normalization, embedding, scoring, matching) are identical.
  - No regression on existing PDF-only comparisons.
- **Why P0**: XLS is not a "nice to have" — a significant portion of adjuster estimates are delivered in spreadsheet format, and users who cannot convert to PDF are completely blocked from using the product. Supporting XLS is likely a prerequisite for commercial viability, not an enhancement.
- **Dependency**: benefits significantly from Symbility column-mapping work in #36 (the Symbility XLS column layout is the same as the Symbility PDF column layout, just structured). Implement #36 first.

### 38. Loading / progress screens need phase-level status messages ~~P0, OPEN~~ — **RESOLVED Jun 3 2026**
- **Resolution**: Phase-level status messages implemented. `/api/comparisons/[id]` now returns the current pipeline phase label. `new-comparison/page.tsx` progress bar shows real-time phase descriptions (e.g. "Detecting zones", "Extracting line items", "Matching items"). Elapsed time visible. All waiting screens updated.

### 38-original. Loading / progress screens need phase-level status messages **(P0, OPEN — May 24 2026)**
- **Files**: `estimatch-app/app/app/new-comparison/page.tsx`, comparison detail page loading states, review gate waiting screens
- **Context**: All pipeline waiting screens currently show a generic animated progress bar with no indication of what the pipeline is actually doing. Users have no idea if they're waiting for zone detection, extraction, matching, or something else. This is especially confusing during long-running phases like Phase 8 (line item extraction, which can take several minutes per zone on large PDFs).
- **What needs to be built**:
  1. Surface current pipeline phase from the API — the comparison status endpoint (`/api/comparisons/[id]`) should optionally return the current Inngest step name or a coarse phase label (e.g. "Detecting zones", "Extracting line items", "Matching items").
  2. Update the progress bar on `new-comparison/page.tsx` to show the current phase label below or alongside the bar.
  3. Update any waiting screens on the comparison detail page similarly.
  4. Consider a visible elapsed time or estimated time remaining for phases with known typical durations.
- **Why P0**: Without phase visibility, users have no confidence the system is working and are likely to abandon or repeatedly re-upload.

---

## N3 Pipeline — Additional Items (May 24, 2026 Review)

### N3-6 — HNSW index missing on pgvector embedding column ~~OPEN~~ — **RESOLVED May 24 2026**
- **File**: `estimatch-app/prisma/migrations/` (new migration needed), `estimatch-app/lib/n3/passes/generate-candidates.ts`
- **Symptom**: Phase 12 candidate generation performs a brute-force O(n×m) cosine similarity scan across all `n3_line_items` embeddings for every comparison. At 500+ items per side, this scan takes multiple seconds and will time out under concurrent load. At 1,000+ items per side it will exceed Vercel's step timeout.
- **Fix**: Add an HNSW index on the `embedding` column of `n3_line_items`:
  ```sql
  CREATE INDEX CONCURRENTLY n3_line_items_embedding_hnsw
    ON n3_line_items USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
  ```
  This must be applied as a migration (not raw SQL) and confirmed on the production Supabase instance (requires pgvector 0.5.0+ and the `vector` extension, both available on Supabase Pro).
- **Why P0 at scale**: without this, the first large commercial comparison (500+ items/side) will either time out in Phase 12 or cause serious DB load under concurrent users. This is a one-time index creation that has zero impact on write performance and dramatically reduces scan cost.

### N3-7 — `createMany` in Phase 18 will hit PostgreSQL bind-parameter limit ~~P1~~ — **RESOLVED May 24 2026**
- **Resolution**: Replaced array-style `$transaction([...])` with callback-style `$transaction(async (tx) => { ... })`. `createMany` is now called in chunks of 800 rows (28,000 bind params, well under the 65,535 ceiling). `deleteMany` and `comparison.update` remain in the same transaction — atomicity preserved. File: `lib/n3/passes/persist-decisions.ts:386-415`.
- **File**: `estimatch-app/lib/n3/passes/persist-decisions.ts:388-404`
- **Symptom**: `prisma.lineItem.createMany({ data: rows })` passes all rows in a single PostgreSQL statement. PostgreSQL limits bind parameters to 65,535. The `LineItem` model has ~35 columns — the limit is hit at `65535 / 35 ≈ 1,872 rows`. For a comparison with 2,000+ decisions (large commercial or multi-zone claims), Phase 18 will throw `P2027: Raw query failed` and the entire pipeline run fails on the very last step after all processing is complete.
- **Fix**: chunk `rows` into batches of ≤800 before calling `createMany` (800 × 35 = 28,000 params, well under the limit). The `deleteMany` inside the same transaction should remain as a single call — it is unaffected. Update the `$transaction` to loop over row chunks.
- **Why P1 and not P0**: average residential claims stay well under 1,872 decisions. Large commercial claims will hit this. Should be fixed before significant traffic.

### N3-8 — Score thresholds need recalibration after Phase 10 NLP lands **(P1, OPEN — May 24 2026)**
- **File**: `estimatch-app/lib/n3/constants.ts:67-72`
- **Symptom**: `SCORE_THRESHOLDS.REJECT` was temporarily lowered from 0.60 → 0.30 to compensate for `materialObjectSimilarity` (weight 0.15) and `itemCodeSimilarity` (weight 0.12) stub features always returning 0. At 0.30, approximately 3× as many edges survive into the bipartite graph as intended (~3,366 observed vs ~500 expected at 0.60). This inflates the graph, increases Phase 14 component sizes, pushes more items into the `large` component path, and adds unnecessary LLM adjudication load in Phase 17.
- **Fix**: once Phase 10 NLP (N3-9) is implemented and both stub features are returning real values, re-run the calibration suite across all test sets to find the threshold that maintains ≥98% recall at the lowest false-positive rate. Reset `REJECT` toward 0.55–0.65. Also recalibrate `ACCEPT` (currently 0.82) and `POSSIBLE` (currently 0.60).
- **Dependency**: blocked on N3-9 (Phase 10 NLP). Do not adjust thresholds until real feature values are available.

### N3-9 — Phase 10 NLP: AI trade/action classification has 37–48% null rate **(P1, OPEN — May 24 2026)**
- **File**: `estimatch-app/lib/n3/passes/normalize-line-items.ts`, `estimatch-app/lib/n3/constants.ts` (`ABBREV_EXPANSION`, `DESCRIPTION_STOPWORDS`)
- **Symptom**: The `trade` and `action` fields on `N3NormalizedLineItem` are populated by keyword lookup in `normalize-line-items.ts`. On production test sets, 37–48% of items have `null` for both fields. When both are null, the score weight for `tradeActionSimilarity` (currently 0.07 combined) effectively contributes nothing, and Phase 16 group matching's `tradeActionCoverage` feature is similarly degraded.
- **Fix**: add a small AI classification pass (Haiku call, batched, cheap) as a fallback for items where keyword lookup returns null. For each null-trade item, send description to Haiku with a structured prompt: `"Classify this construction line item into: trade (carpentry/painting/plumbing/electrical/roofing/flooring/drywall/hvac/masonry/other) and action (install/remove/replace/repair/clean/inspect/none). Return JSON only."` Batch 50–100 items per call. This should bring the null rate below 10%.
- **Dependency**: feeds into N3-8 (score recalibration) — do N3-9 first.

### N3-10 — Large component zone-blind greedy produces mislabeled decisions **(P1, OPEN — May 24 2026)**
- **File**: `estimatch-app/lib/n3/passes/assign-matches.ts`, `estimatch-app/POTENTIAL_FIXES.md`
- **Symptom**: Set18 (704 items, single large component) produced 4 "Content manipulation / Move and reset" pairs mislabeled as `MISSING_FROM_ADJUSTER` + `ADDED_BY_ADJUSTER` instead of `MODIFIED`. Dollar gap was 100% correct. Root cause: the greedy Hungarian algorithm in Phase 15 does not consider zone correspondence when breaking ties, so it can mis-assign items across zones when their individual scores are close.
- **Four fix options documented in `POTENTIAL_FIXES.md`**:
  1. Zone-affinity score boost in Phase 13 (+0.08 for correspondence-confirmed pairs)
  2. Zone-affinity tiebreaker in Phase 15 greedy loop (intervene when scores within 0.05)
  3. Increase `MEDIUM_MAX` threshold so 700-item estimates use near-optimal algorithm
  4. Run more test sets first before deciding
- **Recommended path**: Option 3 is the lowest-risk change (single constant), Option 1 fixes the root cause. Do not implement until 2–3 additional large-set runs confirm the pattern repeats.

### N3-11 — Phase 4 → Phase 8 format handoff ~~P1~~ — **RESOLVED May 24 2026**
- **Resolution**: Replaced auto-detection approach with user-selected format at upload time. Two `<select>` dropdowns (Xactimate/Symbility) added to `app/app/new-comparison/page.tsx`. Values sent as `yourEstimateFormat` + `adjusterEstimateFormat` in formData. API route validates and stores them via migration `20260524130000_add_comparison_estimate_formats`. `lib/n3/passes/extract-line-items.ts` now reads `comparison.yourEstimateFormat` / `comparison.adjusterEstimateFormat` and passes real format context to `buildExtractionPrompt`. Architectural decision: user selection is deterministic and error-free vs probabilistic auto-detection from PDF content.

### N3-12 — Phase 5 / Phase 7 / Phase 8.5 review gates need production verification ~~P1~~ — **RESOLVED May 24 2026**
> Confirmed working across many test runs. All three gates (zone review, correspondence review, line item review) suspend and resume correctly with real comparisons in production.
- **File**: `estimatch-app/lib/n3/inngest/process-comparison-v3.ts` (steps `p5-zone-review-gate`, `p7-correspondence-gate`, `p8-5-line-item-review-gate`), `estimatch-app/app/api/comparisons/[id]/zone-review/confirm/route.ts`, `estimatch-app/app/api/comparisons/[id]/match-review/confirm/route.ts`, `estimatch-app/app/api/comparisons/[id]/line-item-review/confirm/route.ts`
- **Symptom**: The review gate APIs and `ZoneReview` / `MatchReview` / `LineItemReview` React components are all wired. However, all end-to-end testing has been run with `N3_SKIP_ZONE_REVIEW=true` and `N3_SKIP_LINE_ITEM_REVIEW=true`, which bypasses all three gates. The actual user-facing review flows — including the `step.waitForEvent` Inngest suspend/resume pattern with real HTTP confirm endpoints — have never been exercised with a real comparison in a real environment.
- **What needs verification**:
  1. Zone Review gate (Phase 5): status flips to `AWAITING_ZONE_REVIEW`, UI renders zones correctly from `n3_zones`, confirm POST fires `comparison/n3-zone-review.completed`, pipeline resumes.
  2. Correspondence Review gate (Phase 7): status flips to `AWAITING_MATCH_REVIEW`, UI renders proposed correspondences (current `MatchReview` component shows N2-style zone pairs — verify it renders N3 correspondence data correctly), confirm POST fires `comparison/n3-correspondence-review.completed`, pipeline resumes.
  3. Line Item Review gate (Phase 8.5): status flips to `AWAITING_LINE_ITEM_REVIEW`, UI renders per-zone item counts from `line-item-review` API, confirm/reextract actions work, pipeline resumes or re-runs Phase 8.
- **Fix**: run at least one comparison end-to-end with all skip flags set to `false`. Document observed behavior. Fix any rendering or event-firing issues found.

---

## Resolved — May 24, 2026 Session

> Six N3 bugs identified and fixed during the May 24, 2026 deep-dive. All changes are in `estimatch-app/lib/n3/`.

### Bug Fix A — `many_to_many` missing from Phase 6 Zod schema ✅ **RESOLVED May 24 2026**
- **File**: `lib/n3/passes/propose-correspondences.ts:45`
- **Fix**: Added `'many_to_many'` to `z.enum([...])` in `CorrespondenceItemSchema`. Prevents Phase 6 from exhausting retries when the LLM correctly returns a many:many correspondence.

### Bug Fix B — `CORRESPONDENCE_MAX_TOKENS` fixed at 1500 regardless of zone count ✅ **RESOLVED May 24 2026**
- **File**: `lib/n3/passes/propose-correspondences.ts:33-38`
- **Fix**: Replaced constant with `computeCorrespondenceMaxTokens(yoursCount, adjCount)` — scales at 40 tokens/zone with a 1500 floor. Prevents truncation on comparisons with 30+ zones per side.

### Bug Fix C — Voyage AI batch response not length-validated ✅ **RESOLVED May 24 2026**
- **File**: `lib/n3/passes/generate-embeddings.ts:62-66`
- **Fix**: Added explicit `throw` if `json.data.length !== texts.length`. Converts silent embedding misalignment into a loud, retryable error.

### Bug Fix D — `possible` decision falls through to `MODIFIED` in Phase 18 ✅ **RESOLVED May 24 2026**
- **File**: `lib/n3/passes/persist-decisions.ts:207-208`
- **Fix**: Default switch case now maps `possible` → `MATCH_UNVERIFIED` instead of `MODIFIED`. Prevents a Phase 17 bug from producing false confirmed-modified matches.

### Bug Fix E — `dump-metrics-snapshot` writes to read-only filesystem in production ✅ **RESOLVED May 24 2026**
- **File**: `lib/n3/inngest/process-comparison-v3.ts:404`
- **Fix**: Wrapped entire metrics snapshot block in `if (process.env.NODE_ENV !== 'production')`. DB metrics query and filesystem writes are skipped entirely on Vercel.

### Bug Fix F — Stale "all steps stubbed" completion log message ✅ **RESOLVED May 24 2026**
- **File**: `lib/n3/inngest/process-comparison-v3.ts:425`
- **Fix**: Removed `(all steps stubbed)` suffix from `[n3] process-comparison-v3 completed` log line.

### Bug Fix G — `computeMaxTokens` underestimated per-pair token budget (prior session) ✅ **RESOLVED May 23 2026**
- **File**: `lib/n3/passes/llm-adjudication.ts:39-43`
- **Fix**: Raised `MAX_TOKENS_PER_PAIR` from 80 → 130, added `MAX_TOKENS_ENVELOPE = 50`, introduced `MAX_TOKENS_CEIL = 32_768`. Prevents silent JSON truncation in Phase 17 LLM adjudication batches.

---

## Code Review Findings — May 25, 2026

### N16 — `finalize-checkout` partial usage reset on period rollover **(P1, OPEN)**
- **File**: `app/api/stripe/finalize-checkout/route.ts:186`
- **Symptom**: When `shouldResetUsage` is true (new billing period detected via `subscriptionEndsAt` advancing), only `comparisonsUsedThisPeriod: 0` is spread into the DB update. `llmEditsUsedThisPeriod` and `executiveSummariesUsedThisPeriod` are **not** reset.
- **Contrast**: The Stripe webhook handler (`app/api/webhooks/stripe/route.ts`) correctly resets all four counters (`comparisonsUsedThisPeriod`, `addonComparisonsThisPeriod`, `llmEditsUsedThisPeriod`, `executiveSummariesUsedThisPeriod`) in the same scenario.
- **Impact**: If `finalize-checkout` runs before the Stripe webhook fires (normal race — checkout success redirect is immediate), a user in a new billing period will see their LLM edit and executive summary quotas as still depleted until the webhook eventually arrives and corrects them. Could surface as a false 429 for AI tools immediately after renewal.
- **Fix**: Add `llmEditsUsedThisPeriod: 0` and `executiveSummariesUsedThisPeriod: 0` to the `shouldResetUsage` spread at line 186, matching the webhook handler.

### N17 — `inngest.send` failure after DB transaction leaves zombie PROCESSING comparison **(P1, OPEN)**
- **File**: `app/api/comparisons/route.ts` (POST handler)
- **Symptom**: The DB transaction (creates comparison row + increments `comparisonsUsedThisPeriod`) runs first, then `inngest.send()` is called. If `inngest.send()` throws (network error, Inngest outage, env var misconfiguration), the catch block: (a) cleans up Supabase files ✓, but (b) does **not** delete the zombie comparison row ✗, and (c) does **not** decrement the usage counter ✗.
- **Impact**: User loses a comparison slot and is left with a PROCESSING comparison that will never complete. Low frequency (Inngest is reliable), but permanently harmful when it does occur.
- **Fix**: In the catch block, after file cleanup, attempt `prisma.comparison.delete({ where: { id: comparison.id } })` if the comparison was created, and decrement `comparisonsUsedThisPeriod` by 1 (with a floor of 0). Since this is compensating for an already-committed transaction, these should be independent `try/catch` blocks with logging if either compensating action fails.

### N18 — `UsageLimitError` race returns 403 before Supabase file cleanup **(P2, OPEN)**
- **File**: `app/api/comparisons/route.ts` (POST handler catch block)
- **Symptom**: Two concurrent requests from the same user race to create the last comparison slot. Both pass the pre-check, both upload files to Supabase, then the slower request's atomic guard inside the transaction throws `UsageLimitError`. The catch block returns `NextResponse.json(..., { status: 403 })` early — BEFORE the file-cleanup block. The Supabase files uploaded by the losing request are never deleted.
- **Impact**: Low frequency (requires exact concurrent requests and the user being at their limit), but each occurrence leaks 2 Supabase files permanently.
- **Fix**: Move the `UsageLimitError` early-return into its own path that still runs the file cleanup: clean up `uploadedPaths` before returning 403. Or restructure so cleanup always runs in a `finally` block regardless of error type.

### N19 — `/api/billing`, `/api/user`, `/api/n3` missing from `proxy.ts` `isProtectedRoute` **(P2, OPEN)**
- **File**: `proxy.ts:8-20`
- **Symptom**: The #24 block-list middleware fix added an explicit `isProtectedRoute` matcher. The following API paths were not included: `/api/billing/(.*)`, `/api/user/(.*)`, `/api/n3/(.*)`. Routes under these paths have their own `auth()` checks and return 401 correctly, so there is no security hole. However, the middleware block-list is incomplete — if a new route were added under these paths without an `auth()` call, it would be silently public.
- **Impact**: Defense-in-depth gap only. All existing routes are individually protected.
- **Fix**: Add `/api/billing(.*)`, `/api/user(.*)`, `/api/n3(.*)` to the `isProtectedRoute` matcher array.

---

## Potential N3 Improvements

> Algorithm and accuracy enhancements for the N3 pipeline. These are deferred improvements to the matching algorithm — the pipeline is functional and accurate without them. Revisit after the application is otherwise complete.

### N3-9 — Phase 10 NLP: AI trade/action classification (37–48% null rate)
- **File**: `estimatch-app/lib/n3/passes/normalize-line-items.ts`, `estimatch-app/lib/n3/constants.ts`
- **Context**: `trade` and `action` fields are populated by keyword lookup. 37–48% of items return `null` for both, meaning `tradeActionSimilarity` contributes zero scoring signal for nearly half of all items.
- **Proposed fix**: Haiku fallback pass (batched, ~50–100 items/call) for items where keyword lookup returns null. Structured JSON prompt classifying trade + action. Should bring null rate below 10%.
- **Dependency**: N3-8 is blocked on this.

### N3-8 — Score threshold recalibration
- **File**: `estimatch-app/lib/n3/constants.ts:67-72`
- **Context**: `SCORE_THRESHOLDS.REJECT` was temporarily lowered 0.60 → 0.30 because `materialObjectSimilarity` and `itemCodeSimilarity` stub features always return 0. This inflates the graph and adds unnecessary LLM adjudication load in Phase 17.
- **Proposed fix**: Once N3-9 is implemented and both stub features return real values, re-run calibration across all test sets and reset thresholds toward 0.55–0.65.
- **Dependency**: blocked on N3-9.

### N3-10 — Large-component zone-blind greedy produces mislabeled decisions
- **File**: `estimatch-app/lib/n3/passes/assign-matches.ts`, `estimatch-app/POTENTIAL_FIXES.md`
- **Context**: Set18 (704 items, single large component) produced 4 "Content manipulation / Move and reset" pairs mislabeled as `MISSING_FROM_ADJUSTER` + `ADDED_BY_ADJUSTER` instead of `MODIFIED`. Dollar gap was 100% correct. Root cause: greedy Hungarian does not consider zone correspondence when breaking ties.
- **Four fix options documented in `POTENTIAL_FIXES.md`** — do not implement until 2–3 additional large-set runs confirm the pattern repeats.

---

## Future Work — Resolve After All Other Items

### 31-deferred. Symbility format compatibility testing
- **Context**: Before Symbility pipeline (#36) can be built and validated, real-world Symbility PDFs must be sourced (at least 3 — small/medium/large) and run through N3 to document what fails and why. This discovery work is a prerequisite to #36 construction.
- **What needs to happen**: source representative PDFs, run through N3 with logging enabled, document exact failure points (zone detection, extraction prompt, normalization), then hand off findings to #36.
- **Dependency**: implement everything else first. Symbility is a second-format expansion, not a launch blocker for Xactimate users.
