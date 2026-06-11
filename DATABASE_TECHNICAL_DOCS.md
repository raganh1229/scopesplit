# ScopeSplit — Database Technical Documentation

> **Purpose**: Deep technical reference for the Supabase + Prisma database layer. Covers connection setup, schema design, client usage, common commands, and troubleshooting.
>
> **Last Updated**: April 28, 2026 (N1 Phase 2A added Prisma migrations directory + `comparison_processing_state` intermediate-state table)
>
> **Deployment Note**: For localhost → production key/secret/URL swaps, follow `PRODUCTION_CUTOVER_CHECKLIST.md`.

---

## 0. Need-to-Know Before You Touch Anything

- **Core hierarchy + supporting tables**: Users → Comparisons → Line Items, plus `comparison_notes`, `comparison_versions` → `comparison_version_line_items`, `comparison_processing_state` (Inngest intermediate-state), `addon_purchases`, and `subscription_cancellation_feedback`.
- **Prisma is the standard DB access layer** from app code. Import `prisma` from `lib/prisma.ts`. Raw SQL is used in tightly scoped places where generated client types may lag schema pushes (currently phone-verification upsert path).
- **Supabase client (`lib/supabase.ts`) is only for file storage** (PDF uploads). Not for database queries.
- **Clerk webhook is the auth→DB bridge.** `/api/webhooks/clerk` listens for `user.created`, `user.updated`, and `user.deleted` and keeps the `users` table in sync.
- **Schema changes — dev**: `npx prisma db push` (apply to Supabase) then `npx prisma generate` (regenerate TypeScript client).
- **Schema changes — prod / shared workflow**: as of N1 Phase 2A there is now a `prisma/migrations/` directory. The build script runs `prisma migrate deploy && next build`, so any committed migration is automatically applied on deploy. To author a new migration without poolers, use `prisma migrate diff --from-schema-datamodel … --to-schema-datamodel … --script > migrations/<name>/migration.sql` then commit. **Never use `migrate dev`** — it hangs on Supabase poolers. The first committed migration (`0_baseline`) was generated from a schema snapshot via `migrate diff`.
- **The `.env` file in the project root is a trap** — Prisma auto-generated it with a localhost URL. Our real config loads from `.env.local`. Don't edit `.env`.
- **All credentials live in two places**: `.env.local` (in the app, gitignored) and `Spec Documentation/credentials.md` (outside the repo, for reference).

---

## 1. Infrastructure Overview

### Supabase Project
- **Project Name**: `scopesplit`
- **Project Ref**: `pkoyyojellmangswrczj`
- **Region**: US East 1 (aws-1-us-east-1)
- **Dashboard**: https://supabase.com/dashboard/project/pkoyyojellmangswrczj
- **Project URL**: `https://pkoyyojellmangswrczj.supabase.co`

### Connection Details

Supabase provides three connection methods. The pooler connections are recommended for both dev and prod. The direct connection requires an IPv6-capable network and is not used in standard setup.

| Connection Type | Hostname | Port | Use Case |
|----------------|----------|------|----------|
| **Session Pooler** (IPv4) | `aws-1-us-east-1.pooler.supabase.com` | `5432` | Prisma migrations, `db push`, `prisma studio` — supports DDL |
| **Transaction Pooler** (IPv4) | `aws-1-us-east-1.pooler.supabase.com` | `6543` | Runtime app queries (high concurrency) — does NOT support DDL |
| Direct (IPv6 only) | `db.pkoyyojellmangswrczj.supabase.co` | `5432` | Requires IPv6-capable network |

**CRITICAL**: The transaction pooler (port 6543) does NOT support:
- `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`
- `CREATE TYPE` (enums)
- `prisma migrate dev` (requires shadow database)
- Any DDL operations

The **session pooler (port 5432) supports `prisma migrate deploy`** — which is what the build script uses. `migrate deploy` does not need a shadow database, only the ability to run the committed SQL migrations.

For this reason, `DATABASE_URL` in `.env.local` uses the **session pooler (port 5432)** which supports all operations.

### Connection String Format

```
postgresql://postgres.pkoyyojellmangswrczj:[PASSWORD]@aws-1-us-east-1.pooler.supabase.com:5432/postgres
```

The database password contains `!@` at the end. In the URL, the `@` must be percent-encoded as `%40`:
```
postgresql://postgres.pkoyyojellmangswrczj:Heyokayigetit1678!%40@aws-1-us-east-1.pooler.supabase.com:5432/postgres
```

The username format `postgres.pkoyyojellmangswrczj` (with dot + project ref) is required for pooler connections. Direct connections use just `postgres`.

---

## 2. Prisma Configuration

### Version
- **Prisma CLI**: 7.7.0
- **Prisma Client**: 7.7.0 (`prisma-client` generator, NOT the legacy `@prisma/client` import)

### Files

| File | Purpose |
|------|---------|
| `prisma/schema.prisma` | Schema definition (models, enums, relations) |
| `prisma.config.ts` | Runtime config — loads `.env.local`, sets datasource URL |
| `app/generated/prisma/` | Auto-generated Prisma client (created by `npx prisma generate`) |
| `lib/prisma.ts` | Singleton PrismaClient instance for the app |
| `.env.local` | Contains `DATABASE_URL` and `DIRECT_URL` |

### prisma.config.ts — How It Works

```typescript
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });  // ← MUST load .env.local, NOT .env
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
});
```

**Why `.env.local` explicitly?** Prisma init auto-generates a `.env` file with a local Prisma Postgres URL. If `dotenv/config` is used (default), it loads `.env` and connects to localhost instead of Supabase. We override this by loading `.env.local` explicitly.

### Prisma v7 Breaking Changes (vs v4-v6)

1. **`url` and `directUrl` removed from `schema.prisma`** — Connection URLs go in `prisma.config.ts` only. The `datasource` block in schema.prisma only has `provider`.
2. **`directUrl` not supported in config** — The `prisma.config.ts` `datasource` object only accepts `url` and `shadowDatabaseUrl`, NOT `directUrl`.
3. **Generator output**: `provider = "prisma-client"` (not `prisma-client-js`).
4. **Import path**: `import { PrismaClient } from '@/app/generated/prisma/client'` (not `@prisma/client`, and note the `/client` suffix — there is no index.ts in the generated folder).
5. **Driver adapter required** — `new PrismaClient()` with zero args does NOT work. You must pass an adapter: `new PrismaClient({ adapter })` using `@prisma/adapter-pg`.
6. **No `prisma migrate dev` through poolers** — The `migrate dev` command needs to create/drop a shadow database, which poolers don't allow. Use `prisma db push` instead for development.

### Environment Variables in .env.local

```bash
# Both use session pooler (port 5432) for full DDL support
DATABASE_URL="postgresql://postgres.pkoyyojellmangswrczj:Heyokayigetit1678!%40@aws-1-us-east-1.pooler.supabase.com:5432/postgres"
DIRECT_URL="postgresql://postgres.pkoyyojellmangswrczj:Heyokayigetit1678!%40@aws-1-us-east-1.pooler.supabase.com:5432/postgres"

# Supabase client keys
NEXT_PUBLIC_SUPABASE_URL=https://pkoyyojellmangswrczj.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_UnoslENjE0rpOYJg2466og_EhuETwK3
SUPABASE_SERVICE_ROLE_KEY=sb_secret_JtpdpLFZ1Nt430mgXowenA_Wa49DtwZ
```

---

## 3. Database Schema

### Hierarchy Overview

The data model centers on a three-level comparison hierarchy. A user owns comparisons, each comparison contains line items, and notes can attach either to a comparison or directly to a specific line item.

```
┌─────────────────────────────────┐
│            USERS                │  ← One row per registered account
│  clerk_id, email, plan, usage   │     (synced from Clerk via webhook)
└──────────────┬──────────────────┘
               │
               │  1 user → many comparisons
               │  FK: comparisons.user_id → users.id
               │
  ┌────────────▼────────────┐  ┌────────────────────────┐
  │      COMPARISON A       │  │      COMPARISON B       │
  │  "Smith Claim #12345"   │  │  "Jones Roof Repair"    │
  │  Your total: $285,694   │  │  Your total: $42,100    │
  │  Adjuster: $90,261      │  │  Adjuster: $38,500      │
  │  Gap: $195,433          │  │  Gap: $3,600            │
  └────────────┬────────────┘  └─────────────────────────┘
               │
               │  1 comparison → many line items
               │  FK: line_items.comparison_id → comparisons.id
               │
  ┌────────────▼──────┐  ┌──────────────────┐  ┌──────────────────┐
  │   LINE ITEM 1     │  │   LINE ITEM 2    │  │   LINE ITEM 3    │
  │  "Remove shingles" │  │  "Replace felt"  │  │  "Ice shield"    │
  │  You: $4,200       │  │  You: $3,800     │  │  You: $2,100     │
  │  Adj: $4,200       │  │  Adj: $1,900     │  │  Adj: (none)     │
  │  Status: MATCH ✅  │  │  Status: MOD ⚠️  │  │  Status: MISS 🔴 │
  └────────────────────┘  └──────────────────┘  └──────────────────┘
```

### Foreign Keys & Cascade Behavior

| Relationship | Foreign Key | On Delete |
|-------------|------------|-----------|
| User → Comparisons | `comparisons.user_id` → `users.id` | **CASCADE** — delete user = delete all their comparisons |
| Comparison → Line Items | `line_items.comparison_id` → `comparisons.id` | **CASCADE** — delete comparison = delete all its line items |
| Comparison → Comparison Notes | `comparison_notes.comparison_id` → `comparisons.id` | **CASCADE** — delete comparison = delete all its notes |
| Line Item → Comparison Notes | `comparison_notes.line_item_id` → `line_items.id` | **CASCADE** — delete line item = delete linked notes |
| Comparison → Comparison Versions | `comparison_versions.comparison_id` → `comparisons.id` | **CASCADE** — delete comparison = delete all its versions |
| Comparison Version → Version Line Items | `comparison_version_line_items.version_id` → `comparison_versions.id` | **CASCADE** — delete version = delete all its rows |

This means deleting a user automatically cleans up everything they own (comparisons, line items, notes, add-on purchases, and cancellation feedback). No orphaned data.

### What Each Table Represents

- **users** — The person. Synced from Clerk (auth identity) and updated by Stripe (payment status). Tracks subscription tier, billing dates, and how many comparisons they've used this month.
- **comparisons** — A single job where the user uploaded two PDFs. Stores the file references, metadata (insured name, claim number), and aggregate results (totals, gap, match counts). Has a processing status (processing → completed/failed).
- **line_items** — One row per matched (or unmatched) line from the Xactimate estimates. Stores both sides (yours and adjuster's) for every cost column (remove, replace, reset, tax, O&P, total). The `match_status` enum classifies each item as MATCH, MODIFIED, MISSING_FROM_ADJUSTER, ADDED_BY_ADJUSTER, or GROUPED.
- **comparison_notes** — Threaded notes authored by users. Notes can be general (comparison-wide, `line_item_id = null`) or tied to a specific line item (`line_item_id` set).
- **comparison_versions** — Immutable snapshots of a comparison. Created the first time a user opens a completed comparison ("Initial" v1, populated from canonical `line_items`), and again every time a user applies an LLM Edit or saves a batch of inline edits. Exactly one version per comparison has `is_active = true` at any time. Stores the `edit_prompt` for AI-driven versions.
- **comparison_version_line_items** — Per-version copy of line items, structurally identical to `line_items` (same cost columns, zone fields, match status, sort order). Each row has an optional `original_line_item_id` pointing back to the canonical `line_items.id` it was derived from (NULL for rows added during an edit).
- **comparison_processing_state** — Inngest worker intermediate state. One row per in-flight comparison; at most one row per `comparison_id` (unique constraint). Stores the JSON payload produced by each completed pipeline stage (`extracted` → `prematched` → `paired`) so the next stage can pick up where the previous one left off. Stage D (`finalize-and-persist`) clears the row on success. Cascade deletes with the parent `comparisons` row. Helpers in `lib/comparison-processing-state.ts` (`writeStage`, `readStage`, `hasStage`, `clearStage`). See `N1_INNGEST_CONVERSION.md` for the multi-step durability rationale.
- **addon_purchases** — Stripe add-on credit grants with idempotency via unique checkout session IDs.
- **subscription_cancellation_feedback** — Optional free-text feedback captured during cancellation flows.

---

### Detailed Table Specifications

#### `users` (mapped from Prisma model `User`)
Synced from Clerk via webhook. One row per registered user.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| clerk_id | String | No | — | Unique. Maps to Clerk user ID. |
| email | String | No | — | From Clerk |
| phone_number | String | Yes | — | E.164 verified trial phone from Twilio flow (`privateMetadata.trialPhoneNumber`) |
| full_name | String | Yes | — | From Clerk |
| company_name | String | Yes | — | User-editable in settings |
| stripe_customer_id | String | Yes | — | Set when Stripe customer created |
| subscription_tier | Enum | Yes | — | STARTER / PROFESSIONAL / ENTERPRISE |
| subscription_status | Enum | Yes | — | TRIALING / ACTIVE / CANCELED / PAST_DUE / EXPIRED |
| trial_ends_at | DateTime | Yes | — | End of 7-day trial |
| subscription_ends_at | DateTime | Yes | — | End of current billing period |
| email_opt_in | String | Yes | — | `'ENROLLED'` when opted in, `null` otherwise |
| email_opt_in_prompt_dismissed_at | DateTime | Yes | — | Set when user clicks "Never show again" |
| pending_tier_downgrade | Enum | Yes | — | Scheduled downgrade target tier |
| pending_tier_effective_at | DateTime | Yes | — | When pending downgrade takes effect |
| comparisons_used_this_period | Int | No | 0 | Reset monthly |
| addon_comparisons_this_period | Int | No | 0 | Add-on credits this period (reset on rollover) |
| llm_edits_used_this_period | Int | No | 0 | LLM Bulk Edit calls this period (reset on rollover); Phase 6f cap enforcement |
| executive_summaries_used_this_period | Int | No | 0 | Executive Summary generations this period (reset on rollover); Phase 6f cap enforcement |
| period_reset_date | DateTime | Yes | — | When to reset all per-period usage counters (comparisons + AI tools) |
| created_at | DateTime | No | `now()` | Auto-set |
| updated_at | DateTime | No | `@updatedAt` | Auto-updated by Prisma |

#### `addon_purchases` (mapped from Prisma model `AddonPurchase`)
Idempotent tracking of Stripe add-on comparison pack purchases.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| user_id | UUID | No | — | FK → users.id (CASCADE delete) |
| stripe_session_id | String | No | — | Unique. Stripe checkout session ID for idempotency |
| addon_key | String | No | — | e.g. `starter_addon_5`, `professional_addon_10` |
| comparisons_granted | Int | No | — | Number of credits granted |
| created_at | DateTime | No | `now()` | Auto-set |

#### `subscription_cancellation_feedback` (mapped from Prisma model `SubscriptionCancellationFeedback`)
Optional feedback collected when user cancels subscription.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| user_id | UUID | No | — | FK → users.id (CASCADE delete) |
| stripe_customer_id | String | Yes | — | For reference |
| stripe_subscription_id | String | Yes | — | For reference |
| subscription_tier | Enum | Yes | — | Tier at cancellation time |
| feedback_text | String | Yes | — | User-provided cancellation reason |
| scheduled_end_at | DateTime | Yes | — | When access ends |
| created_at | DateTime | No | `now()` | Auto-set |

#### `comparisons` (mapped from Prisma model `Comparison`)
One row per PDF comparison job.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| user_id | UUID | No | — | FK → users.id (CASCADE delete) |
| insured_name | String | Yes | — | Optional metadata |
| claim_number | String | Yes | — | Optional metadata |
| property_address | String | Yes | — | Optional metadata |
| your_estimate_filename | String | No | — | Original filename |
| your_estimate_storage_path | String | No | — | Supabase Storage path |
| your_estimate_total | Decimal(12,2) | Yes | — | Populated after AI processing |
| adjuster_estimate_filename | String | No | — | Original filename |
| adjuster_estimate_storage_path | String | No | — | Supabase Storage path |
| adjuster_estimate_total | Decimal(12,2) | Yes | — | Populated after AI processing |
| total_gap | Decimal(12,2) | Yes | — | Difference between totals |
| match_count | Int | No | 0 | Count of exact matches |
| modified_count | Int | No | 0 | Count of modified items |
| missing_count | Int | No | 0 | Count of items missing from adjuster |
| added_count | Int | No | 0 | Count of items added by adjuster |
| status | Enum | No | PROCESSING | PROCESSING / COMPLETED / FAILED |
| error_message | String | Yes | — | Only populated on FAILED |
| created_at | DateTime | No | `now()` | Auto-set |
| updated_at | DateTime | No | `@updatedAt` | Auto-updated |

#### `line_items` (mapped from Prisma model `LineItem`)
Individual line item comparison results within a comparison.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| comparison_id | UUID | No | — | FK → comparisons.id (CASCADE delete) |
| match_status | Enum | No | — | MATCH / MODIFIED / MISSING_FROM_ADJUSTER / ADDED_BY_ADJUSTER / GROUPED |
| zone_yours | String | Yes | — | Original zone name from contractor estimate (set by Claude zone mappings) |
| zone_adjuster | String | Yes | — | Original zone name from adjuster estimate (may differ from yours) |
| zone_canonical | String | Yes | — | Unified canonical zone name for grouping (set by Claude zone reconciliation) |
| zone_confidence | Float | Yes | — | Zone match confidence score (0-1, from Claude) |
| description_yours | String | Yes | — | Line item description |
| description_adjuster | String | Yes | — | May differ |
| qty_yours | String | Yes | — | Stored as string: "16.00 HR" |
| qty_adjuster | String | Yes | — | |
| remove_yours | Decimal(12,2) | Yes | — | Cost column |
| remove_adjuster | Decimal(12,2) | Yes | — | |
| replace_yours | Decimal(12,2) | Yes | — | Cost column |
| replace_adjuster | Decimal(12,2) | Yes | — | |
| reset_yours | Decimal(12,2) | Yes | — | Cost column |
| reset_adjuster | Decimal(12,2) | Yes | — | |
| tax_yours | Decimal(12,2) | Yes | — | Cost column |
| tax_adjuster | Decimal(12,2) | Yes | — | |
| op_yours | Decimal(12,2) | Yes | — | O&P (overhead & profit) |
| op_adjuster | Decimal(12,2) | Yes | — | |
| total_yours | Decimal(12,2) | Yes | — | Row total |
| total_adjuster | Decimal(12,2) | Yes | — | |
| diff_amount | Decimal(12,2) | Yes | — | total_yours - total_adjuster |
| category | String | Yes | — | e.g. "ROOFING", "DRYWALL" |
| sort_order | Int | No | — | Preserves PDF order |
| group_id | UUID | Yes | — | Links grouped/duplicate matches |
| created_at | DateTime | No | `now()` | Auto-set |

#### `comparison_notes` (mapped from Prisma model `ComparisonNote`)
User-authored notes on a comparison or a specific line item.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| comparison_id | UUID | No | — | FK → comparisons.id (CASCADE delete) |
| line_item_id | UUID | Yes | — | Optional FK → line_items.id (CASCADE delete) |
| user_id | UUID | No | — | FK → users.id (CASCADE delete) |
| content | String | No | — | Note body |
| created_at | DateTime | No | `now()` | Auto-set |
| updated_at | DateTime | No | `@updatedAt` | Auto-updated |

Indexes:
- `idx_comparison_notes_comparison_created` on `(comparison_id, created_at)` for chronological thread loading.

#### `comparison_versions` (mapped from Prisma model `ComparisonVersion`)
Immutable edit snapshots. The original AI pipeline output in `line_items` is **never mutated** — every edit produces a new version row whose `comparison_version_line_items` are written instead.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| comparison_id | UUID | No | — | FK → comparisons.id (CASCADE delete) |
| version_number | Int | No | — | 1-based; v1 is always the "Initial" snapshot of canonical line items |
| label | String | No | `Initial` | UI label (e.g. `Initial`, `Edit #2`, `Manual edit — 3 rows`) |
| edit_prompt | String | Yes | — | Populated only for LLM-edit versions; `NULL` for v1 and inline-edit versions |
| is_active | Boolean | No | `false` | Exactly one version per comparison should be `true` |
| created_at | DateTime | No | `now()` | Auto-set |

Constraints / Indexes:
- `uq_comparison_version_number` unique on `(comparison_id, version_number)` — prevents duplicate version numbers for the same comparison.
- `idx_comparison_version_active` on `(comparison_id, is_active)` — fast active-version lookup.

Writer rules:
- The version-edit endpoints (`apply-edits`, `inline-edits`, `activate`) always do `updateMany({ where: { comparisonId, isActive: true }, data: { isActive: false } })` followed by setting the new version active, inside a single `prisma.$transaction`.
- The `delete` endpoint refuses to delete the last remaining version and reactivates the highest remaining version if the deleted one was active.

#### `comparison_version_line_items` (mapped from Prisma model `ComparisonVersionLineItem`)
Per-version line items. Same column shape as `line_items` so frontend zone-grouping logic is shared.

| Column | Type | Nullable | Default | Notes |
|--------|------|----------|---------|-------|
| id | UUID | No | `uuid()` | Primary key |
| version_id | UUID | No | — | FK → comparison_versions.id (CASCADE delete) |
| original_line_item_id | UUID | Yes | — | Optional pointer to the canonical `line_items.id`. `NULL` for rows added during an edit. **No FK constraint** — deleting the underlying line_item won't cascade here. |
| match_status | Enum | No | — | Same `MatchStatus` enum as `line_items.match_status` |
| zone_yours / zone_adjuster / zone_canonical / zone_confidence | String / Int | Yes | — | Same shape as `line_items` |
| description_yours / description_adjuster | String | Yes | — | |
| qty_yours / qty_adjuster | String | Yes | — | |
| remove_yours / remove_adjuster / replace_yours / replace_adjuster / reset_yours / reset_adjuster / tax_yours / tax_adjuster / op_yours / op_adjuster / total_yours / total_adjuster | Decimal(12,2) | Yes | — | Cost columns (same as `line_items`) |
| diff_amount | Decimal(12,2) | Yes | — | Recomputed on every edit as `total_yours - total_adjuster` |
| category | String | Yes | — | |
| sort_order | Int | No | — | Reassigned (0..N-1) on every version write so UI ordering is stable |

Indexes:
- `idx_version_line_items_sort` on `(version_id, sort_order)` for ordered loads.

### Enums

| Enum | Values | Used By |
|------|--------|---------|
| `subscription_tier` | STARTER, PROFESSIONAL, BUSINESS | users.subscription_tier |
| `subscription_status` | TRIALING, ACTIVE, CANCELED, PAST_DUE, EXPIRED | users.subscription_status |
| `comparison_status` | PROCESSING, COMPLETED, FAILED | comparisons.status |
| `match_status` | MATCH, MODIFIED, MISSING_FROM_ADJUSTER, ADDED_BY_ADJUSTER, GROUPED | line_items.match_status |

### Relations

```
User (1) ──► (many) Comparison ──► (many) LineItem
Comparison (1) ──► (many) ComparisonNote
LineItem (0..1) ──► (many) ComparisonNote
Comparison (1) ──► (many) ComparisonVersion ──► (many) ComparisonVersionLineItem
User (1) ──► (many) ComparisonNote
User (1) ──► (many) AddonPurchase
User (1) ──► (many) SubscriptionCancellationFeedback
```

- Deleting a User cascades to delete all their Comparisons, ComparisonNotes, AddonPurchases, and CancellationFeedback
- Deleting a Comparison cascades to delete all its LineItems, ComparisonNotes, and ComparisonVersions (which in turn cascade to ComparisonVersionLineItems)
- Deleting a LineItem cascades to delete notes linked by `line_item_id` but does **not** affect `comparison_version_line_items.original_line_item_id` (no FK)

---

## 4. Client Usage

### Prisma Client (lib/prisma.ts)

```typescript
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@/app/generated/prisma/client';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL!;
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export const prisma = globalForPrisma.prisma || createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
export default prisma;
```

**Why singleton?** Next.js hot-reloads in development, which would create a new PrismaClient on every reload, exhausting database connections. The singleton pattern stores the client on `globalThis` so it persists across reloads.

**Why the adapter?** Prisma v7 removed the built-in PostgreSQL driver. You must install `@prisma/adapter-pg` and pass it to the constructor. Without it, `new PrismaClient()` throws "Expected 1 arguments, but got 0".

**Usage in API routes / server components:**
```typescript
import prisma from '@/lib/prisma';

// Create a user
const user = await prisma.user.create({
  data: { clerkId: 'user_xxx', email: 'test@example.com' }
});

// Find user by Clerk ID
const user = await prisma.user.findUnique({ where: { clerkId: 'user_xxx' } });

// Create a comparison with line items
const comparison = await prisma.comparison.create({
  data: {
    userId: user.id,
    yourEstimateFilename: 'estimate.pdf',
    yourEstimateStoragePath: 'estimates/user_xxx/est1.pdf',
    adjusterEstimateFilename: 'adjuster.pdf',
    adjusterEstimateStoragePath: 'estimates/user_xxx/adj1.pdf',
    lineItems: {
      create: [
        { matchStatus: 'MATCH', descriptionYours: 'Remove shingles', sortOrder: 1 },
        { matchStatus: 'MODIFIED', descriptionYours: 'Replace underlayment', sortOrder: 2 },
      ]
    }
  },
  include: { lineItems: true }
});

// Get all comparisons for a user
const comparisons = await prisma.comparison.findMany({
  where: { userId: user.id },
  orderBy: { createdAt: 'desc' }
});

// Get comparison with all line items
const full = await prisma.comparison.findUnique({
  where: { id: comparisonId },
  include: { lineItems: { orderBy: { sortOrder: 'asc' } } }
});

// Update subscription status
await prisma.user.update({
  where: { clerkId: 'user_xxx' },
  data: {
    subscriptionTier: 'STARTER',
    subscriptionStatus: 'ACTIVE',
    stripeCustomerId: 'cus_xxx'
  }
});

// Increment comparison usage
await prisma.user.update({
  where: { id: userId },
  data: { comparisonsUsedThisPeriod: { increment: 1 } }
});

// Delete a comparison (cascades to line_items)
await prisma.comparison.delete({ where: { id: comparisonId } });
```

### Supabase Client (lib/supabase.ts)

```typescript
import { createClient } from '@supabase/supabase-js';

// Client-side (respects RLS policies)
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Server-side (bypasses RLS — use only in API routes)
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
```

**When to use which:**
- `supabase` (anon key) — Client components, browser-side file uploads. Respects Row Level Security.
- `supabaseAdmin` (service key) — API routes, webhooks, server actions. Bypasses RLS. **Never expose to client.**

**Primary use case**: Supabase Storage for PDF uploads. Database queries go through Prisma, not the Supabase client.

---

## 5. Commands Reference

All commands run from the `scopesplit-app/` directory (folder is still named `estimatch-app` on disk but package.json says `scopesplit-app`). PowerShell requires the execution policy bypass prefix on this machine.

```bash
# Push schema changes to Supabase (use instead of migrate dev)
powershell -ExecutionPolicy Bypass -Command "npx prisma db push"

# Regenerate Prisma client after schema changes
powershell -ExecutionPolicy Bypass -Command "npx prisma generate"

# Open visual database browser (GUI)
powershell -ExecutionPolicy Bypass -Command "npx prisma studio"

# Format schema file
powershell -ExecutionPolicy Bypass -Command "npx prisma format"

# Pull schema from existing database (introspect)
powershell -ExecutionPolicy Bypass -Command "npx prisma db pull"
```

### Schema Change Workflow
1. Edit `prisma/schema.prisma`
2. Run `npx prisma db push` to apply changes to Supabase
3. Run `npx prisma generate` to regenerate the TypeScript client
4. Restart the dev server (if running)

### Clerk Webhook Setup

Route implemented at `app/api/webhooks/clerk/route.ts`.

- Handles `user.created` and `user.updated` via Prisma `upsert` when user sync is enabled for unverified users.
- Handles `user.deleted` via Prisma `deleteMany` by `clerk_id`.
- Uses Clerk signature verification (`verifyWebhook`) and returns `400` on invalid signatures.

Deferred sync mode (implemented):

- Env flag `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED` controls whether webhook creates rows before phone verification.
- Default behavior is strict: webhook defers user row creation until `public_metadata.phoneVerifiedForTrial === true`.
- Set `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED=false` to restore immediate webhook-based row creation.

Required configuration:

1. Add `CLERK_WEBHOOK_SIGNING_SECRET` to `estimatch-app/.env.local`.
2. In Clerk Dashboard → Webhooks, create endpoint:
   - URL (local): `https://<your-ngrok-or-tunnel>/api/webhooks/clerk`
   - Events: `user.created`, `user.updated`, `user.deleted`
3. Ensure `proxy.ts` includes `/api/webhooks/clerk(.*)` in public routes (already configured).

Production webhook URL (no ngrok):
- `https://<your-production-domain>/api/webhooks/clerk`

### Twilio SMS Phone Verification + Duplicate Phone Guard (Implemented)

Routes implemented:

- `POST /api/verification/phone/start`
  - Auth-required (`auth()`)
  - Validates country code + phone number
  - Normalizes destination to E.164 (`+<country><digits>`)
  - Checks `users.phone_number` for duplicates before sending OTP
  - Returns `409` when phone is already associated with another account
  - Calls Twilio Verify `Verifications` endpoint (SMS channel)
- `POST /api/verification/phone/confirm`
  - Auth-required
  - Validates OTP against Twilio Verify `VerificationCheck`
  - Re-checks duplicate `users.phone_number` before write (race-safety)
  - Updates Clerk metadata:
    - `publicMetadata.phoneVerifiedForTrial = true`
    - `privateMetadata.trialPhoneNumber = +E164`
    - `privateMetadata.phoneVerifiedAt = ISO timestamp`
  - Upserts Supabase `users` row (id/clerk_id/email/full_name/phone_number)

Required Twilio env vars:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_VERIFY_SERVICE_SID`

Related trial-abuse env vars:

- `TRIAL_IP_HASH_SALT`
- `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED`

### Unverified Clerk Account Cleanup Route (Implemented)

Route: `POST /api/internal/cleanup-unverified-users`

Behavior:

- Requires secret header: `x-cleanup-secret`
- Also accepts `Authorization: Bearer <CRON_SECRET>` for scheduler invocations
- Supports both `POST` and `GET` for scheduler compatibility
- Controlled by env toggle: `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED=true`
- Scans Clerk users and deletes users older than `UNVERIFIED_ACCOUNT_MAX_AGE_HOURS` (default 24) when `privateMetadata.trialPhoneNumber` is missing
- Deletes matching Supabase `users` row by `clerk_id`
- Intended for scheduler-triggered execution (daily)

Scheduler wiring currently present:

- `estimatch-app/vercel.json` includes daily cron (`0 4 * * *`) for `/api/internal/cleanup-unverified-users`

Required cleanup env vars:

- `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED`
- `UNVERIFIED_ACCOUNT_CLEANUP_SECRET`
- `CRON_SECRET` (required for Vercel Cron auth)
- `UNVERIFIED_ACCOUNT_MAX_AGE_HOURS`
- `UNVERIFIED_ACCOUNT_CLEANUP_BATCH_SIZE` (optional)

### Stripe Billing Setup (Implemented — Local Verified)

Routes implemented:

- `POST /api/stripe/checkout`
  - Auth-required (`auth()`)
  - Looks up synced `users` row by `clerk_id`
  - Creates Stripe Checkout session for:
    - recurring subscriptions (`kind: "subscription"`, plans starter/professional/business)
    - one-time add-ons (`kind: "addon"`)
  - Creates/links Stripe customer (`users.stripe_customer_id`) when missing
  - Applies 7-day trial for eligible users when `trial: true`
  - Current temporary testing behavior: trial eligibility enforces Clerk phone verification only
  - Stripe trial reuse checks/writes via customer metadata (`trial_phone_number`, `trial_ip_hash`) are currently disabled and must be restored before production
- `POST /api/webhooks/stripe`
  - Public route (allowed in `proxy.ts`)
  - Verifies `stripe-signature` with `STRIPE_WEBHOOK_SECRET`
  - Handles:
    - `checkout.session.completed`
    - `customer.subscription.created`
    - `customer.subscription.updated`
    - `customer.subscription.deleted`
    - `invoice.payment_failed`
  - Syncs DB `users` billing fields (`stripe_customer_id`, `subscription_tier`, `subscription_status`, `trial_ends_at`, `subscription_ends_at`)
  - Syncs Clerk `publicMetadata.plan` for paywall middleware

Related files:

- `lib/stripe.ts` — canonical plan limits (`PLAN_COMPARISON_LIMITS`, `PLAN_LLM_EDIT_LIMITS`, `PLAN_EXECUTIVE_SUMMARY_LIMITS`, `ADDON_COMPARISON_GRANTS`)
- `lib/usage.ts` — AI-tool usage gate helpers used by `apply-edits` and `executive-summary` routes
- `app/api/stripe/checkout/route.ts`
- `app/api/stripe/change-plan/route.ts`
- `app/api/stripe/cancel/route.ts`
- `app/api/stripe/resume/route.ts`
- `app/api/stripe/cancel-downgrade/route.ts`
- `app/api/stripe/finalize-checkout/route.ts`
- `app/api/webhooks/stripe/route.ts`
- `app/(auth)/subscribe/page.tsx` (initial checkout trigger)
- `app/app/settings/page.tsx` (in-app Manage Subscription tier-selector modal trigger; calls `/api/stripe/change-plan`)
- `proxy.ts` (public route: `/api/webhooks/stripe(.*)`)

Required env vars for Stripe routes:

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_CHECKOUT_SUCCESS_PATH` (optional path override; origin is now derived from the request, see Phase 6h / N4)
- `STRIPE_CHECKOUT_CANCEL_PATH` (optional path override; origin is now derived from the request, see Phase 6h / N4)
- `STRIPE_PRICE_STARTER_MONTHLY`
- `STRIPE_PRICE_PROFESSIONAL_MONTHLY`
- `STRIPE_PRICE_BUSINESS_MONTHLY`
- `STRIPE_PRICE_STARTER_ADDON_5`
- `STRIPE_PRICE_PROFESSIONAL_ADDON_10`
- `STRIPE_PRICE_BUSINESS_ADDON_10`

Local development requirement:

- Stripe cannot call `localhost` directly.
- Keep a Stripe listener running in a separate terminal during local checkout tests:
  - `stripe listen --forward-to localhost:3000/api/webhooks/stripe`
- Update `.env.local` with the listener's current `whsec_...` value and restart dev server whenever the listener secret changes.

### Resend Bug Report Email Route (Implemented)

Route implemented at `app/api/bug-report/route.ts`.

Current behavior:

- `POST /api/bug-report` (multipart form-data)
- Requires authenticated Clerk user (`auth()`), returns `401` when not signed in
- Requires `RESEND_API_KEY`, returns `500` when missing
- Required form fields:
  - `name`
  - `email`
  - `message`
- Optional attachments under `images` key with strict validation:
  - max 3 images
  - max 5MB each
  - allowed MIME types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`
- Escapes HTML in user-provided fields before composing email body
- Sends via Resend REST API (`https://api.resend.com/emails`) using:
  - from: `ScopeSplit Bug Reports <bugs@scopesplit.com>`
  - reply-to: submitting user email
  - subject: `[Bug Report] from <name>`
  - attachments: base64 content when provided

Current recipient configuration:

- Route currently sends to a fixed recipient constant in code (`BUG_REPORT_TO`).
- Recommended production follow-up: move destination recipient to environment variable for easier operations/rotation.

Production readiness checks for this route:

1. Verify Resend sender/domain is fully verified for `bugs@scopesplit.com`.
2. Set `RESEND_API_KEY` in production env.
3. Confirm recipient inbox is correct and monitored.
4. Run 2 smoke tests post-deploy:
   - one without screenshots
   - one with 1-3 screenshots at valid types/sizes
5. Confirm non-happy-path behavior:
   - unauthenticated request returns `401`
   - invalid file type/oversize returns `400`
   - upstream Resend failures return `502`

### PDF Upload Storage Setup

Legacy route at `app/api/uploads/estimates/route.ts` is now deprecated.

Primary comparison creation route implemented at `app/api/comparisons/route.ts`.

- Accepts multipart form data with:
  - `yourEstimate` (PDF)
  - `adjusterEstimate` (PDF)
- Requires authenticated Clerk session and synced DB user row.
- Validates each file:
  - PDF MIME type only
  - max 20MB per file
- Uploads to Supabase Storage bucket `estimates` using service-role credentials.
- Creates a `comparisons` row after successful uploads with:
  - `user_id`
  - estimate filenames
  - estimate storage paths
  - `status = PROCESSING` (default)
- Includes storage cleanup on failure (removes uploaded files when DB create fails).
- File path format:
  - `<clerk_id>/<timestamp>-<uuid>-<sanitized_filename>.pdf`

`/api/comparisons` current handlers:

- `POST /api/comparisons`
  - uploads both PDFs to Storage
  - creates `comparisons` record in Postgres via Prisma
  - returns created `comparison.id`
- `GET /api/comparisons`
  - returns current user's recent comparisons (latest first)

Development processing stub:

- Comparison creation now optionally triggers `lib/comparison-processing-stub.ts` in non-production environments.
- Default behavior:
  - `NODE_ENV !== production` and `ENABLE_COMPARISON_PROCESSING_STUB` unset → stub runs.
  - `ENABLE_COMPARISON_PROCESSING_STUB=false` → stub disabled.
  - `ENABLE_COMPARISON_PROCESSING_STUB=true` → stub enabled (including production if explicitly set).
- Stub behavior:
  - waits briefly, then marks comparison `COMPLETED` by default
  - if line items exist, recalculates counts/totals/gap from persisted rows
  - keeps this logic isolated from the eventual real extraction pipeline

Processing orchestrator:

- `lib/comparison-processing.ts` now controls processing execution for both:
  - create-route trigger (`POST /api/comparisons`)
  - manual trigger (`POST /api/comparisons/:id/process`)
- Real processing mode is opt-in and guarded by env vars:
  - `ENABLE_REAL_COMPARISON_PROCESSING=true`
  - `ANTHROPIC_API_KEY=<your_key>`
  - optional: `ANTHROPIC_MODEL=<model_name>` (default: `claude-sonnet-4-6`)
  - optional: `MAX_COMPARISON_INPUT_TOKENS_PER_REQUEST=<int>` (default: `24000`)
  - optional: `COMPARISON_PROCESSING_MAX_RETRIES=<int>` (default: `3`)
- Real processing flow:
  - download both PDFs from Supabase Storage
  - extract raw text server-side from both PDFs (`pdf-parse`)
  - preserve line order with line-numbered records per estimate
  - pre-filter lines (drop headers, totals, summaries, boilerplate)
  - **deterministic prematch** (`lib/deterministic-prematch.ts`): resolve high-confidence matches without AI (~33% of lines); persist as `line_items`
  - parse all scope lines into `ParsedScopeFields` maps (descriptions, costs, zones, quantities) for server-side cost resolution
  - split **remaining unmatched lines** into deterministic chunks sized to token budget
  - **compact AI prompt**: send only `lineNumber|description|qty unit` (no cost columns) to Anthropic; Claude returns pair mappings `{pairs:[{y,a}]}`
  - **server-side pair resolution**: look up parsed fields by line number, extract costs deterministically, classify MATCH vs MODIFIED via `costsAllMatch()`; legacy `{lineItems:[...]}` format is supported as fallback
  - retry/back off on `429 rate_limit_error` responses; chunk subdivision on JSON parse failures
  - merge prematch items + AI-resolved items, normalize, replace persisted `line_items` for the comparison
  - recompute comparison aggregates (`totals`, `gap`, status counts)
  - mark comparison `COMPLETED`
  - optional: `COMPARISON_PROCESSING_PREMATCH=false` to disable prematch (default: enabled)
- Failure behavior:
  - processing exceptions are captured and comparison is marked `FAILED`
  - `error_message` stores the truncated root error text for UI/debug visibility

- Fallback behavior when real processing is not enabled:
  - continue using the processing stub path (existing non-production default)
- Manual trigger route for testing:
  - `POST /api/comparisons/:id/process`
  - requires auth + ownership (same as detail route)
  - optional JSON body: `{ "mode": "success" | "failed" }`
  - defaults to `success` when no body is sent
  - route now uses the shared processing orchestrator (real mode when enabled, otherwise stub)

Detail-read route implemented at `app/api/comparisons/[id]/route.ts`:

- `GET /api/comparisons/:id`
  - requires authenticated Clerk session
  - enforces ownership (only returns records owned by requesting user)
  - returns comparison metadata + grouped zone/item payload for detail UI
  - maps persisted `line_items.match_status` values into UI-safe status strings
  - preserves row ordering via `line_items.sort_order`

Required dashboard setup:

1. In Supabase → Storage, create bucket `estimates`.
2. Keep bucket private (recommended).
3. Do not expose service role key client-side.

Current scope: upload + comparison record creation + comparison read/list/detail APIs are wired. AI extraction/matching + line item persistence are next.
- `POST /api/uploads/estimates` now returns `410` and should not be used.
- `/app/comparison/[id]` is now API-backed, with loading/error/processing/failed state banners and a mock-data fallback only when the API request fails.
- Development-only processing transitions are now available via the comparison processing stub; production extraction is still pending.

### Validation Status (Completed)

The following were tested successfully in local development:

- DB connectivity (`npx prisma generate`, `npx prisma db push`, and runtime queries)
- Webhook event sync:
  - `user.created` / `user.updated` behavior follows `DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED`
    - strict mode (`true`, default): defer row creation until phone verification
    - legacy mode (`false`): insert/update `users` row immediately
  - `user.deleted` → removes `users` row
- Signature validation:
  - Valid signed Clerk deliveries return `200`
  - Unsigned/fake request returns `400`
  - Wrong `CLERK_WEBHOOK_SIGNING_SECRET` causes delivery failures as expected
- Cascade integrity:
  - Deleting a user cascades to `comparisons` and `line_items` (verified by SQL test)

### Why `db push` Instead of `migrate dev`
`prisma migrate dev` creates a shadow database to detect drift. This requires DDL permissions that Supabase's **transaction pooler** doesn't support, and the **session pooler** sometimes hangs on shadow database creation. `db push` applies the schema directly without a shadow database. For production, use `prisma migrate deploy` with a direct connection.

---

## 6. Troubleshooting

### "Can't reach database server"
- **Cause**: DNS resolution failure or wrong hostname
- **Fix**: Use pooler hostname (`aws-1-us-east-1.pooler.supabase.com`), not direct (`db.xxx.supabase.co`)
- **Verify**: `Test-NetConnection aws-1-us-east-1.pooler.supabase.com -Port 5432`

### `/api/test-db` redirects to login
- **Cause**: Route is protected by Clerk middleware (not in public route list)
- **Fix**: Sign in first, or temporarily mark `/api/test-db(.*)` as public for diagnostics

### "P1001: Can't reach database" with correct hostname
- **Cause**: Using transaction pooler (port 6543) for DDL operations
- **Fix**: Switch to session pooler (port 5432) in DATABASE_URL

### Prisma reads wrong DATABASE_URL (connects to localhost)
- **Cause**: `prisma.config.ts` loading `.env` instead of `.env.local`
- **Fix**: Ensure config uses `dotenv.config({ path: ".env.local" })`, NOT `import "dotenv/config"`

### "Cannot find module '@/app/generated/prisma'"
- **Cause**: Prisma client not generated yet, or IDE hasn't re-indexed
- **Fix**: Run `npx prisma generate`, then restart IDE TypeScript server

### migrate dev hangs indefinitely
- **Cause**: Shadow database creation blocked by pooler
- **Fix**: Use `npx prisma db push` for development instead

### Password encoding issues
- **Cause**: Database password `Heyokayigetit1678!@` contains `@` which is a URL delimiter
- **Fix**: Encode `@` as `%40` in the connection string: `Heyokayigetit1678!%40`

### Stripe checkout error: "No such price: 'price_...'"
- **Cause**: `STRIPE_SECRET_KEY` account/mode does not match `STRIPE_PRICE_*` IDs.
- **Fix**: List prices using the same secret key and copy IDs from that exact account/mode:
  - `stripe --api-key <sk_...> prices list --limit 100`
  - Replace all `STRIPE_PRICE_*` vars together, then restart dev server.

### Checkout succeeds but app redirects back to `/subscribe`
- **Cause**: Stripe webhook did not update Clerk `publicMetadata.plan` (listener not running, wrong `STRIPE_WEBHOOK_SECRET`, or webhook delivery failure).
- **Fix**:
  - verify `POST /api/webhooks/stripe 200` in app logs
  - verify Stripe listener is forwarding to `/api/webhooks/stripe`
  - ensure `STRIPE_WEBHOOK_SECRET` matches current listener output
  - refresh app after webhook processing

### Verify-phone confirm raw SQL error: `23502 null value in column "id"` or `"updated_at"`
- **Cause**: direct insert into `users` in phone-confirm path without required NOT NULL fields.
- **Fix**: route now supplies `id` (UUID) and timestamps (`created_at`, `updated_at`) on insert, plus conflict update logic.

### Cleanup route returns `{ skipped: true, reason: "cleanup_disabled" }`
- **Cause**: `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED` is missing or not `true`.
- **Fix**: set `UNVERIFIED_ACCOUNT_CLEANUP_ENABLED=true`, restart app, retry with `x-cleanup-secret` header.

### Cleanup route scans users but deletes `0`
- **Cause**: users are newer than `UNVERIFIED_ACCOUNT_MAX_AGE_HOURS`, or they already have `privateMetadata.trialPhoneNumber`.
- **Fix**: lower age threshold for testing (e.g., `UNVERIFIED_ACCOUNT_MAX_AGE_HOURS=1`) and retry.

### Stripe webhook Prisma error: invalid `Date` for `subscriptionEndsAt`
- **Cause**: Missing/invalid subscription period timestamp from event payload shape.
- **Fix**: Webhook now safely parses timestamp candidates and writes `null` instead of invalid `Date`.
- **Note**: This fix is in `app/api/webhooks/stripe/route.ts` (`fromUnixSeconds` + `readUnixSecondsCandidate`).

---

## 7. What's Not Yet Wired

| Component | Status | What's Needed |
|-----------|--------|---------------|
| Clerk → users table | ✅ | Implemented at `/api/webhooks/clerk` (create/update/delete), with strict defer mode support until phone verification (`DEFER_USER_SYNC_UNTIL_PHONE_VERIFIED`). |
| Twilio phone verification → users.phone_number | ✅ | `/api/verification/phone/start` + `/api/verification/phone/confirm` implemented with duplicate-phone guard and metadata + DB persistence. |
| Unverified account cleanup scheduling | ⚠️ route implemented, scheduler required | `POST /api/internal/cleanup-unverified-users` exists; production must configure daily scheduler trigger. |
| Supabase Storage bucket + upload route | ✅ | Bucket-backed uploads implemented (used by `/api/comparisons`); keep `estimates` bucket configured in Supabase |
| Comparison detail read API | ✅ | `/api/comparisons/:id` implemented with auth + ownership checks; returns grouped line items for detail page |
| Row Level Security (RLS) | ❌ | RLS policies on all tables (users see only their own data) |
| Stripe → users table | ✅ (local validated) | Checkout + webhook + in-app subscription management (change-plan/cancel/resume/cancel-downgrade) wired; production cutover still required (live keys, live prices, production webhook endpoints) |
| Comparison creation API | ✅ | `/api/comparisons` POST uploads files + creates comparison row; GET lists user comparisons |
| Usage limit enforcement | ✅ | `POST /api/comparisons` enforces `comparisonsUsedThisPeriod` + `addonComparisonsThisPeriod` vs plan limit; period rollover resets both |
| AI tool usage caps (Phase 6f) | ✅ | `POST /api/comparisons/[id]/versions/apply-edits` and `POST /api/comparisons/[id]/executive-summary` enforce per-tier caps via `lib/usage.ts` (`assertWithinLimit`, `tryIncrementUsage`); period rollover resets `llmEditsUsedThisPeriod` and `executiveSummariesUsedThisPeriod` alongside comparisons |
| Add-on credit system | ✅ | `addon_purchases` table + `addon_comparisons_this_period` field; credits granted on paid Stripe webhook; idempotent. **AI tools have no add-on extension path — flat per-tier caps only** |
| Email opt-in | ✅ | `GET/POST /api/user/email-opt-in`; `email_opt_in` + `email_opt_in_prompt_dismissed_at` columns; `EmailOptInToast` component |
| Billing summary | ✅ | `GET /api/billing/summary` aggregates plan, usage, limits, downgrade status, add-on info |
| Subscription management | ✅ | change-plan, cancel, resume, cancel-downgrade, finalize-checkout routes |

---

## 8. Security Notes

1. **Service role key** (`SUPABASE_SERVICE_ROLE_KEY`) bypasses all RLS. Only use server-side.
2. **Anon key** (`NEXT_PUBLIC_SUPABASE_ANON_KEY`) is safe to expose client-side but requires RLS policies.
3. **Database password** is in `.env.local` (gitignored) and `credentials.md` (outside repo).
4. **Connection string** contains the password — never log it or expose in client code.
5. **Prisma client** runs server-side only. Never import `lib/prisma.ts` in client components.
6. **Cascade deletes** are configured: deleting a user deletes all their comparisons and line items.
