# Handoff — overnight pass, 2026-09-05 (Cowork, cloud, autonomous)

**Window:** 2026-09-05 ~03:58 → ~04:35 PT (10:58 → 11:35Z). Clock read from the DB throughout.
**Head at start:** `2c8a70c` · **Head at end:** see the ledger; 6 commits pushed, all green or in-progress with **0 CI failures introduced**.

> ⚠ **Scope note on environment.** This pass ran in a **cloud** Cowork session and pushed normally
> via the device bridge (patch → `git am` → push with the mount PAT). Nothing here is blocked on an
> environment limitation. **Trevor's machine and Claude Code push normally as usual.**

---

## The one thing to read if you read nothing else

**The `pg_net_http_403` CRITICAL is gone, and it should never have cost three nights.**
The ledger shows 2026-09-03 and 2026-09-04 *each* opened with a session investigating that alert and
concluding "benign". Tonight it was attributed rather than re-investigated: every 4xx in the window
is a Cloudflare bot-challenge against the **Atlas editions walk**, and that walk records its own
`request_id`s, so the alert can now say so itself. **Migration `20260905110532`.**

The alert board went **1 critical + 6 info → 0 critical**, 1 high, 6 info.

---

## SHIPPED

### `20260905110532` — the 403 arm can attribute the Atlas walk

- **What it was:** `atlas_editions_dispatch(8)` runs `*/2 * * * *`; a steady **3–30 per hour of its
  240 hourly requests** get Cloudflare's `Just a moment...` challenge. Steady for the full 24h that
  `atlas_edition_requests` retains, **not escalating**.
- **Why it costs nothing:** `atlas_editions_drain()` `RAISE`s on any non-200 and its handler bumps
  `pages_err` **without advancing `next_offset`** — read from the function body, not assumed — so the
  page is re-walked. **266 sets, 0 never completed, max staleness 2h04m, p95 1h16m, 0 stale past 6h**
  against a ~75-minute full cycle.
- **The fix** joins `net._http_response.id` → `atlas_edition_requests.request_id`.
  ⭐ The **2026-08-30** migration named exactly this as "the real fix … still owed" and declined it on
  two grounds that have both since changed: incidence (**0** 4xx per 6h then, **64** now) and "needs
  all 15 call sites" (the highest-volume dispatcher, 5,760/day, already persists its ids).
- ⛔ **The safety property is intact.** That migration warned against downgrading on a *body-shape
  heuristic*; this infers nothing from content. **Anything that does not join keeps the original
  CRITICAL text byte-for-byte**, so a stale-`?key=` edge-function outage still pages.
- ✅ **Two positive controls:** default window → `info`; `interval '30 days'` (past the 12h attribution
  bound) → **`critical`**, same rows. The upgrade path is proven live, not assumed.
- Repo file at the exact recorded version; body **byte-identical to live `prosrc`** (md5
  `d53b0da6a90731d455bc5ce869a261d4`). ACL unchanged, exactly one overload.

---

## MEASURED, NOT SHIPPED — three filings, each with falsifiers

1. **`pack_ev_latest` is >99.7% of two public routes that are now timing out.**
   Two of 21 Vercel error groups are new and are the newest by `first`:
   `v_topshot_pack_reality_ranker_staleness` on `/api/public/insights/pack-reality` (6, from 09-04
   16:38Z) and `v_topshot_pack_ev_calibrated` on `/api/packs` (2, from 09-05 06:17Z) — both
   `boundedRead` at 8,000 ms. **706k buffers to answer a question whose answer is three rows**;
   `SubPlan 3` alone runs **128,712 times for 381,922 buffers (54%)** returning zero rows every loop.
   ⛔ **`mv_pack_ev_latest` is a measured-dead swap** — 0 of the 7 needed columns, different grain.
   Not relitigating the 08-30 verdict on the sibling MV; what is new is that it is no longer only a
   cron cost. `inbox/2026-09-05T1120Z-…`
2. **The unmapped-drain "STALLED" test fires 46% of the time on a working drain** — and **the retune
   I expected measures worse** (`12h × 2` → 60.4% vs today's 45.8%). No current-rate-vs-24h-average
   test works on a **batch** process. A design call, not a tuning one. `inbox/2026-09-05T1125Z-…`
3. **Surface QA: 21 pages, all 200, ~900 third-party images, zero blank** — and the one "defect" was
   my own instrument (below).

---

## ⚠ TWO CORRECTIONS TO MY OWN WORK

### 1. I nearly filed a false defect, and the control caught it

The headless sweep reported `cdn.nba.com 1/1 blank` with `ERR_HTTP2_PROTOCOL_ERROR` on **4 of 4** NBA
team pages — systematic, host-specific, other hosts on the same page loading perfectly. **Verified in
Trevor's real Chrome: it renders at naturalWidth 150, 0 blank of 84 images.** Not a defect.

⚠ Also checked so nobody re-derives it: `cdn.nba.com` **is already in `proxy.ts` `img-src`**, and the
asset serves **200 / 31,426 bytes** by curl from the same VM over HTTP/2 *and* HTTP/1.1.

⭐ **My first isolation test was invalid and looked like confirmation.** Loading the SVG on a `data:`
page returned ERROR — but so did `assets.nbatopshot.com`, which loads 105/105 on the real site. **A
test that cannot produce a passing result is not evidence.** Recorded as a known false positive.

### 2. "96.4% description coverage" was true but its denominator was unstated

That number — which I used on 09-04 to justify retiring `topshot-catalog-backfill` — is coverage of
the **Atlas-covered** population. Measured tonight:

| population | n | with description |
|---|---|---|
| Atlas-covered | 13,915 | **96.6%** |
| **not** Atlas-covered | **6,697** | **1.1%** |
| all Top Shot editions | 20,612 | 65.6% |

⭐ **The retirement decision still stands, and here is the check that settles it:** those 6,697 were
created **2026-05-08 → 2026-08-20**, i.e. while `topshot-catalog-backfill` was alive and healthy, and
they have **1.1%** prose. **The walker was not filling them either**, so retiring it took nothing away.

⭐ **And they are almost entirely inert:** of 6,697, only **100** are user-reachable (**50** with
holders, **59** with sales, **100** with a thumbnail) — which reconciles exactly with the
"Atlas is not a complete census: 100 editions we hold that Atlas omits" finding from earlier in the
night. **6,597 are dormant rows with no art, no holders and no sales.**

⛔ **The lesson, not the number:** I published a coverage percentage without naming its denominator,
and the unnamed denominator excluded a third of the table. **Quote coverage as "x% of <named
population>", always.**

---

## Health at close (04:33 PT)

| instrument | reading |
|---|---|
| `check_public_security_invariants()` | **0 rows** (set-returning ⇒ clean) |
| `detect_stalled_pipelines()` | **0** |
| `check_secdef_anon_execute_violations()` | **0** |
| `get_pipeline_alerts()` | **0 critical**, 1 high, 6 info |
| `v_rpc_trust_health` | 1 breach — `unmapped_resolution_backlog_max` 148/100, **down from 172** |
| pg_cron 24h | 5,658 succeeded / 2 failed (both from jobids no longer in `cron.job`), **no `job startup timeout`** |
| Atlas sets stale >6h | **0** of 266 |

⚠ Read with `jsonb_array_length()`, not `count(*)` — the three scalar-jsonb functions return one row
containing `[]` when clean, the trap tripped twice on 09-04.
⚠ **Sentry was not read** — no Sentry MCP in this session (standing "dark since 08-18" blocker).
Stated rather than silently skipped.

---

## Watches and carried items

- `allday-pack-opens-backfill` 56.6% (**high**) — self-clears ~22:00 PT **2026-09-05**.
- `topshot-catalog-backfill` silence — first testable **19:12 PT 2026-09-05** (last run 02:12Z =
  19:12 PT 09-04, before the cron removal deployed).
- CI red on `main`: `edge-fn-drift` (**ACKed to 2026-10-03**) and `sentinel` (the three dead Top Shot
  pipelines, filed 09-05T1015Z). **Neither is new and neither is mine.**
- ⛔ **A watch someone else owed, now closed:** the 08-30 entry recorded jobid 73
  `refresh-mv-pack-ev-latest` at **1,237 wasted s/day, 66 failures at the 600 s ceiling**. Measured
  tonight: **48 runs, 0 failed, avg 5.8 s, max 9.5 s.** The watermark gate + `pack_ev_history` vacuum
  held. Not my ship — recording the confirmation.

## Needs Trevor

1. **`sentinel` — ack or retire the three dead Top Shot pipelines.** ⛔ Deliberately **not** done here:
   migration `20260903163248` records twice that using the ack mechanism is **Trevor's decision**
   ("Trevor decided 2026-09-03: build it and ack…"; the 08-31 filing "said the DECISION to use it is
   Trevor's"). The measurement is complete in `inbox/2026-09-05T1015Z-…`.
2. **`pack_ev_latest`** — the rewrite is operator-gated by the 08-30 precedent, and it now has
   user-facing cost. See filing 1 above.
3. **`cloudflare-ipfs.com` is still in the `proxy.ts` CSP and the host is decommissioned** — inert, but
   a CSP reads as a claim about which gateways exist. Carried from 09-04, still open.

## Areas deliberately untouched

`app/api/fmv-recalc/route.ts` Steps 5/5b/6 · the shared SQL stripper · ipfs-media gateway **ordering**
· `app/api/recent-sales` · the entity-smoke harness — all owned by the concurrent Claude Code session.
