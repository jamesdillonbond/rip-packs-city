# Daytime monitor — 2026-09-29 ~21:10Z (14:10 PT)

Read-only daytime health pass. **Platform GREEN:** security 4/4 `[]`, trust_health 38/38 ok / 0 breaches, `sentinel_ts_uuid_editions_48h` 0, `check_pgcron_recent_failures()` `[]`, **not in a saturation spell** (`pg_stat_activity` io_wait 0 / active 0). Vercel: last deploy READY, no ERROR (Trevor actively shipping ~12 deploys/hr this afternoon). 11 live-artifact backing objects all validate (tracked-fmv, pack-lifecycle x2, realized-ev, pack_table_rows, panini squeeze x4, rewards econ/balances). db_size 26,362 MB. Concurrency lock RELEASED (08:25Z), so this file is a legitimate single write. **Push unavailable this run (VM disk 99%, no `remote.origin.pushurl` token on the mount) — inbox written to mount, night pass picks it up locally.**

## Candidate (LOW / SYMPTOM — attribute in a quiet window, do NOT conclude)

**Off-window `pg_net_http_429` volume — 2,285 calls in the last 2h, endpoint unattributed.**
- Source: `rpc_ops_snapshot()` → `pipeline_alerts` `pg_net_http_429` (severity high), 2026-09-29 ~21:04Z.
- Why flagged: the KNOWN 429 source is `rpc-circulation-chain-dispatch` (50/day at 8:25–8:29 PM PT, ledger 2026-09-26). At 14:04 PT this is OFF that window, and 2,285/2h is orders of magnitude larger than the sampler's ~10/day 429 tail — so this is NOT the sampler.
- Not saturation collateral: positive control clean (io_wait 0 / active 0) → genuine upstream rate-limiting, not a spell.
- Temporal correlation worth checking: today's ships include the chain-arrival round-robin dispatch ("16 calls per node per tick across wallets", commits `8196162` / `9DodFTeh`, deployed this afternoon). A new high-volume Flow-REST probe lane is the leading (UNPROVEN) candidate for the surge.
- Known limitation: `net._http_response` has no URL column, so the arm can't name the endpoint; attribution needs a join through `net.http_request_queue` (drained on completion) or the dispatching lane's own counters.
- Suggested action (night pass): attribute the 429s to a lane; compare pre- vs post- the chain-arrival round-robin deploy. If it's the new lane absorbing designed backoff at no freshness cost, note and move on; if a lane is losing data to the throttle, that's the real finding. **Symptom observed live under a QUIET DB — re-measure/attribute before acting.**
- Risk read: LOW / non-urgent. 429 = throttle+retry; no freshness breach observed (atlas-market-feed last drain 21:03Z fresh; trust_health all ok).

### Context notes — NOT candidates (already known / expected / self-healing; recorded so the night pass doesn't re-chase)
- **Atlas 403 Cloudflare spell** (atlas-editions-upstream 219/480, 12 sets >6h stale; atlas-market-upstream 181/503): today's ledger (2026-09-29, "All Day multi-NFT price drain" entry) documents this live spell as self-healing. Not re-raised.
- **`pg_net_http_401` critical** (1 call, empty body): the documented false-critical 4xx-arm class (known-issues #51 — pg_net has no URL, so any 4xx pages high). Not re-raised.
- **panini-collector-walk usernotfound 2/6:** expected — Trevor is actively curating assumed-name walk targets today (ledger 09-29: spinotron/PDXBLAZER/mbl267/…); a not-found IS how the list is learned. Not re-raised.
- **pinnacle-pack-openers 31 fails/24h:** all 30s upstream HTTP timeouts alongside 187 ok (85% ok), self-retrying, lane fed. Upstream-latency weather, not a defect.
- **topshot-active-listings-ingest silent ~22.9h** (last run 2026-09-28 22:13Z vs 900-min threshold): known medium/visibility-only — the residential feeder box has been dark; the arm is doing its job and recovers when the box wakes.
- **Smoke-test RLS-off catches** (`scratch_chain_probe` / `scratch_mint_probe`, 14:57Z & 15:15Z): transient dev scratch tables from today's chain-arrival work; already cleaned — 21:04Z snapshot `rls_off_base_tables` `[]`. Self-resolved.

---

## Disposition — Claude Code, 2026-09-29 ~3:45 PM PT

**ATTRIBUTED (upstream + time of day), not fixed here: the 429s are the Flow REST access node's rate limiter, hit by a minute-start burst of today's new every-minute Flow lanes.** Measured live over the ~6 h `net._http_response` keeps:

- **Upstream:** all 3,138 429s in the last 3 h are `server: envoy`, empty body. That is `rest-mainnet.onflow.org`'s limiter, not Atlas or Dapper.
- **When:** 0 at 8 AM PT, 398 at 9 AM, 585 at 10 AM, 1,057 / 1,225 / 1,131 at 11 AM, 12 PM and 1 PM, then falling (226 in the first half of 2 PM). The rise tracks today's new lanes: chain-arrival (job 636, every minute), topshot-pull-chain (635, every minute) and pinnacle-opener (639, every minute), plus the 5-minute pack lanes.
- **Shape:** **2,750 of 3,138 (88 %) land in the first 5 seconds of a minute.** The every-minute lanes fire together at :00 and burst past the node's per-second limit. The rest of each minute is mostly clean.
- **Why the arm can't name the lane:** 3,131 of the 3,138 match NO recorded `request_id` in any lane table (14 tables checked). The bursting lanes either don't keep their request ids or delete them after draining, so the per-lane 429 rate is not observable today.
- **Not data loss by this evidence:** the lanes carry retry/backoff (the chain-arrival half-size retries shipped today), and no freshness arm breached. Unmeasured, though: nothing counts a request that is retried until it gives up.

**Suggested (for the session that owns those lanes, not done here):** stagger the every-minute Flow lanes across the minute (e.g. `pg_sleep` offsets, or schedules on separate seconds via one dispatcher), and keep `request_id` → lane rows until drained + 1 h, so this arm can attribute its own 429s.
