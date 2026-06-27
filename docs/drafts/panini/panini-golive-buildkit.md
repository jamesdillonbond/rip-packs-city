# Panini — go-live build kit

Status (2026-06-27): **Plane-A data discovery COMPLETE** (see [panini-api-contract.md](panini-api-contract.md)).
This kit is everything needed to take the Panini segment live. Nothing here is wired — all drafts.

**Architecture = residential push** (not the proxy-pull the first scaffolding assumed — `/onepanini` is bot-walled
to datacenter egress and signs every request with a 15-min token, so RPC can't fetch it server-side):

```
 residential box (logged-in Panini Chrome profile)
   └─ ingest-panini-runner.mjs  (Playwright; site signs natively; intercepts /onepanini)
        └─ POST batches  ──►  /api/cron/panini-ingest  (normalize + upsert, service-role)
                                   ├─ panini_editions       (still_in_packs = unopened_pack_count, pulled, floor)
                                   ├─ panini_fmv_snapshots  (panini-1.0.0)
                                   └─ panini_pack_state     (packs_remaining, % ripped)
                                        └─ panini_squeeze_board / panini_pack_ev_board (public read views)
```

## The pieces (all in docs/drafts/panini/)
| File | Goes to | What |
|---|---|---|
| `panini-schema.sql` | apply via migration | `panini_editions` (still_in_packs stored = unopened_pack_count + for_sale_count/burned_count), `panini_fmv_snapshots`, `panini_pack_state`; §4 = optional evm bridge registration (contract `0x23ae…`) |
| `panini-read-rpcs.sql` | apply via migration | `panini_squeeze_board` + `panini_pack_ev_board` (security_invoker, anon-read) |
| `ingest-panini-runner.mjs` | `scripts/` (residential box) | Playwright runner — walks pack + edition pages, intercepts `getCardMarketStats`/`getPackMarketStats`/`getPskuTotalCardsList`, POSTs batches |
| `panini-ingest-route.ts` | `app/api/cron/panini-ingest/route.ts` | push ingest: normalize the captured feed → tables (Bearer INGEST, inert-safe) |
| `panini-methodology.md` | reference | pack rollup + `panini-1.0.0` FMV + §4 label canonicalization |
| `panini-api-contract.md` | reference | the four operations + the field→schema mapping (authoritative) |

**Supersedes:** the committed pull-model scaffolding (`lib/chains/panini/feed.ts` + `normalize.ts` +
`app/api/ingest/panini-editions` + `app/api/cron/panini-{circulation-refresh,fmv-recalc}`) was built for a proxy
pull. The push model above replaces it. Those files are inert (no cron) and harmless — retire or repoint them at
go-live; do NOT wire both.

## Two captures still needed (each one `onepanini` call, copy-paste)
1. **The grid enumeration query** — on `/marketplace/nfts.html?…sport=Soccer` for the WC2026 set, the call that
   returns the *list* of edition pskus (many cards in one response, e.g. `getMarketPlaceList`-style). Feeds the
   runner's psku list (`PANINI_PSKU_FILE`). Without it, derive pskus from the catalog, but the grid call is cleanest.
2. **The FOTL pack page / pack_id** (Hobby `1038`/50,480 confirmed) — add its URL to `PACK_URLS` in the runner.

## Go-live runbook
- **G1 — capture** the two calls above; drop the psku list into a file for the runner.
- **G2 — DB**: apply `panini-schema.sql` then `panini-read-rpcs.sql`. Verify `check_public_security_invariants()`=0,
  both views `security_invoker=on` + anon-SELECT-only, RLS on the tables.
- **G3 — residential box**: a machine with a Chrome profile logged into Panini. `npm i -D playwright`; set
  `PANINI_USER_DATA_DIR`, `RPC_PANINI_INGEST_URL`, `INGEST_SECRET_TOKEN`, `PANINI_PSKU_FILE`. Run once:
  `node scripts/ingest-panini-runner.mjs`. **Verify reconciliation:** each edition `with_collectors_count +
  unopened_pack_count (+ burned) = end_seq`; pack `unopen_pack_count/total_pack_qty` ≈ the tracker's ~54% ripped;
  `panini_editions` row count ≈ the checklist (players × parallels).
- **G4 — schedule** the runner on the box (cron/Task Scheduler, every few hours). The session needs periodic
  re-login (token/cookie expiry) — the box keeps the profile; refresh when a run returns auth errors.
- **G5 — surfaces**: build the public squeeze / pack-EV / FMV / special-serials pages on the read views, behind the
  existing feature gate; QA via `rpc-insights-qa`. Keep routes out of `isPublicPath` until G6.
- **G6 — go public**: `collections.panini_blockchain.is_active=true`, publish the registry entry, add routes to
  `isPublicPath` + sitemap + OG. Smoke + security-invariant + post-ship watch.

## Notes / honest caveats
- **The residential box is mandatory** (datacenter egress = HTTP 426; signature is per-request + 15-min). There is
  no Vercel/Supabase-only path for Plane A. This is the AllDay-Atlas / dapper.market pattern you already run.
- **Token safety:** the Panini session lives only on the residential box (in the Chrome profile). RPC code never
  holds it; the runner POSTs already-normalized public data with the RPC ingest bearer.
- **Serials / special-serials** (`getPskuTotalCardsList.nft_type` = `number 1`/`jersey mint`/`perfect mint`) are a
  v2 add — a `panini_card_serials` table + the serial-FMV layer. The runner already captures them; the route TODOs them.
- **On-chain Plane B** (bridge contract `0x23ae7a05f598fc234ee9dbef04033080dea8ab19`) stays optional/thin — wire only
  if a reason appears (`panini-schema.sql` §4 is ready).
- **Guardrail:** still a *sequenced* expansion — chain two is Candy/Solana. This kit makes Panini a fast start when
  its turn comes; it doesn't greenlight a parallel build now.
