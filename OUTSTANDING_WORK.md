# ScopeSplit — Outstanding Work

> **Purpose**: Single source of truth for known follow-up work derived from the Apr 27, 2026 full-application code review (multiple passes, including a Vercel/serverless hardening pass in the evening). Items are scoped to "needs implementation/fix"; routine testing tasks are tracked separately.
>
> **Last Updated**: May 3, 2026 (~22:59 EDT) — N1 Inngest conversion **RESOLVED** (all 9 phases complete, empirically verified end-to-end on 1717-item run). Added #32 continuation-extraction hallucination, #33 Stage A page-chunking for >1K-item PDFs, #34 undici dispatcher prod-verification — three hand-offs to N2 (speed / capacity / accuracy).
>
> **Source**: Multi-pass `/review` of `estimatch-app/` covering all API routes, lib modules, middleware (`proxy.ts`), webhooks, frontend pages, and components. The evening pass specifically evaluated behavior under Vercel serverless constraints (maxDuration, fire-and-forget patterns, read-only filesystem).

---

## Conventions

- **P0** — Pre-launch blocker. Cost, security, or data-correctness risk.
- **P1** — Should-fix before significant traffic. UX or operational risk.
- **P2** — Nice-to-have / cleanup. Refactor, dedup, polish.
- Each item lists: file path(s), root cause, recommended fix.

---

## P0 — Pre-launch Blockers

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

### 25. Prisma migrations never set up — schema/DB/client drift risk **(P0, OPEN — discovered Apr 28 2026)**
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

### 30. PDF extraction prompt is hardcoded for numbered Xactimate output — silently fails on unnumbered formats **(P0, OPEN — discovered Apr 29 2026)**
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
  - Item #31 (Symbility format testing) is the test plan for one specific instance of the format-tolerance fix.
  - N1 Phase 8.6 / 8.7 stress tests are blocked on having properly-formatted test data; will be unblocked once Phase 1 baselines are regenerated with numbered output (or this fix lands).

### 31. Symbility format compatibility — must test and verify before launch **(P0, OPEN — Apr 29 2026)**
- **File**: `estimatch-app/lib/pdf-vision-extract.ts` (extraction prompt) + `scripts/n1-baseline-smoke.ts` (regression coverage harness)
- **Context**: ScopeSplit's user base spans both Xactimate and Symbility users — these are the two dominant insurance-estimating platforms. Every test, baseline, smoke run, and Phase 8 stress test we have run to date has used Xactimate-formatted output. **We have ZERO live evidence that Symbility PDFs work end-to-end in our pipeline.** This is a major launch risk: any Symbility user uploading on day 1 may hit the same silent-hallucination behavior described in #30, or some other format-mismatch failure.
- **Symbility format characteristics that differ from Xactimate** (verify these against actual exports before relying on this list):
  - Different column layout (often has a "Code" column where Xactimate doesn't)
  - Different zone/room header conventions (Symbility uses "Areas" terminology, sometimes nested differently)
  - Different total-row formatting at the end of zones
  - May or may not have numbered line items by default (must verify)
  - Different tax line presentation (some jurisdictions show tax differently in Symbility output)
- **What needs to happen pre-launch**:
  1. **Source representative Symbility PDFs**: at least 3 real-world examples covering small (~50 items), medium (~250 items), and large (~1000 items) cases. Ideally from at least 2 different adjusters/companies to capture format variation.
  2. **Run them through the existing pipeline** with current extraction prompt. Document what happens: does Haiku extract correctly, partially, hallucinate, or fail? Does prematch find anything? Do Sonnet pairing results look sensible?
  3. **Per-format fixes**: based on findings from step 2, either (a) extend the existing prompt with Symbility-specific guidance, (b) add a format-detection branch (see #30), or (c) require the user to specify format on upload.
  4. **Add Symbility cases to baseline coverage**: extend `n1-baseline-smoke.ts` with at least one Symbility comparison so future regressions are caught.
  5. **Update marketing copy and onboarding** to either explicitly support Symbility (if confirmed working) or explicitly limit support to Xactimate (if not).
- **Acceptance criteria**:
  - At least 3 Symbility comparisons processed end-to-end with extracted items spot-checked against source PDFs (no hallucination, ≥95% extraction accuracy).
  - Aggregates (yours total, adjuster total, gap) within ±2% of values computable by hand from the PDFs.
  - At least one Symbility case is in the regression suite.
  - Marketing/landing-page claims about supported formats are factually accurate.
- **Why P0 (not P1)**: any Symbility user hitting the silent-hallucination path on day 1 will get a "successful comparison" full of fabricated line items, charge against their AI usage cap, and have no way to know the result is garbage. This is a data-correctness + customer-trust failure mode, both of which qualify as P0 launch blockers.
- **Cross-reference**: blocks the same "non-numbered format" hallucination class as #30. Resolving #30 first (with the anti-hallucination guard) at least bounds the worst case to "clean failure" instead of "fabricated success", at which point Symbility support becomes a P1 enhancement instead of a P0 trust risk.

### 32. Continuation-extraction hallucination — Haiku fabricates items to satisfy its own `total_count` estimate **(P0, OPEN — discovered Apr 29 2026 during N1 P8.6)**
- **File**: `estimatch-app/lib/pdf-vision-extract.ts` (specifically the continuation logic around `buildContinuationPrompt` and the items-merge after each call)
- **Discovery context**: During N1 Phase 8.6's empirical stress run (comparison `ff969ae4-e9b1-47eb-b7ff-c737c36ddfae`), the adjuster PDF — which the user reports contains ~600 items — extracted as **1116 items**. First Haiku call returned 713 items + `truncated=true` and self-reported `total_count=1116`; the continuation call then "delivered" the remaining 403 items. Zone-density signature is consistent with fabrication: yours side has ~22 items per zone average, adjuster side has ~45 items per zone average — roughly 2× density across 25 zones.
- **Symptom**: when Haiku hits `max_tokens=64000` mid-extraction and reports `total_count=N` greater than what it actually streamed, the continuation prompt asks Haiku for items `N+1..total_count`. The model then produces plausible-looking continuation items that match its earlier zone vocabulary but **don't correspond to anything in the source PDF**. This is a different failure mode from the unnumbered-PDF hallucination tracked in #30 — that one happens because Haiku can't anchor at all; this one happens because Haiku self-anchors on an estimate it invented.
- **Why this is P0**: same reason as #30 — silent fabrication with no error signal, paid AI spend on doomed continuation calls, downstream Sonnet pairing produces a `COMPLETED` comparison full of items the user never wrote. Customer trust + cost + correctness all compromised.
- **Suspected root cause**: the system prompt currently says `total_count must equal the highest item number in the PDF. Count all numbered items BEFORE extracting to ensure none are skipped.` Haiku interprets this as a *commitment* — once it claims `total_count=1116`, it feels obligated to deliver 1116 items even if it loses page anchoring during streaming and starts fabricating.
- **Fix sketch** (must be designed in N2):
  1. **Don't trust `total_count` as a hard target.** The continuation loop should ask for items `N+1` onward without specifying an upper bound, and stop when Haiku responds with an empty array or repeats earlier items.
  2. **Anchor continuation by content, not by index.** Continuation prompt should include the *last 3-5 verbatim descriptions* extracted so Haiku can locate its position in the PDF, then explicitly say "return only items that come AFTER these. If you cannot find them, return `{\"items\":[]}`."
  3. **Detect duplication post-merge.** After merging continuation items into `allItems`, fingerprint each item (description + zone + costs) and flag near-duplicates spanning the continuation boundary as a strong fabrication signal.
  4. **Sanity-check zone density.** If an extracted side's per-zone item density is more than 1.5× the contralateral side's, log a warning and consider rejecting the continuation pages.
- **Acceptance criteria**:
  - The same adjuster PDF re-extracts to the user's expected ~600 items (±5%).
  - At least 3 large-PDF comparisons re-run end-to-end with extracted item counts within ±5% of hand-counted truth.
  - No silent fabrication — when continuation cannot anchor, the system errors out cleanly rather than producing fictional items.
- **Cross-references**: tightly coupled with #30 (format-tolerance) and #33 (page-chunking — a page-chunked architecture would inherently solve this by giving each chunk a known page range to anchor against). Likely both are addressed together in N2.

### 33. Stage A extraction needs page-chunked architecture for PDFs >1,000 items **(P0, OPEN — discovered Apr 29 2026 during N1 P8.6)**
- **File**: `estimatch-app/lib/pdf-vision-extract.ts` (`extractWithVision`, `callHaikuExtraction`, and the continuation-call loop)
- **Discovery context**: During the same Phase 8.6 stress run, Stage A extraction (both sides) took **9.4 minutes wall-clock** for 601 + 1116 = 1717 items. Linear extrapolation puts a 5,000-item single-side extraction at **35-45 minutes** for one side, which exceeds Vercel's `maxDuration=800` ceiling per step. We also hit Anthropic's upstream Cloudflare-edge timeout (HTTP 520) on a different ~1000-item single-call attempt earlier in the same session — confirming that single-call full-PDF extraction has a hard ceiling at the API-provider layer, not just on our side.
- **Symptom — capacity ceiling at scale**: a comparison whose largest single side has >1,000 items either (a) takes longer than `maxDuration` and gets killed mid-step, (b) hits Anthropic's upstream 520, or (c) succeeds but at a wall-clock that's user-hostile (>15 min just for extraction).
- **Why this is P0**: the user's stated capacity target (`N1_INNGEST_CONVERSION.md` §11) is 5,000 items per side. The N1 conversion proves the durable infrastructure handles that scale architecturally; what does NOT yet hold is the algorithmic ability to *do the extraction* at that scale within plan limits.
- **Fix — page-chunked parallel Haiku calls**:
  1. **Pre-flight via `pdf-parse`** to estimate page count and total numbered-item count.
  2. **Compute chunk size** — e.g., 25-50 pages per chunk, capped at ~250 items per Haiku call to stay well under the 64K output ceiling.
  3. **Slice the PDF by page range** (existing `pdf-lib` or similar can produce sub-PDFs in memory) — each chunk is a smaller PDF Haiku call.
  4. **Fire chunks in parallel** with a concurrency cap (e.g., 3 simultaneous Haiku calls per side) — respecting Anthropic's tier rate limits.
  5. **Merge chunk outputs**, renumber items consistently across chunks, dedupe items that may span chunk boundaries.
  6. **Each chunk is anchored on a known page range** — solves the continuation-hallucination issue (#32) as a side effect.
- **Acceptance criteria**:
  - 5,000-item-per-side comparison completes Stage A within 15 min wall-clock (parallelism converts the linear 35-45 min extrapolation to roughly N/concurrency).
  - No single Haiku call exceeds Vercel's `maxDuration=800` per step.
  - No upstream 520 errors from `api.anthropic.com` — each chunk is small enough to stay within Cloudflare's connection budget.
  - Item-count accuracy on a hand-counted reference PDF is within ±2% (no fabrication via misanchored continuations).
- **Cross-reference**: this is the architectural answer to both #30 and #32. N2 should treat #30/#32/#33 as a single epic.

### 34. Undici dispatcher patch needs production verification **(P0, OPEN — Apr 29 2026)**
- **File**: `estimatch-app/lib/pdf-vision-extract.ts:10-11, 64-82, 161, 197-199` (Agent dispatcher import + `getExtractionDispatcher()` + dispatcher passed to `undiciFetch`)
- **Context**: Tonight we patched a fundamental Node-fetch limit: the built-in `fetch` (Node 18+) uses `undici` under the hood and has a 5-minute default `headersTimeout`. Long-running Haiku PDF calls can take >5 min between request send and first response byte (Anthropic processing the PDF before generating output), which caused `UND_ERR_HEADERS_TIMEOUT` errors that killed otherwise-healthy extraction calls. The fix imports `Agent` and `fetch` from `undici` (npm), constructs a memoized dispatcher with extended `headersTimeout`/`bodyTimeout` matching `ANTHROPIC_EXTRACTION_TIMEOUT_MS`, and routes the Anthropic call through that dispatcher.
- **What needs production verification**:
  1. **The npm-installed `undici` is compatible with Vercel's Node runtime.** It works locally because dev-Node's bundled undici and the npm-installed undici don't interact (we use undici's own `fetch`, not Node's global `fetch`). Vercel's runtime *should* behave the same, but this has not been observed in prod.
  2. **The `dispatcher` option is honored at runtime.** TypeScript's `RequestInit` doesn't expose `dispatcher`; we pass it positionally to undici's `fetch`. Vercel's bundler (Turbopack via Next.js) might tree-shake or wrap the call differently than dev. Need first-prod-comparison evidence that the option survives the bundle.
  3. **`UND_ERR_HEADERS_TIMEOUT` does not appear in Vercel function logs** during any real extraction call. Any occurrence is a P0 — extraction will silently fail past 5 min.
- **Verification plan**: during the staged rollout (`PRODUCTION_CUTOVER_CHECKLIST.md` §4.7.3 stage 4), the first 5-10 prod comparisons should be live-tailed with `vercel logs --follow`. Watch for any undici-headers-timeout errors. If they appear, immediately roll back to a previous deploy and investigate (consider `setGlobalDispatcher` instead of per-call dispatcher, or moving the Anthropic call into a separate non-Vercel function).
- **Companion documentation**: `PRODUCTION_CUTOVER_CHECKLIST.md` §4.7.5 ("First-Week Production Watch List") includes `UND_ERR_HEADERS_TIMEOUT` as one of the six explicit signals to monitor. This item exists to make the verification a discrete launch checklist task rather than just a passive watch.
- **Why P0**: silent extraction failure post-launch is the worst possible failure mode — comparisons would either get stuck or surface generic errors, with no signal pointing back to this specific cause. A few minutes of live verification on the first prod runs avoids weeks of mystery debugging.

### 35. Merged zones (1:many) — UI rendering + end-to-end functionality verification **(P0, OPEN — Apr 29 2026)**
- **Cross-reference**: `N2_SPEED_CAPACITY_ACCURACY.md` Issue 7 (one-to-many zone mappings).
- **Context**: The N2 three-pass architecture supports 1:many zone matching — e.g., E1 has "Master Suite" while E2 splits it into "Master Bedroom" + "Master Bathroom." Pass 3 (Opus) declares the merge (`isMerged: true`); Pass 4 receives all sub-PDFs for the many-side and outputs items under a single canonical zone name. The DB stores a `mergedFrom` JSON field on the zone record.
- **What needs verification**:
  1. **UI rendering**: merged zones display with the canonical name and a (!) indicator icon. Tooltip correctly shows the original zone names and page ranges from both sides (e.g., *"Matched from Master Bedroom (p14–17) + Master Bathroom (p18–20) in the adjuster's estimate"*).
  2. **Line items under merged zones**: all items from the many-side sub-PDFs appear in the correct zone, correctly ordered, with no duplicates or orphans.
  3. **Match classification accuracy**: items within a merged zone are classified as MATCH / MODIFIED / MISSING / ADDED correctly — the merge does not introduce false mismatches.
  4. **DB integrity**: `mergedFrom` JSON field is populated on merged zone records and absent/null on standard 1:1 zone records.
- **Acceptance criteria**:
  - At least one real comparison with a known 1:many zone pairing processed end-to-end.
  - UI displays the merged zone with tooltip metadata matching the `mergedFrom` field.
  - Item counts within the merged zone match hand-counted truth from the source PDFs (±2%).
- **Why P0**: a wrong merge silently corrupts all line-item data for that zone. If the UI doesn't surface merge metadata, the user has no way to audit what happened.

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
