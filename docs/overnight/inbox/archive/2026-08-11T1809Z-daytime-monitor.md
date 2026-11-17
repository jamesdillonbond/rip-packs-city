# Daytime monitor — 2026-08-11T18:09Z (11:09 PDT)

Environment: workspace shell DOWN again (`useradd … /sessions no space left`, now 7th+ consecutive incident) → no git clone. Connectors (Supabase/Vercel/Sentry) + file tools work. This file written to the MOUNT; **push unavailable** — night pass picks it up locally.

Health: security 4/4 clean (invariants/anon-write/rls-off/secdef-anon all `[]`) · Vercel last prod deploy READY (`dpl_DU5kUALxARV3ZtLvuTH1zVZJ9NdM`=`030b9fa6`; CANCELED tail = superseded-by-newer-push from heavy Trevor/CC activity, no ERROR) · 0 new Sentry/12h · DB 12,515 MB (12,499→12,515, normal growth) · `detect_stalled_pipelines()` = the two pack-opens backfills only (below).

Trust: **3 breaches, ALL known / unchanged from 15:12Z** — `panini_sale_price_capture_dry_days` 14 (operator home-box runner outage), `unmapped_resolution_backlog_max` 215 (AllDay backfill inflow, net-draining), `public_board_slow_count` 17 (saturation collateral, still frozen by the failed 12:58Z precompute — same as 15:12Z Candidate 1, NOT a separate finding).

---

## Candidate 1 — [LOW] ipfs-media 5xx CHARACTERIZED (the 08-11 overnight's assigned follow-up) — climbing, upstream 502, fails soft

The 08-11 overnight queued "`/api/public/ipfs-media/[cid]` 5xx elevated (103/6h) → daytime monitor to characterize." Characterization this tick:

- **Source:** Vercel runtime logs, prod, last 6h, path `ipfs-media`, statusCode 5xx → **188 responses, ALL 502** (grouped by statusCode). Individual-line pull timed out under the current log-query saturation, but the group-by is unambiguous: the elevation is entirely **502 Bad Gateway**, i.e. the upstream IPFS gateway the route proxies is timing out / refusing, not a code fault in the route.
- **Trend:** **103/6h (08-11 overnight) → 188/6h now** — roughly doubled, so it is escalating, not decaying.
- **Blast radius: LOW.** This is a media pass-through (`/api/public/ipfs-media/[cid]`); a 502 means one image asset fails to load, and entity/moment pages carry fallback media, so it degrades gracefully (fails soft — consistent with the overnight's read). No user-facing page is down; no Sentry issue attached (route returns the upstream status rather than throwing).
- **Suggested action (night pass / CC):** confirm which upstream IPFS gateway host the route targets and whether a single gateway is flaking vs. a systemic rate-limit; the durable fix is a **multi-gateway fallback / retry** on the pass-through (try gateway B on a 5xx from gateway A) or a short-TTL negative cache so a flaking CID doesn't re-hammer the gateway. Read-only monitor took no action. Not urgent — soft-failing — but the doubling means it is worth a code look before it saturates further.

---

## NOT findings / already-logged (dispositioned this run)

- **D34 precompute split (jobid 287) 12:58Z failure** — this is the 15:12Z tick's Candidate 1 (MEDIUM, CC-owned). No new precompute tick since (last_run still 12:58Z failed, 06:58Z succeeded); the next natural tick is **18:58Z** — the tell the 15:12Z candidate flagged. `trust_precompute_max_age_hours` still well under its 13h breach. Not re-filed — same open item, awaiting the 18:58Z re-measure.
- **`allday-pack-opens-backfill` + `topshot-pack-opens-history-backfill` stalled ~15h** (last runs 02:46Z / 03:11Z, both `last_ok=true`; 299/225 successful runs over 72h). Already the 0610Z + 15:12Z monitors' open item. Both last-ran SUCCESSFULLY then went silent — consistent with caught-up-to-forward-cursor or a dropped cron-job.org trigger batch, not a crash. Persisting but benign (backfill walkers, not user-facing). Not re-filed — same open item.
- **pg_cron MV-refresh saturation cluster** — `rpc-refresh-allday-pack-realized` (3/4 fail, 12:35Z), `rpc-trust-health-precompute-refresh` (12:58Z, = Candidate 1 above), `rpc-refresh-misattrib-candidates` (15:35Z), `rpc-thin-sale-ask-disclosure-refresh` (09:25Z), `rpc-refresh-new-collectors` (job startup timeout, 09:45Z): standing disk-IO-saturation MV cluster, already queued (`2026-08-08T1717Z*`/`1945Z*`), self-retrying. No new lever.

## Not deep-validated this run
- **Artifacts:** not enumerated/deep-run this tick (shell down; standing precedent of not piling heavy read load on a saturation-prone pooler while the precompute/MV cluster is already timing out). Estate was structurally unchanged as of 15:12Z with no schema break since. Night pass should re-validate when DB/shell recover.
