# SplitScope

Insurance scope-of-loss comparison platform. Upload a contractor estimate and an adjuster estimate as PDFs, get a side-by-side line-item match analysis powered by Claude.

---

## Repository Layout

```
Primary Repository/
├── estimatch-app/           # Next.js 15 app (App Router)
│   ├── app/                 # Routes, API handlers, pages
│   ├── lib/                 # Domain logic (n2/, n3/, comparison-processing.ts, …)
│   ├── prisma/              # Schema + migrations
│   └── __tests__/           # Vitest unit tests
├── n1-baselines/            # Frozen accuracy baselines for regression testing
├── N3.md                    # N3 pipeline specification (binding)
├── N3_BUILD_LEDGER.md       # N3 implementation ledger (ground truth of what is built)
├── PROJECT_CONTEXT.md       # Living project state document
├── DATABASE_TECHNICAL_DOCS.md
├── PRODUCTION_CUTOVER_CHECKLIST.md
├── API_CALL_FLOW.md
├── OUTSTANDING_WORK.md
├── N1_INNGEST_CONVERSION.md
├── N2_SPEED_CAPACITY_ACCURACY.md
└── N2_ALGORITHM_DASHBOARD.html
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
| `STRIPE_PORTAL_RETURN_URL` | Stripe customer portal redirect |
| `RESEND_API_KEY` | Bug report email delivery |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` | Phone verification |
| `ENABLE_REAL_COMPARISON_PROCESSING` | `true` to use real AI pipeline |

`.env` and `.env.local` are gitignored. Never commit them.

---

## Pipelines

The app has run through three generations of comparison engines:

- **N1** — Direct Claude pass on full PDF text (legacy, paused)
- **N2** — Zone-aware multi-pass with deterministic prematch (paused via `N2_PAUSED_FOR_N3 = true`)
- **N3** — Global-candidate retrieval + scored assignment ([N3.md](./N3.md), [N3_BUILD_LEDGER.md](./N3_BUILD_LEDGER.md))

N3 is the active development target. Status is tracked in `N3_BUILD_LEDGER.md`.

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
