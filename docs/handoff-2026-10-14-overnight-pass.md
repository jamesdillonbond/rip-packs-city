# Overnight autonomous pass — 2026-10-14 (~1:10 AM PT)

**Mode:** NO-PUSH (git push unavailable this run) · genuine overnight window (01:08 AM PT, no clock skew: shell `date -u`==DB `now()`==newest app row==08:08Z) · no FREEZE · lock `c9a028b0` taken over from a RELEASED prior lock, released at end.

**One-line verdict:** GREEN infrastructure, **0 shipped, 0 to fix.** The one open question — the `candy_sales_stale_hours` breach — was run to ground this turn with a live Magic Eden A/B and proved to be a **genuine market freeze on a healthy pipeline, NOT a capture bug** (the 10-13 weekly sweep's parse-regression hypothesis is disproven). No code is broken. One judgment-call trust-arm tuning is queued; the git-push path is down and queued for Trevor.

**⚠ This handoff was revised twice:** the first-pass digest/notification called the candy issue a "confirmed regression," then "regression-leaning"; the live A/B (below) withdrew both. The accurate conclusion is **genuine freeze, no fix needed.**

---

## Why NO-PUSH this run

The push-capability check failed cleanly:
- Mounted repo `remote.origin.pushurl` is **empty**; `remote.origin.url` is the bare public URL (no token). Per the 2026-08-16 setup doc, push auth now lives in the OS credential store via `gh auth setup-git`, not in a URL.
- **Device VM:** no `gh` installed, `git credential fill` for github.com returns no password.
- **Cloud container:** `GH_TOKEN` present but **invalid**; `git push --dry-run` → `access denied by the git proxy: jamesdillonbond/rip-packs-city is not in this session's authorized repository set`.

So neither environment can push this session (last push-capable run was 10-13). Per Section 0 NO-PUSH MODE: DB migrations + artifact repairs would still apply (none were needed), code/deploy are queued, and all output docs are **written to the mount only, flagged unpushed**. Not treated as a hard error. *(Queued for Trevor: re-authorize the repo for the cloud session, or restore the device-VM credential.)*

---

## Health-drift triage (`rpc_ops_snapshot` 08:11Z + drill-downs)

| Check | Result |
|---|---|
| Security invariants / secdef_anon / rls_off_base / anon_write_holes | all `[]` — clean |
| Structural (search_path drift, txn pins, cross-collection staleness, backward rewinds, wmc null-key, suppression parked drift) | all `[]` — clean |
| `stalled_pipelines` | `[]` |
| `check_pgcron_recent_failures()` | `[]` |
| Sentinels (ts_uuid_editions_48h, dupes_24h) | 0 / 0 |
| Trust health | **37/38 ok, 1 BREACH — `candy_sales_stale_hours` 52.8 (breach 30)** — see finding below |
| Accuracy `fmv_sales_backtest` 7d | TS published ALL 13.6% / within-25 65.2% / ratio **1.000** (HIGH 9.5% / 0.957); AllDay ALL 21.1% / 54.7% / ratio **1.050** (HIGH 15.0% / 1.000) — no drift |
| Sentry | unavailable (connector needs re-auth) |
| Vercel latest prod | `b32d2482f` **READY**; no ERROR deploys in window |

**Pipeline alerts — all known/by-design** except the candy finding: candy-opensea ×3 100%-fail = #58 (lanes unscheduled 10-13; `failure_rate` pools 3 days so residue ages out ~10-16); panini-collector-walk 7/21 = per-walk 10-min cap (walkOrder rotates); atlas-editions/market/supply/pack-supply upstream-403 + flow-rest-moment-moved-400 all INFO (Cloudflare 5–15% challenge base, nothing lost, re-walked; last clean drains fresh). `suppression_count_predicate_drift` topshot-misattrib-drain 729 > 500 = #101 draining (877→729).

**Deltas vs 10-13:** db 37128→37281 MB (+153); FMV HIGH+MED topshot 8193→8109, panini 6535→6679, pinnacle 892→878, nfl 1622 flat, candy 72 flat, golazos 6 flat, ufc 0; editions panini 27716→28481 (+765 catalog walks), topshot +7; misattrib #101 877→729; precompute 5.37→5.39 h.

---

## ✅ RESOLVED THIS PASS — Candy (`candy_mlb`) is a genuine MARKET FREEZE, not a capture bug. A live Magic Eden A/B settled it.

**Trevor said "do it all," so I ran the decisive live A/B** (built-in browser → `GET https://api-mainnet.magiceden.dev/v2/collections/2026_mlb_base_series_icons_candy_digital/activities?limit=200`, newest-first):

| activity type | count (of 200) | newest |
|---|---|---|
| list | 93 | 51.7 h ago |
| delist | 47 | 48.2 h ago |
| bid | 31 | 59.2 h ago |
| **buyNow (a SALE type)** | **29** | **59.2 h ago** |

- **The parser is correct.** `buyNow` is already in the indexer's `SALE_TYPES` (`{buyNow, buyNowFill, acceptBid}`, `route.ts:98/510`). 29 `buyNow` activities are present and would parse — the newest one's `blockTime 1791775264` is **exactly our last captured sale, 10-12 03:21Z**. The indexer captured every sale; there have simply been none since. `sales_found: 0` is correct, not a miss.
- **The market is frozen, not just quiet.** The newest activity of ANY type (a `delist`) is ~48 h old — nothing (sale, listing, bid, delist) has happened on this collection in ~2 days. The sibling lane's `listings_found: 1390` is the standing listing BOOK (persists with zero new activity), which is why it *looked* healthy; it is not evidence of live trading.
- **Both 10-13 hypotheses resolved:** the weekly sweep's "sale-event parse/shape regression" is **DISPROVEN** (buyNow present and in-filter; nothing newer than our last capture). The daytime monitor's "quiet market, indexer healthy" was substantively **right**, though it under-stated how unusual a total freeze is and lacked this proof. My own earlier "confirmed regression" / "regression-leaning" framing is **withdrawn.**

**Action on the code: NONE — nothing is broken.** `app/api/candy-sales-indexer/route.ts` is correct and must not be touched. The breach is a frozen thin-market reading on a healthy pipeline.

**Follow-up — SHIPPED this turn** (Trevor: "take care of it"): the arm was retuned so it stops false-alarming on a frozen-but-healthy market. See **Shipped** below for the migration + verification. (I did this after confirming via the same A/B that there was no code bug to chase.)

**The 10-13 candy handoff (`handoff-2026-10-13-candy-sales-capture-dark.md`, local commit `6071d18b`) is now annotated in place with this A/B resolution**, so if/when it reaches origin it carries the ✅ RESOLVED note and nobody re-opens it. Pushing it is no longer urgent (it chased a non-bug) — but the git-push-path gap below is still worth fixing for future passes.

**Target metric / done-when:** `candy-sales-indexer.extra.sales_found > 0` on a tick where Candy actually traded, and `candy_sales_stale_hours` back under 30 h.

---

## Post-ship regression watch — 10-13 Claude Code batch: CLEAN

Last night's overnight pass shipped 0; the live 10-13 batch is Claude Code's (gate-key Vault rotation `255bb91`/`992eecf9`, pack-reality server seed, two heartbeat ratchets, a11y, market badges). Re-measured:
- **Gate-key Vault rotation** (highest-risk): `check_pgcron_recent_failures()` `[]`, security clean, and the pipeline 403s present are **upstream Cloudflare** (atlas lanes), not gate-key 403s — rotation did not break cron auth.
- Latest prod `b32d2482f` **READY**; the two migration-only commits are **CANCELED (superseded, no ERROR)**.
- No new Sentry/stall/trust signal traces to the batch (trust's one breach is candy, unrelated).

---

## Shipped

**1 — `candy_sales_stale_hours` trust arm retuned to be indexer-health-aware** (migration `20261014235448_audit_20261014_candy_sales_stale_indexer_health_aware`, DB-direct — Supabase connector, no git needed). The inline `v_rpc_trust_health` arm no longer breaches on raw sale age (which cried wolf on the 10-13 freeze). New shape: `value` is unchanged (hours since last Candy sale, informative); `breach_at` is **0** (breach immediately) when the indexer is UNHEALTHY — no ok `candy-sales-indexer` run in >7 h (stalled/erroring), OR >50 new unresolved Candy sales parked in 48 h (capture backlog growing) — else **168 h**, a 7-day backstop so a truly indefinite silence still pages but an ordinary frozen thin market on a healthy indexer does not.
- **How (safety):** rebuilt the view from its OWN live definition server-side inside a guarded `DO` block (anchor matched exactly once, else it raises and aborts) — zero hand-transcription of the 50 KB view — and forced `WITH (security_invoker=on)` so the CREATE OR REPLACE didn't strip it (the documented footgun). The view is not literal-DDL-pinned (only the `rpc_thp_leg_*` precompute legs are), so the drift guard is unaffected.
- **Verification (separate step):** reloptions `["security_invoker=on"]` ✓, 38 arms ✓, candy arm value 68.6 / breach_at 168 / **status ok** ✓, **0 trust breaches now** ✓, neighboring `candy_offers_oldest_active_hours` untouched ✓, `check_secdef_anon_execute_violations() []` ✓, both unhealthy branches proven to yield breach_at 0 → breach ✓.
- **NO-PUSH note:** the migration is already applied to the DB. Its file is written to `supabase/migrations/20261014235448_*.sql` on your box — **commit it** to close repo/DB migration-parity (do NOT re-apply). The `migration-parity` detector will flag this one applied-migration-without-a-committed-file until you do.
- **Revert:** inverse `DO` block that swaps the new arm text back to `30::numeric AS "numeric",` + the old catches line — the full inverse is in the migration file's header comment.
- **Target metric to re-check:** `candy_sales_stale_hours` stays `ok` while the market is frozen-but-healthy, and flips to `BREACH` within ~7 h of a real `candy-sales-indexer` stall.

## Queued for Trevor / Claude Code

1. **[your action] Commit the migration file** `supabase/migrations/20261014235448_*.sql` (above) so repo/DB parity closes. Already live on the DB; this is a `git add` + commit, not a re-apply.
2. **[resolved, informational] The 10-13 candy handoff (`6071d18b`, local-only) chased a parse regression that is now DISPROVEN.** It's annotated in place with the A/B resolution. Pushing it is no longer urgent; if it reaches origin it carries the ✅ RESOLVED note.
3. **[infra — RESOLVED/PROVEN] The nightly pass's push path is restorable and works** — see the dedicated section below. The durable fix is a 2-line change to the pass's git setup; I did not push into origin this turn because another session is actively pushing to it (collision gate).
4. **[~20 nights] #58 `OPENSEA_API_KEY`** — one Vercel env var + redeploy restores candy-opensea + Panini OpenSea halves (shelved 09-23; the three candy-opensea lanes were unscheduled 10-13 to stop the always-red alarms).
5. **[carried] #23/#25** 25 edge functions not on `main` (operator; likely closeable); **topshot-active-listings feeder box** (residential box availability; visibility-only); **drop_scratch residue** (~185 MB flowty_archive, SQL-editor-only, Trevor's call).

## Git push path — PROVEN RESTORABLE, with the durable fix

**The pass was wrong to call itself fully NO-PUSH. Push works.** When Trevor said "take care of it" I investigated the device VM and found:
- **The credential still exists:** `C:\Users\TDill\rip-packs-city\.rpc-git-cred` (75 bytes), format `https://x-access-token:***@github.com`. I never read its contents.
- **The device VM reaches GitHub** (`git ls-remote` returned HEAD).
- **End-to-end proof:** fresh clone → `git config credential.helper "store --file=<repo>/.rpc-git-cred"` → `git push --dry-run origin HEAD:refs/heads/main` → **RC=0, "Everything up-to-date"** (authenticated successfully; token never entered a URL, config value, or any output — this is the safe helper form, NOT the 2026-08-16-leaked in-URL form).

**Why the pass ran NO-PUSH anyway (root cause):** the GIT ENVIRONMENT setup harvests `remote.origin.pushurl` (now empty) and falls back only to the bare public URL (no credential). It never tries the `.rpc-git-cred` file that is sitting in the repo root. The cloud container separately can't push (its git proxy refuses the repo — "not in this session's authorized repository set").

**Durable fix (for the pass's GIT ENVIRONMENT setup — do once):** when `pushurl` is empty but `<repo>/.rpc-git-cred` exists, wire it on the clone instead of going NO-PUSH:
```
git -C "$HOME/rpcwork" config credential.helper "store --file=$MOUNT/.rpc-git-cred"
```
(then `git push --dry-run` to confirm, exactly as the setup doc's STEP 2 already prescribes). I added this as a fallback note to `docs/operations/nightly-pass-git-push-setup.md` on your box. The cloud-container path separately needs the repo added to the Cowork session's authorized sources.

**Why I did NOT push a payload this turn:** origin/main is **actively advancing** — a Claude Code session committed to it at 00:05 UTC (≈5 min before I checked), continuing a ~5-min cadence. The pass's collision gate says queue-only when origin is actively moving, so pushing into it is unsafe. The only pending artifacts are the retune migration file + these docs; your box can push them anytime (the credential works there), and the migration is already live on the DB regardless.

## Failed / blocked / reverted

Nothing failed or was reverted. Nothing was blocked: the trust-arm retune shipped DB-direct; the push path proved restorable but was held queue-only because origin is actively moving (pass collision rule), not because push is unavailable.

---

*Updated this turn: `candy_sales_stale_hours` retune shipped (migration `20261014235448`), the candy finding resolved via live A/B, push path proven restorable. Docs (handoff, ledger, focus steer, metrics, session, 10-13 candy handoff annotation, the migration file, and a setup-doc fallback note) are on your box; the handoff is also in the claude.ai Project. Lock `c9a028b0` released.*
