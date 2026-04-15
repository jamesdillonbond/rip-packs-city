# Rip Packs City

Collector intelligence platform for Flow-blockchain NFTs — FMV pricing, deal sniper, pack EV, badge tracker, and portfolio analytics for serious collectors.

Live: <https://rip-packs-city.vercel.app>

## What it is

RPC is a production-grade analytics platform competing with LiveToken. It surfaces mispriced listings, edition depth, pack expected value, and badge-weighted FMV across five Flow collections, with a Claude-powered AI concierge on every page.

## Tech stack

- **Next.js 16** (App Router) + **React 19** + **TypeScript 5**
- **Tailwind 4** for styling
- **Supabase** (Postgres + Edge Functions + RLS)
- **Vercel** hosting + edge runtime for OG images
- **Flow / @onflow/fcl** for on-chain reads and Cadence 1.0 purchase transactions

## Supported collections

| Collection        | Contract address     |
| ----------------- | -------------------- |
| NBA Top Shot      | `0x0b2a3299cc857e29` |
| NFL All Day       | `0xe4cf4bdc1751c65d` |
| LaLiga Golazos    | `0x87ca73a41bb50ad5` |
| Disney Pinnacle   | `0xedf9df96c92f4595` |
| UFC Strike        | migrated to Aptos    |

Dapper merchant: `0xc1e4f4f4c4257510` · NFTStorefrontV2: `0x4eb8a10cb9f87357`

## Pipeline architecture

cron-job.org hits `/api/pipeline-trigger?token=...` every 20 minutes and runs sequentially:

1. **Ingest** — pulls active listings from Top Shot GraphQL + Flowty
2. **Sales indexer** — scans Flow blocks for `ListingCompleted` + `MomentPurchased` events
3. **FMV recalc** — weighted-average-price model with `days_since_sale` and `sales_count_30d`
4. **FMV backfill** — fills gaps from historical sales
5. **Listing cache** — materialized snapshot for fast collection reads

## Local development

```bash
npm install
npm run dev        # http://localhost:3000
npx tsc --noEmit   # type check
```

### Required env vars

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
ANTHROPIC_API_KEY=
```

Optional: `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `INGEST_SECRET_TOKEN`, `NEXT_PUBLIC_WALLETCONNECT_ID`.

## Key routes

- `/[collection]/collection` — wallet analyzer
- `/[collection]/sniper` — real-time deals below FMV
- `/[collection]/packs` — pack drops with EV
- `/[collection]/badges` — badge editions + serial premiums
- `/[collection]/market` — edition-level intel
- `/api/fmv` — FMV lookup (GET single, POST batch)
- `/api/support-chat` — Claude Sonnet concierge
