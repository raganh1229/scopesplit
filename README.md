# ScopeSplit

Insurance scope-of-loss comparison SaaS. Upload a contractor estimate and an adjuster estimate (Xactimate PDF, Symbility PDF, or Excel/CSV), get a side-by-side line-item match analysis powered by Claude. **Live at https://scopesplit.com**

---

## Repository Layout

```
scopesplit/
├── estimatch-app/           # Next.js 16.2.3 app (App Router, Turbopack)
│   ├── app/                 # Routes, API handlers, pages
│   ├── lib/                 # Domain logic (n3/, n4/, comparison-processing.ts, …)
│   ├── prisma/              # Schema + migrations
│   └── __tests__/           # Vitest unit tests
├── n1-baselines/            # Frozen accuracy baselines for regression testing
├── N3.md                    # N3 pipeline specification (reference)
├── N3_BUILD_LEDGER.md       # N3 implementation ledger
├── N4-multi-format-pipeline.md  # N4 pipeline spec (COMPLETE)
├── N5.md                    # N5 feedback-aware re-extraction (planned)
├── PROJECT_CONTEXT.md       # Living project state document
├── DATABASE_TECHNICAL_DOCS.md
├── PRODUCTION_CUTOVER_CHECKLIST.md
├── OUTSTANDING_WORK.md
└── TESTING_PLAN.md
```

The Next.js app lives in `estimatch-app/`. All `npm` commands run from inside that folder.

---

## Quick Start (Development)

```bash
cd estimatch-app
npm install
npm run dev
```

In a second terminal (for background job processing):

```bash
cd estimatch-app
npx inngest-cli@latest dev -u http://127.0.0.1:3000/api/inngest
```

App at `http://localhost:3000`, Inngest dashboard at `http://localhost:8288`.

---

## Required Environment Variables

Create `estimatch-app/.env.local` with:

| Variable | Purpose |
|----------|---------|
| `DATABASE_URL` | Supabase Postgres pooled connection string |
| `DIRECT_URL` | Supabase Postgres direct connection (for migrations) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk auth public key |
| `CLERK_SECRET_KEY` | Clerk auth server key |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role (server-only) |
| `ANTHROPIC_API_KEY` | Claude Sonnet API access |
| `VOYAGE_API_KEY` | Voyage AI embeddings (Phase 11) |
| `STRIPE_SECRET_KEY` | Stripe billing |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature verification |
| `RESEND_API_KEY` | Bug report email delivery |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` | Phone verification |
| `ENABLE_REAL_COMPARISON_PROCESSING` | `true` to use real AI pipeline |

`.env` and `.env.local` are gitignored. Never commit them.

---

## Pipelines

The app has run through four generations of comparison engines:

- **N1** — Direct Claude pass on full PDF text (retired — archived to `DELETED CHANGES/`)
- **N2** — Zone-aware multi-pass with deterministic prematch (retired — archived to `DELETED CHANGES/`; utility code in `lib/n2/` still imported by N3/N4)
- **N3** — Global-candidate retrieval + scored assignment ([N3.md](./N3.md), [N3_BUILD_LEDGER.md](./N3_BUILD_LEDGER.md)) — active, Xactimate-only
- **N4** — Multi-format pipeline extending N3 with Symbility, CSV, and cross-format support ([N4-multi-format-pipeline.md](./estimatch-app/N4-multi-format-pipeline.md)) — **active production pipeline** (complete Jun 3, 2026)

N3 and N4 run in production. `N3_ENABLED=true` in env routes through N4 (which wraps N3). Status tracked in `N3_BUILD_LEDGER.md` and `N4-multi-format-pipeline.md`.

---

## Testing

```bash
cd estimatch-app
npx vitest run        # Unit tests (Vitest)
npx eslint .          # Linting
```

---

## Production Cutover

See `PRODUCTION_CUTOVER_CHECKLIST.md` for the launch checklist covering Clerk, Stripe, Supabase, Anthropic, Voyage AI, Resend, and Twilio production readiness.
