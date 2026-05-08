# N2 — Speed, Capacity, Accuracy

> **Purpose**: Persistent record of the N2 effort — **scaling the comparison pipeline beyond its current empirically-verified ceiling of ~1,700 items per comparison up to the stated target of 5,000 items per side, while drastically improving extraction accuracy.** This document mirrors `N1_INNGEST_CONVERSION.md`'s structure: planning + ledger + post-mortem in one place.
>
> **Companion docs**: `N1_INNGEST_CONVERSION.md` (predecessor — the durable-orchestration foundation N2 builds on), `OUTSTANDING_WORK.md` (P0 items #30/#31/#32/#33/#34 are N2's targets), `PRODUCTION_CUTOVER_CHECKLIST.md` §4.7 (operational baseline).

**Started**: Apr 29, 2026 (~19:20 EDT, immediately after N1 RESOLVED)
**Status**: ⏸️ **PAUSED FOR N3 DEVELOPMENT (May 7, 2026 ~20:30 EDT).** N2 is no longer the active production pipeline — N1 has resumed that role while N3 is built. All N2 code, prompts, schemas, the Inngest function, and the `ComparisonProcessingState` table are left INTACT for fast restoration. The disconnect lives in `lib/n2/n2-routing.ts` (`N2_PAUSED_FOR_N3 = true`). Flip that constant to `false` and verify `N2_ENABLED=true` in `.env.local` to restore N2.

**Final state at pause**: Phases 1 + 2 + 2B + 2C + 3 + 4 COMPLETE. Pass 4 hardening complete (May 6 — Issues 37, 38). Pass 5 (Cross-Zone Reconciliation) IMPLEMENTED + HARDENED (May 6–7 — Issues 39, 40, 41, 42, 43). Pass 4 deterministic classifier override (May 7 — Issue 44). JSON parser tolerance (May 7 — Issue 45). Pass 1/2 zone-detection robustness (May 7 — Issue 46). **Set3 item accuracy ~91–93% (single-run variance). Cheatsheet count exact match (78 items) when zone detection collapses; ~107 items when zone detection is correct due to remaining cross-zone reconciliation gap.** Phase 5 (Large Zone Flow) + Phase 6 (Routing & Validation) not started.

**Why paused**: Pass 3's within-zone matching is structurally fragile. On May 7 we observed Pass 3 wrong-pairing the adjuster's `Demolition & Debris Hauling` zone with the contractor's `General Site Conditions` zone (cheatsheet expected Demolition unmatched). This corrupted ~26 items by classifying them as ADDED instead of MATCH-via-Pass-5-cross-zone. The same elimination-plus-count-similarity logic that correctly merged `Lobby + Exam + Records → Carpentry & Misc.` produced this failure, indicating the architecture's reliance on Pass 3 being right-on-the-first-pass is a hard ceiling on accuracy. N3's design (verified zones as PRIORS rather than HARD WALLS, with global candidate generation) removes this dependency entirely. The N3 build supersedes further N2 hardening.

**Owner**: Cascade + user (paired)

> **Terminology — Phase vs. Pass.** This doc uses two similar-sounding terms with distinct meanings:
> - **Pass N** = an architectural AI-call stage in the pipeline. The pipeline has five Passes: Pass 1 (zone detection E1), Pass 2 (zone detection E2), Pass 3 (zone matching), Pass 4 (per-zone extraction + matching), Pass 5 (cross-zone item reconciliation, added May 6).
> - **Phase N** = a project-management milestone in the build-out timeline. Phases 1–4 are complete; Phases 5 (Large Zone Flow) and 6 (Routing & Validation) are deferred. **Phase 5 ≠ Pass 5** — Phase 5 is the deferred Large Zone Flow capacity work; Pass 5 is the newly-added cross-zone reconciliation AI call. The two are unrelated.

---

## 1. The Three Goals (in priority order)

### 1.1 Accuracy

**Most important.** A fast, high-capacity pipeline that produces fabricated line items is worse than a slow, low-capacity pipeline that produces correct ones. Every other improvement is gated on extraction not lying.

**Concrete targets:**
- No silent hallucination on **any** PDF format (numbered Xactimate, unnumbered Xactimate, Symbility, generic table). When the system can't extract reliably, it errors out; it does not invent items.
- Item-count accuracy on hand-counted reference PDFs within **±2%**.
- Aggregate accuracy (yours total, adjuster total, gap) within **±2%** of values computable by hand from the source PDFs.

**Source items**: `OUTSTANDING_WORK.md` #30, #31, #32.

### 1.2 Capacity

**Reach the stated 5,000-item-per-side ceiling.** N1 verified the durable infrastructure can carry that load via Supabase escape-hatch + multi-step Inngest. The remaining work is algorithmic: extraction, prematch, pairing each need to stay inside per-step time and cost budgets at that scale.

**Concrete targets:**
- 5,000-item-per-side comparison completes end-to-end without a `maxDuration` breach on any single step.
- No upstream Anthropic Cloudflare 520s — no single API call is large enough to hit the provider edge ceiling.
- Stage C (Sonnet pairing) chunked-pairing path validated at multi-chunk scale (tonight's run hit single-chunk path only).

**Source items**: `OUTSTANDING_WORK.md` #33.

### 1.3 Speed

**Reduce end-to-end wall-clock for production-shape inputs.** Tonight's empirical baseline: ~13 min for a 1,717-item comparison. That's user-hostile. Every minute we cut applies to every user, every comparison, forever.

**Concrete targets:**
- 1,000-item comparison completes in **<5 min** (down from tonight's ~13 min).
- 5,000-item comparison completes in **<15 min** (vs. linear extrapolation of ~35-45 min for extraction alone).
- Stage A wall-clock dominated by parallelism, not single-call latency.

**Source items**: `OUTSTANDING_WORK.md` #33 (parallel page-chunked extraction is the primary lever); secondary opportunities in Stage B/C TBD.

---

## 2. Empirically Discovered Constraints (carried forward from N1)

These were observed during N1 Phase 8 — they are facts to design around, not hypotheses to test:

| # | Constraint | Where observed | Implication for N2 |
|---|---|---|---|
| 1 | Single Haiku call hits Anthropic upstream **HTTP 520** at ~2 min request duration | Earlier in Apr 29 session against an unnumbered ~1000-item PDF | Per-call extraction must stay well under the upstream connection budget — drives chunking |
| 2 | Single Haiku call output ceiling at **64K tokens (`max_tokens=64000`)** | Tonight's adjuster side, first call truncated at 713 items | Per-chunk output target should be ~150-250 items max |
| 3 | Continuation prompts that anchor on **self-reported `total_count`** drive fabrication | Tonight's adjuster side: ~400 items hallucinated to satisfy `total_count=1116` claim | Continuation must anchor on PDF-page boundaries, never on numeric targets |
| 4 | Node `fetch` has a **5-min default `headersTimeout`** that kills long calls before app-level timeout | Apr 29, before undici dispatcher patch | Already patched in N1; needs prod verification (#34) |
| 5 | Stage A wall-clock for ~1,100 items: **9.4 min** | Tonight's adjuster side, two Haiku calls serially | Parallel chunked extraction is the only way to scale this |
| 6 | Stage C single-chunk pairing at 1,647 lines: **94s** | Tonight's run | Likely fine; multi-chunk path at 5K-per-side untested |
| 7 | N1 durable infrastructure has **no observed ceiling** in tonight's testing | All 7 P8 verifications + the 1,717-item run | Infrastructure is not the bottleneck — algorithm is |

---

## 3. Agreed Architecture: Five-Pass Design

> **Status**: Agreed in session Apr 29, 2026 (Passes 1–4). Pass 5 added May 6, 2026 to address structural mismatch between contractor and adjuster zone organization. Replaces the original Phase A/B/C/D plan below (§3-legacy).
>
> **Title note**: The architecture was originally titled “Three-Pass Design” in May 1–3 sessions (the meaningful logical separation was Detect / Match / Extract). The pipeline has always implemented this as four separate AI-call stages (Passes 1, 2, 3, 4). Pass 5 was added May 6, 2026, bringing the total to five distinct AI-call passes.

---

> ### 🚨 N1 IS THE FALLBACK — DO NOT REPLACE IT DURING N2 DEVELOPMENT
> **N2 is built alongside N1, not on top of it.** N1 remains the active production pipeline throughout the entire N2 development and validation period. All N2 code is written in new files. No N1 file is modified or deleted until N2 has been fully verified in production.
>
> If N2 fails in production for any reason, N1 is the rollback. That rollback path must remain clean and intact at all times. Any developer working on N2 must treat N1 code as read-only.
>
> N1 is retired in one deliberate commit — only after N2 has been validated end-to-end on real production comparisons.

---

> ### ⚠️ SCOPE: XACTIMATE-XACTIMATE ONLY
> **Everything documented in this architecture — every pass, every prompt rule, every issue resolution, every design decision — is explicitly scoped to the `xactimate-xactimate` comparison case.**
>
> Once Xactimate-Xactimate is fully built, tested, and validated in production, the architecture will be retrofitted for:
> - `symbility-symbility` (Issue 23)
> - `xactimate-symbility` cross-format (Issue 24)
>
> Do not attempt to generalize any implementation to cover these cases until Xactimate-Xactimate is bulletproof. Every offshoot will be designed as a deliberate extension of what is proven here, not a parallel effort.

---

The original pipeline (extract all → reconcile zones → pair all) is replaced with a multi-pass architecture that does zone matching **before** item extraction. This eliminates continuation hallucination, removes the 64K output ceiling risk, removes the HTTP 520 risk, and improves matching accuracy by scoping each AI call to a single zone.

**Pipeline summary (5 passes):**

1. **Pass 1** — Zone detection on contractor PDF (parallel chunked Sonnet calls).
2. **Pass 2** — Zone detection on adjuster PDF (parallel chunked Sonnet calls, identical to Pass 1).
3. **Pass 3** — Cross-estimate zone matching (one Sonnet call, text only — see Pass 3 §3 entry for the historical Opus spec deviation).
4. **Pass 4** — Per-zone item extraction + matching (parallel Sonnet calls, one per zone pair, with explicit per-side zone-name allow-lists for merged zones).
5. **Pass 5** — Cross-zone item reconciliation (one Opus call, text only) — sweeps unpaired items across zone boundaries to recover MATCH/MODIFIED pairs that Pass 4 couldn’t produce because the contractor and adjuster organize their estimates differently (e.g. contractor groups demo work by room, adjuster bundles all demo into a single “Demolition” zone). Conservative confidence threshold; matched cross-zone pairs file under a synthetic **CROSS ZONE MATCHES** zone.

---

### Pass 1 — Zone Detection for Estimate 1 (parallel Haiku chunks)

**What:** Chunk estimate 1's PDF into ~10-page sub-PDFs. Fire all chunks in parallel to Haiku asking **only** for zone/section names and their start pages. No line items extracted here.

**Why chunking is required:** Sending a full 60-80 page PDF in one call risks the HTTP 520 at ~2 min request duration even with tiny output, because input processing time scales with PDF size regardless of output size.

**Output per chunk:** ~50-120 tokens (zone names, page numbers, and approximate item counts). Very fast per call.

**Result after merge:** One sorted zone map for estimate 1 with estimated item counts:
```
Kitchen→P1 (~35 items), Dining Room→P3 (~22 items), Lounge→P7 (~45 items), Living Room→P11 (~60 items) ...
```

**Approximate item count per zone** — each chunk also returns an estimated number of line items visible under each zone header. This is a rough count (Haiku is already reading the pages, so this adds near-zero cost). Five uses:
1. **Large Zone Flow routing:** If any zone's estimated count exceeds ~200 items per side, that zone is routed to the Large Zone Flow (deterministic prematch + tiered AI matching) instead of standard Pass 4. See Issue 10.
2. **Pass 3 confidence signal:** Similar item counts between two zones across estimates is a weighted factor that increases zone-matching confidence.
3. **Post-extraction validation:** After Pass 4, compare actual extracted count against the estimate. A large discrepancy (actual < 50% of estimate) flags a potential extraction failure for logging or retry.
4. **Concurrency scheduling:** Large zones (high item count) are scheduled first within the concurrency cap so they run in parallel with faster-finishing small zones, improving wall-clock utilization.
5. **Output token budget:** `max_tokens` for each Pass 4 call can be set proportionally to the expected item count, making truncation detection (Issue 34) more precise.

#### Format Detection (chunk 1 only — no separate pass)

The first chunk of each PDF sees the document header, branding, footer, and overall structure. Format detection is embedded as a required field in the Pass 1/2 chunk 1 prompt only — not a separate API call, not a separate pass, zero added latency.

Prompt addition to chunk 1: *"Before listing zones, identify the format of this document: Xactimate, Symbility, or Unknown."*

The detected format is stored alongside the zone map and used to select prompt templates for all downstream passes (Pass 1/2 remaining chunks, Pass 3, Pass 4). The format pair (E1 format + E2 format) determines which template set is used:
- `xactimate-xactimate` → standard templates (built first, fully validated before others)
- `symbility-symbility` → deferred (see Issue 23)
- `xactimate-symbility` → deferred (see Issue 24)

If format is `Unknown`, surface an error to the user rather than proceeding with potentially wrong templates.

---

#### ⚠️ CRITICAL: Page Numbering in Chunk Prompts

When a PDF is sliced into a sub-PDF (e.g. pages 11-20 of the original), the sub-PDF's internal page numbers restart at 1. The model will report zone start pages as 1-10 when the real document pages are 11-20.

**Every chunk prompt MUST explicitly state the original page offset:**
> "These pages are pages 11–20 of the original 80-page document. Report all page numbers using the original document page numbers (11–20), NOT this sub-document's page numbers (1–10)."

Failure to do this means all zone start pages are wrong, which corrupts every downstream page range calculation.

#### Zone Page Range Derivation (computed by us — no model call needed)

After merging all chunk results, sort zones by start page. End pages are computed deterministically:
```
Zone N end page  = Zone N+1 start page
Last zone end    = final page of document
```

**No extra buffer or artificial overlap needed.** The reasoning:
- Zone N's items cannot start before Zone N's header page (the header IS the start marker).
- Zone N's items can spill onto the same page as Zone N+1's header.
- By defining Zone N's end as Zone N+1's start page, the boundary page is included in both zones' ranges.
- Zone-aware prompts in Pass 4 handle attribution on the shared boundary page — no double-counting.

**Approximate item count aggregation:** Each chunk reports `approx_items` per zone header it detects. A zone that spans multiple chunks will only have a count from the chunk(s) where its items are visible. At merge time, sum `approx_items` across all chunks that report items for the same zone. For zones that span chunks without a new header (chunk returns empty zones array), the items on those pages belong to the preceding zone — add the chunk's total visible item count to that zone's running total. The result is a rough per-zone item count estimate used for Large Zone Flow routing (Issue 10) and other downstream decisions.

---

### Pass 2 — Zone Detection for Estimate 2 (parallel Haiku chunks)

**What:** Identical to Pass 1, applied to estimate 2's PDF.

**Timing:** Passes 1 and 2 are independent and run fully concurrently — all chunks for both estimates fire simultaneously under the concurrency cap.

**Result after merge:** One sorted zone map for estimate 2:
```
Dining Room→P1, Living Room→P5, Main Lounge→P13 ...
```

End pages computed the same way as Pass 1.

---

### Pass 3 — Zone Matching (one Sonnet call, text only — no PDFs)

**Model:** `claude-sonnet-4-6` (implementation reality as of May 3, 2026). The original architectural spec called for `claude-opus-4-7` because Pass 3 must handle ambiguous zone name matching, duplicate zone names with page-number disambiguation, and 1:many zone relationships. During Phase 3 implementation we deviated to Sonnet 4-6 after empirical accuracy on real Xactimate-Xactimate test cases proved sufficient at substantially lower latency and cost. The Opus reasoning headroom is held in reserve for Pass 5 (cross-zone reconciliation), where the conservative posture and per-pair scrutiny justify Opus pricing.

**What:** Send both zone maps (zone names + page ranges, plain text) to Sonnet. Sonnet matches zones across the two estimates by name/meaning.

**Pass 3 does NOT receive any PDF data.** Only the two zone lists.

**Output:**
```
Matched:   Dining Room (E1: P3–P7)  ↔ Dining Room (E2: P1–P5)
Matched:   Lounge (E1: P7–P11)      ↔ Main Lounge (E2: P13–P19)
Unmatched: Kitchen (E1: P1–P3)      → no counterpart in E2
Unmatched: (none in E1)             ← Garage (E2: P44–P49)
```

**Cost:** Tiny input, tiny output. ~5-15 seconds.

**Unmatched zones** still proceed to Pass 4 — extract only, no cross-estimate matching. All items from unmatched zones classified as MISSING_FROM_ADJUSTER or ADDED_BY_ADJUSTER wholesale.

---

### Pass 4 — Parallel Per-Zone Extraction + Item Matching

**Model:** `claude-sonnet-4-6` (raised from Haiku 4.5 on May 6, 2026 — see Issue 38). Tier 2 rate limits are identical for Sonnet and Haiku at the 4.x generation (1,000 RPM / 450K ITPM / 90K OTPM), so throughput is unaffected. Per-call output cap raised from `8,192` to `16,384` (Sonnet supports up to 64K).

**What:** One AI call per matched zone pair (and one per unmatched zone). Each call:
1. Receives **two sub-PDFs** as separate document blocks: zone A pages sliced from estimate 1 + zone B pages sliced from estimate 2. For 1:many (merged) zone pairs the relevant sides’ page ranges are concatenated into a single sub-PDF via `sliceMultipleRanges()`.
2. Extracts all line items from both zone documents.
3. Matches and classifies each item pair: MATCH / MODIFIED / MISSING_FROM_ADJUSTER / ADDED_BY_ADJUSTER.

**Why this is accurate:** The model is comparing ~20-50 items against ~20-50 items within a single zone, not 1,700 against 1,700 across an entire document. Hallucination risk drops dramatically — no single call can approach the 64K output ceiling or the 2-min 520 threshold.

**Merged-zone scoping (Issue 37, May 6, 2026):** The Pass 4A prompt now receives explicit per-side zone-name allow-lists (`e1ZoneNames[]` and `e2ZoneNames[]`) — every contractor zone whose pages were stitched into Document 1, and every adjuster zone whose pages were stitched into Document 2. The prior single-canonical-name scoping rule (“extract only items in zone X; stop at any other zone header”) was a vestigial guard from before merged-zone support existed. On a merged contractor PDF (e.g. `Lobby + Exam + Records` stitched into one document), it told the model to stop reading at the first “foreign” header inside the document, silently dropping ~17 items per merged zone. The new rule explicitly enumerates every legitimate header and asks the model to ignore only headers from outside both lists.

**Large Zone Flow:** If any zone's estimated item count (from Pass 1/2) exceeds ~200 items on either side, that zone pair is routed to the Large Zone Flow — a separate extraction → deterministic prematch → tiered AI matching path. See Issue 10 for the full algorithm. Standard zones and Large Zone Flow zones within the same comparison are processed independently. (Phase 5 work — not yet wired.)

**All zone pairs fire in parallel** under the concurrency cap of 8.

**Unmatched zone calls (Pass 4B):** Single sub-PDF only. Prompt extracts all items and marks them MISSING or ADDED accordingly. These items are eligible inputs to Pass 5 cross-zone reconciliation — do not assume “unmatched zone” means “definitively unmatched items.” Pass 5 may pair them with orphans from other zones.

---

### Pass 5 — Cross-Zone Item Reconciliation (one Opus call, text only — no PDFs)

> **Status:** Architecture agreed May 6, 2026. Implementation in progress.
>
> **Distinguish from Phase 5 (Large Zone Flow):** Phase 5 is deferred capacity work for zones with >200 items per side. Pass 5 is the new cross-zone item reconciliation AI call described here. The two share a number but solve unrelated problems.

**Model:** `claude-opus-4-7` (or current Opus tier). Opus is required because Pass 5 must scrutinize every candidate cross-zone pair against zone, total, quantity, unit, and description signals, and must err strongly on the side of CAUTION — a wrong cross-zone match silently corrupts the user’s line-item report. The reasoning headroom matters more here than in any other pass. Sonnet was considered and rejected for Pass 5: this call sees fewer than 50 items per side per typical comparison, so Opus per-call cost is negligible (~$0.05) while accuracy difference on conservative pairing is meaningful.

**Problem solved:** Pass 4 strictly pairs items within a single zone. When the contractor and adjuster organize the same property differently — e.g. contractor groups demolition work by room, adjuster bundles all demolition into a single `Demolition & Debris Hauling` zone — the same line of work appears in both estimates but in different zones. Pass 4 cannot pair these because they live in different zone results. The contractor side gets MISSING_FROM_ADJUSTER; the adjuster side gets ADDED_BY_ADJUSTER. Both classifications are wrong: the work is present in both estimates, just structurally relocated. On Set3, this mechanism alone produced ~22 misclassified items (~28 percentage points of accuracy loss).

**What:** A single text-only call to Opus that receives:
- The full list of MISSING_FROM_ADJUSTER items collected across all Pass 4 zones (contractor orphans).
- The full list of ADDED_BY_ADJUSTER items collected across all Pass 4 zones (adjuster orphans).
- For each orphan: description, quantity, unit, total, and the home zone name (so Opus can weight zone proximity into its decision).

**Pass 5 receives no PDFs.** It operates on already-extracted structured data from Pass 4.

**Output:** A list of proposed cross-zone pairs, each carrying a confidence score (0–100). Pairs at confidence ≥ 75 are accepted. Pairs below threshold are rejected and the orphans remain MISSING / ADDED.

**Skip conditions:** Pass 5 is skipped entirely (zero API cost) when either orphan pool is empty or contains fewer than 2 items. 1:1 zone pairings with symmetric organization typically produce zero orphans.

**Both-sides-only constraint:** Only items that are unpaired on both sides are eligible inputs. Pass 5 does **not** revisit MATCH / MODIFIED pairs from Pass 4. Pass 4 saw both sides of those pairs in the same document and made a within-zone decision; Pass 5 does not have license to override that.

**Conservative-pairing posture:** The prompt instructs Opus to refuse pairings rather than force them. Default decision when in doubt is to leave both items as orphans. This is asymmetric error-cost reasoning: a missed cross-zone match (false negative) leaves the user with the existing MISSING / ADDED disposition, which is recoverable via manual review. A wrong cross-zone match (false positive) silently corrupts the report and is not recoverable. The asymmetry justifies a strict threshold and a hesitant posture.

**Synthetic CROSS ZONE MATCHES zone:** Accepted Pass 5 pairs do not file back into the contractor’s home zone (rejected: would hide that the item was structurally relocated by the adjuster, which the user has a legitimate interest in seeing). Instead they file under a new synthetic zone named **`CROSS ZONE MATCHES`**, surfaced in the dashboard with a stylistic distinction (color, icon, or shading) and a tooltip explaining: *“These items appear in both estimates but were filed under different zones — most commonly because one side groups by room and the other by trade. Each item shows its original zone in both estimates.”* The dashboard rendering is a UI layer concern — Pass 5 itself just emits the pairs and a `crossZoneOrigin: { e1Zone, e2Zone }` field on each pair.

**Inngest fit:** Pass 5 lives inside the existing `step.run('extract-and-match')` Inngest step. It runs after `runWithConcurrencyLimit(...)` resolves all Pass 4 results and before the state write. No new step boundary, no new event, no new state stage — the reconciled zone results write to the same `n2:zones_extracted` payload. If Pass 5 fails or its API call errors, the orchestrator falls back to the un-reconciled Pass 4 output (fail-open posture) and records the failure in logs.

**Cost & latency:** ~$0.03–$0.10 per comparison. ~5–10s wall-clock added when triggered; 0s when skipped. Single API call — not a fan-out.

---

### Prompt Engineering Principles

**Context framing:** Every prompt includes a brief sentence or two explaining what insurance estimates are and why two estimates for the same property exist. This anchors the model's judgment on ambiguous cases — a model that understands it's comparing disputed insurance claims makes better decisions than one following rules with no frame.

**VERBATIM zone names (carry-over from current extraction prompt):** Zone names must be copied character-for-character from the PDF header, including floor prefixes ("1st Floor - Common Lobby", not "Common Lobby"). This rule appears in the current `pdf-vision-extract.ts` prompt and is equally critical in Pass 1/2 zone detection. Abbreviation or paraphrasing at this stage corrupts zone matching in Pass 3 and slicing in Pass 4.

**Removed: `total_count` field:** The current extraction prompt asks the model to self-report `total_count`. This is the primary source of continuation hallucination (N1 Phase 8 confirmed: model reported 1,116 items, fabricated ~400 to reach the target). The field is removed entirely from all N2 prompts. Page-chunked extraction eliminates the need for it.

**Carry-overs from current `comparison-processing.ts` prompt into Pass 4:**
- Unmatched items are normal and expected — the two estimates will almost never have the same item count. Do not force matches.
- Description similarity matching: "R&R Base cabinets" ↔ "Remove & replace lower cabinets" should match.
- Total cost as a confirming signal: if descriptions are similar but costs differ significantly, it's likely still the same item with a pricing dispute — classify as MODIFIED, not unmatched.
- One-to-one rule: each item number must appear in exactly one pair.
- Items describing completely different work must NEVER be paired even if they are the only remaining unmatched items.
- Common Xactimate patterns: R&R = Remove & Replace, SF/LF/EA/SY abbreviations, "Detach & reset" ≈ "R&R" for fixtures, grade/finish differences are normal and should still match.

**Pre-deduplication before Pass 3:** Before sending zone lists to Opus, the merge step runs a deterministic dedup pass (similar to the existing `preDeduplicateZones()` in `zone-reconciliation.ts`). This collapses obvious within-estimate duplicates — e.g. "Common Lobby" and "1st Floor - Common Lobby" in the same estimate — using substring and stem matching before Opus sees the list. Opus then handles any remaining ambiguity via Rule 7 in its prompt.

**Temperature:** All API calls use `temperature: 0` for deterministic output.

**Pass 1/2 structural note:** Pass 1/2 chunks should include 1 page of overlap at chunk boundaries (e.g. Chunk 1 = pages 1–11, Chunk 2 = pages 11–21) so the model always has visibility past the last zone header on its final page. This is a code-level concern, not a prompt concern — it handles the edge case where a zone header falls on the last page of a chunk and its confirming line items are on the next page.

---

### Baseline Prompts

> These are the baseline prompts for all four passes as agreed in session. They will evolve as Issues 5–21 are resolved. Do not treat them as final — treat them as the starting point that all future changes are layered on top of.

---

#### Pass 1 — Zone Detection, Chunk 1 (Haiku 4.5)
*(Format detection included. Used only for the first chunk of each PDF.)*

**SYSTEM**
```
You are analyzing a section of an insurance estimate PDF. Your only job is to identify the document format and locate all zone/section headers on these pages. Do not extract line items, costs, or any other data. Return only valid JSON — no markdown fences, no explanation.
```

**USER**
```
You are processing pages {startPage}–{endPage} of a {totalPages}-page insurance estimate PDF.
These page numbers are the ORIGINAL PRINTED page numbers from the document — do not renumber them from 1.

Context: Insurance estimates for property damage claims are written by two independent parties — the contractor and the insurance adjuster — for the same property. Each estimate groups line items under zone/room headers. You are identifying where each zone begins in this section of the document.

━━━ TASK 1: DOCUMENT FORMAT (this chunk only) ━━━
Identify what software produced this estimate based on its layout, branding, column structure, and visual design.
Return one of: "xactimate" | "symbility" | "unknown"

━━━ TASK 2: ZONE/SECTION HEADERS ━━━
Find all zone or section headers on these pages that mark the beginning of a group of line items for a specific room or area of the property.

WHAT IS A VALID ZONE HEADER:
A standalone heading in the body of the estimate that names a room, area, or section of the building (e.g. "Kitchen", "1st Floor - Master Bedroom", "Exterior Envelope"), immediately followed by numbered line items or a cost table on the same page or the next page.

WHAT IS NOT A VALID ZONE HEADER:
- Zone names listed in a table of contents, summary page, or recap section
- Page headers or footers
- Subtotal rows or section totals
- Headings not followed by any line items on these pages

RULES:
1. Search the body of the estimate only. Do not report zone names from any table of contents, recap, or summary section at the start of the document.
2. A valid zone header must be immediately followed by numbered line items or a cost table on the same page or the next page. If you cannot see line items beneath a heading on these pages, do not report it.
3. For each valid zone header, you MUST return the first line item visible beneath it as evidence. No evidence = do not report the header.
4. Return zone names VERBATIM — character for character exactly as they appear in the PDF. Do NOT abbreviate, shorten, rephrase, or paraphrase. Always include floor prefixes exactly as shown (e.g. "1st Floor - Common Lobby" not "Common Lobby", "2nd Floor - Office Suite 201" not "Office Suite").
5. If the same zone name appears more than once on these pages, report only the last occurrence.
6. Use the original document page numbers ({startPage}–{endPage}) for all page references — NOT 1, 2, 3 from the start of this sub-document.
7. If no valid zone headers are found, return an empty zones array. This is valid and expected.
8. For each zone header, estimate the approximate number of numbered line items visible beneath it on these pages. Count the numbered items you can see — do not guess beyond what is visible on the pages in this chunk. If the zone continues beyond this chunk, count only what is visible here.
9. Also count the total number of numbered line items visible on ALL pages in this chunk, regardless of which zone they belong to. Return this as approx_items_on_pages.

Return this exact JSON — nothing else:
{
  "first_page_printed_number": <integer — the page number printed on the very first page of this chunk>,
  "format": "xactimate" | "symbility" | "unknown",
  "approx_items_on_pages": <integer — total approximate count of ALL numbered line items visible on these pages>,
  "zones": [
    {
      "name": "<verbatim zone name exactly as it appears in the PDF>",
      "start_page": <integer — original printed page number where this header appears>,
      "evidence_item": "<text of the first numbered line item visible beneath this header>",
      "approx_items": <integer — approximate count of numbered line items visible under this zone on these pages>
    }
  ]
}
```

---

#### Pass 2 — Zone Detection, Chunks 2+ (Haiku 4.5)
*(No format detection. Used for all chunks after chunk 1, for both PDFs.)*

**SYSTEM**
```
You are analyzing a section of an insurance estimate PDF. Your only job is to locate all zone/section headers on these pages. Do not extract line items, costs, or any other data. Return only valid JSON — no markdown fences, no explanation.
```

**USER**
```
You are processing pages {startPage}–{endPage} of a {totalPages}-page insurance estimate PDF.
These page numbers are the ORIGINAL PRINTED page numbers from the document — do not renumber them from 1.

Context: Insurance estimates for property damage claims group line items under zone/room headers. You are identifying where each zone begins in this section of the document.

Find all zone or section headers on these pages that mark the beginning of a group of line items for a specific room or area of the property.

WHAT IS A VALID ZONE HEADER:
A standalone heading in the body of the estimate that names a room, area, or section of the building (e.g. "Kitchen", "1st Floor - Master Bedroom", "Exterior Envelope"), immediately followed by numbered line items or a cost table on the same page or the next page.

WHAT IS NOT A VALID ZONE HEADER:
- Zone names listed in a table of contents, summary page, or recap section
- Page headers or footers
- Subtotal rows or section totals
- Headings not followed by any line items on these pages

RULES:
1. Search the body of the estimate only. Do not report zone names from any table of contents, recap, or summary section.
2. A valid zone header must be immediately followed by numbered line items or a cost table on the same page or the next page. If you cannot see line items beneath a heading, do not report it.
3. For each valid zone header, you MUST return the first line item visible beneath it as evidence. No evidence = do not report the header.
4. Return zone names VERBATIM — character for character exactly as they appear in the PDF. Do NOT abbreviate, shorten, rephrase, or paraphrase. Always include floor prefixes exactly as shown (e.g. "1st Floor - Common Lobby" not "Common Lobby").
5. If the same zone name appears more than once on these pages, report only the last occurrence.
6. Use the original document page numbers ({startPage}–{endPage}) for all page references — NOT 1, 2, 3 from the start of this sub-document.
7. If no valid zone headers are found, return an empty zones array. This is valid and expected.
8. For each zone header, estimate the approximate number of numbered line items visible beneath it on these pages. Count the numbered items you can see — do not guess beyond what is visible on the pages in this chunk. If the zone continues beyond this chunk, count only what is visible here.
9. Also count the total number of numbered line items visible on ALL pages in this chunk, regardless of which zone they belong to. Return this as approx_items_on_pages.

Return this exact JSON — nothing else:
{
  "first_page_printed_number": <integer — the page number printed on the very first page of this chunk>,
  "approx_items_on_pages": <integer — total approximate count of ALL numbered line items visible on these pages>,
  "zones": [
    {
      "name": "<verbatim zone name exactly as it appears in the PDF>",
      "start_page": <integer — original printed page number where this header appears>,
      "evidence_item": "<text of the first numbered line item visible beneath this header>",
      "approx_items": <integer — approximate count of numbered line items visible under this zone on these pages>
    }
  ]
}
```

---

#### Pass 3 — Zone Matching (Opus 4.6)

**SYSTEM**
```
You are an expert at reconciling zone and room names across two insurance estimate documents for the same property. A contractor writes one estimate; the insurance adjuster writes the other. Both describe the same building but are created independently and may use different zone names, abbreviations, floor prefixes, and levels of specificity.

Your job is to match zones referring to the same physical room or area, assign a canonical name to each match, and flag zones that exist in only one estimate. Accuracy is critical — a wrong zone match corrupts all line-item comparison data for that zone. When in doubt, leave a zone unmatched. Return only valid JSON — no markdown fences, no explanation.
```

**USER**
```
Match the zones from these two estimates for the same property. Each zone is shown with its name, page range, and approximate item count from the original document.

Estimate 1 (Contractor) — {n} zones:
{numbered list: "Zone Name" pages {start}–{end} (~{approxItems} items)}

Estimate 2 (Adjuster) — {n} zones:
{numbered list: "Zone Name" pages {start}–{end} (~{approxItems} items)}

━━━ MATCHING RULES ━━━

1. SAME NAME, SEPARATED PAGE RANGES = DISTINCT ZONES
   If "Bathroom" appears at pages 16–19 AND again at pages 34–37 in the same estimate, these are two separate physical rooms. Treat each as an independent zone and match each one separately against the other estimate.

2. WATCH FOR DELINEATORS IN SIMILAR NAMES
   Zones with nearly identical names may be distinct rooms if they carry qualifying labels. Pay close attention to:
   - Numbers: "Bathroom 1" ≠ "Bathroom 2"
   - Floor levels: "1st Floor" ≠ "2nd Floor", "Upper" ≠ "Lower", "Main Level" ≠ "Upper Level"
   - Directions: "North Wing" ≠ "South Wing", "Front Entry" ≠ "Rear Entry"
   - Type qualifiers: "Master Bathroom" ≠ "Guest Bathroom", "Primary" ≠ "Secondary"

3. NUMBERS ARE SACRED
   Never match zones with conflicting explicit numbers. "Restroom 1" ≠ "Restroom 2". "Suite 201" ≠ "Suite 202". Exception: a simplified number may refer to the same room — "Office Suite 1" may match "Office Suite 201" if no other Office Suite exists and context supports it.

4. PAGE SPAN AND ITEM COUNT SIMILARITY BOOST CONFIDENCE
   Zones with very similar page counts are more likely to be the same room. A zone spanning 3 pages matched to a zone spanning 18 pages warrants reduced confidence — they may be different things despite sharing a name. Similarly, zones with similar approximate item counts are more likely to be the same room. A zone with ~25 items matched to a zone with ~200 items suggests a mismatch even if the names are similar.

5. BE VIGILANT FOR ABBREVIATIONS
   Zone names may be abbreviated differently across estimates. Treat abbreviated forms as potential matches for their full counterparts and factor this into your confidence assessment.

6. CANONICAL NAME = LONGEST, MOST SPECIFIC VERSION
   Always choose the most complete name. "1st Floor - Common Lobby" beats "Common Lobby". "Exterior Envelope" beats "Exterior". "General / Administrative" beats "General". "Master Bathroom" beats "Bath".

7. HANDLE WITHIN-ESTIMATE INCONSISTENCIES
   If one estimate contains both "Common Lobby" and "1st Floor - Common Lobby" as separate entries, they likely represent the same zone reported inconsistently. Treat them as one zone using the longer canonical name before cross-estimate matching.

8. NEVER FORCE A MATCH
   If no confident match exists for a zone, mark it unmatched. An unmatched zone is recoverable downstream. A wrong match corrupts all line-item data for that zone. Unmatched is always the safer choice.

9. SAME NAME, START PAGES DIFFER BY 1–2 = CHUNK BOUNDARY DUPLICATE
   If the same zone name appears twice within the same estimate and the start pages differ by only 1 or 2 pages, treat them as the same zone detected twice at a document processing boundary — not two distinct rooms. Use the lower start page. This is distinct from Rule 1 (same name, clearly separated page ranges = distinct rooms).

10. ONE-TO-MANY ZONE MATCHES ARE VALID AND EXPECTED
    One estimate may group work under a single zone (e.g. "Master Suite") while the other splits it into multiple zones (e.g. "Master Bedroom" + "Master Bathroom"). This is normal — two estimators may use different levels of granularity for the same physical area. When you identify this pattern, return the match with both zones on the many-side listed in the array. Assign the canonical name from the more specific or descriptive side. Set isMerged: true.

━━━ CONFIDENCE SCALE ━━━
- 100: Identical names
- 95: Obvious floor prefix, suffix, or formatting variant of the same name
- 90: Clear synonym or common abbreviation of the same room
- 80: Likely match based on name similarity and context
- 50–79: Possible match — include it, but assign a low confidence score
- Below 50: Do not match — return as unmatched

Return this exact JSON — nothing else:
{
  "matched": [
    {
      "e1Zones": [{ "zone": "<zone name from estimate 1>", "pages": [startPage, endPage] }],
      "e2Zones": [{ "zone": "<zone name from estimate 2>", "pages": [startPage, endPage] }],
      "canonical": "<longest most specific name for this room>",
      "isMerged": false,
      "confidence": <integer 75–100>
    }
  ],
  "unmatchedE1": [
    { "zone": "<zone name>", "pages": [startPage, endPage] }
  ],
  "unmatchedE2": [
    { "zone": "<zone name>", "pages": [startPage, endPage] }
  ]
}
```

---

#### Pass 4A — Per-Zone Extraction + Matching, Matched Zones (Sonnet 4-6)

> **Updated May 6, 2026** — Model switched Haiku 4.5 → Sonnet 4-6 (Issue 38). Rule #3 replaced with explicit per-side zone-name allow-lists (Issue 37). The opening paragraph now lists every constituent zone for merged-zone calls and adds a clarifying note when at least one side is merged.

**SYSTEM**
```
You are an expert insurance estimate analyst. You extract and compare line items from two insurance estimate PDFs zone by zone. Return ONLY valid JSON — no markdown fences, no explanation, no extra text.
```

**USER**
```
You are comparing two insurance estimates written for the same property damage claim. Both documents below correspond to the same logical area of work: {canonical zone name}.

Document 1 is the contractor's estimate (pages {e1StartPage}–{e1EndPage} of the original document).
Document 1 covers these contractor zones: "{e1ZoneNames[0]}", "{e1ZoneNames[1]}", ...
Document 2 is the insurance adjuster's estimate (pages {e2StartPage}–{e2EndPage} of the original document).
Document 2 covers these adjuster zones: "{e2ZoneNames[0]}", "{e2ZoneNames[1]}", ...

[Conditional, only included when at least one side has more than one zone:]
Note: One or both documents have had multiple zones concatenated together — treat every line item under ANY of the listed zone headers as in-scope for this comparison.

Context: The contractor and adjuster each wrote independent repair estimates for the same property damage. The same work frequently appears with different wording, abbreviations, units, or prices. The two estimates will almost never have the same number of items — unmatched items are normal and expected. Do not force matches to reduce the unmatched count.

━━━ STEP 1: EXTRACT LINE ITEMS FROM BOTH DOCUMENTS ━━━

Apply these rules to BOTH Document 1 and Document 2:

1. Extract ONLY numbered line items. A numbered line item begins with an integer followed by a period (e.g. "1.", "47.", "203.").
2. SKIP everything that is not a numbered line item: zone headers, section headers, measurement summaries, sub-totals, totals, grand totals, and notes.
3. For Document 1, extract every numbered line item appearing under any of these contractor zone headers: "{e1ZoneNames[0]}", "{e1ZoneNames[1]}", ... For Document 2, extract every numbered line item appearing under any of these adjuster zone headers: "{e2ZoneNames[0]}", "{e2ZoneNames[1]}", ... If you encounter a header for a zone NOT in the relevant list, ignore everything under it (this is a defensive guard against page-boundary spillover and should rarely fire).
4. Cost values must be exact numbers from the PDF — do not round, estimate, or calculate.
5. If a cost column has no value for an item, return null for that field.
6. If a description spans multiple lines, concatenate all lines into one string.
7. Do not invent items. If you are not certain an item exists in the PDF, do not include it.

For each line item extract:
- n: item number (integer)
- d: full description text (concatenated if multi-line)
- q: quantity as a string (e.g. "120.35") or null
- u: unit code (SF, LF, EA, SY, CY, HR, etc.) or null
- rm: remove cost (number or null)
- rp: replace cost (number or null)
- rs: reset cost (number or null)
- tx: tax (number or null)
- op: overhead & profit (number or null)
- t: total — always the rightmost cost value for this line item (number or null)

━━━ STEP 2: MATCH AND CLASSIFY ━━━

After extracting all items from both documents, match items across the two estimates.

MATCHING GUIDANCE:
- Match items describing the same trade or work, even with different wording. Examples: "R&R Base cabinets" ↔ "Remove & replace lower cabinets", "Tear out ceiling drywall" ↔ "Demo ceiling drywall".
- R&R = Remove & Replace. Common units: SF=Square Feet, LF=Linear Feet, EA=Each, SY=Square Yard, CY=Cubic Yard.
- "Detach & reset" and "R&R" are equivalent for fixtures (faucets, light fixtures, etc.).
- Grade or finish differences are normal and should still match: "standard grade" ↔ "economy grade", "satin" ↔ "eggshell".
- If two items have similar descriptions AND similar total costs, they are very likely the same item.
- If descriptions are similar but costs differ significantly, they are likely still the same item with a pricing dispute — classify as MODIFIED, not unmatched.
- Each item must appear in exactly one pair. Never use the same item number twice across any pairs.
- Items describing completely different work must NEVER be paired, even if they are the only remaining unmatched items in the zone.

Classify each pairing as:
- MATCH: Same work, same or near-identical quantity and cost. Minor wording differences acceptable.
- MODIFIED: Same type of work but different quantity, unit, or cost values.
- MISSING_FROM_ADJUSTER: Item exists in Document 1 (contractor) with no counterpart in Document 2 (adjuster).
- ADDED_BY_ADJUSTER: Item exists in Document 2 (adjuster) with no counterpart in Document 1 (contractor).

BEFORE RETURNING, VERIFY:
- Every item in your output actually appears in the PDF — no invented items
- All cost values match the PDF exactly — no rounding
- Every extracted item from both documents appears exactly once in your output

Return this exact JSON — nothing else:
{
  "zone": "{canonical zone name}",
  "pairs": [
    {
      "status": "MATCH",
      "e1": {"n":1,"d":"R&R Drywall 5/8 inch","q":"120.00","u":"SF","rm":0,"rp":234.50,"rs":null,"tx":21.93,"op":46.54,"t":302.97},
      "e2": {"n":3,"d":"R&R Drywall 5/8\"","q":"120.00","u":"SF","rm":0,"rp":234.50,"rs":null,"tx":21.93,"op":46.54,"t":302.97}
    },
    {
      "status": "MODIFIED",
      "e1": {"n":2,"d":"Paint ceiling - 2 coats","q":"120.00","u":"SF","rm":null,"rp":89.40,"rs":null,"tx":8.36,"op":17.73,"t":115.49},
      "e2": {"n":4,"d":"Paint ceiling","q":"100.00","u":"SF","rm":null,"rp":74.50,"rs":null,"tx":6.97,"op":14.78,"t":96.25}
    },
    {
      "status": "MISSING_FROM_ADJUSTER",
      "e1": {"n":5,"d":"Floor leveling compound","q":"1.00","u":"EA","rm":null,"rp":450.00,"rs":null,"tx":42.08,"op":89.20,"t":581.28},
      "e2": null
    },
    {
      "status": "ADDED_BY_ADJUSTER",
      "e1": null,
      "e2": {"n":7,"d":"Cleaning - general","q":"1.00","u":"EA","rm":null,"rp":85.00,"rs":null,"tx":7.95,"op":16.85,"t":109.80}
    }
  ]
}
```

---

#### Pass 4B — Per-Zone Extraction, Unmatched Zones (Sonnet 4-6)

> **Updated May 6, 2026** — Model switched Haiku 4.5 → Sonnet 4-6 (Issue 38). Prompt body unchanged (single-zone unmatched calls have no merged-zone problem).


**SYSTEM**
```
You are an expert insurance estimate analyst. You extract line items from an insurance estimate PDF. Return ONLY valid JSON — no markdown fences, no explanation, no extra text.
```

**USER**
```
You are extracting line items from one insurance estimate. This document covers the zone: {canonical zone name}. This zone exists only in this estimate and has no counterpart in the other estimate.

This is the {contractor's | adjuster's} estimate (pages {startPage}–{endPage} of the original document).

Context: Insurance estimates for property damage claims group line items by zone/room. You are extracting all line items from one zone that appears in only one of the two estimates.

EXTRACTION RULES:
1. Extract ONLY numbered line items — items beginning with an integer followed by a period (e.g. "1.", "47.", "203.").
2. SKIP: zone headers, section headers, measurement summaries, sub-totals, totals, grand totals, and notes.
3. Extract ONLY items within the zone "{canonical zone name}". Stop if you encounter a header for a different zone.
4. Cost values must be exact numbers from the PDF — do not round, estimate, or calculate.
5. If a cost column has no value for an item, return null for that field.
6. If a description spans multiple lines, concatenate all lines into one string.
7. Do not invent items. If you are not certain an item exists in the PDF, do not include it.

For each item extract: n, d, q, u, rm, rp, rs, tx, op, t (same fields as the matched variant).

Return this exact JSON — nothing else:
{
  "zone": "{canonical zone name}",
  "items": [
    {"n":1,"d":"Insulation - blown-in attic","q":"800.00","u":"SF","rm":null,"rp":1240.00,"rs":null,"tx":116.00,"op":245.60,"t":1601.60}
  ]
}

> **Implementation note:** Status (MISSING_FROM_ADJUSTER / ADDED_BY_ADJUSTER) is assigned by code in the extract-and-match orchestrator based on which side the zone belongs to — the AI returns items only. This matches `Pass4BResponseSchema` in `lib/n2/schemas/pass-responses.ts`.
```

---

#### Pass 5 — Cross-Zone Item Reconciliation (Opus 4-7)

> **Added May 6, 2026.** New AI call introduced to recover MATCH/MODIFIED pairs that Pass 4 cannot produce because contractor and adjuster organize their estimates differently. Operates on Pass 4's already-extracted structured output — no PDFs sent. See §3 Pass 5 for full architecture rationale.

**SYSTEM**
```
You are an expert insurance estimate analyst performing a careful, conservative cross-zone reconciliation pass on items that two different estimators left unpaired.

Your job is to identify the small subset of items that are clearly the same line of work, even though one estimator filed them under a different zone than the other. The two estimates have already been compared zone-by-zone; the items in front of you are the leftovers — items that found no counterpart inside their own zone.

You must err strongly on the side of CAUTION. A wrong cross-zone pairing silently corrupts the user's report and is unrecoverable. A missed cross-zone pairing leaves both items in their existing MISSING / ADDED disposition, which the user can review manually. The asymmetry is intentional — when in doubt, do NOT pair.

Return ONLY valid JSON — no markdown fences, no explanation, no extra text.
```

**USER**
```
Two contractors wrote independent insurance estimates for the same property damage. They organized their work differently — for example, one may have grouped demolition by room while the other bundled all demolition into a single zone. After zone-by-zone comparison, the following items were left unpaired on each side. Many of them are genuinely unique to their estimate. A small minority describe the same physical work and were misfiled into different zones; those are the candidates you must identify.

━━━ CONTRACTOR ORPHANS (items with no adjuster counterpart in their home zone) ━━━
{numbered list, each entry has:
  - id: C1, C2, ...
  - description
  - quantity + unit
  - total
  - home zone name }

━━━ ADJUSTER ORPHANS (items with no contractor counterpart in their home zone) ━━━
{numbered list, each entry has:
  - id: A1, A2, ...
  - description
  - quantity + unit
  - total
  - home zone name }

━━━ HOW TO DECIDE A CROSS-ZONE PAIR ━━━

For each potential pair, weigh ALL of these signals and form a confidence score 0–100:

1. DESCRIPTION SEMANTIC MATCH (highest weight)
   - The two descriptions must describe the same physical work, not just superficially similar trades.
   - Common synonyms are valid: "Tear out" / "Demo" / "Strip" / "Remove" all denote demolition. "R&R" = "Remove & replace". "Detach & reset" ≈ "R&R" for fixtures. "ACT" = "acoustical ceiling tile".
   - Different work types must NEVER pair. "Demo wet ACT" must not pair with "Replace ACT" — one is demolition, the other is installation. "Paint walls" must not pair with "Patch drywall."
   - Quality / grade variants are acceptable matches: "satin" ↔ "eggshell", "standard grade" ↔ "economy grade".

2. QUANTITY + UNIT MATCH (high weight)
   - Identical or near-identical quantity with the same unit is a strong positive signal.
   - Different units (SF vs LF) is a strong negative signal — usually different work.
   - Quantity differing by more than ~10% with no obvious reason is a negative signal.

3. TOTAL COST MATCH (high weight)
   - Totals within 1% of each other reinforce a match.
   - Totals differing significantly do NOT veto a pair (legitimate pricing disputes are common in insurance estimates) — but they do reduce confidence.

4. ZONE PROXIMITY (moderate weight)
   - A contractor item from "Lobby" pairing with an adjuster item from "Demolition & Debris Hauling" is a believable structural-mismatch pattern when the descriptions clearly describe demolition work.
   - A contractor item from "Roof" pairing with an adjuster item from a kitchen-related zone is implausible — flag heavy doubt.
   - Trade-bundling zones on the adjuster side ("Demolition", "General Conditions", "Carpentry") are common cross-zone pairing destinations.

5. ONE-TO-ONE PAIRING ENFORCEMENT (constraint)
   - Each contractor orphan can be paired with at most ONE adjuster orphan, and vice versa.
   - If two contractor items both look like the same adjuster item, choose the BEST single pair and leave the other contractor item unpaired.

━━━ DECISION POLICY (READ TWICE) ━━━

- If your confidence is < 75, DO NOT pair. Return the items as unpaired.
- Bias hard toward NOT pairing. The user is far better served by an unmatched orphan they can review than by a wrong cross-zone match they will not catch.
- A pairing must be defensible on description AND (quantity OR total). Description alone is never sufficient.
- Identical descriptions with vastly different totals AND different units = different work. Do not pair.
- When uncertain whether items represent the same work or two different lines of similar work, default to leaving them unpaired.

━━━ STEP 2: CLASSIFY ACCEPTED PAIRS ━━━

For each pair you accept:
- If quantity AND unit AND total match within 1% → status: "MATCH"
- Otherwise → status: "MODIFIED"

(The orchestrator may override this classification deterministically after parsing — your judgment on pairing is what matters most.)

━━━ OUTPUT FORMAT ━━━

Return this exact JSON — nothing else:
{
  "pairs": [
    {
      "contractorId": "C3",
      "adjusterId": "A7",
      "confidence": <integer 75–100>,
      "status": "MATCH" | "MODIFIED",
      "rationale": "<one short sentence explaining the match — used only for diagnostic logging>"
    }
  ]
}

Items not appearing in `pairs` remain unpaired. If you accept zero cross-zone pairings, return `{"pairs": []}`. This is a valid and expected outcome for many comparisons.
```

**Output handling:**
- Pairs at confidence ≥ 75 → applied; orphan removed from MISSING/ADDED bucket; new pair added to a synthetic `CROSS ZONE MATCHES` zone result with `crossZoneOrigin: { e1Zone: "<contractor home zone>", e2Zone: "<adjuster home zone>" }`.
- Pairs at confidence < 75 → ignored; orphans stay in their original disposition.
- Status is recomputed deterministically post-parse using the qty/total logic above (defends against AI classification drift).

---

### What This Replaces in the Current Pipeline

| Current Stage | Replaced By |
|---|---|
| Stage A: Full PDF extraction with continuation | Pass 1 + Pass 2 (zone detection) + Pass 4 (per-zone extraction) |
| Stage B: Zone reconciliation + deterministic prematch | Pass 3 (Sonnet zone matching, text only) |
| Stage C: Item pairing across all items | Pass 4 (per-zone extraction + matching combined) |
| (no equivalent) — cross-zone item recovery was not addressed | Pass 5 (cross-zone item reconciliation, Opus, text only) |
| Stage D: Finalize + persist | Unchanged |

Continuation logic in `pdf-vision-extract.ts` is **eliminated entirely** — no zone has enough items to require continuation.

---

## 3-legacy. Original Phase Structure (SUPERSEDED — kept for reference)

> Mirrors N1's phase pattern: each phase has clear entry criteria, exit criteria, and acceptance tests. Order is deliberate — accuracy work gates capacity work, capacity work informs speed work.

### Phase A — Accuracy Foundations (highest priority)

**Goal**: Eliminate silent hallucination in all paths. Add anti-fabrication guards. Resolve `OUTSTANDING_WORK.md` #30 + #32.

**Likely tasks:**
- Add anti-hallucination guard to extraction prompt: explicit "if you cannot find numbered items, return empty" instruction.
- Refactor continuation logic to anchor on PDF-page boundaries (not item-count targets).
- Post-merge fingerprint-based duplicate detection.
- Zone-density sanity check across yours/adjuster sides.
- Re-run tonight's `ff969ae4-...` adjuster PDF and confirm extraction matches user's expected ~600 items (±5%).

### Phase B — Page-Chunked Extraction (capacity + speed compound here)

**Goal**: Replace single-call extraction with page-range chunked extraction. Resolve `OUTSTANDING_WORK.md` #33. Naturally subsumes #32's "anchor by content" fix.

**Likely tasks:**
- Pre-flight pdf-parse pass to count pages + estimate items.
- Page-range slicing (probably via `pdf-lib`).
- Concurrency-controlled parallel Haiku calls.
- Cross-chunk merge + dedupe + renumber.
- Verify against #30/#32 acceptance criteria — accuracy must hold under chunking.
- Stage A wall-clock target: 5,000 items in <10 min wall-clock.

### Phase C — Format Tolerance (Symbility + unnumbered Xactimate)

**Goal**: Resolve `OUTSTANDING_WORK.md` #31. Pipeline supports any reasonable Xactimate or Symbility export, with format auto-detection or explicit user selection.

**Likely tasks:**
- Source 3 representative Symbility PDFs at small/medium/large scale.
- Run through current pipeline; document failure modes per format.
- Either (a) format-detection branch with format-specific prompts, or (b) a single robust prompt that handles all formats, or (c) explicit user-selected format on upload.
- Add Symbility regression case to `n1-baseline-smoke.ts`.

### Phase D — Stage C Multi-Chunk Validation

**Goal**: Validate the existing chunked-pairing code path that was not exercised in N1's testing. Make sure 5K-per-side pairing works.

**Likely tasks:**
- Test against a comparison with 2,500+ items per side (where chunking will trigger).
- Verify chunk-boundary item handling.
- Verify aggregate correctness across chunks.

### Phase E — Production Cutover

**Goal**: Ship N2 to production, verify the prod-cutover items from N1 (#34) plus N2's own additions.

**Likely tasks:**
- Coordinate with `PRODUCTION_CUTOVER_CHECKLIST.md` §4.7.
- First-week production watch list now includes N2's additions.

### Phase F — Documentation Sweep (mirrors N1 Phase 9)

**Goal**: Sync all four supplementary docs with N2's changes.

---

## 4. Open Questions

**Resolved:**
- ~~Phase ordering~~ — N/A. The three-pass architecture replaces the phase A/B/C/D ordering question entirely.
- ~~Continuation hallucination fix~~ — Eliminated architecturally. No zone has enough items to require continuation.
- ~~Overlap at zone boundaries~~ — Resolved. Zone N end page = Zone N+1 start page. Built-in, no artificial buffer needed. Zone-aware prompts handle attribution on shared boundary pages.
- ~~Pass 3 model choice~~ — Resolved May 3, 2026. Implementation deviates from spec: `claude-sonnet-4-6` (not `claude-opus-4-7`). Empirical accuracy on Xactimate-Xactimate proved sufficient at lower latency/cost; Opus reasoning headroom is held for Pass 5.
- ~~Pass 4 model choice~~ — Resolved May 6, 2026. **`claude-sonnet-4-6`** for both Pass 4A and Pass 4B. Originally piloted with Haiku 4.5; production-quality accuracy testing on Set3 surfaced silent item-drop on merged zones (~17 items lost on a 27-item merged zone). Switched to Sonnet for output fidelity. Tier 2 rate limits identical between Haiku and Sonnet at 4.x generation, so no throughput tradeoff. Per-call max_tokens raised from 8,192 to 16,384.
- ~~Pass 5 model choice~~ — Resolved May 6, 2026. **`claude-opus-4-7`** for cross-zone reconciliation. Conservative-pairing posture and per-pair scrutiny justify Opus reasoning quality despite higher per-token cost; per-call cost remains negligible (~$0.05) because the call sees fewer than ~50 items per side.

**Still open:**
1. **Concurrency budget**: How many parallel Sonnet calls? Tied to user's Anthropic API tier rate limits. Check console before implementing the concurrency cap. (Currently 8; Tier 2 supports 1,000 RPM so unlikely to be a constraint.)
2. **Pass 5 confidence threshold tuning**: Threshold set to 75 based on initial reasoning. May need adjustment after empirical Set3-style testing — if false-positive rate exceeds 1%, raise to 80–85.
3. **Format-detection vs. user-selection**: Should ScopeSplit auto-detect Xactimate vs. Symbility, or ask the user on upload? Deferred — address in a later pass once the core five-pass architecture is working.
4. **5K verification approach**: Real PDFs (sourcing problem) or synthetic generation (expand existing test PDFs by repeating items across zones)? Pick a path before scale testing.
5. **CROSS ZONE MATCHES UI rendering**: Synthetic zone needs visual distinction in dashboard — deferred to UI polish pass. Pass 5 emits `crossZoneOrigin` metadata; rendering decision (color, icon, tooltip wording, sort position) handled separately.

---

## 5. Execution Ledger

| Date (UTC) | Phase.Task | Action | Notes |
|---|---|---|---|
| 2026-04-29 ~19:20 EDT | — | N2 doc created at N1 closure | Goals + constraints inventoried from N1 Phase 8 findings. Phase plan marked DRAFT. |
| 2026-04-29 ~evening EDT | Architecture | Three-pass design agreed with user | Replaces original Phase A/B/C/D plan. No code written yet. |
| 2026-05-01 | Phase 1 | Foundation complete | Schema migrations, pdf-lib, shared infra, Inngest skeleton, routing gate. |
| 2026-05-01 | Phase 2 | Zone detection complete | 4 new files, Step 2 wired. Sonnet selected over Haiku for accuracy. |
| 2026-05-02 | Phase 2B | Zone Review & Correction complete | Inngest waitForEvent gate, correction agent (Sonnet + 10 playbooks), examine_pdf_pages tool, 3 API routes, ZoneReview UI. |
| 2026-05-03 | Phase 3 | Zone matching complete | match-zones prompt + orchestrator, Sonnet model (deviation from Opus spec), Step 3 wired. |
| 2026-05-03 | Phase 2C | Zone Match Review complete | Unconditional gate (deviation from spec), MatchReview drag-and-drop UI, match-review API routes, back navigation. |
| 2026-05-03 | Phase 4 | Standard extraction complete | Pass 4A/4B prompts, extract-and-match orchestrator, splitMispaired, atomic persist, Steps 4+5 wired. |
| 2026-05-03 | Cross-cutting | Gate exit deletion implemented | Exit button on ZoneReview + MatchReview, beforeunload guard, confirmation dialog, DELETE on confirm, gate-state hidden from comparisons list. |
| 2026-05-06 | Pass 4 hardening | Pass 4 prompt fix + Sonnet switch | Discovered merged-zone bug: Pass 4A prompt rule #3 (“stop at different zone header”) was a vestigial guard from before merged-zone support existed; on merged contractor PDFs it silently dropped ~17 items per merged zone. Replaced with explicit `e1ZoneNames[]`/`e2ZoneNames[]` allow-lists. Switched Pass 4A and 4B from Haiku 4.5 to Sonnet 4-6; raised `PASS4_MAX_TOKENS` from 8,192 to 16,384. Set3 coverage went 90% → 98%, total items extracted 49 → 115. Item Accuracy temporarily dropped 86% → 66% because the previously-hidden cross-zone Demolition mismatch became visible (motivates Pass 5). Issues 37 and 38 closed. |
| 2026-05-06 | Pass 5 architecture | Cross-zone reconciliation pass designed | New AI-call stage: Opus 4-7, text only, fed Pass 4’s MISSING+ADDED orphan pools, conservative pairing posture (confidence ≥ 75 to accept), accepted pairs file under synthetic `CROSS ZONE MATCHES` zone with `crossZoneOrigin` metadata. Lives inside existing `extract-and-match` Inngest step (no new step boundary). Issues 39–41 documented. |

---

## 6. Document History

| Date (UTC) | Change | Reason |
|---|---|---|
| May 7, 2026 ~20:30 EDT | **N2 PAUSED FOR N3 DEVELOPMENT.** Set `N2_PAUSED_FOR_N3 = true` in `lib/n2/n2-routing.ts` so all comparison creation routes to N1. Updated Status banner to reflect pause. Final state: Set3 ~91–93% item accuracy with Pass 3 wrong-pairing of Demolition zone exposed as the architectural ceiling. All N2 code, prompts, schemas, Inngest function, and ComparisonProcessingState table left INTACT. Restoration: flip the constant to false. | Pass 3's elimination-plus-count-similarity logic produces the wrong call when an adjuster trade zone has no contractor counterpart but the model has been told to consider 1:many merges valid. Within-zone matching is the architectural weakness. N3's verified-zones-as-priors design removes this dependency. Continued N2 hardening past the structural ceiling is not a good investment relative to building N3-lite. |
| May 7, 2026 | Added Issues 42–46 (temperature deprecation, Pass 5 prematch + prompt rebalance, Pass 4 deterministic classifier, JSON parser tolerance, Pass 1/2 zone-detection robustness). Updated top-of-doc Status. | Today's Pass 5 + Pass 4 hardening pass moved Set3 from 80% to 92–93% item accuracy. Documenting the changes alongside the code so future readers see the decision trail. |
| 2026-04-29 ~19:20 EDT | Initial creation. | N1 closed; user requested immediate transition to N2 with focus on speed, capacity, accuracy. |
| 2026-04-29 ~evening EDT | Added §3 (Three-Pass Architecture), superseded original phase plan to §3-legacy, updated §4 open questions. | Architecture agreed in session — recorded before context limit to preserve decisions. |
| 2026-04-29 ~evening EDT | Added §7 Pre-Implementation Issues. | 22 issues identified in mastermind session. Resolving 1-by-1 before any code is written. |
| 2026-04-29 ~evening EDT | Added format detection to Pass 1 chunk 1; added Issues 23 + 24 (Symbility scenarios deferred). | Xactimate-Xactimate built and validated first. Symbility and cross-format retrofitted after. |
| 2026-04-29 ~evening EDT | Added Prompt Engineering Principles to §3; reviewed existing prompts for carry-overs; baseline prompts for all four passes established in session. | Full prompt review of pdf-vision-extract.ts, zone-reconciliation.ts, comparison-processing.ts completed before writing baselines. |
| 2026-05-02 ~evening EDT | Added Issues 37–41 (Zone Review & Correction system) and Phase 2B to Construction Phases. Updated pass1-chunk1.ts and pass1-chunk-n.ts prompts with 8 improvements (Total: vs Totals: distinction, coverage subdividers, pseudo-zones with placeholder dimensions, Height: Peaked, area-as-zone exception, format detection cues, Rule 3 chunk boundary clarification, Rule 5 tightening). | Session focused on prompt hardening against Empire Estimators and RRA format edge cases, and full architecture design for user-facing zone correction. |
| 2026-05-03 ~evening EDT | Phases 3, 2C, and 4 built and completed. Back navigation on match review gate. Gate exit deletion feature: Exit button on both gate components, `beforeunload` guard, confirmation dialog in page.tsx, `DELETE /api/comparisons/[id]` on confirm, gate-state comparisons filtered from comparisons list. Construction Phases updated to reflect all phases through Phase 4 complete. | Full pipeline now runnable end-to-end through standard extraction. Phases 5 (LZF) and 6 (Routing & Validation) remain. |
| 2026-05-06 ~evening EDT | Doc reconciliation sweep: (a) renamed §3 “Three-Pass Design” → “Five-Pass Design”; (b) added Pass 5 architecture section + baseline prompt + What-This-Replaces row; (c) reconciled stale Pass 3 model spec (Opus) with implementation reality (Sonnet); (d) reconciled Pass 4 stale Haiku references in §3 description, baseline prompt headers, Open Questions, and Phase 4 Implementation Summary key constants; (e) updated Pass 4A baseline prompt rule #3 with the new e1/e2 zone-name allow-list approach; (f) added Issues 37–41 covering today’s prompt fix, Sonnet switch, Pass 5 architecture, CROSS ZONE MATCHES synthetic zone, and Pass 5 confidence-threshold policy; (g) added Phase vs. Pass terminology callout to prevent confusion with the existing “Phase 5 (LZF)” concept. | Documentation needed to match code reality before Pass 5 implementation begins. Discrepancies (D1–D7) catalogued during /review and explicitly reconciled in this commit. |

---

## 7. Pre-Implementation Issues

> All 41 issues must be resolved before implementation begins. Work through them in order. Update status inline as each is closed.
>
> **Note:** Issues 1–36 are pre-implementation design questions resolved before or during the initial Phases 1–4 build-out. Issues 37–41 were added May 6, 2026 covering today’s Pass 4 hardening (37, 38) and the new Pass 5 architecture (39, 40, 41). The Phase 2B specifications below are a separate section — they describe a fully-designed feature, not open questions.

---

### Pass 1 / 2 — Zone Detection

**Issue 1 — Printed page numbers vs. PDF internal page numbers**
- **Status:** 🟢 RESOLVED
- **Problem:** The model reports numbers printed on PDF pages. pdf-lib slices by internal 0-indexed position. On PDFs with cover pages, summaries, or ToCs before the estimate body, these two numbering systems are offset by N pages. Every slice will be wrong if we don't reconcile them.
- **Resolution:** Every Pass 1/2 chunk prompt must require the model to return the printed page number of the first page in that chunk as a mandatory field in its response. At merge time, compute the offset for each chunk: `offset = chunk_start_internal_index - reported_first_page_printed_number`. Apply the offset when converting any reported zone start page to an internal pdf-lib index: `internal_index = printed_page_number + offset`. This is not optional — it is a core field in every chunk's response schema. Zone ranges are always stored and communicated in printed page numbers; the offset is only applied at the moment of pdf-lib slicing.

---

**Issue 2 — Table of contents / summary pages reporting false zone starts**
- **Status:** 🟢 RESOLVED
- **Problem:** Many Xactimate PDFs open with a recap listing all zone names. The model may report all zones as starting on the recap page rather than their actual location in the document body.
- **Resolution:** Six layers of defense in total — four in the prompt (Pass 1/2), two in code/Pass 3.

  **Pass 1/2 Prompt — Layer 1: Scope the search**
  *"Find zone headers in the body of the estimate only — ignore any table of contents, recap, or summary section at the start of the document."*
  Intent-level guidance. First filter.

  **Pass 1/2 Prompt — Layer 2: Define what a valid header is**
  *"A valid zone header is a standalone heading followed immediately by line items or a cost table on the same page or the next page. A zone name listed in a summary or contents section is NOT a zone header."*
  Structural definition. Gives the model a testable criterion, not just a concept.

  **Pass 1/2 Prompt — Layer 3: Evidence requirement (strongest prompt-level defense)**
  The model must return the first line item it sees beneath each reported zone header as a required field in its response. If it cannot produce one, it must not report that header. A ToC entry fails this test by definition — nothing follows it but more ToC entries.

  **Pass 1/2 Prompt — Layer 4: Last-occurrence hint**
  *"If the same zone name appears more than once in this document, report only the last occurrence."*
  Soft model-level bias toward body headers over ToC entries.

  **Merge step code — Layer 5: Never discard on name alone**
  If duplicate zone names still appear after all prompt-level filters, the merge step keeps both and disambiguates by appending the start page to the name: `"Bathroom (p16)"` and `"Bathroom (p34)"`. No zone is ever silently discarded in code based on name alone. Both entries are passed forward to Pass 3 with their page numbers intact.

  **Pass 3 (Opus) — Layer 6: Intelligent resolution with full context**
  Pass 3 receives the complete zone maps from both estimates, including any disambiguated duplicate entries with page numbers. Claude Opus (`claude-opus-4-7`), which handles all zone matching, has full positional context across both documents and resolves ambiguous duplicate names intelligently — e.g. matching `"Bathroom (p16)"` in E1 to `"Bathroom (p14)"` in E2, and `"Bathroom (p34)"` in E1 to `"2nd Floor Bath (p31)"` in E2. Ambiguity is resolved by the model doing the reasoning work, not by brittle code heuristics.

---

**Issue 3 — Chunk with no zone headers**
- **Status:** 🟢 RESOLVED (non-issue by algorithm design)
- **Problem:** A 10-page chunk that falls entirely within one large zone returns an empty zone list.
- **Resolution:** Not a problem. If Zone A starts on page 9 (reported by chunk 1) and Zone B starts on page 23 (reported by chunk 3), Zone A's range is pages 9–23 — naturally encapsulating chunk 2's entire page range. An empty chunk result means "no new zones start in this page range," which the range derivation already handles. Empty results are valid and expected; they require no special handling beyond a null/empty check in the merge step.

---

**Issue 4 — Duplicate zone names within one estimate**
- **Status:** 🟢 RESOLVED
- **Problem:** "Bathroom" may appear 3 times in a large job. The zone map must treat these as distinct zones. Pass 3 matching and Pass 4 slicing both need to handle non-unique zone names.
- **Resolution:** Two parts — a structural data fix and Pass 3 prompt engineering.

  **Structural fix — (name, startPage) as the zone key:**
  Every zone throughout the entire pipeline is identified by `{name, startPage, endPage}` — never by name alone. Two zones can share a name but never the same name AND start page. When passed to Pass 3, duplicate-named zones are automatically disambiguated by their page numbers: `"Bathroom (p16)"` and `"Bathroom (p34)"`. Pass 4 slices using startPage and endPage — no ambiguity about which zone to slice.

  **Pass 3 Opus prompt engineering:**
  The following rules are included in the Pass 3 zone matching prompt:

  1. **Same name, separated page ranges = distinct zones.** If an identical zone name appears at pages 2–8 and again at pages 29–34, treat them as two separate zones and match each one independently against the other estimate. Do not merge them.

  2. **Watch for delineators in similar-sounding zone names.** Even zones with nearly identical names may be distinct if they carry numeric, floor-level, or directional qualifiers. Pay close attention to: numbers (Bathroom 1 / Bathroom 2), floor levels (1st Floor / 2nd Floor, Upper / Lower, Main Level / Upper Level), directional indicators (North / South, Front / Rear, Interior / Exterior), and type qualifiers (Master / Guest, Primary / Secondary).

  3. **Page span similarity boosts match confidence.** If two zones have very similar page counts, that corroborates the match. If one zone spans 2 pages and its proposed match spans 15 pages, reduce confidence — they may be different things despite sharing a name.

  4. **Be vigilant for abbreviations.** Zone names may be abbreviated differently across estimates. Treat abbreviated forms as potential matches for their full counterparts and factor this into your confidence assessment.

  5. **Never force a match.** If no confident match exists for a zone, mark it as unmatched. A wrong match corrupts Pass 4 for that entire zone. An acknowledged mismatch is recoverable. Unmatched is a valid and preferred outcome over a low-confidence pairing.

  6. **Return a confidence score for every match.** Each matched zone pair must include a confidence level (high / medium / low). Low-confidence matches are flagged in the output for downstream handling.

---

**Issue 5 — Zone header near a chunk boundary, reported by two chunks**
- **Status:** 🟢 RESOLVED
- **Problem:** A zone header on the last page of chunk N and first page of chunk N+1 (overlap page) may be reported by both chunks. If both chunks report the same name at the same page, exact dedup on `(name, startPage)` handles it cleanly. The harder case: chunk N reports "Kitchen" at page 15 and chunk N+1 reports "Kitchen" at page 16.
- **Resolution:** Pass 3 (Opus) handles this via Rule 9 in the zone matching prompt — no fuzzy merge code needed.

  The merge step performs only exact dedup on `(name, startPage)`. Everything else — including the ±1 page boundary case — is passed to Opus as-is. Rule 9 instructs Opus: *"If the same zone name appears twice within the same estimate and start pages differ by only 1–2 pages, treat them as the same zone detected at a document processing boundary — use the lower start page."* Opus has full positional context across the entire zone list and can apply this correctly without brittle code heuristics.

---

**Issue 6 — Zero zone headers detected (flat-list PDF)**
- **Status:** 🟢 RESOLVED — handled by Large Zone Flow (Issue 10)
- **Problem:** Some adjuster estimates have no zone/room groupings — just a flat item list. Pass 1/2 returns zero zone headers and the four-pass architecture collapses.
- **Resolution:** A flat-list PDF is functionally a single oversized zone. The pipeline treats it as such:

  **Detection:** If all chunks for an estimate return zero zone headers, synthesize a single zone named "General" spanning the entire document (page 1 to last page). The `approx_items` for this zone is the sum of all chunks' item counts.

  **Routing:** This synthesized zone will almost always exceed the ~200 item threshold — triggering the Large Zone Flow (Issue 10) automatically. No separate flat-list architecture is needed. The same deterministic prematch + tiered AI matching algorithm handles both "one giant General zone" and "oversized Exterior zone in a well-zoned estimate" identically.

  **Pass 3 behavior:** If both estimates are flat (both have one synthesized "General" zone), Pass 3 trivially matches them 1:1. If one is flat and one is zoned, Pass 3 matches "General" against nothing — it goes to unmatched, and all items are classified as MISSING or ADDED. This is the correct behavior for V1 (Xactimate-Xactimate scope). Cross-format matching between flat and zoned estimates is a future enhancement.

  **For Xactimate-Xactimate scope:** Flat-list Xactimate PDFs should be rare — Xactimate enforces zone assignment. If a flat list is detected, it likely means one huge "General" zone, which the Large Zone Flow handles. If both estimates are flat with no zone structure at all, the comparison will produce results but with all items unmatched (no zone-level cross-matching). This is an acceptable degradation for a rare edge case.

---

### Pass 3 — Zone Matching

**Issue 7 — One-to-many zone mappings**
- **Status:** 🟢 RESOLVED
- **Problem:** E1 may have "Master Suite" as one zone while E2 splits it into "Master Bedroom" and "Master Bathroom." Architecture currently assumes 1:1 pairings. Treating the extras as unmatched misclassifies all their items as MISSING or ADDED — a real accuracy failure on a common real-world pattern.
- **Resolution:** Support true 1:many matching. Both sides of a matched pair are arrays. For standard 1:1 matches each array has one entry; for 1:many one array has multiple entries. Opus declares the merge in Pass 3; Pass 4 receives all sub-PDFs for the many-side and outputs a single flat item list under the canonical zone name.

  **UI treatment:** 1:many matches are not rendered as subsections. The comparison shows one zone row with the canonical name and a (!) icon. The tooltip reads: *"Matched from [Zone A] (p14–17) + [Zone B] (p18–20) in the adjuster's estimate."* No change to how line items are displayed.

  **DB treatment:** All line items stored under the canonical zone name. The zone record carries a `mergedFrom` JSON field listing the original zone names and page ranges for each side. The merge metadata travels with the zone, not the individual items.

  **Pass 3 schema change:** See Issue 8. Both `e1Zones` and `e2Zones` are arrays. `isMerged: true` when either array has length > 1.

  **Pass 4 change:** When a matched pair has multiple zones on one side, each sub-PDF is sent as a separate labeled document block. The prompt identifies each block by its original zone name and page range. All items extracted from the many-side are output together under the canonical zone name.

---

**Issue 8 — Pass 3 output schema not defined**
- **Status:** 🟢 RESOLVED
- **Problem:** No defined JSON schema for what Opus returns from zone matching. Must be locked before building Pass 3 or Pass 4.
- **Resolution:** Schema locked below. Both sides are arrays to support 1:many (Issue 7). `isMerged` is explicit rather than inferred from array length.

  ```json
  {
    "matched": [
      {
        "e1Zones": [{ "zone": "<zone name>", "pages": [startPage, endPage] }],
        "e2Zones": [{ "zone": "<zone name>", "pages": [startPage, endPage] }],
        "canonical": "<longest most specific name for this room>",
        "isMerged": false,
        "confidence": 95
      },
      {
        "e1Zones": [{ "zone": "Master Suite", "pages": [12, 18] }],
        "e2Zones": [
          { "zone": "Master Bedroom", "pages": [14, 17] },
          { "zone": "Master Bathroom", "pages": [18, 20] }
        ],
        "canonical": "Master Suite",
        "isMerged": true,
        "confidence": 85
      }
    ],
    "unmatchedE1": [
      { "zone": "<zone name>", "pages": [startPage, endPage] }
    ],
    "unmatchedE2": [
      { "zone": "<zone name>", "pages": [startPage, endPage] }
    ]
  }
  ```

---

**Issue 9 — Zone match confidence threshold**
- **Status:** 🟢 RESOLVED
- **Problem:** "Lounge" vs "Main Lounge," "Half Bath" vs "Powder Room" — match or no match? Opus needs an explicit confidence threshold and a defined behavior for ambiguous cases.
- **Resolution:** Threshold is 50. Any zone pair with confidence ≥ 50 proceeds to Pass 4 as a matched pair. Any zone pair with confidence < 50 is returned as unmatched — both zones go through Pass 4B (extraction only, items classified as MISSING or ADDED). Confidence scores are internal only and not surfaced in the UI.

---

### Pass 4 — Per-Zone Extraction + Matching

**Issue 10 — Oversized zones exceeding single-call limits (Large Zone Flow)**
- **Status:** 🟢 RESOLVED
- **Problem:** A zone spanning 30+ pages (e.g. "Exterior" in a large commercial job, or a single "General" zone containing an entire estimate) could hit the HTTP 520 threshold as a Pass 4 sub-PDF, and even if chunked for extraction, matching 400+ items against 400+ items in a single call exceeds the 64K output token ceiling (~450-500 pairs max) and degrades matching quality.
- **Resolution:** Two paths based on estimated item count from Pass 1/2.

  **Standard zones (≤ 200 estimated items per side):** Extraction + matching happen in one combined Pass 4 call, as currently designed. 10-page chunking within the zone applies if the zone spans more than 10 pages — each chunk gets its own combined extract+match call. No single API call ever receives a large sub-PDF.

  **Routing trigger:** After Pass 3 zone matching, each matched zone pair is evaluated independently. If EITHER side of the pair has `approx_items` > 200, that entire pair goes through the Large Zone Flow — regardless of whether the other side has fewer items. The decision is per-zone-pair — one comparison can have 13 zones on the standard path and 1 zone on the Large Zone Flow. Passes 1/2 and 3 execute identically regardless of zone size.

  **Large Zone Flow (> 200 estimated items on either side of a matched zone pair):** A separate extraction → deterministic prematch → tiered AI matching path within Pass 4. This replaces the standard combined extract+match call for oversized zones. Designed to handle the worst case (2,000+ items per side) with accuracy ≥ 95%.

  **Step 1 — Extraction (chunked, parallel, Haiku, from sub-PDFs):**
  Chunk each side's page range into 10-page sub-PDFs with 1-page overlap between chunks (pages 1-10, 10-20, 20-30, etc.). The overlap ensures items at page boundaries appear fully in at least one chunk. Each chunk gets an extraction-only Haiku call: "Extract all line items — return `n`, `d`, `q`, `u`, `rm`, `rp`, `rs`, `tx`, `op`, `t`. Do not match anything." Each side is extracted independently — no cross-estimate data in extraction calls. All chunks for both sides fire in parallel under the concurrency cap. After all complete, merge each side's chunks into one flat JSON array and dedup by item number (overlap pages may double-report boundary items). Column normalization: the extraction prompt maps whatever column layout the estimate uses (REMOVE/REPLACE/TAX/O&P/TOTAL, or REMOVE/REPLACE/RESET/TAX/O&P/TOTAL, or UNIT PRICE/TAX/O&P/RCV, etc.) into the standard `rm`, `rp`, `rs`, `tx`, `op`, `t` fields. Missing columns → `null`. This ensures both sides use the same schema regardless of column differences between estimates. Post-extraction count validation: compare actual extracted count against Pass 1/2 `approxItems`. If they differ by > 20%, log a warning for investigation. Output: two JSON arrays — E1's full item list and E2's full item list.

  **Step 2 — Deterministic prematch (code-only, no API call):**
  Run the N2 deterministic prematch script (`n2-deterministic-prematch.ts`) on the two JSON arrays. This is a zero-AI, description-primary matching engine that pairs obvious matches using tokenized description similarity (Jaccard + containment), abbreviation expansion (100+ Xactimate shorthands), action-verb synonyms, plural normalization, and unit mismatch rejection. Confidence threshold is 0.90 (tightened from N1's 0.82) — high precision, moderate recall. Only near-certain pairs are auto-matched; ambiguous cases are left for the AI. Expected hit rate: 40-65% of items paired. Cost classification: if all costs and quantities match → MATCH, else → MODIFIED. Output: matched pairs + unmatched E1 items + unmatched E2 items. Executes in < 1 second regardless of item count.

  **Step 3 — Tiered AI matching (text-only, no PDFs):**
  After prematch, evaluate the unmatched pool size to determine the matching tier:

  **If unmatched E2 ≤ 500 → skip to Tier 2 directly.**

  **Tier 1 — Wide sweep (parallel, high-confidence only):**
  Triggered when unmatched E2 > 500. Split unmatched E1 items into groups of ~300. Send each group against the FULL unmatched E2 list in parallel text-only calls. The prompt explicitly instructs: "Only return pairs where you are very confident the descriptions refer to the same work item. If uncertain, skip the item — it will be matched in a later step. Each E2 item can only be matched once within this call." After all calls return, **dedup across calls**: if an E2 item was claimed by multiple E1 items across different parallel calls, keep the highest-confidence pair and release the losing E1 item back into the unmatched pool. Also validate within each call's output that no E2 item appears twice. Expected additional hit rate: 30-50% of remaining items. Prompts must reinforce 1:1 matching and include confidence scores per pair.

  **Tier 2 — Sequential matching with shrinking pool:**
  Send remaining unmatched E1 items in batches of ~150, each batch against the full remaining unmatched E2 pool. After each batch returns, remove claimed E2 items from the pool before sending the next batch. The pool shrinks naturally — later batches see fewer E2 items and match more precisely. Cap: E2 pool should ideally be ≤ 500 at the start of Tier 2 (Tier 1 ensures this for large zones; prematch ensures this for moderate zones). Full matching prompt — no precision restriction, catch everything the model can. Each pair in the response includes a confidence score. Prompts reinforce: "Every E1 item matches at most one E2 item. Every E2 item matches at most one E1 item. Never double-claim."

  **Step 4 — Merge and classify:**
  Combine all matched pairs from Step 2 (prematch) + Step 3 Tier 1 (if run) + Step 3 Tier 2 into one flat list. Each pair carries its `resolutionSource` (`deterministic` or `ai`) and confidence score. Remaining unmatched E1 items → MISSING_FROM_ADJUSTER. Remaining unmatched E2 items → ADDED_BY_ADJUSTER. Apply `splitMispaired` (Issue 32) on the merged results. Output format is identical to standard Pass 4 — downstream code does not know or care that the zone went through the Large Zone Flow.

  **Timing estimate (worst case — 2,000 vs 2,000 items):**
  | Step | Calls | Wall-clock |
  |------|-------|------------|
  | Step 1 — Extraction | ~20 parallel Haiku | ~10-15s |
  | Step 2 — Prematch | 0 (code) | < 1s |
  | Step 3a — Tier 1 | ~4 parallel | ~15s |
  | Step 3b — Tier 2 | ~4 sequential | ~40s |
  | Step 4 — Merge | 0 (code) | < 1s |
  | **Total** | **~28 API calls** | **~70s** |

  Well within the 300s Inngest step budget. Smaller zones (200-500 items) skip Tier 1 entirely and complete in ~30-40s.

  **This algorithm also resolves Issue 6 (flat-list PDFs) and Issue 25 (flat-list matching strategy).** A flat-list PDF with one giant zone is simply a zone that triggers the Large Zone Flow. No separate flat-list architecture is needed — the same algorithm handles both cases identically.

---

**Issue 11 — PDF fetch strategy for Pass 4 slicing**
- **Status:** 🟢 RESOLVED
- **Problem:** Slicing sub-PDFs for 28 zone calls requires access to the original PDF bytes. Fetching from Supabase once per zone call means 56 total round-trips for the same two files.
- **Resolution:** Fetch each PDF once at the top of the Pass 4 `step.run()` callback, hold both in memory, slice all zones from those in-memory bytes, then fire all zone calls in parallel via `Promise.all()`.

  ```typescript
  await step.run('zone-extract-and-match', async () => {
    const e1Bytes = await fetchPdfFromSupabase(e1StoragePath);
    const e2Bytes = await fetchPdfFromSupabase(e2StoragePath);

    const results = await Promise.all(
      matchedZones.map(async (zone) => {
        const e1SubPdf = await slicePages(e1Bytes, zone.e1Pages);
        const e2SubPdf = await slicePages(e2Bytes, zone.e2Pages);
        return callHaikuForZone(zone, e1SubPdf, e2SubPdf);
      })
    );
    return results;
  });
  ```

  `e1Bytes` and `e2Bytes` live on the heap for the full duration of the `Promise.all`. Every `slicePages` call reads from the same `Uint8Array` — no copies, no re-fetches. This is standard Node.js memory behavior, nothing Inngest-specific.

  **Memory budget:** Two 100-page Xactimate PDFs are typically 5–15 MB each. 28 sliced sub-PDFs in memory simultaneously add maybe 50–80 MB total. Well under Vercel's 1024 MB default (configurable to 3008 MB on Pro). Not a concern.

  **Note:** This pattern also confirms that `Promise.all()` inside a single `step.run()` is the correct fan-out approach for Pass 4 — see Issue 15.

---

**Issue 12 — Pass 4 output schema not defined**
- **Status:** 🟢 RESOLVED
- **Problem:** The model must return structured data mapping to the existing Prisma LineItem schema. Gaps between the Pass 4 output and the LineItem table needed to be identified and resolved.
- **Resolution:** Pass 4A output schema (defined in baseline prompts) is confirmed correct. Field mapping and gap resolutions below.

  **Pass 4 → LineItem field mapping:**
  | Pass 4 field | LineItem column | Notes |
  |---|---|---|
  | `d` | `descriptionYours` / `descriptionAdjuster` | Split by e1/e2 side |
  | `q` | `qtyYours` / `qtyAdjuster` | |
  | `u` | `unitYours` / `unitAdjuster` | **New columns — see below** |
  | `rm` | `removeYours` / `removeAdjuster` | |
  | `rp` | `replaceYours` / `replaceAdjuster` | |
  | `rs` | `resetYours` / `resetAdjuster` | |
  | `tx` | `taxYours` / `taxAdjuster` | |
  | `op` | `opYours` / `opAdjuster` | |
  | `t` | `totalYours` / `totalAdjuster` | |
  | `status` | `matchStatus` | |
  | `n` | — | Item number extracted but not stored — not meaningful after comparison is built |

  **Fields populated from other sources (not Pass 4):**
  | Column | Source |
  |---|---|
  | `zoneYours`, `zoneAdjuster`, `zoneCanonical` | Pass 3 output |
  | `zoneConfidence` | Pass 3 confidence score |
  | `diffAmount` | Computed: `totalAdjuster - totalYours` |
  | `sortOrder` | Assigned during final persist: zone order + item order within zone |
  | `groupId` | Dead field — always `null`. Never implemented, no UI reads it. Ignore in N2. |

  **Schema migration required — add unit columns:**
  `u` (unit: SF, LF, EA, SY, etc.) is extracted by the model and must be stored. It is a strong match-validation signal — two items with the same description but different units are likely different work. The UI can also display it to explain why quantities differ on MODIFIED pairs.

  Add two nullable columns to the `LineItem` model:
  ```prisma
  unitYours      String?  @map("unit_yours")
  unitAdjuster   String?  @map("unit_adjuster")
  ```
  Minimal migration — nullable columns, no existing data affected.

---

**Issue 13 — Items before the first zone header**
- **Status:** 🟢 RESOLVED (non-issue for Xactimate-Xactimate scope)
- **Problem:** Some PDFs may have line items before any zone header appears.
- **Resolution:** Xactimate enforces zone assignment at the point of entry — the software will not allow a line item to be added without assigning it to a room/area. A proper Xactimate export will never have floating pre-zone items. What appears to be a "General" section is a legitimate zone called "General" or "General Items" and is detected as a zone header like any other. Revisit if/when supporting manually-created or non-Xactimate PDFs.

---

**Issue 14 — Reassembling and ordering items across zones**
- **Status:** 🟢 RESOLVED
- **Problem:** After all parallel Pass 4 calls complete, results must be merged into one coherent ordered item list for final persist. Sort order must be a code guarantee — not dependent on model output order, which is fragile and can silently corrupt the UI display.
- **Resolution:** Two deterministic sort keys applied in code after all Pass 4 results are collected.

  **1. Zone order:** Sort all zones by E1 start page (from Pass 3 output). For E2-only unmatched zones (no E1 counterpart), interleave by E2 start page. This guarantees the comparison follows the physical reading order of the contractor's document.

  **2. Item order within zone:** Sort by item number `n` — E1's `n` for MATCH / MODIFIED / MISSING_FROM_ADJUSTER pairs, E2's `n` for ADDED_BY_ADJUSTER pairs. This matches the printed order on the page.

  **3. `sortOrder` assignment:** After both sorts, assign sequential integers 1, 2, 3, ... across the full flattened list. This is the value written to the `sortOrder` column.

  **1:many merged zones (Issue 7):** The merged zone sorts by E1's start page. Items from E2 sub-zones interleave by E2 `n`.

---

### Inngest / Infrastructure

**Issue 15 — Dynamic fan-out inside an Inngest step (hard blocker)**
- **Status:** 🟢 RESOLVED — not a blocker
- **Problem:** Inngest doesn't natively support spawning N parallel sub-tasks where N is unknown at design time. Would `Promise.all()` inside a single `step.run()` breach `maxDuration`?
- **Resolution:** `Promise.all()` inside a single `step.run()` is confirmed as the correct pattern (same memory space, same execution context, same timeout boundary — consistent with Issue 11). Not a structural blocker.

  **Time budget:** The 300s `maxDuration` is generous for this workload. Wall-clock is governed by the slowest single zone call (~30s worst case), not the sum of all calls. Even with a conservative concurrency cap of 5–8 parallel calls instead of all 28 simultaneously, the work processes in 4–6 batches × 30s = 120–180s worst case. Still well under 300s.

  **Real governor:** Rate limits (Issue 21), not `maxDuration`. The concurrency cap set in Issue 21 will naturally batch the calls and keep well within the time budget.

---

**Issue 16 — Failure isolation per zone in Pass 4**
- **Status:** 🟢 RESOLVED
- **Problem:** If 1 of 28 Pass 4 calls fails, `Promise.all()` retries the whole step — re-running already-completed zone calls.
- **Resolution:** Collect all zone results from `Promise.all()`, then write to `ComparisonProcessingState` in one atomic write. Never write partial results to `line_items`.

  ```typescript
  const results = await Promise.all(
    remainingZones.map(async (zone) => {
      const result = await callHaikuForZone(zone, ...);
      return { key: zoneKey(zone), result };
    })
  );
  // One atomic write with all zone results
  await persistAllZoneResults(comparisonId, results);
  ```

  **Why not persist per-zone inside the Promise.all():** 28 zone calls completing near-simultaneously would produce 28 concurrent Prisma writes racing to update the same JSON column on the same row — a recipe for lost updates where one write overwrites another's result.

  **Why Option A (collect then persist once) over a mutex/serial loop:** The scenario Option A doesn't cover — Prisma write fails after all 28 API calls succeed — is extremely rare. Inngest's retry handles it cleanly: retry reloads state, finds zero completed zones, re-runs all 28 cheap Haiku calls, tries the persist again. The simplicity is worth that tradeoff.

  **Core invariant (matches N1 pattern):** `ComparisonProcessingState` holds all intermediate results. `line_items` only receives a clean atomic write at final persist. Partial line_item writes never happen.

  **Implementation note — `Promise.all` vs `Promise.allSettled`:** `Promise.all` fails fast — if zone #3 throws, it rejects immediately while the other 27 in-flight calls keep running. Their results are silently discarded when the rejection propagates up to `step.run()`, so on retry all 28 calls re-run including the 27 that succeeded.

  `Promise.allSettled` is the alternative: it waits for all 28 to finish regardless of failures and returns `{status: 'fulfilled', value}` or `{status: 'rejected', reason}` per zone. Fulfilled results could be persisted to state before throwing, so retry only re-runs the failed zones.

  For this workload, the distinction probably doesn't matter — each zone call is cheap and re-running 28 small calls on retry is negligible in cost and latency. `Promise.all` is simpler. If thorough retry isolation is desired, swap to `Promise.allSettled` with partial-result persistence. Decide at implementation time, not now.

---

**Issue 17 — ComparisonProcessingState schema for new passes**
- **Status:** 🟢 RESOLVED — no schema migration needed
- **Problem:** The intermediate state table needs new stage values and payload shapes for N2's four passes.
- **Resolution:** `ComparisonProcessingState` already has `stage: String` and `payload: Json`. New stage values and payload shapes are new conventions only — no Prisma migration required.

  **Critical detail:** Each stage **overwrites** the previous one. The table has `@unique` on `comparisonId` — one row per comparison, not one row per stage. When `zones_matched` is written, `zones_detected` is gone. Downstream stages must carry forward anything they need from earlier stages.

  **Fields that must carry forward:**
  - `chunkOffset` / `endPageChunkOffset` per zone (Issue 35) — stored on each `N2DetectedZone`, consumed by Pass 4 for pdf-lib page slicing. These replace the superseded `e1PageOffset`/`e2PageOffset` top-level fields. They travel inside the zone objects through `zones_detected` → `zones_matched` (via `e1ZoneMeta`/`e2ZoneMeta`) automatically.
  - `routingDecision` — computed at `zones_detected` time, needed by every downstream step to select the correct flow. Carry through all payloads.
  - `e1Format` / `e2Format` — carry into `zones_matched`.
  - `approxItems` per zone — aggregated from Pass 1/2 chunks at merge time. Used for Large Zone Flow routing (Issue 10), Pass 3 confidence (Rule 4), concurrency scheduling, post-extraction validation, and output token budgeting.

  **Stage values and payload shapes:**

  `zones_detected` — written once both Pass 1 and Pass 2 complete:
  > **Note (Issue 35):** Per-zone `chunkOffset`/`endPageChunkOffset` replace the superseded `e1PageOffset`/`e2PageOffset` top-level fields shown in earlier drafts. Offsets are stored on each zone object and consumed by Pass 4 for pdf-lib slicing.
  ```json
  {
    "e1Zones": [
      { "name": "Kitchen", "startPage": 5, "endPage": 12, "approxItems": 35, "chunkOffset": -4, "endPageChunkOffset": -4 },
      { "name": "Master Suite", "startPage": 12, "endPage": 22, "approxItems": 180, "chunkOffset": -4, "endPageChunkOffset": -11 }
    ],
    "e2Zones": [
      { "name": "Kitchen", "startPage": 3, "endPage": 10, "approxItems": 30, "chunkOffset": -2, "endPageChunkOffset": -2 },
      { "name": "Master Bedroom", "startPage": 10, "endPage": 15, "approxItems": 85, "chunkOffset": -2, "endPageChunkOffset": -2 },
      { "name": "Master Bathroom", "startPage": 15, "endPage": 19, "approxItems": 70, "chunkOffset": -2, "endPageChunkOffset": -2 }
    ],
    "e1Format": "xactimate",
    "e2Format": "xactimate",
    "routingDecision": "zoned-zoned"
  }
  ```

  `zones_matched` — written after Pass 3 (carries forward per-zone slice metadata, format, routing):
  > **Note (Issue 35):** `e1ZoneMeta`/`e2ZoneMeta` carry each zone's `chunkOffset`/`endPageChunkOffset` so Pass 4 can slice without reading `zones_detected`. The superseded `e1PageOffset`/`e2PageOffset` fields are gone.
  ```json
  {
    "matched": [...],
    "unmatchedE1": [...],
    "unmatchedE2": [...],
    "e1Format": "xactimate",
    "e2Format": "xactimate",
    "routingDecision": "zoned-zoned",
    "e1ZoneMeta": {
      "Kitchen_p5": { "startPage": 5, "endPage": 12, "approxItems": 35, "chunkOffset": -4, "endPageChunkOffset": -4 }
    },
    "e2ZoneMeta": {
      "Kitchen_p3": { "startPage": 3, "endPage": 10, "approxItems": 30, "chunkOffset": -2, "endPageChunkOffset": -2 }
    }
  }
  ```

  `zones_extracted` — written after Pass 4 (offsets no longer needed, routing carried for consistency). Must carry forward Pass 3 zone metadata — step 5 needs `zoneYours`, `zoneAdjuster`, `zoneCanonical`, `zoneConfidence`, and `isMerged`/`mergedFrom` to populate LineItem fields. These come from Pass 3, not Pass 4. Since `zones_extracted` overwrites `zones_matched` (@unique on comparisonId), this metadata must be embedded in `zones_extracted` or step 5 has no way to recover it:
  ```json
  {
    "zoneResults": {
      "Kitchen_p5": { "pairs": [...] },
      "Master Suite_p12": { "pairs": [...] }
    },
    "zoneMeta": {
      "Kitchen_p5": {
        "canonical": "Kitchen",
        "zoneYours": "Kitchen",
        "zoneAdjuster": "Kitchen",
        "confidence": 100,
        "isMerged": false
      },
      "Master Suite_p12": {
        "canonical": "Master Suite",
        "zoneYours": "Master Suite",
        "zoneAdjuster": ["Master Bedroom", "Master Bathroom"],
        "confidence": 85,
        "isMerged": true
      }
    },
    "routingDecision": "zoned-zoned"
  }
  ```

---

### Existing Code / Migration

**Issue 18 — Fate of pdf-vision-extract.ts**
- **Status:** 🟢 RESOLVED
- **Problem:** This file implements single-call + continuation extraction — entirely replaced by the new architecture. Decision: gut and rebuild in-place, or write new files alongside?
- **Resolution:** Write new files alongside. `pdf-vision-extract.ts` stays frozen and untouched during N2 development. New N2 logic goes into new files (e.g. `zone-detection.ts`, `zone-extraction.ts`). Once N2 is verified in production, the old file and all N1 pipeline steps are deleted in one clean commit. N1 remains a rollback path until that point.

---

**Issue 19 — N1 baseline compatibility**
- **Status:** 🟢 RESOLVED
- **Problem:** Can the N1 baselines serve as acceptance tests for N2?
- **Resolution:** No — and that's by design. N2 testing is methodical and phase-by-phase. Each pass is validated to 100% accuracy before the next phase begins. N2 establishes its own ground truth through careful testing against real PDFs, hand-counting, and spot-checking. N1 baseline results are a snapshot of a less accurate pipeline and are virtually irrelevant as an acceptance gate for N2.

  N1 baselines remain useful for one purpose only: guarding against accidentally breaking the N1 pipeline during the N2 development period (per the N1-as-fallback requirement above). Once N2 ships and N1 is retired, the N1 baselines are deleted alongside the N1 code.

---

**Issue 20 — Fate of deterministic-prematch.ts**
- **Status:** 🟢 RESOLVED
- **Problem:** Currently disabled in N1. Is there a role for deterministic pre-matching within a zone in N2?
- **Resolution:** The original N1 file (`deterministic-prematch.ts`) stays frozen — not deleted until N1 is fully retired. A new N2-adapted copy (`n2-deterministic-prematch.ts`) has been created for the Large Zone Flow. It serves as Step 2 of the Large Zone Flow (Issue 10): a high-precision, zero-AI pre-filter that pairs obvious matches before the AI matching tiers. Key differences from the N1 version: (1) accepts already-extracted JSON items instead of raw PDF text lines — all PDF parsing, line joining, column layout detection, and zone assignment logic removed; (2) confidence threshold tightened from 0.82 to 0.90; (3) category field removed from confidence scoring; (4) input/output types aligned with the N2 `N2ExtractedItem` schema (`n`, `d`, `q`, `u`, `rm`, `rp`, `rs`, `tx`, `op`, `t`). The core matching engine is unchanged: tokenized description similarity, abbreviation expansion, action-verb synonyms, plural normalization, unit mismatch hard gate, greedy best-reciprocal matching, MATCH vs MODIFIED classification.

---

### Cost / Rate Limits

**Issue 21 — API call count and rate limit ceiling**
- **Status:** 🟢 RESOLVED
- **Problem:** N2 makes ~42–47 total API calls per comparison — ~10× the current count. Rate limits become the primary operational constraint.
- **Resolution:** Concurrency cap set at **8 parallel Pass 4 Haiku calls**. OTPM is the binding constraint — it's a speed limit, not a capacity limit.

  **Tier 2 Haiku limits:** 1,000 RPM / 450,000 ITPM / 90,000 OTPM
  - RPM and ITPM are never a concern at N2's call volumes.
  - OTPM is the governor for Pass 4.

  **OTPM estimates by comparison size:**

  | | 500/side | 1,000/side | 3,000/side |
  |---|---|---|---|
  | Zones | ~10 | ~18 | ~28 |
  | Items/zone | ~50 | ~55 | ~107 |
  | Output tokens/zone | ~4,000 | ~5,500 | ~12,000 |
  | Batch of 8 | ~32,000 | ~44,000 | ~96,000 |
  | % of 90K OTPM | ~39% | ~55% | ~100%+ |

  Large comparisons (3,000/side) may brush against the 90K OTPM ceiling with 8 concurrent calls. This is fine — hitting OTPM returns 429, the SDK retries automatically with exponential backoff, nothing breaks, no data is lost. The comparison takes slightly longer.

  If testing shows frequent 429s on large comparisons adding noticeable latency, drop concurrency to 6. Don't over-optimize before seeing real behavior.

  **Pool separation:** Pass 1/2 (Haiku) and Pass 4 (Haiku) share the same OTPM pool but run in separate pipeline stages — they never overlap, so no combined draw concern. Pass 3 (Opus) has its own separate pool.

---

**Issue 22 — Cost per comparison**
- **Status:** 🟢 RESOLVED
- **Problem:** Need a cost-per-comparison estimate to validate the pricing model and finalize model choices per pass.
- **Resolution:** Verified against actual Anthropic 4.x pricing. Model assignments and cost breakdown below.

  **Model assignments (final):**
  | Pass | Model | Reason |
  |---|---|---|
  | Pass 1 + 2 (zone detection) | Claude Haiku 4.5 | Cheap, fast, tiny output — well within Haiku's capability |
  | Pass 3 (zone matching) | Claude Opus 4.6 | Best reasoning for ambiguous zone name matching and disambiguation |
  | Pass 4 (extract + match) | Haiku 4.5 first; Sonnet 4.6 fallback | See strategy below |

  **Pass 4 model strategy:**
  - Start with Haiku 4.5. If accuracy on real zone extractions proves insufficient, switch to Sonnet 4.6.
  - Long-term: potentially use Sonnet for smaller comparisons (fewer zones, lower cost impact) and Haiku for larger ones where call volume makes cost meaningful. Validate in testing before committing.

  **Actual pricing (Claude 4.x):**
  | Model | Input | Output |
  |---|---|---|
  | Haiku 4.5 | $1/MTok | $5/MTok |
  | Sonnet 4.6 | $3/MTok | $15/MTok |
  | Opus 4.6 | $5/MTok | $25/MTok |

  **Cost breakdown — large comparison (3,000 vs 3,100 items, ~100 pages/estimate, ~28 zones):**
  | Pass | Tokens | Cost |
  |---|---|---|
  | Pass 1+2 — Haiku 4.5 | 315K input / 4.2K output | ~$0.34 |
  | Pass 3 — Opus 4.6 | 2K input / 1K output | ~$0.04 |
  | Pass 4 — Haiku 4.5 (32 calls) | 384K input / 320K output | ~$1.98 |
  | Pass 4 — Sonnet 4.6 (32 calls) | 384K input / 320K output | ~$5.95 |
  | **Total with Haiku Pass 4** | | **~$2.36** |
  | **Total with Sonnet Pass 4** | | **~$6.33** |

  **Cost breakdown — typical small comparison (200–300 items, ~10-15 pages/estimate, ~5-8 zones):**
  - Roughly 1/8th to 1/10th the token volume of the large comparison above.
  - Estimated total with Haiku Pass 4: **~$0.25–$0.35**

  **Cost breakdown — worst-case ceiling (4,000 vs 4,000 items, ~130 pages/estimate, 1 massive zone triggering Large Zone Flow):**

  The Large Zone Flow adds API calls beyond standard Pass 4: Step 1 extraction (~26 parallel Haiku calls for both sides), Step 3a Tier 1 (~4 parallel matching calls), Step 3b Tier 2 (~6 sequential matching calls). Step 2 (prematch) is code-only, zero cost.

  | Pass | Tokens | Cost |
  |---|---|---|
  | Pass 1+2 — Haiku 4.5 | 410K input / 5.5K output | ~$0.44 |
  | Pass 3 — Opus 4.6 | 2K input / 1K output | ~$0.04 |
  | Pass 4 standard zones — Haiku 4.5 | 384K input / 320K output | ~$1.98 |
  | LZF Step 1 extraction — Haiku 4.5 (~26 calls) | 820K input / 260K output | ~$2.12 |
  | LZF Step 3 matching — Haiku 4.5 (~10 calls) | 350K input / 195K output | ~$1.33 |
  | **Total with Haiku (all passes + LZF)** | | **~$5.91** |

  If matching calls use Sonnet instead of Haiku (higher accuracy on ambiguous pairs), the LZF matching cost rises to ~$3.98, bringing total to **~$8.56**.

  **Key insight:** The ~$6 figure is the absolute worst-case ceiling — a 4,000-item-per-side comparison with a single massive zone. Most residential comparisons have no Large Zone Flow zones and cost $0.25–$2.36. Pass 3 (Opus) is essentially free at $0.04 regardless of comparison size.

---

**Issue 23 — Symbility-Symbility format support**
- **Status:** 🔵 DEFERRED — tackle after Xactimate-Xactimate is fully validated in production
- **Problem:** Symbility PDFs have a different visual layout, zone naming conventions, cost column structure, and potentially different line item granularity than Xactimate. The current prompt templates are designed for Xactimate only and will not work reliably on Symbility.
- **To-do when ready:**
  - Source representative Symbility PDFs (small/medium/large).
  - Document how Symbility zones appear visually vs. Xactimate zones — determine if the Pass 1/2 zone detection prompt needs a separate template or can share Xactimate's with additions.
  - Document Symbility's cost column structure and map it to the existing LineItem schema.
  - Write Symbility-specific Pass 4 extraction + matching prompt template.
  - Run against N1 baselines equivalent for Symbility; establish new Symbility baselines.
  - Validate format detection correctly identifies Symbility in chunk 1.

---

**Issue 24 — Xactimate-Symbility cross-format support**
- **Status:** 🔵 DEFERRED — tackle after both Xactimate-Xactimate and Symbility-Symbility are individually validated
- **Problem:** Cross-format comparison is the hardest case. Zone names may differ ("Master Bedroom" vs "Bedroom - Master"). Line item granularity may differ (one Xactimate item split into two Symbility items or vice versa). Cost column names won't match directly. Pass 3 (Opus) and Pass 4 both need to understand they are doing cross-format work.
- **To-do when ready:**
  - Define a normalized line item representation that both Xactimate and Symbility items can be mapped to — Pass 4 extracts into this normalized form for cross-format comparisons rather than format-specific fields.
  - Write a cross-format Pass 3 prompt that tells Opus explicitly it is matching across formats and to apply looser name-matching rules.
  - Write a cross-format Pass 4 prompt template that instructs the model to normalize cost columns before comparing.
  - Handle granularity mismatches (1:many item relationships) — define whether these are classified as MODIFIED or as separate MISSING/ADDED items.
  - Validate against real Xactimate-Symbility estimate pairs.

---

**Issue 25 — Flat-list matching strategy for large item counts**
- **Status:** 🟢 RESOLVED — by Large Zone Flow (Issue 10)
- **Problem:** In Flow 2 (Flat vs. Flat) and Flow 3 (Flat vs. Zoned), if a flat estimate contains hundreds or thousands of items, matching cannot be done in a single API call. Chunking the matching step risks missing cross-chunk matches (e.g. E1 item 150 correctly matches E2 item 650, but they land in different chunks). Two candidate approaches identified: (A) sequential matching with a claimed-items pool — accurate but slow; (B) parallel chunked matching with post-dedup — fast but risks missed matches. Decision deferred.
- **Resolution:** Resolved by the Large Zone Flow algorithm defined in Issue 10. A flat-list PDF is treated as a single oversized zone (Issue 6), which triggers the Large Zone Flow: chunked extraction → deterministic prematch → tiered AI matching (Tier 1 wide sweep + Tier 2 sequential shrinking pool). The deterministic prematch pairs obvious matches by description similarity (40-65% hit rate), then the AI tiers handle the remaining ambiguous items with progressively shrinking search pools. Cross-chunk matching is not a problem because all items are extracted first, then matched against the full pool — not partitioned. See Issue 10 for the full algorithm.

---

**Issue 26 — Pass 1/2 chunk failure handling**
- **Status:** 🟢 RESOLVED
- **Problem:** Pass 1 and Pass 2 fire all zone detection chunks in parallel. If one chunk call fails (429, network error, malformed JSON), the zone map for that page range is missing. Unlike Pass 4 where a single zone failure is recoverable (cheap to re-run), a missing zone detection chunk means the zone map is incomplete and Pass 3 cannot proceed safely — we may be missing entire zones from the document. No defined behavior for this failure mode.
- **Resolution:** Four layers of defense, applied in order within each chunk call.

  **Layer 1 — JSON cleaning before every parse**
  Before calling `JSON.parse()` on any chunk response, run a cleaning step that strips markdown fences and extracts the JSON block from surrounding text. N1 already has this logic — share it. Eliminates the most common model-side failure mode. Temperature 0 makes malformed responses rare, but not impossible.

  **Layer 2 — Schema validation before accepting a chunk result**
  After parsing, validate the object structurally before treating the chunk as successful:
  - `zones` array exists (empty array is valid and expected — see Issue 3)
  - `first_page_printed_number` is a positive integer
  - `approx_items_on_pages` is a non-negative integer
  - Every zone entry has `name` (non-empty string), `start_page` (integer), `evidence_item` (non-empty string), and `approx_items` (non-negative integer)
  - For chunk 1 only: `format` field exists and is one of `xactimate | symbility | unknown`

  If validation fails, treat it as a retryable error — same as a network failure. A structurally invalid response (e.g. `{"zones": [{"name": "Kitchen"}]}` — missing `start_page`) would otherwise pass JSON parse, pass the settled check, and silently produce a corrupt zone map entry that breaks Pass 4 slicing downstream. Catching it here forces a retry rather than letting corrupt data propagate.

  **Layer 3 — Per-chunk retry loop (3 attempts, exponential backoff)**
  Each chunk call is individually wrapped in a retry loop before surfacing to the settled results. Layer 1 and Layer 2 failures both feed into this retry loop. Transient 429s, network blips, and occasional model-side garbage are caught here. Most real-world failures are transient — this handles them without Inngest ever knowing.

  **Layer 4 — `Promise.allSettled` for chunk fan-out, hard fail if any rejected**
  `Promise.allSettled` is used (not `Promise.all`) so one failing chunk doesn't cancel the others mid-flight. After all chunks settle, check for any `rejected` entries. If any exist after their retry budget is exhausted, throw — fail the step. Inngest retries the full step; all chunks re-run.

  **Why no partial-state persistence for Pass 1/2:** Pass 1/2 chunks are tiny (30–80 tokens output, a few seconds per call). Re-running all 10 chunks on a full step retry costs essentially nothing. Persisting successful chunk results and only re-running failed ones adds meaningful complexity for negligible gain. That optimization belongs in Pass 4 where each call does real work.

  **Concrete failure behavior:**
  ```
  All chunks succeed                  → merge zone map, proceed to Pass 3
  1 chunk fails, retry succeeds       → merge zone map, proceed normally
  1 chunk fails all 3 retries         → step throws → Inngest retries all chunks
  All retries exhausted repeatedly    → Inngest marks step failed → comparison fails with error surfaced to user
  ```

  A comparison that fails at Pass 1/2 after Inngest exhausts retries surfaces as a failed comparison — no silent data corruption.

---

**Issue 27 — Pass 3 output validation against input zone lists**
- **Status:** 🟢 RESOLVED
- **Problem:** Opus could hallucinate a zone name in its Pass 3 output that does not exist in either of the input zone maps. If the code attempts to slice pages for a zone that was never detected (no `startPage` / `endPage` on record), the page range lookup fails — either with a runtime error or with incorrect page ranges. This would corrupt Pass 4 for that zone silently if not caught.
- **Resolution:** Two distinct failure modes, handled separately.

  **Failure Mode A — Hallucinated zone name:** Opus returns a zone name in its output that doesn't exist in either Pass 1/2 input list. Lookup by zone name returns nothing. Pass 4 either crashes or slices the wrong pages.

  **Failure Mode B — Silent zone omission:** Opus has 14 input zones but accounts for only 13 in its output — one zone is absent from matched, unmatchedE1, and unmatchedE2. No error is thrown. That zone gets no Pass 4 call. Its items are silently missing from the comparison. Harder to detect and potentially more damaging than a hallucinated name.

  **Design anchor — page ranges come from Pass 1/2, not Pass 3**
  Page ranges used for Pass 4 slicing are always taken from the Pass 1/2 zone map, keyed by zone name. Pass 3's `pages` arrays are included in the prompt so Opus can reason about the zones, but they are informational only and ignored by code. Page range drift in Pass 3 output is harmless — only zone names matter for validation.

  **Validation step after Pass 3 returns (before any Pass 4 work begins):**

  1. **JSON cleaning + schema validation** — same pattern as Issue 26. Verify `matched`, `unmatchedE1`, `unmatchedE2` arrays exist before proceeding.

  2. **Name lookup — exact first, fuzzy fallback**
     For every zone name in Pass 3 output (across all three arrays):
     - First attempt: exact lookup against the Pass 1/2 zone map.
     - If exact lookup fails: attempt normalized comparison — collapse whitespace, normalize dashes and hyphens to a canonical form. If a unique match is found, silently map it to the canonical Pass 1/2 name and continue. This handles trivial formatting differences between what Opus was shown in the zone list text and what it typed back (e.g. en-dash vs hyphen, double space vs single space).
     - If no normalized match exists: true validation failure — proceed to retry logic below.

  3. **Coverage check** — every zone from Pass 1/2 must appear exactly once across Pass 3 output:
     - Build a set of all E1 zone names. Confirm each appears exactly once across `matched[].e1Zones[]` and `unmatchedE1[]`.
     - Same for E2 zones.
     - Missing zone → validation failure. Duplicate zone (appears in both matched and unmatched) → validation failure.

  **On true validation failure — retry Pass 3 (up to 2 retries)**
  Re-send Pass 3 with a correction prefix: *"Your previous response contained zone names or omissions that don't match the input. You MUST use zone names exactly as provided — verbatim, character for character. Every zone in the input must appear exactly once in your output."* Then re-append the original zone lists. Pass 3 (Opus) costs ~$0.04 per call — two retries add $0.08 worst case.

  **Fallback after retries exhausted — force to unmatched, rescue valid counterparts**
  If validation still fails after 2 retries, do not fail the comparison. Two cases:

  - **Missing zone (omission):** Add the missing zone to `unmatchedE1` or `unmatchedE2` using the authoritative page ranges from Pass 1/2. Proceeds to Pass 4B.

  - **Hallucinated zone name in a matched pair (no fuzzy match found):** Strip the bad matched entry entirely. The valid zone from the other side of the pair (which has a real name that does exist in the Pass 1/2 map) must not be lost — move it to its appropriate unmatched array (`unmatchedE1` or `unmatchedE2`). Both sides proceed to Pass 4B independently. Do not silently discard the real zone just because its paired counterpart was invalid.

  Log all forced-unmatched zones prominently. This is a data quality signal worth tracking in production.

---

**Issue 28 — N2 routing mechanism during development and testing**
- **Status:** 🟢 RESOLVED
- **Problem:** During the N2 development and testing period, some comparisons should run through N2 and others should remain on N1. There is no defined mechanism to control which pipeline processes a given comparison. Without this, all comparisons in a deployed environment would either all go to N1 or all go to N2 — making it impossible to test N2 incrementally in production without fully cutting over.
- **Resolution:** Separate Inngest functions with an environment-variable gate and a persisted routing decision.

  **Separate Inngest functions — not a branch inside the existing function**
  N2 is a new Inngest function (`comparison/process-v2`). The existing `comparison/process` (N1) is never modified. The routing decision happens at the single point where the pipeline is triggered — the API route or server action that fires the Inngest event — before any pipeline code runs. This is the only approach consistent with the "N1 is read-only" constraint: if N2 lived as a branch inside the N1 function, the N1 function would have to be modified to add the branch.

  **Routing flag — `N2_ENABLED` environment variable**
  `N2_ENABLED=false` by default in production. Set to `true` in staging and any environment where N2 is being tested.

  **Write `pipelineVersion` first, then send the Inngest event**
  The `pipelineVersion` field on the Comparison record must be written to the DB before the Inngest event is sent — not after. If the event fires but the DB write fails (or vice versa), the comparison must have the correct version recorded regardless. Writing first means: if the event send fails, the comparison sits at processing with the version already on record — retry logic can re-send to the correct pipeline based on the persisted version without guessing.

  ```typescript
  // Write version to DB first
  await prisma.comparison.update({
    where: { id: comparisonId },
    data: { pipelineVersion: useN2 ? 'n2' : 'n1' }
  });

  // Then fire the event
  await inngest.send({
    name: useN2 ? 'comparison/process-v2' : 'comparison/process',
    data: { comparisonId }
  });
  ```

  **`isN2Eligible()` — phased rollout control**
  Initially returns `true` for a hardcoded allowlist of user IDs (development team only). As confidence grows: flip to a percentage rollout or a `n2Opt` flag on the User model. When fully rolled out: function always returns `true` and is deleted in the retirement commit.

  **`pipelineVersion` schema migration — deploy before any N2 code**
  `pipelineVersion String @default("n1")` is added to the Comparison model. It is a defaulted nullable String — safe for existing rows, which all get `"n1"` via `@default`. However, this is the first N2 change that modifies the production database schema in a way that affects existing rows — not just adding new columns that N1 never writes. This migration must land and run cleanly in production before any N2 code is deployed. It is low-risk but it is the one piece that cannot be rolled back simply by "stop routing to N2."

  **The retirement commit — one clean sweep**
  When N2 is fully validated in production:
  1. Remove `isN2Eligible()` and the routing branch — all comparisons go to `comparison/process-v2`
  2. Rename `comparison/process-v2` to `comparison/process`
  3. Delete N1 files (`pdf-vision-extract.ts`, `deterministic-prematch.ts`, N1 Inngest function)
  4. Remove `N2_ENABLED` env var from all environments
  5. Migrate or deprecate `pipelineVersion` field

---

**Issue 29 — Comparison deletion while Inngest pipeline is running**
- **Status:** 🟢 RESOLVED
- **Problem:** If a user deletes a comparison while the Inngest pipeline is mid-execution, the comparison row is removed from the DB. When the pipeline reaches the final persist step, the Prisma write fails on a foreign key constraint. Inngest treats this as a step failure and retries indefinitely. The pipeline is effectively stuck in an infinite retry loop for a comparison that no longer exists.
- **Resolution:** Three layers. Layers 1+2 handle correctness and are required unconditionally. Layer 3 is a cleanliness optimization.

  **Layer 1 — Existence check at the top of every step**
  Every `step.run()` callback begins with a lightweight existence check before doing any real work:
  ```typescript
  await step.run('some-step', async () => {
    const exists = await prisma.comparison.findUnique({
      where: { id: comparisonId },
      select: { id: true }
    });
    if (!exists) return { status: 'cancelled' };
    // ... actual step work
  });
  ```
  Returning normally (not throwing) makes Inngest see the step as succeeded. The function proceeds to the next step, which also exits cleanly, until the function completes naturally. No retry loop, no stuck execution. Handles the between-steps deletion case.

  **Layer 2 — Catch Prisma not-found errors at write time**
  For mid-step deletions, wrap all Prisma writes in a catch that specifically handles "record not found" and foreign key constraint error codes (`P2025`, `P2003`). On those codes, return cleanly instead of throwing. Re-throw everything else — legitimate errors must still surface.
  ```typescript
  try {
    await prisma.lineItem.createMany({ data: results });
  } catch (err) {
    if (isPrismaNotFoundError(err)) return { status: 'cancelled' };
    throw;
  }
  ```

  **Why Layers 1+2 are required even when Layer 3 works perfectly**
  The Inngest cancel API is eventually consistent — calling cancel does not immediately stop a currently executing step. If Pass 4 has 28 Haiku calls in `Promise.allSettled` and cancellation is triggered mid-flight, some calls may complete and attempt to persist before cancellation propagates. Layers 1+2 are not fallbacks for "Layer 3 unavailable" — they cover the race window that exists even when cancellation works exactly as designed.

  **Layer 3 — Store Inngest run ID, attempt cancellation at deletion time**
  Add `inngestRunId String?` to the Comparison model. Persist the run ID as the very first step of the function — before any pipeline work begins:
  ```typescript
  await step.run('store-run-id', async () => {
    await prisma.comparison.update({
      where: { id: comparisonId },
      data: { inngestRunId: step.runId }
    });
  });
  ```
  Using `step.run()` for this write makes it independently retryable and consistent with the rest of the pipeline. This is one fast Prisma write — not worth optimizing further.

  When the user deletes a comparison, the deletion handler checks for a stored run ID and calls the Inngest cancel API before deleting the row. This stops the pipeline from executing further steps, avoiding wasted Pass 4 Haiku calls for zones whose results will never be persisted.

  **Correct deletion sequence:**
  1. If `inngestRunId` is set, call Inngest cancel API first
  2. Delete the comparison row (cascade handles child rows)
  3. Layers 1+2 cover the race window between cancel and full propagation

---

**Issue 30 — pdf-lib not installed — PDF slicing dependency missing**
- **Status:** 🟢 RESOLVED
- **Problem:** The entire N2 architecture depends on slicing PDFs into sub-PDFs by page range (Pass 1/2 chunking, Pass 4 zone slicing). The document assumes `pdf-lib` for this. The project currently has `pdf-parse` (text extraction only) but **does not have `pdf-lib` installed**. `pdf-parse` cannot create or slice PDFs — it's read-only. `pdf-lib` is the dependency that provides `PDFDocument.load()`, `PDFDocument.create()`, and `copyPages()` for page-range extraction into new sub-PDFs. Must be added before any N2 implementation begins.
- **Resolution:** Install `pdf-lib` and write two utility functions — `loadPdf()` and `slicePages()` — as the single shared interface used by all chunking code in N2.

  **Why `pdf-lib` specifically:** Pure JavaScript — no native bindings. This is the critical constraint for Vercel serverless deployment. Native PDF libraries require native compilation that doesn't survive Vercel's build pipeline. `pdf-lib` deploys without any special configuration. `pdf-parse` (already installed) remains — it does read-only text extraction, a different job.

  **`pdf-lib` is the only new npm dependency N2 introduces.**

  **Two utility functions — load once, slice many:**

  ```typescript
  import { PDFDocument } from 'pdf-lib';

  export async function loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument> {
    return PDFDocument.load(pdfBytes);
  }

  export async function slicePages(
    srcDoc: PDFDocument,
    startIndex: number,  // 0-based internal pdf-lib index (offset-corrected per Issue 1)
    endIndex: number     // inclusive
  ): Promise<Uint8Array> {
    const newDoc = await PDFDocument.create();
    const indices = Array.from(
      { length: endIndex - startIndex + 1 },
      (_, i) => startIndex + i
    );
    const pages = await newDoc.copyPages(srcDoc, indices);
    pages.forEach(page => newDoc.addPage(page));
    return newDoc.save();
  }
  ```

  **Why `slicePages()` receives a `PDFDocument`, not `Uint8Array`:** `PDFDocument.load()` parses the full cross-reference table, page tree, and object catalog — not a free operation. Passing raw bytes and calling `load()` inside `slicePages()` would parse the same PDF 28 times for a 28-zone comparison. Loading once and passing the loaded document gives two parses total (one per estimate) regardless of zone count.

  **Caller pattern in Pass 4:**
  ```typescript
  const e1Doc = await loadPdf(e1Bytes);
  const e2Doc = await loadPdf(e2Bytes);

  const results = await Promise.all(
    zones.map(async (zone) => {
      const e1Sub = await slicePages(e1Doc, zone.e1Start, zone.e1End);
      const e2Sub = await slicePages(e2Doc, zone.e2Start, zone.e2End);
      return callHaikuForZone(zone, e1Sub, e2Sub);
    })
  );
  ```

  `e1Doc` and `e2Doc` live on the heap for the same duration as `e1Bytes` and `e2Bytes` already did. No additional memory cost.

  **Two details locked:**
  - `startIndex` and `endIndex` are 0-based internal pdf-lib indices, already converted from printed page numbers by the caller via Issue 1's offset logic. `slicePages()` knows nothing about printed page numbers.
  - Both ends are inclusive. The shared boundary page between adjacent zones is included in both sub-PDFs. Pass 4 prompts handle attribution on that boundary page.

---

**Issue 31 — `category` field in N2**
- **Status:** 🟢 RESOLVED
- **Problem:** The `LineItem` schema has a `category` column (nullable String). In N1 this was populated from extracted data. Should N2 extract it?
- **Resolution:** N2 does not extract a `category` field. There is no reliable, independent line-item category in Xactimate PDFs outside of the zone the item belongs to. The zone IS the grouping. All N2-produced line items will have `category: null`. The `category` column remains in the schema for backward compatibility with N1 data but is not populated by N2. No prompt, no extraction, no mapping. If a future need arises for sub-zone grouping, it would be based on Xactimate sub-headers within a zone — not a separate category code field.

---

**Issue 32 — Post-pair mispair splitting logic — fate in N2**
- **Status:** 🟢 RESOLVED
- **Problem:** N1 has a post-pair validation step (`splitMispaired` in `comparison-processing.ts`) that scans MODIFIED pairs and splits any whose descriptions share zero meaningful tokens into MISSING + ADDED. This catches model mispairs like "Ceiling fan" ↔ "Smoke detector". In N2, matching happens per-zone with 20-50 items per side — mispairs should be rarer. But rarer ≠ impossible. Decide: (a) port the mispair splitter as a post-Pass-4 code step, (b) rely on the model to not mispair at zone scale and skip it, or (c) add explicit anti-mispair instructions to the Pass 4 prompt. Options are not mutually exclusive.
- **Resolution:** Both (a) and (c) — which is already the current state.

  **Option (c) — prompt instruction:** Already present in the Pass 4A baseline prompt: *"Items describing completely different work must NEVER be paired, even if they are the only remaining unmatched items in the zone."* No additional change needed. This is the primary prevention at zone scale.

  **Option (a) — port `splitMispaired` as a post-Pass-4 code step:** Port it directly from N1's `comparison-processing.ts`. It is a deterministic text comparison — no API call, negligible cost, and already battle-tested. The function is a zero-cost safety net: it does nothing when the model gets it right, and catches the rare case when it doesn't. Shipping N2 without it removes a known protection for no gain.

  **Where it runs in N2:** After all Pass 4 zone results are collected and merged, before final persist. Operates on the full flat item list assembled from all zones — same input shape as N1.

  **What it does:** Scans every MODIFIED pair. Tokenizes both descriptions, strips stopwords, checks if the intersection of meaningful tokens is empty. Zero overlap → split the pair: E1 item becomes MISSING_FROM_ADJUSTER, E2 item becomes ADDED_BY_ADJUSTER.

  **What it does not touch:** MATCH pairs, unmatched items. Only catches the specific failure mode of the model labeling completely unrelated items as MODIFIED.

---

**Issue 33 — ComparisonVersionLineItem schema must mirror LineItem migration**
- **Status:** 🟢 RESOLVED
- **Problem:** Issue 12 adds `unitYours` and `unitAdjuster` to the `LineItem` model. The `ComparisonVersionLineItem` model (used by the parallel edit/versioning layer) is a structural copy of `LineItem` but does NOT automatically inherit schema changes. If `unitYours`/`unitAdjuster` are added to `LineItem` but not to `ComparisonVersionLineItem`, the version creation code will silently drop unit data when copying line items to a new version. Both models must be migrated together.
- **Resolution:** Three things that must happen together — not independently.

  **1. Same migration, both models**
  Add `unitYours String?` and `unitAdjuster String?` to `ComparisonVersionLineItem` in the exact same Prisma migration that adds them to `LineItem`. One migration file, both models. A migration that adds to `LineItem` but fails before reaching `ComparisonVersionLineItem` leaves the schema inconsistent. One migration means it either fully applies or fully rolls back.

  **2. Update the version creation copy code**
  The code that copies `LineItem` rows into `ComparisonVersionLineItem` must be updated to include `unitYours` and `unitAdjuster` in the copy — in the same commit as the schema change. Adding columns to the schema without updating the copy code means the columns exist but are never populated: silent data loss through omission.

  **3. Standing convention — enforced going forward**
  The root cause is that `ComparisonVersionLineItem` is a structural mirror of `LineItem` with no enforced process to keep them in sync. Document the rule:

  > Any change to the `LineItem` model — new column, removed column, type change — must be evaluated for `ComparisonVersionLineItem` in the same PR. The version creation copy code must be updated in the same commit as the schema change. These two are never changed independently.

  This is a discipline requirement, not a code problem. The failure mode (silent version data loss) is serious enough to warrant calling it out explicitly as a standing convention.

  **Scope:** Only `unitYours` / `unitAdjuster` require mirroring from N2. `pipelineVersion` and `inngestRunId` are on `Comparison`, not `LineItem` — no `ComparisonVersionLineItem` impact. `category` is already in the N1 schema on both models.

---

**Issue 34 — Pass 4 JSON parse failure handling**
- **Status:** 🟢 RESOLVED
- **Problem:** Every Pass 4 call expects valid JSON back from the model. If the model returns malformed JSON (markdown fences, truncated output, extra text before/after the JSON), `JSON.parse()` throws and the zone call fails. The N1 pipeline has existing JSON cleaning logic (stripping markdown fences, extracting JSON from surrounding text). N2 needs the same resilience per zone call. Decide: (a) share the existing JSON cleaning utility, (b) write a new one, or (c) rely on the `temperature: 0` + strict prompt to always get clean JSON and handle parse failures as retryable errors.
- **Resolution:** New shared utility, consistent pattern across all passes, with explicit truncation detection using SDK metadata.

  **JSON cleaning — new shared utility, N1 untouched**
  Write the cleaning logic in a new shared utility file (e.g. `lib/ai-response.ts`). Do not touch N1's `comparison-processing.ts` — N1 is read-only. The function is small enough that the duplication is the right trade. When N1 is retired, only the shared utility remains.

  Cleaning steps:
  1. Strip leading/trailing whitespace
  2. Strip markdown code fences
  3. Extract the outermost `{...}` block from any surrounding text
  4. Return cleaned string for `JSON.parse()`

  **Schema validation after parse**
  After parsing, validate that the result has `zone` (non-empty string) and `pairs` (array). Invalid schema → retryable error, same as a network failure.

  **Per-zone retry loop — same pattern as Issue 26**
  Each Pass 4 zone call runs inside a retry loop (up to 3 attempts). JSON cleaning + schema validation failures both feed into this loop. On the third failure the zone call surfaces as rejected to `Promise.allSettled` — Issue 16's failure isolation handles it from there.

  **Truncation detection — SDK metadata first, heuristic fallback**
  Truncation is the one failure mode cleaning cannot fix — content is physically missing. Detection order:

  1. **Check `stop_reason` from the Anthropic SDK response first.** If `stop_reason === "max_tokens"`, the response is definitively truncated. This is authoritative — no guessing from output content.
  2. **Fall back to output heuristic only if SDK metadata is unavailable.** If the raw output does not end with `}` or `]`, classify as likely truncated.

  Checking `stop_reason` first avoids false positives where a legitimate JSON parse error (e.g. malformed content inside a complete response) looks like truncation and gets misclassified.

  On confirmed truncation: log prominently, fail the zone call, let the retry loop attempt again. Truncation should be extremely rare given 10-page zone chunks — a 10-page zone has at most 50–100 items, well within the output budget. Persistent truncation across all retries is a signal that the zone needs sub-chunking (Issue 10's algorithm). Surface it through Issue 16's isolation path — never silent.

  **The consistent pattern across all passes (Issues 26, 27, 34):**
  Clean → parse → validate schema → retry on any failure. Truncation detected via `stop_reason` metadata, heuristic as fallback. Same shared utility used everywhere.

---

**Issue 35 — Pass 1/2 page offset calculation assumes uniform offset across entire PDF**
- **Status:** 🟢 RESOLVED
- **Problem:** Issue 1 resolves printed-vs-internal page numbering by computing an offset from chunk 1's `first_page_printed_number`. This offset is applied globally to all zone start pages when converting to internal pdf-lib indices. The assumption is that the offset is constant across the entire PDF. This holds for most Xactimate exports (cover page adds a fixed offset). But if a PDF has sections with different numbering schemes (e.g. Roman numeral pages i-iv, then Arabic 1-80), the offset computed from chunk 1 may be wrong for later chunks. Each chunk reports its own `first_page_printed_number` — the merge step should compute a per-chunk offset and use the correct one when converting each zone's printed pages to internal indices, not a single global offset.
- **Resolution:** Per-chunk offsets were always the intent of Issue 1 ("compute the offset for each chunk"). Issue 35 closes the gap by specifying the implementation precisely so the natural mistake — computing offset from chunk 1 only and applying it globally — cannot happen.

  **Why per-chunk matters even for well-formed Xactimate PDFs:** Each chunk independently validates its own offset. A global offset from chunk 1 silently misaligns every zone if any inconsistency exists past that point. Per-chunk offsets are self-correcting and don't rely on chunk 1's assumptions holding for pages 50–80.

  **Per-chunk offset computation at merge time:**
  ```typescript
  const chunkOffset = chunk.startInternalIndex - chunk.firstPagePrintedNumber;
  // chunk.startInternalIndex: known at dispatch time (we chose which pages to send)
  // chunk.firstPagePrintedNumber: required field returned by the model (Issue 1)
  ```

  **Store the offset directly on each zone entry in the zone map.** Attaching the offset to the zone at merge time eliminates a lookup step at slicing time and makes the offset self-documenting on every zone record:
  ```typescript
  interface Zone {
    name: string;
    startPage: number;           // printed page number from model
    endPage: number;             // derived: next zone's startPage
    chunkOffset: number;         // offset from the chunk that detected this zone's start
    endPageChunkOffset: number;  // offset from the chunk that detected next zone's start
  }
  ```

  **At Pass 4 slicing time:**
  ```typescript
  const startInternal = zone.startPage + zone.chunkOffset;
  const endInternal   = zone.endPage   + zone.endPageChunkOffset;
  ```

  **End page offset:** Zone N's end page is Zone N+1's start page (printed). Use Zone N+1's `chunkOffset` for the end page conversion — it comes from the chunk that detected Zone N+1. Store it as `endPageChunkOffset` when the zone map is finalized. For the last zone, end page is the final page of the document — its internal index is `totalPageCount - 1`, no offset conversion needed.

  **No prompt changes required.** Merge-step data modeling change only. Chunk prompts, zone detection, and Pass 3 are unaffected.

---

**Issue 36 — Inngest step structure for N2 — how many step.run() calls**
- **Status:** 🟢 RESOLVED
- **Problem:** The document defines 4 logical passes but does not define how they map to Inngest `step.run()` calls. Each `step.run()` is independently retryable and has its own `maxDuration` budget. Candidates: (a) one step per pass (4 steps total — simple, each independently retryable), (b) Pass 1+2 combined into one step (they're concurrent anyway, and the `zones_detected` state is written once both complete), (c) Pass 4 split into multiple steps if the concurrency-capped batching approach needs finer retry granularity. The step boundaries affect retry behavior, state persistence timing, and how the Inngest dashboard shows progress. Must be defined before implementation.
- **Resolution:** 5 steps total. Step boundaries chosen for independent retryability, clean state persistence, and dashboard visibility.

  **Pass 1 + 2 in one combined step:** Both estimates' chunks fire simultaneously in one parallel fan-out. `zones_detected` requires both zone maps complete before it can be written — splitting into two steps would require intermediate state with no downstream use, and a Pass 2 failure would needlessly retry Pass 1's successful chunks. Chunks are cheap; they retry together cleanly as a unit.

  **Pass 4 and persist in separate steps:** If persist fails (step 5), Inngest memoization means steps 1–4 don't re-execute — only step 5 retries, reading from the already-persisted `zones_extracted` state. The persist is independently retryable without re-running any API calls.

  **5-step structure:**
  ```
  step 1: "store-run-id"
    Write inngestRunId to Comparison (Issue 29). One fast Prisma write.

  step 2: "detect-zones"
    Pass 1 (E1) + Pass 2 (E2) in parallel.
    All chunks for both estimates fire simultaneously under the concurrency cap.
    Routing decision computed here (Issue 6).
    Writes zones_detected to ComparisonProcessingState.

  step 3: "match-zones"
    Pass 3 — single Opus call, text only.
    Reads zone maps from state. Runs Pass 3 output validation (Issue 27).
    Writes zones_matched to ComparisonProcessingState.

  step 4: "extract-and-match"
    Pass 4 — all zones in parallel, concurrency capped at 8 (Issue 21).
    Fetch both PDFs once, load into PDFDocument (Issue 30), slice all zones.
    All zone calls via Promise.allSettled. Run splitMispaired (Issue 32).
    Writes zones_extracted to ComparisonProcessingState — see payload shape in Issue 17.

  step 5: "persist-results"
    Reads zones_extracted from state.
    Writes all LineItems atomically. Updates Comparison status to complete.
  ```

  **Every step begins with the comparison-existence check (Issue 29, Layer 1).** If the comparison was deleted, the step returns cleanly — no throw, no retry loop.

  **maxDuration budget:**
  | Step | Expected wall-clock | Budget |
  |---|---|---|
  | store-run-id | < 1s | 300s |
  | detect-zones | ~30–60s | 300s |
  | match-zones | ~5–15s | 300s |
  | extract-and-match | ~60–180s | 300s |
  | persist-results | < 5s | 300s |

  **Routing note:** For V1 (Flow 1: Zoned-Zoned only), this structure is exact. When Flow 2 and Flow 3 are added, `match-zones` and `extract-and-match` read the routing decision from state and adapt internally — step boundaries stay the same.

  **Pass 5 placement (May 6, 2026):** Pass 5 (Cross-Zone Item Reconciliation) lives inside the existing `extract-and-match` step — not a new Inngest step. It runs after `runWithConcurrencyLimit(...)` resolves all Pass 4 results and before the `n2:zones_extracted` state write. Rationale: it operates on in-memory Pass 4 output with no external dependencies, fails open (skip on error), and adding a new step boundary would require persisting an intermediate state stage with no other consumer. Step count stays at 5.

---

### Pass 4 Hardening & Pass 5 Architecture (Issues 37–41, May 6, 2026)

**Issue 37 — Pass 4A merged-zone item drop (vestigial “stop at zone header” rule)**
- **Status:** 🟢 RESOLVED (May 6, 2026)
- **Problem:** Pass 4A prompt rule #3 instructed the AI: *“Extract ONLY items within the zone ‘{canonicalZoneName}’. If you encounter a header for a different zone, stop extracting for that document.”* This rule was authored before merged-zone (1:N pairing) support existed in the slicer. Merged contractor PDFs (built by `sliceMultipleRanges()` from multiple constituent zones) contain multiple zone headers concatenated together. The rule told the model to stop reading at the first “foreign” header inside the merged document, silently dropping every line item from every constituent zone after the first.
- **Empirical impact:** Set3 merged contractor zone (`Lobby & Reception + Exam Rooms (3) - Combined + Records / Storage`) had 27 expected items; the app produced ~10 (just the Lobby items). 17 items dropped per merged zone.
- **Resolution:** Two-part change in `lib/n2/prompts/pass4a-extract-match.ts`:
  1. `Pass4APromptParams` extended with `e1ZoneNames: string[]` and `e2ZoneNames: string[]` — every contractor zone name whose pages are in Document 1, every adjuster zone name whose pages are in Document 2.
  2. Rule #3 replaced with explicit allow-lists: *“For Document 1, extract every numbered line item appearing under any of these contractor zone headers: … For Document 2, extract every numbered line item appearing under any of these adjuster zone headers: … If you encounter a header for a zone NOT in the relevant list, ignore everything under it (this is a defensive guard against page-boundary spillover and should rarely fire).”*
- **Caller change:** `callPass4A` in `lib/n2/passes/extract-and-match.ts` extracts the lists from `spec.pair.e1Zones.map(z => z.zone)` and `spec.pair.e2Zones.map(z => z.zone)`. The prompt builder also adds a clarifying “multiple zones concatenated” note when at least one side has more than one zone.
- **Pass 4B unchanged:** Single-zone unmatched calls have no merged-zone problem.

---

**Issue 38 — Pass 4 model upgrade (Haiku → Sonnet)**
- **Status:** 🟢 RESOLVED (May 6, 2026)
- **Problem:** Even after Issue 37’s prompt fix on Set3, the merged Carpentry zone’s Pass 4A call was suspected of dropping items at high item counts, despite output being well within the documented 8K `max_tokens` cap. Investigation showed Haiku 4.5 has weaker performance on long structured-enumeration tasks than the same-tier Sonnet — not a token-budget issue but a reasoning-fidelity issue. Tier 2 rate limits at the 4.x generation are identical between Haiku and Sonnet (1,000 RPM / 450K ITPM / 90K OTPM — verified from Anthropic console), so there is no throughput tradeoff.
- **Resolution:** In `lib/n2/passes/extract-and-match.ts`:
  - `HAIKU_MODEL = 'claude-haiku-4-5-20251001'` → `SONNET_MODEL = 'claude-sonnet-4-6'` (used by both `callPass4A` and `callPass4B`).
  - `PASS4_MAX_TOKENS = 8192` → `16384` (Sonnet supports up to 64K; 16K is generous headroom for ~200 items at ~80 tokens/item without capping responsibility).
- **Cost impact:** Roughly $0.16 per comparison delta at typical Set3-sized workloads (5–7 zones). Negligible against the user-stated “all-in on accuracy” posture.
- **Wall-clock impact:** Pass 4 wall-clock approximately doubles (Sonnet is ~2–3× slower per call than Haiku). Concurrency cap of 8 unchanged; Pass 4 wall-clock budget remains within Inngest 300s step ceiling.
- **Empirical result on Set3:** Coverage went 90% → 98%, total items extracted 49 → 115. Item Accuracy temporarily dropped 86% → 66% — NOT a regression, but exposure of the cross-zone Demolition mismatch that Issue 39’s Pass 5 addresses. The 49→115 items reveal the cross-zone problem that was previously masked by silent item drops.

---

**Issue 39 — Pass 5: Cross-Zone Item Reconciliation (new pass)**
- **Status:** 🟡 IN PROGRESS (May 6, 2026)
- **Problem:** Contractor and adjuster commonly organize the same property differently. Common pattern: contractor groups all work by room (`Lobby`, `Exam Rooms`, `Records`, each containing demolition + replacement work for that room). Adjuster groups by trade (`Demolition & Debris Hauling` for all demo work bundled, then `Carpentry & Misc.` for replacement work bundled). Pass 3 zone matching cannot pair `Lobby` with `Demolition & Debris Hauling` because their zone names and physical scope don’t correspond. Pass 4 strictly pairs items within a single zone. Result: contractor’s `Tear out wet ACT ceiling tiles` (in `Lobby`) becomes MISSING_FROM_ADJUSTER. Adjuster’s `Demo wet acoustical ceiling tiles` (in `Demolition`) becomes ADDED_BY_ADJUSTER. Both are wrong — the work is present in both estimates, just structurally relocated. On Set3, ~22 items misclassified by this mechanism alone (~28 pp accuracy loss).
- **Resolution:** New Pass 5 AI call (Opus 4-7, text only) operating on Pass 4’s already-extracted output. Architecture:
  - **Inputs:** All MISSING items pooled from all Pass 4 zone results (contractor orphans), all ADDED items pooled (adjuster orphans). Each orphan tagged with home-zone name, qty, unit, total, description.
  - **Both-sides-only:** MATCH/MODIFIED pairs from Pass 4 are NOT eligible inputs (Pass 5 doesn’t override within-zone decisions).
  - **Skip when:** Either pool empty or has fewer than 2 items.
  - **Conservative-pairing posture:** Confidence threshold 75. Default decision when in doubt: leave unpaired. Asymmetric error cost — false positive (wrong cross-zone match) silently corrupts user report; false negative (missed cross-zone match) leaves recoverable MISSING/ADDED disposition.
  - **Output:** Proposed pairs with confidence + rationale. Pairs at ≥ 75 promoted to MATCH/MODIFIED (status recomputed deterministically post-parse using qty/total — see Issue 41).
  - **Inngest fit:** Inside existing `extract-and-match` step. No new Inngest step; no new state stage; no new event.
  - **Fail-open:** If Pass 5 errors, orchestrator ships Pass 4 results un-reconciled and logs the failure.
- **Distinguish from Phase 5 (Large Zone Flow):** Phase 5 is the deferred capacity work for zones with >200 items per side. Pass 5 is this new cross-zone reconciliation AI call. Unrelated work; only the number is shared.
- **Files added/modified (planned):**
  - **New:** `lib/n2/prompts/pass5-cross-zone.ts` (Opus prompt builder).
  - **New:** `lib/n2/passes/cross-zone-reconcile.ts` (orchestrator function).
  - **Modified:** `lib/n2/passes/extract-and-match.ts` (call `reconcileCrossZone()` after `runWithConcurrencyLimit`, before state write).
  - **Modified:** `lib/n2/schemas/pass-responses.ts` (add `Pass5ResponseSchema`).
  - **Modified:** `lib/n2/schemas/types.ts` (add `crossZoneOrigin` field on relevant pair shape; add `CROSS_ZONE_MATCHES_ZONE_NAME` constant).

---

**Issue 40 — CROSS ZONE MATCHES synthetic zone (data shape + UI hooks)**
- **Status:** 🟡 PARTIALLY RESOLVED (May 6, 2026 — data shape decided; UI rendering deferred)
- **Problem:** When Pass 5 accepts a cross-zone pair, where do the items live in the persisted output? Three options were considered: (a) file under contractor’s home zone, (b) file under adjuster’s home zone, (c) file under a new synthetic zone named `CROSS ZONE MATCHES`. Options (a) and (b) silently hide the structural relocation from the user, who has a legitimate interest in seeing that the adjuster filed the work differently than the contractor (it’s often relevant to the dispute). Option (c) preserves transparency.
- **Resolution — data shape:**
  - Synthetic zone canonical name: `CROSS ZONE MATCHES` (verbatim, all caps).
  - Each line item carries a `crossZoneOrigin` metadata field: `{ e1Zone: "<contractor home zone>", e2Zone: "<adjuster home zone>" }`. The orchestrator emits this on Pass 5–promoted pairs and persists it to the database for UI consumption.
  - The `zoneCanonical` column on `LineItem` is set to `CROSS ZONE MATCHES` for these items, while `zoneYours` and `zoneAdjuster` retain the original home-zone names (so the UI can show *“originally filed under ‘Lobby’ and ‘Demolition & Debris Hauling’”*).
- **Resolution — UI rendering (deferred):**
  - Dashboard renders `CROSS ZONE MATCHES` as a distinct section with stylistic differentiation (color band, icon, or shading — final design TBD).
  - Tooltip text on the zone header: *“These items appear in both estimates but were filed under different zones — most commonly because one side groups by room and the other by trade. Each item shows its original zone in both estimates.”*
  - Sort order: deferred. Provisional default — last section in the comparison view.
- **Items NOT in scope for this Issue:**
  - Pass 4B unmatched-zone items remain in their unmatched zone unless promoted by Pass 5. They are NOT moved to `CROSS ZONE MATCHES` automatically.
  - Items that Pass 5 declines to pair stay in their MISSING/ADDED disposition under their home zone.

---

**Issue 41 — Pass 5 confidence threshold and post-parse status classification**
- **Status:** 🟢 RESOLVED (May 6, 2026 — initial values; tunable based on Set3-style empirical testing)
- **Problem:** Pass 5’s AI returns a confidence score per proposed pair, plus a status (MATCH or MODIFIED). Two questions: (a) at what confidence threshold do we accept a pair? (b) do we trust the AI’s MATCH/MODIFIED decision or recompute it deterministically?
- **Resolution:**
  - **Confidence threshold:** 75 (initial). Pairs at ≥ 75 are accepted; pairs at < 75 are rejected and orphans remain MISSING/ADDED. Threshold tuning is an Open Question (§4 #2): if false-positive rate exceeds 1% in empirical testing, raise to 80–85.
  - **Status recomputed deterministically post-parse:** AI returns MATCH/MODIFIED, but the orchestrator recomputes from qty/unit/total: `qty1 === qty2 && unit1 === unit2 && Math.abs(total1 - total2) < max(0.01, 0.01 * total1)` → `MATCH`, else `MODIFIED`. The AI’s judgment on PAIRING is what matters; CLASSIFICATION is mechanical and should not be left to model variance. (Mirrors the deterministic classifier pattern from `lib/comparison-processing.ts`.)
  - **Rationale field:** AI returns a one-sentence rationale per accepted pair. Persisted only to logs (not to DB) for diagnostic review of false positives. Not surfaced to end-user.

---

**Issue 42 — Pass 5 Anthropic 400 (`temperature` deprecated for Opus 4.7)**
- **Status:** 🟢 RESOLVED (May 6, 2026)
- **Problem:** First Pass 5 production call returned `HTTP 400 invalid_request_error: "temperature" is deprecated for this model.` Opus 4.7 is an extended-thinking model with fixed sampling and rejects the `temperature` parameter outright; Sonnet 4-6 still accepts it, so the same parameter that works for Pass 1–4 breaks Pass 5.
- **Resolution:** Removed `temperature: 0` from the Pass 5 fetch body in `lib/n2/passes/cross-zone-reconcile.ts`. Inline comment notes the model-specific deprecation so it is not re-added by mistake. Other passes still set `temperature: 0` because they use Sonnet, which is unaffected.
- **Defensive logging:** Pass 5's non-OK response handler now reads and includes the response body (truncated to 1k chars) in the thrown `AIResponseError` message. Without this, the original failure surfaced as a bare `Bad Request` with no diagnostic content. All Anthropic-bound passes should adopt this pattern when adding new models.

---

**Issue 43 — Pass 5 LLM-attention-budget recall failure on Set3 demolition**
- **Status:** 🟢 RESOLVED (May 7, 2026)
- **Problem:** With the Issue 39 conservative prompt (“err strongly on the side of CAUTION”), Opus 4.7 reliably refused to propose obvious cross-zone pairs even when the totals matched to the cent and the descriptions were synonymous. Empirical Set3 case: of 11 expected demolition cross-zone matches, Opus proposed only 4. The misses were not filtered by the 75 confidence threshold — they were never proposed at all (`proposed: 7, rejectedBelowThreshold: 0`). This is the classic LLM attention-budget problem when the prompt asks the model to scan a large many-by-many candidate set conservatively: the model samples a mental subset and silently drops the rest.
- **Resolution:** Two-part fix in `lib/n2/passes/cross-zone-reconcile.ts` and `lib/n2/prompts/pass5-cross-zone.ts`.

  **Part 1 — Deterministic identical-totals prematch (`deterministicPreMatch`)** runs BEFORE the Opus call. Iterates each contractor orphan and finds the best-Jaccard adjuster orphan whose total matches to the cent (±$0.01) AND whose description token-overlap is ≥ 0.20. Auto-pairs at confidence 99 with status assigned by the deterministic classifier (Issue 41 / Issue 44). Pairs that match this rule are removed from the orphan pool BEFORE Opus sees it. False-positive risk is low because (a) totals in insurance estimates are computed quantities with multi-decimal precision, so coincidental cent-level matches are rare, and (b) the description Jaccard floor weeds out the rare coincidence. Empirical Set3: caught 6 of 11 expected demolition cross-zone matches with 100% precision. Threshold rationale documented inline.

  **Part 2 — Prompt rebalance.** The system prompt's asymmetric “missing is recoverable” framing was replaced with balanced framing acknowledging that BOTH false positives and false negatives have real cost. The QUANTITY+UNIT MATCH rule was downgraded from “high weight” to “moderate weight” and now explicitly states that 25–50% quantity differences with the same unit are textbook MOD-QTY pairs (“the contractor and adjuster frequently disagree on dumpster capacity / debris-hauling load count”). Three concrete worked examples added to the DECISION POLICY section (Haul debris qty 8 vs 6, Dumpster qty 6 vs 5, Strip 3-tab shingles identical totals). A note up front tells Opus that identical-total pairs are already handled by the deterministic upstream pass, so it is now reasoning about residual ambiguous cases where its cross-zone judgment adds value.

  **Part 3 — Eligibility skip.** If the residual orphan pools (post-prematch) drop below `PASS5_MIN_ORPHANS_PER_SIDE`, the Opus call is skipped entirely — the prematch already did the work. If Opus errors, the orchestrator now ships prematch results (rather than failing-open back to zero pairs as the Issue 39 baseline did). Strict improvement in worst case.

- **Empirical impact:** On Set3, Pass 5 acceptance went from 4–7 pairs (varying with run-to-run AI variance) to a stable 5–7 pairs with 100% precision and significantly improved recall.

---

**Issue 44 — Pass 4 deterministic MATCH/MODIFIED classifier override**
- **Status:** 🟢 RESOLVED (May 7, 2026)
- **Problem:** Pass 4's AI was observed flagging items with identical totals, identical units, and effectively-identical quantities as MODIFIED purely because the qty STRING differed (`"1"` vs `"1.00"`, or `"120"` vs `"120.00"`). On Set3, three GENERAL SITE CONDITIONS items ("Building permit", "Engineering plans", "Asbestos pre-demo survey") all had cheatsheet-expected MATCH but were classified MODIFIED, costing 3+ accuracy points. The principle from Issue 41 (“pairing is the AI's job, classification is mechanical”) was being honored only inside Pass 5's `classifyPair`; Pass 4 was trusting the AI's status field directly.
- **Resolution:** Added `reclassifyPairFromFields()` in `lib/n2/passes/extract-and-match.ts` and applied it post-coercion to every Pass 4A pair where status is MATCH or MODIFIED. The classifier:
  - Parses qty strings to numbers (strips commas, accepts `"1"` and `"1.00"` as equal, treats null/blank as a single class)
  - Normalizes unit case-insensitively with whitespace trim
  - Applies 1% (or $0.01, whichever larger) tolerance on totals AND quantities
  - Returns MATCH only when total + unit + qty all agree under those tolerances; otherwise MODIFIED

  Same logic is now used by Pass 5's `classifyPair` (replaced the old brittle string-equality version). Both files keep the helper local rather than sharing a util to keep N2 passes independently deployable; comment in each file flags them as duplicates that must stay in sync.
- **Empirical impact:** On Set3, item accuracy moved from ~84% to ~92–93% with no other changes. Modified F1 improved from 36% to 40%; Match F1 from 67% to ~85% on items the runner could grade.

---

**Issue 45 — JSON parser tolerance for trailing non-JSON content**
- **Status:** 🟢 RESOLVED (May 7, 2026)
- **Problem:** `parseAndValidate` in `lib/n2/utils/ai-response.ts` uses `cleanJsonString` to extract the outermost `{...}` block, then calls `JSON.parse`. `cleanJsonString` uses `lastIndexOf('}')` — which works when the AI returns a single JSON object, but fails when the AI returns JSON followed by explanation text containing braces (e.g. “`{example with brace}`” in the trailing prose). On Pass 5 specifically, Opus was observed appending explanation text after its JSON despite the prompt's explicit “no markdown fences, no explanation” rule. Result: `JSON.parse failed: Unexpected non-whitespace character after JSON at position N` on all 3 retries, losing the entire Opus contribution. Set3 production case: 6 prematch pairs preserved, 0 Opus pairs accepted because of this.
- **Resolution:** Added a fallback in `parseAndValidate`'s catch block. When `JSON.parse` throws and the V8 error message matches `/after JSON at position (\d+)/i`, the recovered position N is used to slice `cleaned[0..N)` and re-parse. The native parser has already located where the valid JSON ends; trusting it is sound. If the second parse also fails, the original error path runs.
  - Applies to ALL passes (1, 2, 3, 4A, 4B, 5) since they share `parseAndValidate`.
  - JSON has no `undefined` literal, so `parsed === undefined` is a safe sentinel for “neither parse path succeeded.”
  - Strict-parser successes are unchanged; the fallback only runs when the first `JSON.parse` throws.

---

**Issue 46 — Pass 1/2 zone-detection robustness on trade-grouped adjuster PDFs**
- **Status:** 🟢 RESOLVED (May 7, 2026)
- **Problem:** Pass 2 zone detection was observed flipping non-deterministically between correct and degenerate output on the Set3 adjuster PDF (4 pages, 5 trade-category headers: Demolition & Debris Hauling, Roofing Systems, Carpentry & Misc., Exterior Finishes, General & Site). Some runs returned all 5 zones; others collapsed the entire document into a single mega-zone. The original Pass 1/2 prompts were heavily Xactimate/room-grouped flavored and treated trade-category sections only via a passing reference (“Trade categories or coverage groupings used as standalone zones with placeholder dimensions”). On a short PDF without Xactimate-style “Totals: <name>” closers, the model lacked confidence signals and lazily collapsed.
- **Resolution:** Three layers stacked, all in `lib/n2/passes/detect-zones.ts` and the chunk-1 / chunk-N prompt files.

  **Layer 1 — Prompt expansion.** Both `pass1-chunk1.ts` and `pass1-chunk-n.ts` gained a new STRUCTURAL STYLE section preceding SPECIAL HANDLING. It explicitly enumerates trade-grouped zone styles (`Demolition & Debris Hauling`, `Roofing Systems`, `Carpentry & Misc.`, `Exterior Finishes`, `General & Site`, etc.), states that trade-grouped estimates typically have 3–8 such top-level sections covering the entire document, and instructs the model that trade-grouped zones do NOT need Xactimate-style closers, dimensions, or floorplan thumbnails to qualify. A rule-of-thumb paragraph distinguishes top-level trade zones (e.g. document-level “Plumbing”) from sub-category headers within a room (e.g. “PLUMBING” under “Master Bathroom”). The trade-zone enumeration is the same on both prompts so chunks 2+ get the same guidance as chunk 1.

  **Layer 2 — Sanity gate + retry.** After the chunk parses and the result is constructed, two structural-failure patterns force a retryable error inside `processOneChunk`:
  - `zones.length === 0 && approx_items_on_pages ≥ 5` (items must belong to a zone — contradiction)
  - `zones.length === 1 && approx_items_on_pages ≥ 50` (single zone with many items is the trade-grouped collapse signature)

  Both fall through to the existing `withRetry` loop (5 attempts). Anthropic's per-call variance plus the Layer 1 prompt usually resolves the issue on the second attempt. The 50-item threshold is intentionally high so it does NOT fire on legitimate large single-room contractor chunks (e.g. a Master Bedroom with 25–35 items per chunk). Documented threshold rationale inline.

  **Layer 3 — Text-based candidate header grounding.** A new `extractCandidateHeaders(chunkBytes)` helper uses `pdf-parse` (already a project dep) to extract the embedded text streams from the chunk's sub-PDF and applies deterministic regex filters (3–80 chars, no leading `<digit>.`, no `$` or `%` or large numbers, more letters than digits). The resulting candidate list is appended to the user prompt under a `CANDIDATE HEADERS EXTRACTED FROM PDF TEXT` section, with explicit instructions that the model must still validate each candidate against the WHAT IS A VALID ZONE HEADER rules. Empty list (scanned PDF, encrypted PDF, parse failure) gracefully degrades to vision-only — the helper returns `[]` on any throw. Cap of 60 candidates per chunk to keep the prompt tight. New optional `textHints` field on `ChunkCallSpec` carries the list from `buildChunkSpecs` to `processOneChunk`.

  **Why three layers stacked rather than only one:** Each layer addresses a different failure mode and they reinforce each other. Layer 1 is the cheapest and most direct fix (give the model the rules); Layer 2 is the safety net for residual variance; Layer 3 is the strongest grounding (deterministic ground truth from PDF text). Layer 3 alone is insufficient because pdf-parse can fail on some PDFs; Layer 2 alone is insufficient because the retry might just produce the same wrong answer; Layer 1 alone is insufficient because the model can still drift on borderline inputs.

  **Constraint observed:** “Do not alter the flow so much as to negatively impact estimates larger than the one we are trying to fix.” The 50-item single-zone threshold prevents Layer 2 from firing on large contractor PDFs; Layer 3 has a 60-candidate cap and graceful degradation; Layer 1 only adds prompt content (no removed rules). All three are additive, not substitutive.

---

### Phase 2B — Zone Review & Correction: Feature Specification

**Zone Review & Correction: User-facing pause between detection and matching**
- **Context:** Zone detection (Pass 1/2) will make occasional errors: missed zones, false positives, wrong start pages, duplicate zone headers, and cross-PDF name mismatches. These errors propagate directly into Pass 3 (zone matching) and Pass 4 (extraction), causing incorrect MISSING / ADDED classification on items. The user has no intervention point before the expensive passes run.
- **Resolution:** Insert a user-facing review step between zone detection and zone matching. The pipeline pauses after `detect-zones` completes; the user reviews both zone lists; clicks "Looks good →" to proceed, or types a natural language correction first.

  **Pipeline pause mechanism — `step.waitForEvent`**
  After `detect-zones` writes `n2:zones_detected` to state and sets comparison status to `AWAITING_ZONE_REVIEW`, the Inngest step calls:
  ```typescript
  await step.waitForEvent('zone-review-complete', {
    event: 'comparison/zone-review.completed',
    timeout: '24h',
    match: 'data.comparisonId'
  });
  ```
  The pipeline is suspended at this point. No Opus or extraction calls are made until the event is received.

  **Timeout handling:** If the user does not review within 24 hours, `step.waitForEvent` times out. On timeout: proceed with the originally detected zones as-is, log the auto-proceed event, continue to `match-zones`. Abandoned comparisons never block forever.

  **Resume sequence:**
  1. User optionally applies corrections (Issue 38) — each correction call writes to `n2:zones_corrected`
  2. User clicks "Looks good →" → `POST /api/comparisons/[id]/zone-review/confirm`
  3. That route fires `comparison/zone-review.completed` Inngest event and clears `AWAITING_ZONE_REVIEW` status
  4. `match-zones` step resumes, reads `n2:zones_corrected` if it exists, falls back to `n2:zones_detected`

  **New comparison status value:** `AWAITING_ZONE_REVIEW` — written after zone detection completes, cleared by the confirm route. Any existing status enum must include this value.

  **New state stage — `n2:zones_corrected`:** Same schema as `n2:zones_detected` plus two additional fields:
  ```json
  {
    "e1Zones": [...],
    "e2Zones": [...],
    "e1Format": "xactimate",
    "e2Format": "xactimate",
    "routingDecision": "zoned-zoned",
    "matchHints": [
      { "pdfA": "Master Suite", "pdfB": ["Master Bedroom", "Master Bath"], "reason": "user-confirmed same room" }
    ],
    "confirmedUniqueZones": [
      { "pdf": "A", "zone": "Garage", "reason": "user-confirmed scope difference" }
    ]
  }
  ```
  Written by the zone-correction API route (Issue 38), not by the Inngest pipeline. A new Zod schema must be added to `lib/n2/schemas/state-payloads.ts` alongside the three existing stage schemas. The `n2:zones_corrected` stage key must be added to `lib/n2/utils/n2-state.ts`.

---

**Zone Correction Agent: Natural language correction interface**
- **Context:** Zone detection errors are too varied for a button-based UI. A rename, a merge, a missing zone, a cross-PDF name mismatch, and a legitimate scope difference all require different data transformations. Building explicit UI controls for all combinations is complex and brittle.
- **Resolution:** A natural language interface backed by a two-phase correction agent.

  **Architecture — router with playbooks**
  A single Sonnet 4.6 call receives: (a) both current zone lists as JSON, (b) the user's freeform description, (c) all 10 playbooks as the system prompt (Issue 39). The agent classifies the issue, follows the matching playbook, and returns corrected zone JSON in one response. Playbooks are guides, not rigid scripts — the agent applies judgment within the playbook's framework.

  **Two-phase design within each agent call:**
  - **Phase 1 (parse + classify, no PDF access):** Agent identifies what type of correction is needed and whether PDF re-examination is required.
  - **Phase 2 (PDF re-examination, only when needed):** For corrections requiring verification (missed zone, wrong start page, wrong name, split zone), the agent calls the `examine_pdf_pages` tool (Issue 40) before applying the change. Blind edits (delete false positive, merge duplicates, add match hint) skip Phase 2 entirely.

  **New API routes:**

  `POST /api/comparisons/[id]/zone-correction`
  - Auth-gated — user must own the comparison
  - Comparison must be in `AWAITING_ZONE_REVIEW` status
  - Request body: `{ description: string }`
  - Runs the two-phase correction agent; may call `examine_pdf_pages` tool internally
  - Writes updated zones to `n2:zones_corrected` state (upsert — safe for multiple consecutive corrections)
  - Response: `{ e1Zones, e2Zones, matchHints, confirmedUniqueZones, agentMessage?: string }`
  - If the agent cannot confidently resolve the correction, returns `agentMessage` with a clarifying question and does NOT modify the zones

  `POST /api/comparisons/[id]/zone-review/confirm`
  - Auth-gated
  - Fires `comparison/zone-review.completed` Inngest event (resuming the pipeline)
  - Sets comparison status away from `AWAITING_ZONE_REVIEW`
  - Idempotent — safe to call even if no corrections were made

---

**Zone Correction Playbooks: Per-error-type correction directives**
- **Context:** The correction agent needs structured guidance for each of the 10 failure modes, or it will apply generic reasoning that doesn't match the structural requirements of the zone JSON (e.g. inventing page numbers, or modifying the wrong side's zone list).
- **Resolution:** 10 playbooks embedded in the correction agent's system prompt. Each playbook describes: what trigger phrases identify this error type, what verification action to take (if any), what fields to modify, and a confidence check (when to ask instead of act).

  **Error taxonomy and playbook summary:**

  | # | Error Type | Needs PDF Re-exam? | Blind Edit? |
  |---|---|---|---|
  | 1 | Missed zone (false negative) | **Yes** — get verbatim name + start page | No |
  | 2 | False positive (non-zone in list) | Only if ambiguous | Yes |
  | 3 | Wrong start page | **Yes** — scan ±3 pages | No |
  | 4 | Zone split across chunk boundary (duplicate) | No | Yes — merge two entries |
  | 5 | Two zones merged as one | **Yes** — find second header in range | No |
  | 6 | Wrong zone name | **Yes** — verify verbatim spelling | No |
  | 7 | Same room, different names across PDFs | No | Add `matchHint` |
  | 8 | One PDF splits what other combines | No (add matchHint); optionally Yes if sub-zones need finding | Add `matchHint` with array pdfB |
  | 9 | Legitimate scope difference | No | Add `confirmedUniqueZone` |
  | 10 | Area rollup disagreement (floor label as zone) | **Yes** — verify items beneath label | Conditional |

  **Playbook 1 — Missed Zone:** Re-examine ±3 pages around user's hint. Find verbatim header + start page + first line item. Insert into zone list sorted by start page. End page = next zone's start page. If not found in PDF, ask the user rather than invent.

  **Playbook 2 — False Positive:** Check against known false-positive patterns (CONTINUED marker, ALL-CAPS trade header, coverage subdivider, floor label). If pattern matched: delete entry (no PDF re-exam). If ambiguous: re-examine that page before deleting.

  **Playbook 3 — Wrong Start Page:** Re-examine (current_start − 3) to (current_start + 3). Find the actual header line. Update `startPage`. Recompute adjacent end pages.

  **Playbook 4 — Zone Split Across Chunks:** Identify the two duplicate entries (same/similar name, adjacent pages). Merge: keep earlier `startPage`, later `endPage`, sum `approxItems`. Drop the second entry. No PDF re-exam.

  **Playbook 5 — Two Zones Merged as One:** Re-examine the over-merged zone's full page range. Find a second zone header within the range. If found: split at the second header's start page. If not found: ask user to point to the page.

  **Playbook 6 — Wrong Zone Name:** Re-examine the zone's start page. Read the header verbatim. Update `name`. If user explicitly requests an override name (not from the PDF), ask once for confirmation — verbatim names matter for Pass 3 matching.

  **Playbook 7 — Same Room, Different Names Cross-PDF:** Do NOT modify zone JSON. Add `matchHint: { pdfA: "<name>", pdfB: "<name>", reason: "user-confirmed same room" }`. Pass 3 treats this as a confidence-100 pre-declared match.

  **Playbook 8 — One Splits, Other Combines:** Do NOT modify zone JSON. Add `matchHint: { pdfA: "<name>", pdfB: ["<name1>", "<name2>", ...], reason: "structural grouping difference" }`. Pass 3 handles fan-out matching.

  **Playbook 9 — Legitimate Scope Difference:** Do NOT modify zone JSON. Add `confirmedUniqueZone: { pdf: "A"|"B", zone: "<name>", reason: "user-confirmed scope difference" }`. Pass 3 skips match attempts for this zone; it proceeds to Pass 4B as an expected unmatched zone.

  **Playbook 10 — Area Rollup Disagreement:** Re-examine the area label's page. If it has numbered line items directly beneath it before any sub-zone starts: keep it as a zone. If no items: delete it as a false positive.

  **Universal rules across all playbooks:**
  1. Never invent a zone name, page number, or line item evidence not found in the PDF.
  2. Return complete corrected zone lists — not diffs or partial updates.
  3. Handle one correction per call. If the user describes multiple issues, address the first one clearly and indicate others remain.
  4. If the description does not match any playbook, return `agentMessage` with a clarifying question. Do NOT modify zones.

  **How `matchHints` flow into Pass 3:** Read from `n2:zones_corrected` before the Opus call. Injected into the Pass 3 prompt as pre-declared matches: *"The following zone pairs have been user-confirmed as the same room. Treat them as matched with confidence 100."* Applied in code after Opus returns — merged into the `matched` array, overriding any Opus decision on those zones.

  **How `confirmedUniqueZones` flow into Pass 3:** Injected as: *"These zones exist in only one estimate by confirmed design — do not attempt to match them."* Removed from both zone lists before sending to Opus. Re-added to the appropriate `unmatched` array after Opus returns, with a `confirmedScopeDifference: true` flag for downstream rendering.

---

**PDF Re-examination Tool for Correction Agent**
- **Context:** Several correction playbooks require examining the actual PDF pages to verify zone names, start pages, or item evidence. The correction agent cannot invent or accept unverified user descriptions for fields where accuracy is critical.
- **Resolution:** An `examine_pdf_pages` Anthropic tool-use function available to the correction agent during Phase 2 of each correction call.

  **Tool definition (passed to Anthropic API as a tool):**
  ```typescript
  {
    name: "examine_pdf_pages",
    description: "Re-examine a specific page range of one estimate PDF to answer a targeted factual question about zone headers, verbatim names, or line items visible on those pages.",
    input_schema: {
      type: "object",
      properties: {
        pdf:       { type: "string", enum: ["e1", "e2"] },
        startPage: { type: "integer", description: "Printed page number (inclusive)" },
        endPage:   { type: "integer", description: "Printed page number (inclusive)" },
        question:  { type: "string",  description: "Specific factual question to answer from the PDF pages" }
      },
      required: ["pdf", "startPage", "endPage", "question"]
    }
  }
  ```

  **Tool implementation (API route handler):**
  1. Load PDF bytes from Supabase storage (same `estimates` bucket used by the pipeline)
  2. Convert printed page numbers to 0-based internal indices using chunk offsets from `n2:zones_corrected` (or `n2:zones_detected` fallback)
  3. Slice the relevant pages using `slicePages()` from `lib/n2/utils/pdf-slicer.ts`
  4. Make a focused Sonnet call: system prompt = *"You are examining specific pages of an insurance estimate PDF to answer a single factual question. Return only the answer as plain JSON — no explanation."*
  5. Return the inspection result to the correction agent as the tool response

  **Cost:** Each re-examination call: ~1,000–3,000 input tokens (small sub-PDF) + ~200 output tokens at Sonnet pricing ≈ < $0.01. Negligible even with multiple re-examinations per correction.

  **Re-examination is only triggered when needed.** Blind edits (delete, merge, match hint, scope confirmation) never trigger a tool call. The agent's Phase 1 analysis determines whether re-examination is required before Phase 2 begins.

  **Tool reuse:** The same `slicePages` + Supabase storage download code already used by the main pipeline. No new PDF infrastructure needed — the correction tool is a thin wrapper around existing utilities.

---

**Zone Review UI**
- **Context:** The zone review step requires a UI surface that clearly shows both zone lists, accepts freeform correction input, re-displays the corrected result after each correction, and lets the user confirm and proceed.
- **Resolution:** A full-screen review component shown when comparison status is `AWAITING_ZONE_REVIEW`.

  **Layout:**
  Two-column table: **Your Estimate** | **Adjuster's Estimate**. Each row shows zone name, page range, and approximate item count. Auto-flagged rows show a yellow indicator for:
  - `approxItems < 2` — suspiciously few items
  - Zone exists in one list only — potential scope difference or missed detection
  - `endPage - startPage > 20` on a PDF with < 30 total pages — anomalously large span

  Auto-flags are visual hints only — they do not block the user from proceeding.

  **Text input area** at the bottom: `"Describe what needs to be corrected..."`. Submit → `POST /api/comparisons/[id]/zone-correction`. Updated zone lists re-render in the table immediately. Iterative — multiple corrections can be made sequentially.

  **Correction response handling:**
  - If `agentMessage` is returned (agent needs clarification): display the message in place of re-rendering zones; keep the text input focused for the user's follow-up.
  - If corrected zones are returned: re-render both columns; clear the text input; scroll to the change.

  **"Looks good →" button** (bottom right): calls `POST /api/comparisons/[id]/zone-review/confirm` → comparison proceeds to zone matching. Spinner shown while the pipeline resumes.

  **Skip option:** "Looks good →" is always enabled. Users who are satisfied with the automatically detected zones can click it immediately without making any corrections.

  **Mobile:** Full-width stacked layout (Your Estimate list on top, Adjuster's below). Text input and button pinned to the bottom of the viewport.

  **Inaccessible state:** If the user navigates to a comparison that is NOT in `AWAITING_ZONE_REVIEW`, the zone review screen does not appear — the comparison page renders normally with whatever status it has.

---

### Phase 2C — Zone Match Review: Feature Specification

**Zone Match Review: Conditional user-facing pause between matching and extraction**
- **Context:** Pass 3 (Opus) determines which zone in PDF A corresponds to which zone in PDF B. Even with `matchHints` from Phase 2B, Opus can make mistakes on ambiguous cases: zones with similar names that are actually different rooms (Bedroom 1 vs. Bedroom 2), 1:many structural differences missed by the user in 2B, or legitimately unmatched zones incorrectly forced into a pair. These errors corrupt every line item extracted from the affected zones in Pass 4. The user — who inspected the actual property — can spot mismatches instantly.
- **Resolution:** A conditional review gate between Pass 3 and Pass 4. The gate fires only when Pass 3's output meets at least one trigger condition. When it fires, the user sees the matched pairs and unmatched zones, confirms or corrects them, then proceeds to extraction.

  **Gate trigger conditions — show the review gate if ANY of the following are true:**
  1. Pass 3 produced at least one 1:many match (one zone in A matched to multiple zones in B, or vice versa)
  2. Pass 3 left any zone unmatched on either side (excluding zones already marked `confirmedScopeDifference` in Phase 2B)
  3. Pass 3 paired two zones whose names share fewer than 3 characters in common (low-confidence name match)
  4. *(Future)* Pass 3 returns an explicit confidence score below a configurable threshold

  **If no trigger conditions are met:** Pipeline proceeds directly to Pass 4 without pausing. No user action required for clean same-name comparisons.

  **Pipeline pause mechanism:** Same `step.waitForEvent` pattern as Phase 2B.
  ```typescript
  await step.waitForEvent('zone-match-review-complete', {
    event: 'comparison/zone-match-review.completed',
    timeout: '24h',
    match: 'data.comparisonId'
  });
  ```
  New comparison status value: `AWAITING_MATCH_REVIEW` — written after `match-zones` completes (when triggered), cleared by the confirm route.

  **Timeout handling:** Same as Phase 2B — auto-proceed with Pass 3's original output after 24 hours.

  **New state stage — `n2:zones_match_confirmed`:** Written only if the user makes changes. Carries the same structure as `n2:zones_matched` with user-applied overrides. Pass 4 reads `n2:zones_match_confirmed` if present, falls back to `n2:zones_matched`.

---

**Zone Match Review UI**
- **Context:** The matched pair list is simpler to display than raw zone lists — it's a flat table of pairs. No natural language agent is needed; corrections are direct user manipulations.
- **Resolution:** A full-screen review component shown when comparison status is `AWAITING_MATCH_REVIEW`.

  **Layout: matched pairs section**
  Table rows: **Your Zone** | **↔** | **Adjuster's Zone** | **Type** | **Action**
  - Type: `1:1 match`, `1:many`, or `unmatched`
  - Auto-flagged rows (amber dot): any pair triggered the gate conditions above
  - Action: reassign button (opens inline selector) or "mark as scope difference"

  **Layout: unmatched zones section**
  Two lists: "Only in Your Estimate" and "Only in Adjuster's Estimate". Each entry has:
  - "Mark as scope difference" — removes from match attempts, flags for MISSING/ADDED rendering
  - "Assign to →" — reassign to an existing zone on the other side (replaces a pair)

  **No natural language agent.** All corrections are direct UI interactions. No AI call needed — the user is directly editing the match pairs, not describing errors.

  **"Looks good →" button** (bottom right): always enabled. Calls `POST /api/comparisons/[id]/zone-match-review/confirm` → pipeline resumes, Pass 4 begins.

  **New API routes:**

  `GET /api/comparisons/[id]/zone-match-review`
  - Returns current matched pairs and unmatched zones from `n2:zones_matched` (or `n2:zones_match_confirmed` if corrections already applied)

  `POST /api/comparisons/[id]/zone-match-review/correction`
  - Request body: `{ matchedPairs, unmatchedE1, unmatchedE2 }` — direct overwrite, not a natural language description
  - Writes to `n2:zones_match_confirmed` state (upsert)

  `POST /api/comparisons/[id]/zone-match-review/confirm`
  - Fires `comparison/zone-match-review.completed` Inngest event
  - Sets comparison status away from `AWAITING_MATCH_REVIEW`

---

**Implementation timing:** Build Phase 2C after Phase 3 and 4 are complete and running end-to-end. Real Pass 3 output on production PDFs will reveal how frequently the trigger conditions fire, which should inform whether the condition thresholds need adjustment before the UI gate is worth shipping.

---

# CONSTRUCTION PHASE

> **This section is a living ledger tracking the implementation of the N2 pipeline.**
> Architecture above is the spec. This section tracks what was built, when, and any deviations.

## Build Principles

1. **Production-grade from line 1.** Every file is written as it will run in production on Vercel Lambdas + Inngest. No prototyping rewrites.
2. **Lambda-aware architecture.** Each Inngest step = separate serverless invocation. No shared memory between steps. PDFs re-fetched where needed. All state serialized to JSON via ComparisonProcessingState.
3. **N1 is read-only.** Zero modifications to N1 files. Zero imports from N1 into N2. N1 must remain a working lightswitch fallback at all times.
4. **File isolation.** All N2 code lives under `lib/n2/`. Separate Inngest function (`comparison/process-v2`). Separate utility files. Clean directory boundary.
5. **Idempotent steps.** Every Inngest step is safe to retry. State writes use upsert. LineItem persistence guards against duplicates. Deletion-during-flight handled cleanly.
6. **Zod schemas at every boundary.** All state payloads, API responses, and inter-step contracts validated with Zod. Validate at write AND read.
7. **Structured logging.** Every log line includes `comparisonId`, step name, zone name (where applicable), timing, and token counts. Non-negotiable for production debugging.

## File Structure (Planned)

```
lib/n2/
├── inngest/
│   └── process-comparison-v2.ts    # 5-step Inngest function
├── passes/
│   ├── detect-zones.ts              # Pass 1/2: zone detection + merge
│   ├── match-zones.ts               # Pass 3: Opus zone matching
│   ├── extract-and-match.ts         # Pass 4: per-zone extraction + matching
│   └── large-zone-flow.ts           # LZF Steps 1-4
├── prompts/
│   ├── pass1-chunk1.ts              # Zone detection prompt (with format)
│   ├── pass1-chunk-n.ts             # Zone detection prompt (no format)
│   ├── zone-correction-agent.ts     # Correction agent system prompt (10 playbooks)
│   ├── pass3-zone-matching.ts       # Opus zone matching prompt
│   ├── pass4a-extract-match.ts      # Matched zone extraction + matching
│   └── pass4b-extract-only.ts       # Unmatched zone extraction only
├── schemas/
│   ├── state-payloads.ts            # Zod schemas for all 3 state stages
│   ├── pass-responses.ts            # Zod schemas for AI response validation
│   └── types.ts                     # Shared TypeScript types
├── utils/
│   ├── pdf-slicer.ts                # pdf-lib load + slice utilities
│   ├── ai-response.ts               # JSON clean → parse → validate pipeline
│   ├── chunk-pdf.ts                 # 10-page chunking with overlap
│   ├── zone-merge.ts               # Post-detection zone merge + offset calc
│   └── zone-correction-tool.ts     # examine_pdf_pages tool definition + handler
├── n2-deterministic-prematch.ts     # LZF Step 2: deterministic prematch
├── n2-routing.ts                    # isN2Eligible() + routing gate
└── n2-split-mispaired.ts           # Post-processing safety net
```

## Construction Phases

### Phase 1 — Foundation
**Status:** ✅ COMPLETE
**Scope:** Schema migrations, pdf-lib utilities, shared infrastructure, Inngest skeleton, routing gate.
**Goal:** All scaffolding in place. Inngest function registered and callable (does nothing yet). N1 unaffected.

| Task | File(s) | Status |
|---|---|---|
| Schema migration: unitYours/unitAdjuster on LineItem | prisma/schema.prisma | ✅ |
| Schema migration: unitYours/unitAdjuster on ComparisonVersionLineItem | prisma/schema.prisma | ✅ |
| Schema migration: pipelineVersion on Comparison | prisma/schema.prisma | ✅ |
| Schema migration: inngestRunId on Comparison | prisma/schema.prisma | ✅ |
| Install pdf-lib dependency | package.json | ✅ |
| Install zod dependency | package.json | ✅ |
| PDF slicer utilities (loadPdf, slicePages) | lib/n2/utils/pdf-slicer.ts | ✅ |
| PDF chunking utility (10-page, 1-page overlap) | lib/n2/utils/chunk-pdf.ts | ✅ |
| AI response pipeline (clean → parse → validate + withRetry) | lib/n2/utils/ai-response.ts | ✅ |
| N2 state helpers (writeN2Stage, readZones*, clearN2Stage) | lib/n2/utils/n2-state.ts | ✅ |
| Zod schemas for all state payloads | lib/n2/schemas/state-payloads.ts | ✅ |
| Zod schemas for AI response validation | lib/n2/schemas/pass-responses.ts | ✅ |
| Shared types | lib/n2/schemas/types.ts | ✅ |
| N2 Inngest function skeleton (5 steps, no logic) | lib/n2/inngest/process-comparison-v2.ts | ✅ |
| N2 routing gate (isN2Eligible, N2_ENABLED) | lib/n2/n2-routing.ts | ✅ |
| Register N2 Inngest function in serve() | app/api/inngest/route.ts | ✅ |

### Phase 2 — Zone Detection (Pass 1 + 2)
**Status:** ✅ COMPLETE
**Scope:** Full zone detection pipeline. Chunking → AI calls → merge → offset calc → pre-dedup → state write.
**Goal:** Given two PDFs, produce accurate `zones_detected` state payload.
**Model decision:** `claude-sonnet-4-6` — validated through prompt iteration. Haiku was trialled and rejected for zone detection accuracy.

| Task | File(s) | Status |
|---|---|---|
| Pass 1 prompt (chunk 1, with format detection) | lib/n2/prompts/pass1-chunk1.ts | ✅ |
| Pass 2 prompt (chunks 2+, no format) | lib/n2/prompts/pass1-chunk-n.ts | ✅ |
| Zone detection orchestrator | lib/n2/passes/detect-zones.ts | ✅ |
| Zone merge + end page derivation | lib/n2/utils/zone-merge.ts | ✅ |
| Per-chunk offset calculation | lib/n2/utils/zone-merge.ts | ✅ |
| Pre-dedup (within-estimate duplicates) | lib/n2/utils/zone-merge.ts | ✅ |
| Zero-zone fallback ("General" zone synthesis) | lib/n2/passes/detect-zones.ts | ✅ |
| Write zones_detected to state | lib/n2/passes/detect-zones.ts | ✅ |
| Wire into Inngest Step 2 | lib/n2/inngest/process-comparison-v2.ts | ✅ |

### Phase 2B — Zone Review & Correction
**Status:** ✅ COMPLETE
**Scope:** User-facing pause between zone detection and zone matching. Inngest `step.waitForEvent`, correction agent (Sonnet + tool-use), two API routes, zone review UI.
**Goal:** User can review and optionally correct detected zones before Pass 3 runs. Pipeline pauses, waits for user confirmation, resumes with either original or corrected zones. Corrections are verified against the PDF — no blind edits for fields requiring accuracy.
**Prerequisite:** Phase 2 must be complete and validated first. This phase is the integration seam between zone detection and zone matching.

| Task | File(s) | Status |
|---|---|---|
| New `AWAITING_ZONE_REVIEW` status value in Prisma schema | `prisma/schema.prisma` | ✅ |
| `n2:zones_corrected` Zod schema | `lib/n2/schemas/state-payloads.ts` | ✅ |
| `readZonesCorrected` + `N2_STAGE_ZONES_CORRECTED` state key | `lib/n2/utils/n2-state.ts` | ✅ |
| `step.waitForEvent` in `detect-zones` step (after state write) | `lib/n2/inngest/process-comparison-v2.ts` | ✅ |
| `match-zones` step reads corrected zones if present (falls back to detected) | `lib/n2/passes/match-zones.ts` | ⬜ (wired in Phase 3) |
| Correction agent system prompt (10 playbooks) | `lib/n2/prompts/zone-correction-agent.ts` | ✅ |
| `examine_pdf_pages` tool definition + handler | `lib/n2/utils/zone-correction-tool.ts` | ✅ |
| `GET /api/comparisons/[id]/zone-review` route | `app/api/comparisons/[id]/zone-review/route.ts` | ✅ |
| `POST /api/comparisons/[id]/zone-correction` route | `app/api/comparisons/[id]/zone-correction/route.ts` | ✅ |
| `POST /api/comparisons/[id]/zone-review/confirm` route | `app/api/comparisons/[id]/zone-review/confirm/route.ts` | ✅ |
| Zone Review UI component | `components/app/ZoneReview.tsx` + `ZoneReview.module.css` | ✅ |
| Comparison page: render ZoneReview when status is `AWAITING_ZONE_REVIEW` | `app/app/comparison/[id]/page.tsx` | ✅ |
| `matchHints` + `confirmedUniqueZones` forwarded through `zones_corrected` into Pass 3 prompt | `lib/n2/passes/match-zones.ts` | ⬜ (wired in Phase 3) |
| `confirmedScopeDifference` flag on unmatched zones for downstream rendering | `lib/n2/schemas/types.ts` | ⬜ (wired in Phase 3) |

---

### Phase 2C — Zone Match Review
**Status:** ✅ COMPLETE
**Scope:** Unconditional user-facing pause between Pass 3 (zone matching) and Pass 4 (extraction). Direct drag-and-drop UI edits — no natural language agent.
**Goal:** Let the user verify and adjust Pass 3's zone match decisions before any expensive extraction calls run.
**Deviation from spec:** Gate is **unconditional** — always fires for every comparison. Original spec called for a conditional gate (auto-skip on clean comparisons). User decision: maximum accuracy requires human review on every comparison at this stage. See Deviations section.

| Task | File(s) | Status |
|---|---|---|
| `AWAITING_MATCH_REVIEW` status value in Prisma schema + migration | `prisma/schema.prisma`, `prisma/migrations/20260503_add_awaiting_match_review_status/` | ✅ |
| `step.waitForEvent` in `match-zones` step (unconditional) | `lib/n2/inngest/process-comparison-v2.ts` | ✅ |
| `GET /api/comparisons/[id]/match-review` route | `app/api/comparisons/[id]/match-review/route.ts` | ✅ |
| `POST /api/comparisons/[id]/match-review/confirm` route (rebuilds payload + fires Inngest event) | `app/api/comparisons/[id]/match-review/confirm/route.ts` | ✅ |
| `POST /api/comparisons/[id]/match-review/back` route (reverts status → AWAITING_ZONE_REVIEW, no Inngest event) | `app/api/comparisons/[id]/match-review/back/route.ts` | ✅ |
| `zone-review/confirm` re-entry detection (runs matchZones inline when zones_matched exists, skips Inngest event) | `app/api/comparisons/[id]/zone-review/confirm/route.ts` | ✅ |
| `maxDuration = 60` on zone-review/confirm (covers inline matchZones Sonnet call ~15-30s) | `app/api/comparisons/[id]/zone-review/confirm/route.ts` | ✅ |
| `MatchReview` optional `onBack?` prop + `← Revise zones` button (disabled when confirming) | `components/app/MatchReview.tsx` + `MatchReview.module.css` | ✅ |
| Comparison page: wire `onBack` — re-fetch zone-review data, reset status → AWAITING_ZONE_REVIEW | `app/app/comparison/[id]/page.tsx` | ✅ |
| Zone Match Review UI component (drag-and-drop + confidence badges) | `components/app/MatchReview.tsx` + `MatchReview.module.css` | ✅ |
| Comparison page: render MatchReview when status is `AWAITING_MATCH_REVIEW` | `app/app/comparison/[id]/page.tsx` | ✅ |
| Flash fix: reset state synchronously in useEffect on comparisonId change | `app/app/comparison/[id]/page.tsx` | ✅ |
| Gate exit deletion: `gateExitConfirmOpen` + `gateExiting` states, `handleGateExitRequest`, `handleGateExitConfirm`, `gateExitDialog` | `app/app/comparison/[id]/page.tsx` | ✅ |
| Gate exit: `beforeunload` guard fires on any gate-status comparison (prevents accidental tab close) | `app/app/comparison/[id]/page.tsx` | ✅ |
| Gate exit: `onExit` prop + Exit button on ZoneReview (bottom-bar, left of existing buttons) | `components/app/ZoneReview.tsx` + `ZoneReview.module.css` | ✅ |
| Gate exit: `onExit` prop + Exit button on MatchReview (bottom-bar, left of Back/Confirm) | `components/app/MatchReview.tsx` + `MatchReview.module.css` | ✅ |
| Gate-state comparisons hidden from list: `notIn: ['AWAITING_ZONE_REVIEW', 'AWAITING_MATCH_REVIEW']` filter on `GET /api/comparisons` | `app/api/comparisons/route.ts` | ✅ |

---

### Phase 3 — Zone Matching (Pass 3)
**Status:** ✅ COMPLETE
**Scope:** Sonnet zone matching (see deviation below). Single text-only call → Zod validation → state write.
**Goal:** Given `zones_detected` (or `zones_corrected` if corrections were applied), produce accurate `zones_matched` state payload with carry-forward zone slice metadata.
**Deviation from spec:** Model is `claude-sonnet-4-6` (not Opus). See Deviations section.

| Task | File(s) | Status |
|---|---|---|
| Pass 3 prompt builder | `lib/n2/prompts/match-zones.ts` | ✅ |
| Zone matching orchestrator | `lib/n2/passes/match-zones.ts` | ✅ |
| Reads `zones_corrected` with fallback to `zones_detected` | `lib/n2/passes/match-zones.ts` | ✅ |
| Zod inline schema for raw AI response | `lib/n2/passes/match-zones.ts` | ✅ |
| `buildZoneMeta` — builds per-zone slice info map from detected zones | `lib/n2/passes/match-zones.ts` | ✅ |
| Carry-forward field propagation (format, routingDecision, zoneMeta) | `lib/n2/passes/match-zones.ts` | ✅ |
| Write `n2:zones_matched` to state | `lib/n2/passes/match-zones.ts` | ✅ |
| Wire into Inngest Step 3 + `$executeRaw` status update + `waitForEvent` | `lib/n2/inngest/process-comparison-v2.ts` | ✅ |
| Error handling: FAILED status if no zone state found | `lib/n2/inngest/process-comparison-v2.ts` | ✅ |

### Phase 4 — Standard Extraction (Pass 4)
**Status:** ✅ COMPLETE
**Scope:** Per-zone extraction + matching for standard zones (≤200 items). PDF slicing, concurrency cap, splitMispaired, persist.
**Goal:** Given `zones_matched`, produce `zones_extracted` for all standard zones + unmatched zones. Full persist to LineItems.
**Model:** `claude-haiku-4-5-20251001` for extraction calls (per spec). Pass 4B classification (MISSING/ADDED) done in code, not by AI.

| Task | File(s) | Status |
|---|---|---|
| Pass 4A prompt (extract + match, matched zones) | lib/n2/prompts/pass4a-extract-match.ts | ✅ |
| Pass 4B prompt (extract only, unmatched zones) | lib/n2/prompts/pass4b-extract-only.ts | ✅ |
| Extract-and-match orchestrator | lib/n2/passes/extract-and-match.ts | ✅ |
| PDF slicing per zone (using offset-corrected pages) | lib/n2/passes/extract-and-match.ts | ✅ |
| Concurrency cap (8 parallel Haiku calls) | lib/n2/passes/extract-and-match.ts | ✅ |
| splitMispaired post-processing | lib/n2/n2-split-mispaired.ts | ✅ |
| Sort: zones by E1 start page, items by n | lib/n2/passes/extract-and-match.ts | ✅ |
| Write zones_extracted to state | lib/n2/passes/extract-and-match.ts | ✅ |
| Atomic persist (Step 5 logic) | lib/n2/passes/extract-and-match.ts | ✅ |
| Wire into Inngest Steps 4 + 5 | lib/n2/inngest/process-comparison-v2.ts | ✅ |

### Phase 5 — Large Zone Flow
**Status:** NOT STARTED
**Scope:** LZF Steps 1-4 for zones with >200 items. Chunked extraction, deterministic prematch, tiered AI matching, merge.
**Goal:** Zones that exceed 200 items are handled automatically within Step 4. Output identical to standard path.

| Task | File(s) | Status |
|---|---|---|
| LZF orchestrator | lib/n2/passes/large-zone-flow.ts | ⬜ |
| LZF Step 1: chunked extraction (parallel Haiku) | lib/n2/passes/large-zone-flow.ts | ⬜ |
| LZF Step 2: deterministic prematch | lib/n2/n2-deterministic-prematch.ts | ⬜ |
| LZF Step 3a: Tier 1 wide sweep (conditional) | lib/n2/passes/large-zone-flow.ts | ⬜ |
| LZF Step 3b: Tier 2 sequential matching | lib/n2/passes/large-zone-flow.ts | ⬜ |
| LZF Step 4: merge + classify | lib/n2/passes/large-zone-flow.ts | ⬜ |
| Integration into extract-and-match orchestrator | lib/n2/passes/extract-and-match.ts | ⬜ |

### Phase 6 — Routing, Wiring & Validation
**Status:** NOT STARTED
**Scope:** Connect N2 to the application event system. End-to-end testing. A/B validation mode.
**Goal:** N2 callable via `N2_ENABLED=true`. Side-by-side comparison with N1 results in dev. Production-ready.

| Task | File(s) | Status |
|---|---|---|
| Event dispatch: write pipelineVersion before Inngest event | (comparison creation code) | ⬜ |
| Comparison deletion: cancel Inngest run via inngestRunId | (comparison deletion code) | ⬜ |
| Version copy code: update for new unit columns | (version copy utility) | ⬜ |
| A/B validation mode (dev-only N1 vs N2 comparison) | lib/n2/dev/ | ⬜ |
| End-to-end test: small residential PDF pair | — | ⬜ |
| End-to-end test: large commercial PDF pair | — | ⬜ |
| End-to-end test: flat-list (no zones) PDF pair | — | ⬜ |
| End-to-end test: deletion during pipeline | — | ⬜ |
| Production readiness review | — | ⬜ |

## Construction Log

> Append entries here as work is completed. Format: `[date] Phase X — description of what was done.`

[2026-05-01] Phase 1 COMPLETE. See Phase 1 Verification Audit below for full details.
[2026-05-01] Phase 2 COMPLETE. Zone detection pipeline: 4 new files, Step 2 wired. See Phase 2 Verification Audit below.
[2026-05-02] Phase 2 model finalized: `claude-sonnet-4-6` selected for zone detection after prompt iteration. Haiku rejected for accuracy. `detect-zones.ts` updated from `HAIKU_MODEL` to `SONNET_MODEL`.
[2026-05-02] Phase 2B COMPLETE. Zone Review & Correction fully implemented: Prisma migration (AWAITING_ZONE_REVIEW), n2:zones_corrected Zod schema, step.waitForEvent gate in Inngest, correction agent (Sonnet + 10-playbook system prompt), examine_pdf_pages tool-use handler, GET/POST zone-review routes, POST zone-correction route, POST zone-review/confirm route, ZoneReview UI component. Lint: 0 errors.
[2026-05-03] Phase 3 COMPLETE. Zone matching pass: match-zones prompt builder, match-zones orchestrator, Zod inline response schema, buildZoneMeta, carry-forward fields, state write. Wired into Inngest Step 3 with $executeRaw status update (Prisma enum cache workaround) + step.waitForEvent gate. Error handling for missing zone state. Model: claude-sonnet-4-6 (deviation from Opus spec — see Deviations).
[2026-05-03] Phase 2C COMPLETE. Zone Match Review gate: Prisma migration (AWAITING_MATCH_REVIEW), GET match-review route, POST match-review/confirm route (slot-based payload rebuild + Inngest event), MatchReview drag-and-drop UI component with confidence badges + dark mode + mobile responsive. Comparison page: render guard, match-review data fetch, flash fix (synchronous state reset in useEffect). Gate is unconditional (deviation from spec — see Deviations).
[2026-05-03] Phase 4 COMPLETE. Standard extraction pipeline: Pass 4A prompt (extract+match, matched zones), Pass 4B prompt (extract-only, unmatched zones), extract-and-match orchestrator with concurrency cap 8, splitMispaired post-processor, atomic persist (deleteMany+createMany+comparison update in transaction), clearN2Stage after persist. Wired into Inngest Steps 4+5. Model: claude-haiku-4-5-20251001. See Phase 4 Verification Audit below.
[2026-05-03] Back navigation on match review gate. POST match-review/back (status revert, no Inngest event), zone-review/confirm re-entry detection (inline matchZones + $executeRaw AWAITING_MATCH_REVIEW), maxDuration=60 on zone-review/confirm, MatchReview onBack prop + button, page.tsx wiring. Inngest pipeline untouched — stays blocked at match-review gate throughout back/re-confirm cycle. See Deviations.
[2026-05-03] Gate exit deletion implemented. `onExit` prop added to ZoneReview and MatchReview Props; Exit button rendered in bottom-bar of both components (with `exitBtn` CSS). `page.tsx`: `gateExitConfirmOpen`/`gateExiting` states, `beforeunload` guard (fires on both gate statuses), `handleGateExitRequest`, `handleGateExitConfirm` (calls `DELETE /api/comparisons/[id]` then redirects to `/app/comparisons`), `gateExitDialog` confirmation overlay. Both gate early-return blocks wrapped in fragments to render dialog alongside gate component. Gate-state comparisons (`AWAITING_ZONE_REVIEW`, `AWAITING_MATCH_REVIEW`) excluded from `GET /api/comparisons` response via Prisma `notIn` filter — invisible on list until COMPLETED.

---

## Phase 1 Verification Audit

> **Purpose:** This section is a complete, self-contained audit trail for a second reviewer to independently verify everything built in Phase 1. All file paths are relative to `estimatch-app/`. All commands should be run from within the `estimatch-app/` directory.

### Verification Commands (run these first)

```bash
# 1. TypeScript: should exit 0 with no output
npx tsc --noEmit

# 2. ESLint: should exit 0 with no output
npx eslint lib/n2/schemas/types.ts lib/n2/schemas/state-payloads.ts lib/n2/schemas/pass-responses.ts lib/n2/utils/ai-response.ts lib/n2/utils/pdf-slicer.ts lib/n2/utils/chunk-pdf.ts lib/n2/utils/n2-state.ts lib/n2/n2-routing.ts lib/n2/inngest/process-comparison-v2.ts app/api/inngest/route.ts

# 3. Prisma schema validation: should exit 0
npx prisma validate

# 4. Confirm migration was applied
npx prisma migrate status
# Expected: "Database schema is up to date!"
```

Both `tsc --noEmit` and `eslint` passed with exit code 0 and zero output at time of build.

---

### 1. Schema Changes (`prisma/schema.prisma`)

**Model: `LineItem`** — two new optional columns added after `qtyAdjuster`:
```prisma
unitYours    String? @map("unit_yours")
unitAdjuster String? @map("unit_adjuster")
```

**Model: `ComparisonVersionLineItem`** — same two optional columns added after `qtyAdjuster`:
```prisma
unitYours    String? @map("unit_yours")
unitAdjuster String? @map("unit_adjuster")
```

**Model: `Comparison`** — two new columns added after `errorMessage`:
```prisma
pipelineVersion String  @default("n1") @map("pipeline_version")
inngestRunId    String? @map("inngest_run_id")
```

**Migration file:** `prisma/migrations/20260501215737_n2_foundation/migration.sql`
- Should contain `ALTER TABLE` statements for `line_items`, `comparison_version_line_items`, and `comparisons`.
- `pipeline_version` column defaults to `'n1'` — existing rows get `'n1'` automatically. No data migration needed.

---

### 2. Dependencies (`package.json`)

Two packages added to `dependencies` (not devDependencies):
```json
"pdf-lib": "^1.17.1",
"zod": "^3.24.0"
```

Verify: `node_modules/pdf-lib` and `node_modules/zod` directories should exist.

---

### 3. File Inventory (`lib/n2/`)

Every file below is **new**. No existing files were modified except `prisma/schema.prisma`, `package.json`, and `app/api/inngest/route.ts`.

#### `lib/n2/schemas/types.ts`
**Purpose:** Canonical TypeScript types — the single source of truth for all shared N2 types.

Key exports to verify:
- `EstimateFormat` — `'xactimate' | 'symbility' | 'unknown'`
- `RoutingDecision` — 4 variants + `'unknown'`
- `N2MatchStatus` — `'MATCH' | 'MODIFIED' | 'MISSING_FROM_ADJUSTER' | 'ADDED_BY_ADJUSTER'`
- `N2DetectedZone` — includes `name`, `startPage`, `endPage`, `approxItems`, `chunkOffset`
- `N2MatchedZonePair` — includes `e1Zones[]`, `e2Zones[]`, `canonical`, `isMerged`, `confidence`
- `N2ExtractedItem` — short-key schema (`n`, `d`, `q`, `u`, `rm`, `rp`, `rs`, `tx`, `op`, `t`)
- `N2ItemPair` — `status` + `e1` + `e2` + optional `resolutionSource`
- `N2ZonesDetectedPayload`, `N2ZonesMatchedPayload`, `N2ZonesExtractedPayload` — the 3 state stage types
- `zoneKey(name, startPage)` — utility function, returns `"${name}_p${startPage}"`

**What to check:** No imports from anywhere outside this file (it defines primitives). No import from N1 files.

---

#### `lib/n2/schemas/state-payloads.ts`
**Purpose:** Zod schemas that validate the `payload` JSON column in `comparison_processing_state` at every read and write boundary.

Key exports to verify:
- `N2ZonesDetectedPayloadSchema` — validates `e1Zones[]`, `e2Zones[]`, `e1Format`, `e2Format`, `routingDecision`
- `N2ZonesMatchedPayloadSchema` — validates `matched[]`, `unmatchedE1[]`, `unmatchedE2[]`, carry-forward fields, `e1ZoneMeta`, `e2ZoneMeta`
- `N2ZonesExtractedPayloadSchema` — validates `zoneResults{}`, `zoneMeta{}`, `routingDecision`
- All three have corresponding `type` exports inferred via `z.infer<>`

**What to check:** Imports only from `zod`. No imports from N1 files.

---

#### `lib/n2/schemas/pass-responses.ts`
**Purpose:** Zod schemas for raw AI response validation. One schema per AI call type.

Key exports to verify:
- `Pass1Chunk1ResponseSchema` — includes `first_page_printed_number`, `format`, `zones[]`
- `Pass2ChunkNResponseSchema` — same minus `format` field
- `Pass3ResponseSchema` — `matched[]`, `unmatchedE1[]`, `unmatchedE2[]`
- `Pass4AResponseSchema` — `zone`, `pairs[]` with `status` + `e1` + `e2`
- `Pass4BResponseSchema` — `zone`, `items[]` (extraction only, no pairing)
- `LzfChunkExtractionResponseSchema` — alias of `Pass4BResponseSchema`
- `LzfTierMatchResponseSchema` — `pairs[]` with `e1n`, `e2n`, `confidence`

**What to check:** Imports only from `zod`. No imports from N1 files.

---

#### `lib/n2/utils/ai-response.ts`
**Purpose:** Clean → parse → validate pipeline for all AI responses. Shared by every pass.

Key exports to verify:
- `AIResponseError` class — extends `Error`, has `retryable: boolean` and `context?: string` fields
- `cleanJsonString(raw: string): string` — strips markdown fences, extracts outermost `{}` or `[]` block. Throws `AIResponseError` (retryable) if no JSON block found.
- `parseAndValidate<T>(raw, schema, context): T` — calls `cleanJsonString` then `JSON.parse` then `schema.safeParse`. Throws `AIResponseError` on any failure.
- `isTruncated(stopReason, rawOutput?): boolean` — returns `true` if `stopReason === 'max_tokens'`; falls back to heuristic if `stopReason` is null.
- `withRetry<T>(fn, maxAttempts, context): Promise<T>` — 3 attempts by default, exponential backoff with jitter (base 500ms × 2^attempt + 0–500ms random). Non-retryable `AIResponseError` re-throws immediately without waiting.

**What to check:** No imports from N1. No Anthropic SDK import (that belongs in the pass files, not here).

---

#### `lib/n2/utils/pdf-slicer.ts`
**Purpose:** pdf-lib load and page-slice utilities.

Key exports to verify:
- `loadPdf(pdfBytes: Uint8Array): Promise<PDFDocument>` — wraps `PDFDocument.load`
- `slicePages(srcDoc, startIndex, endIndex): Promise<Uint8Array>` — clamps range, copies pages into new doc, returns bytes. Throws on empty range after clamping.
- `printedToInternal(printedPage, chunkOffset): number` — returns `printedPage + chunkOffset`

**What to check:** All page indices are 0-based. The `for...of` loop (not `forEach`) is used to add pages — this avoids the TypeScript implicit-any callback error. The `Cannot find module 'pdf-lib'` TypeScript error that appeared pre-install should be gone after `npm install` runs.

---

#### `lib/n2/utils/chunk-pdf.ts`
**Purpose:** Produces overlapping chunk descriptors for Pass 1/2 and LZF Step 1.

Key exports to verify:
- `PdfChunk` type — `{ startIndex: number, endIndex: number, chunkIndex: number }`
- `buildChunks(totalPages, chunkSize=10, overlap=1): PdfChunk[]` — all indices 0-based. Overlap means the last `overlap` pages of chunk N are the first `overlap` pages of chunk N+1. Example: 20 pages, size 10, overlap 1 → `[{0,9,0}, {9,18,1}, {18,19,2}]`.
- `uniquePagesInChunk(chunk, overlap): number` — chunk 0 returns full page count; subsequent chunks subtract overlap.

**What to check:** No imports from N1. No external dependencies (no pdf-lib import — this is a pure math utility).

---

#### `lib/n2/utils/n2-state.ts`
**Purpose:** N2-specific state helpers for `comparison_processing_state` table. Parallel to N1's `lib/comparison-processing-state.ts` but uses N2 stage keys and Zod validation on reads.

Key exports to verify:
- `N2_STAGE_ZONES_DETECTED = 'n2:zones_detected'`
- `N2_STAGE_ZONES_MATCHED = 'n2:zones_matched'`
- `N2_STAGE_ZONES_EXTRACTED = 'n2:zones_extracted'`
- `writeN2Stage(comparisonId, stage, payload): Promise<void>` — **upsert** (not insert). Safe to retry.
- `readZonesDetected(comparisonId)` — returns `N2ZonesDetectedPayloadParsed | null`
- `readZonesMatched(comparisonId)` — returns `N2ZonesMatchedPayloadParsed | null`
- `readZonesExtracted(comparisonId)` — returns `N2ZonesExtractedPayloadParsed | null`
- `clearN2Stage(comparisonId): Promise<void>` — uses `deleteMany` (safe if row doesn't exist)

**What to check:** All read functions return `null` (not throw) when the row is missing or the stage key doesn't match — they only throw when the row exists but the payload fails Zod validation (indicating state corruption). N1's `comparison-processing-state.ts` is **not imported**.

---

#### `lib/n2/n2-routing.ts`
**Purpose:** Env-gated routing + eligibility check. The on/off switch for N2.

Key exports to verify:
- `isN2Enabled(): boolean` — returns `true` only if `process.env.N2_ENABLED === 'true'` (exact string)
- `isN2Eligible(comparisonId: string): Promise<boolean>` — Phase 1: delegates entirely to `isN2Enabled()`. Phase 6 will extend with percentage rollout / format gating. Uses `void comparisonId` to satisfy ESLint no-unused-vars (parameter reserved for future use).
- `N2ProcessRequestedEvent` type — event name: `'comparison/process-v2.requested'`. Data fields: `comparisonId`, `trigger: 'create-route' | 'manual-route' | 'replay'`, optional `force?: boolean`.

**What to check:** Does NOT import from N1 files. Does NOT import `prisma` (it's a pure env check in Phase 1). The event name `'comparison/process-v2.requested'` must be different from N1's `'comparison/process.requested'` — they must never cross-trigger.

---

#### `lib/n2/inngest/process-comparison-v2.ts`
**Purpose:** The N2 Inngest function — 5-step durable pipeline skeleton.

Key properties to verify:
- Function ID: `'process-comparison-v2'`
- Trigger event: `'comparison/process-v2.requested'`
- Retries: 3
- Concurrency: key `'event.data.comparisonId'`, limit 1 (one active run per comparison at a time)
- **Step names** (exact strings — these must match the architecture spec):
  - `'check-already-terminal'` (idempotency guard, not a "real" step)
  - `'store-run-id'`
  - `'detect-zones'`
  - `'match-zones'`
  - `'extract-and-match'`
  - `'persist-results'`
  - `'mark-failed'` (error handler only)
- Every step begins with a `prisma.comparison.findUnique` existence check — if the comparison was deleted mid-flight, the step returns `{ skipped: true }` without throwing.
- The `catch` block calls `step.run('mark-failed', ...)` to flip `status → FAILED` and re-throws so Inngest records the run as failed.
- Steps 2-5 are skeleton no-ops that log a TODO message. No AI calls, no PDF reads.

**What to check:** Imports `inngest` from `@/lib/inngest/client` (same client as N1 — correct, they share the app). Does NOT import anything from `lib/inngest/functions/process-comparison.ts` (N1). Does NOT call `isN2Eligible` (routing happens upstream in the API route, not inside the function).

---

#### `app/api/inngest/route.ts` (modified — minimal)

The only change to this file:
1. Added import: `import { processComparisonV2 } from '@/lib/n2/inngest/process-comparison-v2';`
2. Added `processComparisonV2` to the `functions` array: `functions: [processComparison, processComparisonV2]`

**What to check:** `processComparison` (N1) is still in the array and unchanged. `maxDuration = 300` is unchanged.

---

### 4. What Was NOT Changed (N1 Isolation)

The following files were **read** for reference but **not modified**:
- `lib/inngest/functions/process-comparison.ts` — N1 function, untouched
- `lib/inngest/client.ts` — shared Inngest client, untouched
- `lib/comparison-processing-state.ts` — N1 state helpers, untouched
- `lib/prisma.ts` — shared Prisma client, untouched
- `lib/n2-deterministic-prematch.ts` — pre-existing placeholder, untouched

The N2 pipeline imports `prisma` from `@/lib/prisma` (shared client — correct) and `inngest` from `@/lib/inngest/client` (shared client — correct). It imports **nothing else** from N1 files.

---

### 5. Intentional Decisions / Deviations from Architecture Spec

| Decision | Rationale |
|---|---|
| `run.id` (Inngest run ID) NOT persisted in `store-run-id` step | `run` is not available in `HandlerArgs` type for `inngest@4.2.5`. Run ID persistence deferred to Phase 6 when the full cancellation mechanism (Issue 29, Layer 3) is wired. The `inngestRunId` column exists in the DB, ready for Phase 6. |
| `zod` added as a direct dependency (not devDependency) | Zod schemas run at runtime on every AI response and every state read — they are production code, not test utilities. |
| `n2-state.ts` uses `deleteMany` instead of `delete` for `clearN2Stage` | `deleteMany` is safe when the row may not exist (no "not found" error). `delete` throws `P2025` if the row is missing. |
| `withRetry` backoff starts at 500ms (not 1000ms) | N2 runs in Inngest steps with `maxDuration` budgets. A 1000ms base would eat 7+ seconds across 3 retries on a 300s budget. 500ms base is aggressive enough for transient JSON errors while preserving step budget. |

---

## Phase 2 Verification Audit

> **Purpose:** Self-contained audit trail for Phase 2. All paths relative to `estimatch-app/`. Run from within `estimatch-app/`.

### Verification Commands

```bash
# 1. TypeScript: should exit 0 with no output
npx tsc --noEmit

# 2. ESLint: should exit 0
npx eslint lib/n2/prompts/pass1-chunk1.ts lib/n2/prompts/pass1-chunk-n.ts lib/n2/utils/zone-merge.ts lib/n2/passes/detect-zones.ts lib/n2/inngest/process-comparison-v2.ts
```

Both passed with exit code 0 and zero output at time of build.

---

### 1. New Files

#### `lib/n2/prompts/pass1-chunk1.ts`
**Purpose:** Prompt builder for chunk 0 of any PDF. Includes format detection (Task 1 in the spec).

Key exports:
- `Pass1Chunk1PromptParams` — `{ startPage, endPage, totalPages }`
- `buildPass1Chunk1Prompt(p)` — returns `{ system: string; user: string }`

**What to check:** `system` and `user` prompts match the spec verbatim (§Pass 1 — Zone Detection, Chunk 1). Rule 6 in the user prompt uses the parameterized `${p.startPage}–${p.endPage}` values. JSON response template includes `first_page_printed_number`, `format`, `approx_items_on_pages`, and `zones[]`.

---

#### `lib/n2/prompts/pass1-chunk-n.ts`
**Purpose:** Prompt builder for chunks 1+ of any PDF. No format task.

Key exports:
- `Pass1ChunkNPromptParams` — same shape as `Pass1Chunk1PromptParams`
- `buildPass1ChunkNPrompt(p)` — returns `{ system: string; user: string }`

**What to check:** JSON response template does NOT include a `format` field. All other rules identical to chunk 1.

---

#### `lib/n2/utils/zone-merge.ts`
**Purpose:** Merge + post-process raw chunk detection results into `N2DetectedZone[]`.

Key exports:
- `ChunkZoneDetectionResult` — input type; includes optional `detectedFormat` (present for chunk 0 only)
- `mergeChunkZones(chunkResults, pdfInternalPageCount)` — per-chunk offset, zone map, end-page derivation
- `preDeduplicateZones(zones)` — conservative suffix-match dedup
- `synthesizeGeneralZone(chunkResults, pdfInternalPageCount)` — zero-zone fallback

**Per-chunk offset formula (Issue 35):**
```typescript
chunkOffset = chunk.startIndex - firstPagePrintedNumber
```

**End-page derivation (Issue 35):**
```typescript
// Zone N (not last):
endPage = zones[N+1].startPage
endPageChunkOffset = zones[N+1].chunkOffset

// Last zone:
endPage = lastChunk.firstPagePrintedNumber + (lastChunk.chunk.endIndex - lastChunk.chunk.startIndex)
endPageChunkOffset = pdfInternalPageCount - 1 - endPage
// → internalEnd = endPage + endPageChunkOffset = pdfInternalPageCount - 1 ✓
```

**Pre-dedup rule:** Zone A is removed if zone B's name ends with A's name (case-insensitive) AND the character immediately before A in B is a space or dash. This correctly handles `"1st Floor - Common Lobby"` ⊃ `"Common Lobby"` while preserving `"Bathroom 1"` and `"Bathroom 2"`.

---

#### `lib/n2/passes/detect-zones.ts`
**Purpose:** Inngest Step 2 orchestrator.

**What to check:**
- Downloads both PDFs via `supabaseAdmin.storage.from('estimates').download(path)` — same bucket as N1
- Uses `loadPdf` + `buildChunks(pageCount, 10, 1)` (10-page chunks, 1-page overlap)
- All chunk AI calls fire simultaneously via `Promise.allSettled` — E1 and E2 together
- Chunk 0 uses `Pass1Chunk1ResponseSchema`; chunks 1+ use `Pass2ChunkNResponseSchema`
- `processOneChunk` uses `withRetry(fn, 3, context)` — 3 attempts per chunk
- `Promise.allSettled` result: any rejected chunk immediately throws (fails the step → Inngest retries)
- Format extracted from chunk 0's `detectedFormat` field
- Flat-list threshold: `< 2` detected zones after dedup → classified as flat, General zone synthesized
- Routing decision written to state: `routingDecision` field in `n2:zones_detected` payload
- `writeN2Stage` upsert is safe to retry

**Model used:** `claude-haiku-4-5-20251001`, `max_tokens: 2000`, `temperature: 0`

**What NOT to check:** There is no undici custom dispatcher here — zone detection calls are tiny (small output) and complete in seconds. The undici dispatcher is only needed for N1's long-running full-PDF extraction calls.

---

#### `lib/n2/inngest/process-comparison-v2.ts` (modified)

One-line change: Step 2 no-op replaced with `await detectZones(comparisonId)`. Step comment updated to describe what the step now does.

---

### 2. What Was NOT Changed

No N1 files were modified. No existing N2 files were modified except `process-comparison-v2.ts` (Step 2 wiring).

---

### 3. Intentional Decisions / Deviations

| Decision | Rationale |
|---|---|
| `estimatedStartPage = chunk.startIndex + 1` (not a real offset) | All chunk calls fire simultaneously — the true printed start page is unknown at call time. The estimate is context-only; the model reads actual printed numbers from page images and returns them via `first_page_printed_number`. Per-chunk offsets are computed at merge time, not at call time. |
| No concurrency limiter for Pass 1/2 fan-out | Pass 1/2 chunks are tiny (10 pages, zone-names-only output). Firing all simultaneously is well within Haiku's rate limits. Explicit concurrency capping is added in Phase 4 for Pass 4's heavier 8-parallel calls (Issue 21). |
| Regular `fetch` (not undici dispatcher) for zone detection calls | Zone detection calls are short-lived (5–15 s). The 5-min Node fetch timeout is not a risk here. The custom undici dispatcher is only needed for N1's multi-minute full-PDF extraction calls. |
| `FLAT_LIST_THRESHOLD = 2` | An estimate with 0 or 1 detected zones is classified as flat. A single zone means no structure was found (everything is one undifferentiated block). 2+ zones means real zoning exists. |

---

## Deviations from Architecture

> Document any implementation decisions that differ from the architecture spec above. Include rationale.

_Phase 1 and Phase 2 deviations: see their respective Verification Audit sections above._

| Phase | Spec | Actual | Rationale |
|---|---|---|---|
| Phase 3 | Model: `claude-opus-4-7` (Opus) for zone matching | Model: `claude-sonnet-4-6` (Sonnet) | Opus was unavailable/not yet accessible at implementation time. Sonnet handles zone matching well for standard cases. Revisit if accuracy issues emerge on large commercial PDFs with many ambiguously named zones. |
| Phase 3 | Retry logic: 2× re-prompt on validation failure | No explicit retry in pass — relies on Inngest step retry (3×) | Inngest-level retry is equivalent for transient failures; in-pass retry adds complexity without clear benefit at this stage. |
| Phase 3 | Prompt file: `lib/n2/prompts/pass3-zone-matching.ts` | Prompt file: `lib/n2/prompts/match-zones.ts` | Naming aligned with pass file convention (`match-zones.ts` ↔ `match-zones.ts`). |
| Phase 2C | Gate fires conditionally (trigger conditions: any low-confidence match, merged zone, or unmatched zone > 10%) | Gate fires unconditionally on every comparison | User decision: maximum accuracy requires human review on every match. Conditional auto-skip removed entirely. |
| Phase 2C | Routes: `/zone-match-review`, `/zone-match-review/correction`, `/zone-match-review/confirm` | Routes: `/match-review`, `/match-review/confirm` | Simplified naming. Separate correction route eliminated — user corrections are submitted directly via the confirm route's slot-based payload. |
| Phase 2C | Component: `ZoneMatchReview.tsx` | Component: `MatchReview.tsx` | Shorter name. No functional difference. |
| Phase 2C | Status update via `prisma.comparison.update` | Status update via `prisma.$executeRaw` | Prisma client-side enum cache did not include `AWAITING_MATCH_REVIEW` after `ALTER TYPE` migration. `$executeRaw` bypasses the stale runtime enum list. Safe workaround until next full deploy regenerates the Prisma client. |
| Phase 2C Back Nav | Back navigation fires a new Inngest event to re-trigger match-zones | Back navigation reverts DB status to `AWAITING_ZONE_REVIEW`; Inngest pipeline stays blocked at `match-review-complete` gate. On re-confirm, `zone-review/confirm` detects re-entry (`zones_matched` exists) and runs `matchZones()` inline, then sets `AWAITING_MATCH_REVIEW` via `$executeRaw` without touching Inngest. | Zero new Inngest events or function changes needed. Inngest's single `waitForEvent` block handles both the first-time confirm and the post-back confirm identically. Failure mode: if inline `matchZones` times out (>60s, very rare), user sees an HTTP error but state is safe (`AWAITING_ZONE_REVIEW`) and they can retry. |
| Gate exit | Gate exit was not in the original N2 spec | Exit button added to both ZoneReview and MatchReview. Clicking opens a confirmation dialog in `page.tsx`. Confirmed → `DELETE /api/comparisons/[id]` (existing endpoint) + `router.push('/app/comparisons')`. `beforeunload` guard fires on page close/refresh when status is a gate value. Gate-state comparisons excluded from `GET /api/comparisons` via Prisma `notIn` filter. | Ensures abandoned in-progress comparisons (which have no line items yet) are not silently orphaned on the comparisons list. |

---

## Phase 2C Verification Audit

> All paths relative to `estimatch-app/`. Run from within that directory.

### Verification Commands

```bash
# TypeScript
npx tsc --noEmit

# ESLint
npx eslint \
  app/api/comparisons/[id]/match-review/route.ts \
  app/api/comparisons/[id]/match-review/confirm/route.ts \
  components/app/MatchReview.tsx \
  lib/n2/inngest/process-comparison-v2.ts \
  app/app/comparison/[id]/page.tsx

# Prisma
npx prisma validate
npx prisma migrate status
```

### 1. New Files

#### `prisma/migrations/20260503_add_awaiting_match_review_status/migration.sql`
```sql
ALTER TYPE "comparison_status" ADD VALUE 'AWAITING_MATCH_REVIEW';
```

#### `app/api/comparisons/[id]/match-review/route.ts`
- `GET` handler; auth + ownership check + status guard (`AWAITING_MATCH_REVIEW`)
- Reads `n2:zones_matched` via `readZonesMatched`; returns `{ pairs, unmatchedE1, unmatchedE2 }`
- Returns 409 if status is not `AWAITING_MATCH_REVIEW`

#### `app/api/comparisons/[id]/match-review/confirm/route.ts`
- `POST` handler; accepts `{ e1Slots: (string|null)[], e2Slots: (string|null)[] }`
- Rebuilds `N2ZonesMatchedPayload` from slot arrays using zone meta from existing state
- Writes updated payload back via `writeN2Stage`
- Updates status to `PROCESSING` via `prisma.comparison.update`
- Fires `comparison/match-review.completed` Inngest event
- Returns `{ ok: true, skipped: false }` (or `{ ok: true, skipped: true }` if already past this status)

#### `components/app/MatchReview.tsx`
- Props: `comparisonId`, `pairs`, `unmatchedE1`, `unmatchedE2`, `onConfirmed`
- State: `slots` array of `{ e1: string|null, e2: string|null }` rows
- Confidence map built via `useMemo` (avoids ref-during-render lint error)
- Drag-and-drop: HTML5 `draggable` API; cell-level drag start/drop
- Confidence badges: green (≥90), yellow (75–89), grey (<75)
- High-confidence rows: green background highlight
- Confirm button: calls `POST .../match-review/confirm` with current slot arrangement
- Full dark mode + mobile responsive via `MatchReview.module.css`

### 2. Modified Files

#### `lib/n2/inngest/process-comparison-v2.ts`
- Step 3 (`match-zones`): after `matchZones()` completes, uses `prisma.$executeRaw` to flip status to `AWAITING_MATCH_REVIEW`, then `step.waitForEvent('wait-for-match-review', { event: 'comparison/match-review.completed', ... })`
- Try-catch around `matchZones()`: if error message includes `'No zone state found'`, marks comparison `FAILED` and returns `{ skipped: true }`

#### `app/app/comparison/[id]/page.tsx`
- Added `AWAITING_MATCH_REVIEW` to comparison status type union
- Added `n2MatchData` state and `MatchReview` import
- `loadComparison()` fetches `match-review` data when status is `AWAITING_MATCH_REVIEW`
- Poll loop does the same check on status transitions
- Render guard: `comparison?.status === 'AWAITING_MATCH_REVIEW'` returns `<MatchReview ...>` before the full comparison JSX
- **Flash fix:** `setComparison(null)`, `setZones([])`, `setIsLoading(true)`, `setLoadError(null)` called synchronously in `useEffect` body (not inside the async function) so no stale render frame on comparisonId change

### 3. What Was NOT Changed
N1 files untouched. No N2 files from Phases 1/2/2B modified except `process-comparison-v2.ts` (Step 3 wiring) and `page.tsx` (render guard + data fetch).

---

## Phase 3 Verification Audit

> All paths relative to `estimatch-app/`. Run from within that directory.

### Verification Commands

```bash
# TypeScript
npx tsc --noEmit

# ESLint
npx eslint lib/n2/prompts/match-zones.ts lib/n2/passes/match-zones.ts
```

### 1. New Files

#### `lib/n2/prompts/match-zones.ts`
**Purpose:** Builds the system and user prompt for the Sonnet zone matching call.

Key exports:
- `MatchZonesPromptParams` — `{ e1Zones: N2DetectedZone[], e2Zones: N2DetectedZone[], matchHints?: string[], confirmedUniqueZones?: string[] }`
- `buildMatchZonesPrompt(params)` — returns `{ system: string; user: string }`

System prompt mirrors the Pass 3 spec verbatim (§3 / Pass 3 Opus prompt).
User prompt formats both zone lists with zone name, page range, and approxItems.
`matchHints` (from zone review correction agent) are appended as additional context when present.
`confirmedUniqueZones` (zones user confirmed as unique in zone review) are appended as explicit do-not-match instructions.

#### `lib/n2/passes/match-zones.ts`
**Purpose:** Inngest Step 3 orchestrator.

Key constants:
- `MATCH_MODEL = 'claude-sonnet-4-6'`
- `MATCH_MAX_TOKENS = 4096`

Execution order:
1. Read `n2:zones_corrected` (falls back to `n2:zones_detected` if no corrections)
2. Throw `Error('[match-zones] No zone state found for comparison ...')` if both are null
3. Call Anthropic API with `buildMatchZonesPrompt`
4. Parse response via inline `MatchZonesResponseSchema` (Zod)
5. Build `e1ZoneMeta` / `e2ZoneMeta` via `buildZoneMeta()`
6. Assemble and write `N2ZonesMatchedPayload` via `writeN2Stage`

**What to check:** Model constant is `claude-sonnet-4-6`. No PDF content in the prompt (text-only call). Carry-forward fields (`e1Format`, `e2Format`, `routingDecision`) are copied from the detected/corrected state. Zone refs in the matched pairs use `{ zone: name, pages: [startPage, endPage] }` format per the schema.

### 2. Modified Files

#### `lib/n2/inngest/process-comparison-v2.ts`
Step 3 `match-zones`:
```typescript
try {
  await matchZones(comparisonId, logger);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('No zone state found')) {
    await prisma.comparison.update({ ... status: 'FAILED', errorMessage: '...' });
    return { step: 'match-zones', skipped: true, reason: 'no-zone-state' };
  }
  throw err;
}
await prisma.$executeRaw`UPDATE comparisons SET status = 'AWAITING_MATCH_REVIEW'::comparison_status, updated_at = NOW() WHERE id = ${comparisonId}`;
const matchReviewResult = await step.waitForEvent('wait-for-match-review', {
  event: 'comparison/match-review.completed',
  match: 'data.comparisonId',
  timeout: '7d',
});
if (!matchReviewResult) { /* timeout handling */ }
```

### 3. What Was NOT Changed
No N1 files. No files outside `lib/n2/` except `process-comparison-v2.ts` and `page.tsx`.

---

## Phase 4 Verification Audit

> All paths relative to `estimatch-app/`. Run from within that directory.

### Verification Commands

```bash
# ESLint: should exit 0 with no output
npx eslint \
  lib/n2/prompts/pass4a-extract-match.ts \
  lib/n2/prompts/pass4b-extract-only.ts \
  lib/n2/n2-split-mispaired.ts \
  lib/n2/passes/extract-and-match.ts \
  lib/n2/inngest/process-comparison-v2.ts
```

Both passed with exit code 0 and zero output at time of build.

---

### 1. New Files

#### `lib/n2/prompts/pass4a-extract-match.ts`
**Purpose:** Prompt builder for Pass 4A — matched zones (two PDF document blocks).

Key exports:
- `Pass4APromptParams` — `{ canonicalZoneName, e1StartPage, e1EndPage, e2StartPage, e2EndPage }`
- `buildPass4APrompt(p)` — returns `{ system: string; user: string }`

**What to check:** System prompt establishes analyst role. User prompt sends two labeled document blocks (Document 1 = contractor, Document 2 = adjuster). Two-step extraction then matching with explicit MATCH/MODIFIED/MISSING/ADDED classification rules. Anti-mispair instruction: *"Items describing completely different work must NEVER be paired."* JSON template included.

---

#### `lib/n2/prompts/pass4b-extract-only.ts`
**Purpose:** Prompt builder for Pass 4B — unmatched zones (one PDF document block).

Key exports:
- `Pass4BPromptParams` — `{ canonicalZoneName, startPage, endPage, side: 'contractor' | 'adjuster' }`
- `buildPass4BPrompt(p)` — returns `{ system: string; user: string }`

**What to check:** Returns `items[]` (NOT `pairs[]`). Status classification (MISSING_FROM_ADJUSTER or ADDED_BY_ADJUSTER) is applied in code by the orchestrator, not by the AI. JSON template uses `items` key.

---

#### `lib/n2/n2-split-mispaired.ts`
**Purpose:** Post-process MODIFIED pairs to split mispairs (zero token overlap).

Key exports:
- `splitMispaired(pairs: N2ItemPair[]): N2ItemPair[]`

**What to check:** Only scans `MODIFIED` status pairs with both `e1` and `e2` non-null. Tokenizes both descriptions (lowercase, punctuation stripped, stopwords removed, minimum 2 chars). If intersection is empty → split into MISSING_FROM_ADJUSTER + ADDED_BY_ADJUSTER. All other pairs pass through unchanged. No API calls, no external dependencies.

---

#### `lib/n2/passes/extract-and-match.ts`
**Purpose:** Step 4 + Step 5 orchestrators.

**`extractAndMatch(comparisonId, logger)`:**
1. Reads `n2:zones_matched` (throws if missing)
2. Downloads both PDFs via Supabase (`estimates` bucket)
3. Loads into pdf-lib `PDFDocument` (one load per estimate, reused for all zone slices)
4. Builds `ZoneCallSpec[]` for all matched pairs (Pass 4A) and unmatched zones (Pass 4B)
5. For 1:many pairs: `sliceMultipleRanges()` concatenates all zone ranges into one sub-PDF per side
6. Fans out all zone calls via `runWithConcurrencyLimit(..., 8)`
7. Fails fast if any zone exhausts its 3 retry attempts
8. Runs `splitMispaired()` on each zone's raw pairs
9. Builds `zoneResults` and `zoneMeta` dicts, writes `n2:zones_extracted`

**`persistResults(comparisonId, logger)`:**
1. Reads `n2:zones_extracted` (throws if missing)
2. Sorts zone keys: matched + unmatched-E1 first (ascending E1 start page); unmatched-E2 last (ascending E2 start page). Start page parsed from key suffix `_p<N>`.
3. Sorts items within each zone by `e1.n ?? e2.n`
4. Flattens to `LineItemCreateManyInput[]` accumulating aggregate counts and totals
5. Atomic Prisma transaction: `deleteMany` existing LineItems → `createMany` → `update` Comparison (status → COMPLETED, totals, counts)
6. P2025/P2003 catch: comparison deleted mid-flight → return cleanly, no throw
7. `clearN2Stage(comparisonId)` — deletes ComparisonProcessingState row

**Key constants:** `SONNET_MODEL = 'claude-sonnet-4-6'`, `PASS4_MAX_TOKENS = 16384`, `CONCURRENT_ZONE_CALLS = 8`. *(Updated May 6, 2026 — Issue 38. Originally Haiku 4.5 with 8,192 max_tokens.)*

**normalizeItem helper:** Collapses `string | null | undefined` → `string | null` for all optional Zod-parsed item fields before they are assigned to `N2ExtractedItem`.

**What NOT to check:** Large Zone Flow (LZF) for zones >200 items — that is Phase 5. All zones go through Pass 4A/4B standard path in Phase 4. Zones that AI-estimated as >200 items will still be processed; accuracy may be lower for very large zones until Phase 5 is wired.

---

### 2. Modified Files

#### `lib/n2/inngest/process-comparison-v2.ts`
- Added import: `import { extractAndMatch, persistResults } from '@/lib/n2/passes/extract-and-match'`
- Step 4 (`extract-and-match`): replaced TODO no-op with `await extractAndMatch(comparisonId, logger)`
- Step 5 (`persist-results`): replaced TODO no-op with `await persistResults(comparisonId, logger)`, returns `{ lineItemCount }`

### 3. What Was NOT Changed
N1 files untouched. No N2 files from Phases 1–3 modified except `process-comparison-v2.ts` (Steps 4/5 wiring).

### 4. Intentional Decisions / Deviations

| Decision | Rationale |
|---|---|
| All zones use standard Pass 4A/4B regardless of `approxItems` | LZF (Phase 5) not yet wired. Oversized zones still process; accuracy degrades gracefully rather than silently skipping zones. |
| `normalizeItem()` helper defined after its callers | Regular `function` declarations are hoisted in JS/TS — TypeScript resolves them correctly regardless of source order. |
| Plain `number \| null` passed for Prisma `Decimal` columns | Prisma's runtime accepts JavaScript numbers for `@db.Decimal` fields. Avoids `@prisma/client/runtime/library` import which is an internal path and subject to breaking changes. |
| `yourEstimateTotal` / `adjusterEstimateTotal` column names | Matches `Comparison` model field names (see `prisma/schema.prisma` lines 86–89). These differ from the line-item `totalYours` / `totalAdjuster` names. |

### 5. Known Gap — Unit Fields Not Surfaced in Dashboard

`unitYours` and `unitAdjuster` are written to the `line_items` table by `persistResults()`. However, `GET /api/comparisons/[id]/route.ts` does not select these columns, and the comparison dashboard does not display unit codes (e.g. "SF", "LF", "EA"). The data is in the DB — it is purely a display gap. The `qty` field (e.g. "120.00") is shown; the unit is not. Surfacing units requires a one-line addition to the GET route `select` block and a new column in the line-item table row. Deferred to a UI polish pass.
