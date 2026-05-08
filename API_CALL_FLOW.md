# ScopeSplit — AI Comparison Pipeline (5-Stage Architecture)

> **Purpose**: Detailed technical documentation of the multi-stage Claude API comparison pipeline. This is the primary reference for understanding how two Xactimate estimate PDFs are processed, compared, and paired.
>
> **Last Updated**: April 28, 2026 (N1 Inngest conversion — Phases 1–7 complete; production orchestration is now Inngest, not a fire-and-forget call)
>
> **Parent Document**: `PROJECT_CONTEXT.md`

---

## 1. High-Level Flow — 5 Stages

```
User uploads 2 PDFs (Contractor + Adjuster)
           │
           ▼
POST /api/comparisons
  → Auth check (Clerk)
  → Usage enforcement: comparisonsUsedThisPeriod + addonComparisonsThisPeriod vs plan limit
  → Period rollover check (resets usage + addon credits if past periodResetDate)
  → Upload PDFs to Supabase Storage
  → Create comparison row (status: PROCESSING)
  → Increment comparisonsUsedThisPeriod
  → await inngest.send({ name: 'comparison/process.requested', … })
  → Return 202 Accepted with comparison row
           │
           ▼
Inngest worker: processComparison (lib/inngest/functions/process-comparison.ts)
  → step.run('extract')                  — Stage A
  → step.run('reconcile-and-prematch')   — Stage B
  → step.run('pair')                     — Stage C
  → step.run('finalize-and-persist')     — Stage D
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│  STAGE 1: HAIKU VISION EXTRACTION (×2 parallel calls)       │
│  Model: claude-haiku-4-5-20251001                           │
│  Input: Raw PDF bytes (document block)                      │
│  Output: Structured JSON — every line item with costs/zones │
│  Goal: Perfect data extraction from visual PDF layout       │
├──────────────────────────────────────────────────────────────┤
│  STAGE 2: SONNET 1 — ZONE RECONCILIATION                   │
│  Model: claude-sonnet-4-6                                   │
│  Input: Zone name lists from both sides + item counts       │
│  Output: Canonical zone groups with confidence scores       │
│  Goal: Map different zone names to shared canonical names   │
├──────────────────────────────────────────────────────────────┤
│  STAGE 3: PREMATCH (DETERMINISTIC — no AI)                  │
│  Input: Parsed items with canonical zones assigned          │
│  Output: Matched pairs + unmatched remainders               │
│  Goal: Catch obvious matches via description similarity     │
├──────────────────────────────────────────────────────────────┤
│  STAGE 4: SONNET 2 — ITEM PAIRING                          │
│  Model: claude-sonnet-4-6                                   │
│  Input: Only UNMATCHED items from prematch (with zones)     │
│  Output: Compact pairs {y: lineNum, a: lineNum}             │
│  Goal: Semantic matching of remaining difficult items       │
├──────────────────────────────────────────────────────────────┤
│  STAGE 5: RESOLUTION & PERSIST                              │
│  Input: Prematch pairs + Sonnet 2 pairs + parsed field maps │
│  Output: Final RawLineItems → DB line_items table           │
│  Goal: Merge results, extract costs, classify, persist      │
└──────────────────────────────────────────────────────────────┘
           │
           ▼
GET /api/comparisons/[id]
  → Load comparison + line items
  → Group by zoneCanonical
  → Return to UI
```

---

## 2. Entry Points

### `POST /api/comparisons` (`app/api/comparisons/route.ts`)
- **Auth**: Required (Clerk `auth()`)
- **Input**: `yourEstimate` + `adjusterEstimate` (PDF files, 20MB max each)
- **Steps**:
  1. Validate auth + user exists in DB
  2. Upload both PDFs to Supabase `estimates` bucket
  3. Create `comparisons` DB row (status: `PROCESSING`)
  4. `await inngest.send({ name: 'comparison/process.requested', data: { comparisonId, trigger: 'create-route' } })`
  5. Return **`202 Accepted`** with the comparison row
- **Cleanup**: If DB create fails, uploaded files are deleted from storage. If `inngest.send` throws, the row is left in `PROCESSING` and the caller sees a 500 — we deliberately await the dispatch (not fire-and-forget) so transport failures surface.
- **N1 history**: This used to be `void runComparisonProcessing(...)` returning `201 Created`, which was unsafe on Vercel serverless (the lambda terminates on response, interrupting the pipeline). Phase 7 of the N1 Inngest conversion replaced this with the durable enqueue pattern. See `N1_INNGEST_CONVERSION.md`.

### `GET /api/comparisons/[id]` (`app/api/comparisons/[id]/route.ts`)
- **Auth**: Required + ownership check
- **Returns**: Comparison metadata + line items grouped by zone
- **Zone display**: Uses `zoneCanonical` for grouping, shows `yourName` and `adjusterName` as alt names when different

---

## 3. Processing Orchestrator

**Production**: `lib/inngest/functions/process-comparison.ts` → `processComparison` Inngest worker (the durable, multi-step orchestrator). Each of the 4 stages runs as its own `step.run()` invocation with independent retries (default 4) and a per-`comparisonId` concurrency cap.

**Legacy reference / Phase 3 baseline verifier**: `lib/comparison-processing.ts` → `runComparisonProcessing()` is retained as the in-process orchestrator used by `scripts/n1-verify-phase3-refactor.ts` to compare baseline behavior. **No production code path calls it anymore.**

### Mode Selection (identical in both orchestrators)
```
if ENABLE_REAL_COMPARISON_PROCESSING=true + ANTHROPIC_API_KEY set
  → 4-stage real pipeline (extractStage → reconcileAndPrematchStage → pairStage → finalizeAndPersistStage)

else if ENABLE_COMPARISON_PROCESSING_STUB=true (or NODE_ENV !== 'production')
  → runComparisonProcessingStub()  (fake status transitions for UI testing)

else
  → return { mode: 'disabled' }
```

### Error Handling
- **Inngest worker**: stages throw on failure; Inngest applies retry policy (4 retries, exponential backoff). After exhausting retries, a terminal `step.run('mark-failed', …)` flips the comparison row to `FAILED` with `errorMessage` set, mirroring the legacy catch-block exactly. The worker then re-throws so the run is recorded as failed in the Inngest dashboard.
- **Legacy in-process path**: any exception in `runRealProcessing()` is caught; the comparison's status is set to `FAILED` with `errorMessage` (truncated to 400 chars). The error is re-thrown for logging.

### Intermediate State
Stages communicate through the `comparison_processing_state` table (see `DATABASE_TECHNICAL_DOCS.md` and `lib/comparison-processing-state.ts`). Step outputs in Inngest stay tiny status objects (`{ stage: 'extracted' }`, etc.) — the heavy payloads (line items, pairs, prematch maps) live in Postgres.

---

## 4. Stage 1 — Haiku Vision Extraction (×2 parallel calls)

**File**: `lib/pdf-vision-extract.ts` → `extractWithVision()`

**What it does**: Sends the raw PDF bytes directly to Claude Haiku as a document block. Haiku reads the visual table layout and returns every numbered line item as structured JSON. This replaces the old pdf-parse + regex approach with visual understanding of the actual PDF.

**Model**: `claude-haiku-4-5-20251001` (configurable via `ANTHROPIC_EXTRACTION_MODEL`)

**Why Haiku**: Fast (~5-15s per PDF), cheap, and excellent at structured data extraction from tabular layouts. Does not need to understand semantics — just reads and transcribes.

### Two Parallel Calls
Both PDFs are extracted simultaneously via `Promise.all`:
```typescript
const [yourVision, adjVision] = await Promise.all([
  extractWithVision(yourPdfBytes, { comparisonId, side: 'yours' }),
  extractWithVision(adjPdfBytes, { comparisonId, side: 'adjuster' }),
]);
```

### Input
The PDF is base64-encoded and sent as a `document` content block:
```json
{
  "type": "document",
  "source": { "type": "base64", "media_type": "application/pdf", "data": "<base64>" }
}
```

### System Prompt
```
You extract structured line-item data from Xactimate insurance estimate PDFs.
You return ONLY valid JSON — no markdown fences, no explanation, no extra text.
```

### User Prompt (key rules)
- Extract every numbered line item (e.g. "1.", "2.", "247.")
- For each item return: `n` (number), `d` (description), `q` (quantity), `u` (unit), `z` (zone), `rm` (remove), `rp` (replace), `rs` (reset), `tx` (tax), `op` (O&P), `t` (total)
- **Zone rules**: Copy section header text VERBATIM — never abbreviate, rephrase, or shorten
- `total_count` must equal the highest item number in the PDF
- Cost values must be exact from the PDF — no rounding or calculating

### Output Format
```json
{
  "total_count": 101,
  "items": [
    {"n":1, "d":"30 CY dumpster - debris hauling", "q":"2.00", "u":"EA", "z":"General / Administrative", "rm":0, "rp":731.00, "rs":null, "tx":68.41, "op":142.40, "t":941.81}
  ]
}
```

### Truncation Handling
If Haiku hits `max_tokens` mid-response, the system:
1. Attempts to repair the truncated JSON (finds last complete item, closes array/object)
2. Sends a **continuation call** with the same PDF: "Continue from item #N onward"
3. Merges continuation items with the first batch
4. Detects gaps in item numbering and logs warnings

### Trace Output
Each Haiku response is logged to `pipeline-trace.txt`:
```
═══ HAIKU RAW RESPONSE — YOURS ═══
{"total_count":101,"items":[{"n":1,"d":"30 CY dumpster...

═══ HAIKU RAW RESPONSE — ADJUSTER ═══
{"total_count":117,"items":[{"n":1,"d":"Dumpster - 20 CY...
```

### What Comes Out
Each call produces a `VisionExtractionResult`:
- `lines`: `ExtractedLineRecord[]` — synthetic text lines for downstream formatting
- `parsedMap`: `Map<number, ParsedScopeFields>` — structured fields for every item
- `zoneNames`: unique zone names detected in this PDF

---

## 5. Stage 2 — Sonnet 1: Zone Reconciliation

**File**: `lib/zone-reconciliation.ts` → `reconcileZones()`

**What it does**: Takes the unique zone name lists from both Haiku extractions and reconciles them into canonical groups. This is a lightweight Claude call — small input, small output, ~2-5 seconds.

**Model**: `claude-sonnet-4-6` (uses the main `ANTHROPIC_MODEL`)

**Why a separate call**: Zone names between estimates are almost always different ("General / Administrative" vs "General", "Roof System" vs "Roofing", "Waiting Room / Reception" vs "Reception Area" + "Waiting Room"). Getting this right before pairing prevents cross-zone contamination.

### Input
Zone names with item counts from each side:
```
Estimate A (Contractor) — 11 zone names:
  1. "General / Administrative" (14 items)
  2. "Roof System" (14 items)
  3. "Exterior Envelope" (14 items)
  4. "Waiting Room / Reception" (22 items)
  5. "Exam Rooms 1-3 (Combined)" (42 items)
  ...

Estimate B (Adjuster) — 14 zone names:
  1. "General" (12 items)
  2. "Roofing" (13 items)
  3. "Exam Room 1" (15 items)
  4. "Exam Room 2" (15 items)
  5. "Exam Room 3" (15 items)
  ...
```

### System Prompt (key rules)
1. **Within-side dedup**: Detect if a short name is a simplified version of a longer name on the same side (Haiku sometimes simplifies zone headers)
2. **Cross-side matching**: Match zone names across estimates that refer to the same physical room/area
3. **Canonical name**: Always pick the longest, most specific version
4. **Numbers are sacred**: "Bedroom 1" ≠ "Bedroom 2" — never merge numbered rooms
5. **Confidence scoring**: 100 = identical, 95 = obvious variant, 90 = clear synonym, 80 = likely match, <75 = uncertain
6. **Many-to-one merges allowed**: e.g., 3 adjuster exam rooms → 1 contractor combined zone

### Output Format
```json
{
  "groups": [
    {
      "canonical": "General / Administrative",
      "yours": ["General / Administrative"],
      "adjuster": ["General"],
      "confidence": 90
    },
    {
      "canonical": "Exam Rooms 1-3 (Combined)",
      "yours": ["Exam Rooms 1-3 (Combined)"],
      "adjuster": ["Exam Room 1", "Exam Room 2", "Exam Room 3"],
      "confidence": 90
    },
    {
      "canonical": "Medical Storage / Supply Room",
      "yours": ["Medical Storage / Supply Room"],
      "adjuster": [],
      "confidence": 100
    }
  ]
}
```

### What Comes Out
A `ZoneReconciliationResult` containing:
- `groups`: canonical zone groups with per-side zone name lists
- `zoneMap`: `Map<rawZoneName, { canonical, confidence }>` — lookup for any raw zone name → canonical

### Trace Output
```
═══ SONNET 1 (ZONE RECONCILIATION) — INPUT ═══
SYSTEM PROMPT: ...
USER PROMPT: ...

═══ SONNET 1 (ZONE RECONCILIATION) — RAW RESPONSE ═══
```json
{"groups":[{"canonical":"General / Administrative","yours":["General / Administrative"],"adjuster":["General"],"confidence":90},...]}
```

---

## 6. Stage 3 — Deterministic Prematch (No AI)

**File**: `lib/deterministic-prematch.ts` → `runVisionPrematch()`

**What it does**: A fast, deterministic pass that matches line items based on description token similarity — strictly within canonical zones. No AI calls. Runs in <100ms.

**Why**: Catches the 30-60% of items that are obvious matches (same or very similar descriptions with different wording). Reduces the workload for the expensive Sonnet 2 call.

### How It Works
1. Items are grouped by their canonical zone (assigned from Stage 2)
2. Within each zone, contractor items are compared against adjuster items using **tokenized description similarity**
3. Matching uses the `descriptionToTokens()` pipeline:
   ```
   Raw description → lowercase → strip punctuation → split to tokens
     → remove stopwords → stem variants → sort → deduplicate
   ```
4. A similarity score is computed (token overlap percentage)
5. Items scoring above threshold are paired; ties broken by cost similarity

### Match Classification
- **MATCH (100% confidence)**: Same description tokens AND all 6 cost fields match AND quantities match
- **MODIFIED (83-97% confidence)**: Same description tokens but at least one cost or quantity differs

### What Gets Passed Through
- **Matched pairs** → converted to `RawLineItem[]` with canonical zones, directly to Stage 5
- **Unmatched yours** → sent to Sonnet 2
- **Unmatched adjuster** → sent to Sonnet 2

### Trace Output
```
═══ PREMATCH (DETERMINISTIC) ═══

PREMATCH STATS
  Total matched:      55
    Exact (MATCH):    23
    Modified:         32
  Yours input:        202
  Adjuster input:     202
  Yours unmatched:    147
  Adjuster unmatched: 147
  Avg confidence:     0.936

PREMATCH PAIRS (grouped by canonical zone)

  [Roof System] — 6 pairs
    MODIFIED (97%)  y18: "Ridge cap shingles" $499.59  ↔  a16: "Ridge cap - hip and ridge" $464.42
    MODIFIED (97%)  y20: "Drip edge - aluminum" $936.04  ↔  a18: "Drip edge - T-style" $895.60
    ...

PREMATCH UNMATCHED — YOURS (sent to Sonnet 2)
    y1 [General / Administrative]: "30 CY roll-off dumpster - debris"
    y2 [General / Administrative]: "Project manager / superintendent - hr"
    ...

PREMATCH UNMATCHED — ADJUSTER (sent to Sonnet 2)
    a1 [General / Administrative]: "Dumpster - 20 CY - debris haul"
    a2 [General / Administrative]: "Supervision / Project Management - per hr"
    ...
```

---

## 7. Stage 4 — Sonnet 2: Item Pairing

**File**: `lib/comparison-processing.ts` → builds prompt + calls `callAnthropicWithRetry()`

**What it does**: Receives ONLY the unmatched items from prematch (with their canonical zones pre-assigned) and pairs them semantically. This is the expensive, intelligent matching step.

**Model**: `claude-sonnet-4-6` (configurable via `ANTHROPIC_MODEL`)

**Why Sonnet**: Requires deep semantic understanding — "30 CY roll-off dumpster" ↔ "Dumpster - 20 CY - debris haul", "Project manager / superintendent" ↔ "Supervision / Project Management". Haiku can't do this reliably.

### Input Format
Each unmatched item is formatted as:
```
lineNumber|[Canonical Zone]|description|quantity unit|$totalCost
```

Example Sonnet 2 input:
```
CONTRACTOR LINES:
1|[General / Administrative]|30 CY roll-off dumpster - debris|2.00 EA|$1884.00
2|[General / Administrative]|Project manager / superintendent - hr|140.00 HR|$15456.00
11|[Exterior Envelope]|Remove damaged stucco - exterior|480.00 SF|$835.20
...

ADJUSTER LINES:
1|[General / Administrative]|Dumpster - 20 CY - debris haul|2.00 EA|$1762.34
2|[General / Administrative]|Supervision / Project Management - per hr|110.00 HR|$10303.92
13|[Exterior Envelope]|Remove storm-damaged stucco|420.00 SF|$680.40
...
```

### System Prompt (key rules)
The prompt has 7 strictly enforced sections:

1. **Task Overview**: "Your ONLY job is to PAIR matching line items between the two estimates, strictly within each zone."
2. **Domain Context**: Xactimate patterns, dual estimator structure, unmatched items are expected and correct
3. **Zone Rules — STRICTLY ENFORCED**:
   - Zones are pre-assigned and FINAL — do NOT rename, merge, split, or invent zones
   - Do NOT produce zoneMappings — zone reconciliation is already done upstream
   - ONLY match items within the SAME zone tag
   - NEVER match across zones, even if descriptions match perfectly
4. **Item Matching Rules**: Zone-strict → description similarity → cost as confirming signal → one-to-one → unmatched items are fine
5. **Common Xactimate Patterns**: Abbreviation guide (R&R, SF, LF, EA, etc.)
6. **Anti-Hallucination Rules**: No zone invention, no fabricated line numbers, raw JSON only
7. **Output Format**: Compact pairs only

### Output Format
```json
{
  "pairs": [
    {"y": 1, "a": 1},
    {"y": 2, "a": 2},
    {"y": 6, "a": null},
    {"y": null, "a": 10},
    {"y": null, "a": 11}
  ]
}
```

### Critical Design Decision: No Zone Work in Sonnet 2
Sonnet 2 receives items with zones already assigned in brackets. It is explicitly forbidden from:
- Performing any zone reconciliation
- Moving items between zones
- Creating `zoneMappings`
- Matching items across different zone tags

This eliminates zone hallucination — the #1 source of errors in the old single-call architecture.

### Token Configuration
| Setting | Default | Env Override |
|---------|---------|-------------|
| Max input tokens | 160,000 | `MAX_COMPARISON_INPUT_TOKENS_PER_REQUEST` |
| Max output tokens | 64,000 | `MAX_COMPARISON_OUTPUT_TOKENS_PER_REQUEST` |
| Temperature | 0 | — |

### Retry Logic
Up to 3 retries with exponential backoff (8s minimum between requests, 120s timeout per request).

### Trace Output
```
═══ SONNET 2 (ITEM PAIRING) — INPUT ═══
SYSTEM PROMPT: ...
CONTRACTOR LINES: ...
ADJUSTER LINES: ...

═══ SONNET 2 (ITEM PAIRING) — RAW RESPONSE ═══
{"pairs":[{"y":1,"a":1},{"y":2,"a":2},{"y":6,"a":null},...]}
```

---

## 8. Stage 5 — Resolution & Persist

**File**: `lib/comparison-processing.ts` → `resolveCompactPairsToRawItems()` + persist logic

**What it does**: Merges prematch pairs + Sonnet 2 pairs, extracts costs deterministically from the Haiku-parsed field maps (never from AI), classifies match status, and persists to database.

### Pair Resolution
For each Sonnet 2 pair:
1. Look up `ParsedScopeFields` from the Haiku-parsed maps using line numbers
2. Extract costs deterministically using `extractCosts()` — costs come from Haiku's extraction of the actual PDF values
3. Determine `matchStatus`:
   - Both sides present + `costsAllMatch() && quantitiesEqual()` → `MATCH`
   - Both sides present + any difference → `MODIFIED`
   - Only contractor side → `MISSING_FROM_ADJUSTER`
   - Only adjuster side → `ADDED_BY_ADJUSTER`
4. Compute `diffAmount` = `totalYours - totalAdjuster`
5. Assign `zoneCanonical` from the item's pre-assigned zone

### Merging Prematch + Sonnet 2
```typescript
const allRawLineItems = [...prematchRawItems, ...sonnet2RawItems];
```
Prematch items already have canonical zones assigned from Stage 2. Sonnet 2 items get their zones from the bracket tags in the input.

### Normalization
```typescript
const lineItems = normalizeLineItems(allRawLineItems);
```
- Cleans string fields, converts costs to Decimal, assigns sort order
- Validates `matchStatus` against allowed enum values

### Database Transaction
1. Delete existing line items for this comparison (idempotent re-processing)
2. Insert all new line items via `createMany`
3. Update comparison with status `COMPLETED`, aggregate totals, and match counts

### Aggregate Computation
- `yourEstimateTotal` — sum of all `totalYours`
- `adjusterEstimateTotal` — sum of all `totalAdjuster`
- `totalGap` — difference
- `matchCount`, `modifiedCount`, `missingCount`, `addedCount`

**Critical**: Costs are NEVER sourced from Sonnet 2. They are always extracted by Haiku (Stage 1) from the visual PDF layout and stored in `ParsedScopeFields` maps. Sonnet 2 only provides pairing decisions (line number pairs).

---

## 9. Complete Example — Set 13 (202 items per side)

### Stage 1: Haiku Extraction
```
Haiku Call 1 (yours):   202 items extracted, 11 zones detected
Haiku Call 2 (adjuster): 202 items extracted, 14 zones detected
```

### Stage 2: Sonnet 1 Zone Reconciliation
Contractor has 11 zones (combined exam rooms, combined restrooms). Adjuster has 14 zones (separate rooms).

Sonnet 1 output:
```
General / Administrative      ← yours: "General / Administrative", adj: "General"
Roof System                   ← yours: "Roof System", adj: "Roofing"
Exterior Envelope             ← exact match
Waiting Room / Reception      ← yours: "Waiting Room / Reception", adj: "Reception Area" + "Waiting Room"
Exam Rooms 1-3 (Combined)    ← yours: "Exam Rooms 1-3 (Combined)", adj: "Exam Room 1" + "2" + "3"
Procedure Room                ← exact match
Nurse Station / Admin Area    ← yours: "Nurse Station / Admin Area", adj: "Nurse Station"
Restrooms (Men's & Women's)  ← yours: "Restrooms (Men's & Women's)", adj: "Women's Restroom" + "Men's Restroom"
Medical Storage / Supply Room ← yours-only (no adjuster equivalent)
Break Room / Kitchenette      ← yours: "Break Room / Kitchenette", adj: "Break Room"
Building Systems / Site       ← exact match
```

### Stage 3: Prematch
```
55 matched (23 MATCH, 32 MODIFIED)
147 yours unmatched → Sonnet 2
147 adjuster unmatched → Sonnet 2
```

### Stage 4: Sonnet 2 Pairing
```
116 matched, 31 yours-only, 31 adjuster-only
Cross-zone violations: 0
```

### Stage 5: Final Totals
```
Prematch:       55 matched
Sonnet 2:      116 matched + 31 yours-only + 31 adjuster-only
Grand total:   171 matched + 31 MISSING + 31 ADDED = 233 line items
All yours:     55 + 116 + 31 = 202 ✅
All adjuster:  55 + 116 + 31 = 202 ✅
```

---

## 10. Pipeline Trace File

**File**: `scripts/pipeline-trace.txt`

**Controlled by**: `DUMP_PIPELINE_TRACE=true` in `.env.local`

The trace file is overwritten on every run (`traceReset()` at pipeline start). It captures every stage's input and raw output in order:

1. `HAIKU RAW RESPONSE — YOURS` — full JSON from Haiku
2. `HAIKU RAW RESPONSE — ADJUSTER` — full JSON from Haiku
3. `PRE-DEDUP (DISABLED)` — raw zone lists from both sides
4. `SONNET 1 (ZONE RECONCILIATION) — INPUT` — system + user prompt
5. `SONNET 1 (ZONE RECONCILIATION) — RAW RESPONSE` — JSON groups
6. `PREMATCH (DETERMINISTIC)` — stats, grouped pairs, unmatched lists
7. `SONNET 2 (ITEM PAIRING) — INPUT` — system prompt + formatted lines
8. `SONNET 2 (ITEM PAIRING) — RAW RESPONSE` — compact pairs JSON

This file is the primary artifact for auditing pipeline accuracy. It is independently parseable — no database access needed.

---

## 11. API Response Format (GET /api/comparisons/[id])

The API route groups line items by `zoneCanonical` and returns:

```json
{
  "comparison": {
    "id": "uuid",
    "status": "COMPLETED",
    "yourEstimateFilename": "Contractor_Estimate.pdf",
    "adjusterEstimateFilename": "Adjuster_Estimate.pdf",
    "yourEstimateTotal": 62660.02,
    "adjusterEstimateTotal": 45794.83,
    "totalGap": 16865.19,
    "matchCount": 36,
    "modifiedCount": 44,
    "missingCount": 17,
    "addedCount": 4
  },
  "zones": [
    {
      "id": "general-items",
      "canonicalName": "General Items",
      "yourName": "General Items",
      "adjusterName": "General",
      "confidence": null,
      "items": [
        {
          "id": "uuid",
          "status": "modified",
          "descriptionYours": "Roll-off dumpster",
          "descriptionAdjuster": "Dumpster - small job",
          "totalYours": 881.17,
          "totalAdjuster": 684.39,
          "diffAmount": 196.78,
          "zoneCanonical": "General Items"
        }
      ]
    }
  ]
}
```

**Zone sorting**: Matched zones (by gap descending) → unmatched yours → unmatched adjuster → unzoned.

---

## 12. Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ENABLE_REAL_COMPARISON_PROCESSING` | Yes | `false` | Must be `true` for real processing |
| `ENABLE_VISION_EXTRACTION` | Yes | `false` | Must be `true` for the 5-stage pipeline |
| `ANTHROPIC_API_KEY` | Yes | — | Claude API authentication |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-6` | Sonnet 1 + Sonnet 2 model |
| `ANTHROPIC_EXTRACTION_MODEL` | No | `claude-haiku-4-5-20251001` | Haiku extraction model |
| `MAX_COMPARISON_INPUT_TOKENS_PER_REQUEST` | No | `160000` | Max input tokens per Sonnet call |
| `MAX_COMPARISON_OUTPUT_TOKENS_PER_REQUEST` | No | `64000` | Max output tokens per call |
| `COMPARISON_CHUNK_TIMEOUT_MS` | No | `300000` | Timeout per API call (5 min) |
| `PROCESSING_TOTAL_TIMEOUT_MS` | No | `1200000` | Total processing timeout (20 min) |
| `DUMP_PIPELINE_TRACE` | No | `false` | Write trace file for audit |
| `ENABLE_COMPARISON_PROCESSING_STUB` | No | `false` | Enable stub mode for UI testing |

---

## 13. Key Types

### `CompactPair`
```typescript
type CompactPair = {
  y: number | null;  // Contractor line number (null = adjuster-only)
  a: number | null;  // Adjuster line number (null = contractor-only)
  zone?: string;     // Canonical zone name (only in legacy/non-vision path)
};
```

### `ParsedScopeFields` (from `deterministic-prematch.ts`)
```typescript
type ParsedScopeFields = {
  lineNumber: number;
  rawText: string;
  zone: string | null;
  description: string;
  quantity: string | null;
  unit: string | null;
  costs: ExtractedCosts;   // { remove, replace, reset, tax, op, total }
  category: string | null;
};
```

### `HaikuItem` (from `pdf-vision-extract.ts`)
```typescript
type HaikuItem = {
  n: number;       // Line number
  d: string;       // Description
  q: string | null; // Quantity
  u: string | null; // Unit
  z: string | null; // Zone name (verbatim from PDF)
  rm: number | null; // Remove cost
  rp: number | null; // Replace cost
  rs: number | null; // Reset cost
  tx: number | null; // Tax
  op: number | null; // O&P
  t: number | null;  // Total
};
```

### `ZoneReconciliationResult` (from `zone-reconciliation.ts`)
```typescript
type ZoneReconciliationResult = {
  groups: Array<{
    canonical: string;
    yours: string[];
    adjuster: string[];
    confidence: number;
  }>;
  zoneMap: Map<string, { canonical: string; confidence: number }>;
};
```

---

## 14. Match Status Classification

| Status | Condition | UI Label |
|--------|-----------|----------|
| `MATCH` | Both sides present, `costsAllMatch() && quantitiesEqual()` | "Matching" |
| `MODIFIED` | Both sides present, costs or quantity differ | "Contradicting" |
| `MISSING_FROM_ADJUSTER` | Only contractor side (y ≠ null, a = null) | "Missing" |
| `ADDED_BY_ADJUSTER` | Only adjuster side (y = null, a ≠ null) | "Adjuster Added" |

**`costsAllMatch()`** checks exact equality across all 6 cost fields: remove, replace, reset, tax, O&P, total.

**`quantitiesEqual()`** checks exact string equality of quantity fields.

A $0.01 difference or a quantity format difference (e.g., "16.00 HR" vs "16 HR") will result in `MODIFIED`.

---

## 15. Error Handling & Recovery

| Error | Handling |
|-------|----------|
| PDF download fails | Exception → comparison set to FAILED |
| Haiku extraction returns 0 items | Retry once; if still 0 → FAILED |
| Haiku response truncated | Auto-continuation call with same PDF |
| Haiku item gap detected | Logged as warning, processing continues |
| Sonnet 1 zone reconciliation fails | Non-fatal — falls back to raw zone names |
| Sonnet 2 API timeout | Up to 3 retries with backoff; then FAILED |
| Sonnet 2 returns malformed JSON | Fallback parser attempted; if that fails → FAILED |
| Total processing timeout | 1200s → FAILED |
| Line number not in parsed map | Null costs, logged as warning |

---

## 16. Cost & Performance

| Metric | Typical Value |
|--------|--------------|
| Total processing time | 20-60 seconds per comparison |
| Haiku extraction (per PDF) | 5-15 seconds |
| Sonnet 1 zone reconciliation | 2-5 seconds |
| Prematch | <100 milliseconds |
| Sonnet 2 item pairing | 10-30 seconds |
| Haiku tokens (per PDF) | ~5,000-20,000 input, ~2,000-8,000 output |
| Sonnet 1 tokens | ~200-500 input, ~200-500 output |
| Sonnet 2 tokens | ~3,000-15,000 input, ~1,000-5,000 output |
| Estimated cost per comparison | ~$0.03-0.10 (Haiku) + $0.05-0.15 (Sonnet) |
| Anthropic rate limits (Tier 2) | 450K input/min, 90K output/min |

---

## 17. Files Reference

| File | Role in Pipeline |
|------|-----------------|
| `app/api/comparisons/route.ts` | Entry point: upload + create comparison row + `await inngest.send('comparison/process.requested')` + return `202 Accepted` |
| `app/api/comparisons/[id]/route.ts` | Output: load results, group by zone, return to UI |
| `app/api/inngest/route.ts` | Inngest webhook endpoint (`serve()`); registers `processComparison`. Made public via `proxy.ts` middleware exemption |
| `lib/inngest/client.ts` | Inngest client singleton + documented `ComparisonProcessRequestedEvent` payload type |
| `lib/inngest/functions/process-comparison.ts` | **Production orchestrator** — multi-step durable Inngest worker (4 `step.run()` invocations, per-`comparisonId` concurrency cap, 4-retry policy, terminal `mark-failed` step) |
| `lib/comparison-processing.ts` | **Stage implementations** for the 4-stage pipeline: `extractStage`, `reconcileAndPrematchStage`, `pairStage`, `finalizeAndPersistStage`. Also contains the legacy `runComparisonProcessing` orchestrator retained for Phase 3 baseline verification only |
| `lib/comparison-processing-state.ts` | Intermediate-state helpers (`writeStage`, `readStage`, `hasStage`, `clearStage`) backing inter-stage communication |
| `lib/pdf-vision-extract.ts` | **Stage 1**: Haiku vision extraction from raw PDF bytes |
| `lib/zone-reconciliation.ts` | **Stage 2**: Sonnet 1 zone reconciliation call |
| `lib/deterministic-prematch.ts` | **Stage 3**: Prematch engine + shared parsing utilities |
| `lib/debug-trace.ts` | Trace file writing (`traceReset`, `traceStep`) |
| `lib/comparison-line-filter.ts` | Pre-filter (used in legacy non-vision path only) |
| `lib/comparison-processing-stub.ts` | Stub mode for UI testing |
| `lib/prisma.ts` | Database client |
| `lib/supabase.ts` | Storage client |
| `scripts/pipeline-trace.txt` | Trace output for auditing |

---

## 18. Accuracy Results (as of April 20, 2026)

| Set | Yours Items | Adj Items | Zones | Decisions | Score |
|-----|-------------|-----------|-------|-----------|-------|
| Set 1 | 95 | 95 | 5 | 106 | **100%** |
| Set 10 | — | — | 16 | 279 | **100%** |
| Set 12 | 101 | 117 | 9 | 127 | **100%** |
| Set 13 | 202 | 202 | 11 | 244 | **100%** |
| **Cumulative** | | | **41** | **756** | **100%** |

756 pipeline decisions across 4 test sets, 0 errors. Decisions = zone reconciliations + item pairs + unmatched classifications.

---

## 19. Post-Processing Editing Pipeline (Versions)

After the AI pipeline completes, the user can edit the comparison without ever mutating the canonical `line_items` table. Edits flow through a **versioning layer** (`comparison_versions` + `comparison_version_line_items`).

### Snapshot creation (lazy v1)

```
User opens completed comparison
           │
           ▼
GET /api/comparisons/[id]/versions  (frontend on mount)
           │
           ▼
POST /api/comparisons/[id]/versions  (idempotent — creates v1 if missing)
  → Loads canonical line_items
  → Inserts ComparisonVersion { versionNumber: 1, label: 'Initial', isActive: true }
  → Inserts ComparisonVersionLineItem rows mirroring line_items
```

### LLM Edit (`POST /api/comparisons/[id]/versions/apply-edits`)

**Body:** `{ prompt: string; displayItemIds?: string[] }`

```
1. Auth + ownership + comparison.status = COMPLETED
2. validatePromptSafety(prompt)
   - Length cap: 2000 chars
   - Regex blocklist: ignore-instructions, jailbreak, password/api_key/token,
     SQL injection, code-execution patterns, <script, {{template}}, etc.
   - Returns 400 with user-facing error on match
3. Load source rows: active version → fall back to canonical line_items
4. Build display order from displayItemIds (so Claude's "row N" = user's row N)
   - If <50% of IDs resolve, fall back to sequential order
5. Build compact JSON: [{ row, status, zone, yours: {...} | null, adjuster: {...} | null }]
6. Call Claude (model = claude-sonnet-4-6, temp = 0, max_tokens = 8192)
   System prompt: hardened editor role with refusal rules
7. Parse response → { edits: [{ action, row, fields }], summary }
   - Strips ```json fences if present
   - Returns 422 on parse failure
8. Apply edits to source-row clone:
   - "update": copy fields[] into row at displayOrder[row-1]; recalc diffAmount
   - "delete": mark _deleted (filtered out before persist)
   - "add": push new row with all provided fields
9. Reassign sortOrder (0..N-1)
10. Transaction:
    - Deactivate prior active version
    - Create ComparisonVersion { label: `Edit #${n-1}`, editPrompt, isActive: true }
    - createMany ComparisonVersionLineItem
11. Return { version, editsSummary, editsApplied, totalRows }
```

**Token usage:** ~1k-8k input, ~500-3k output, $0.01-0.05 per edit.

### Manual Inline Edit (`POST /api/comparisons/[id]/versions/inline-edits`)

**Body:** `{ edits: Array<{ itemId, fields: {...} }> }`

```
1. Auth + ownership + comparison.status = COMPLETED
2. Load source rows: active version → fall back to canonical line_items
3. For each source row:
   - Look up overrides by itemId, then by originalLineItemId (fallback)
   - Copy non-undefined field values; coerce numeric via toN()
   - Recompute diffAmount = totalYours - totalAdjuster
   - Recompute matchStatus via recalculateMatchStatus():
       no data both sides → keep prior status
       yours only        → MISSING_FROM_ADJUSTER
       adjuster only     → ADDED_BY_ADJUSTER
       both, equal       → MATCH
       both, differ      → MODIFIED
4. Transaction:
   - Deactivate prior active version
   - Create ComparisonVersion { label: `Manual edit — N rows`, editPrompt: null }
   - createMany ComparisonVersionLineItem
5. Return { version, editsApplied }
```

No AI call — pure deterministic field merge. Used by the per-cell draft system on the comparison page.

### Version management

| Endpoint | Behavior |
|----------|----------|
| `GET /api/comparisons/[id]/versions` | Newest-first list with `editPrompt` for AI versions |
| `GET /api/comparisons/[id]/versions/[versionId]` | Returns zones in the same shape as the main comparison GET so the UI swaps without transformation |
| `POST /api/comparisons/[id]/versions/[versionId]/activate` | Atomic active-flag swap inside `prisma.$transaction` |
| `DELETE /api/comparisons/[id]/versions/[versionId]/delete` | Refuses last remaining version; reactivates highest remaining if deleted version was active |

---

## 20. Executive Summary Generation

**Endpoint:** `POST /api/comparisons/[id]/executive-summary`
**Frontend:** `app/app/comparison/[id]/page.tsx` (modal triggered from desktop + mobile toolbar)
**Renderer:** `lib/markdown-to-html.ts`
**Model:** `claude-sonnet-4-6` (env-overridable via `SUMMARY_MODEL`)

### Flow

```
1. Auth + ownership + comparison.status = COMPLETED
2. Load line items: active version → fall back to canonical line_items
3. Load notes (content + line-item context only — no userId/email/timestamps)
4. Compute aggregates server-side:
   - yourTotal, adjusterTotal, gap, percentDifference
   - match/modified/missing/added counts
5. Compute zone summaries (per-zone item count + totals + gap + status counts)
6. Build sanitized payload:
   - sanitize(): strips <html>, {{template}}, [[brackets]]; caps at 500 chars
   - sanitizeNote(): same stripping, 4000-char cap (preserves longer user notes)
   - NO PII: no userId, email, full name, DB row IDs, timestamps
7. Wrap payload in <comparison_data>{...}</comparison_data> XML envelope
8. Call Claude with hardened system prompt:
   - Refusal rules (off-topic / instructions-in-data / system-prompt extraction)
   - Required report structure (9 sections, table-heavy)
   - Format rules (## headers, $ + 2 decimals, bold key numbers)
9. Return { markdown: string }
```

### Frontend rendering

```
markdown response
       │
       ▼
markdownToHtml(md)
  - Escape & < > to HTML entities (XSS prevention)
  - Line-by-line parse:
    * ## / ### / # → headers
    * GFM tables (preserves empty cells via leading/trailing-only trim)
    * Bold ** italic * inline-code `
    * - / * unordered lists, 1. ordered lists
    * --- horizontal rule
       │
       ▼
<div dangerouslySetInnerHTML={{ __html: html }} />  (safe — entities escaped)
```

### Print export

`handlePrintSummary` opens a new window populated with self-contained inline-styled HTML (no app CSS dependency), then calls `window.print()` after a 250 ms paint delay.

### Configuration

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Yes | — | Reused from main pipeline |
| `SUMMARY_MODEL` | No | `claude-sonnet-4-6` | Override model name for the summary route |

### Token usage

| Metric | Typical Value |
|--------|--------------|
| Input tokens | ~3,000-12,000 (depends on line-item count + notes) |
| Output tokens | ~2,000-6,000 (structured markdown report) |
| Latency | 15-30 seconds |
| Cost per summary | ~$0.05-0.20 |

### Known follow-ups

- **Rate limit / cost cap.** The endpoint is currently gated only by Clerk auth + ownership. A logged-in user can spam it. Production should add a per-minute throttle and/or count toward the per-period comparison cap. Tracked in `PRODUCTION_CUTOVER_CHECKLIST.md`.
- **Large comparisons.** For estimates with 200+ line items, the input payload approaches Claude's input window. If reports start truncating, switch to a chunked or summary-pruned payload.
