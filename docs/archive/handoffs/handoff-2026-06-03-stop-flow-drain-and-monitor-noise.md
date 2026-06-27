# Handoff — stop the FLOW drain + cut daytime-monitor noise (2026-06-03)

Plain-text, iPhone-pasteable. Work on main, commit + push. Context: the Cadence payer wallet `0x73f55c4450b8d466` drained to 0 FLOW via the retired storefront-cleanup chore. Nothing live depends on it — Cart + Trade Hub are shelved, the `breaks` schema was never deployed, and the entire live product (FMV / analytics / insights / concierge / pack EV) is reads + Supabase. The drain is already physically stopped (empty wallet). Goal: make it impossible to restart, and silence the dead-capability alarm so the daytime monitor output becomes signal.

## 1. Retire the storefront-cleanup machinery (the drain source) — CODE
- DELETE `scripts/cleanup-storefront-wallets.mjs` — the only repo driver. It reads `.env.local` and shells `flow transactions send cleanup.cdc <addr> --signer my-account`, gas-paid by `0x73f55c4450b8d466`.
- DELETE the root `cleanup.cdc` (`cleanupExpiredListings` against the Dapper storefront). The `cleanupInvalidListing` variant against the dead Flowty fork `0x3cdbb3d569211ff3` (the tx seen on Flowscan) is NOT in the repo — same chore, run ad hoc.
- Both are tied to the listings indexer (retired 2026-05-26) + Flowty (dead 2026-05-13) → zero product value. CLAUDE.md known-issue #9 already lists the storefront audit as de-facto retired; this makes it real.
- Revert: `git revert`.

## 2. Silence the cadence-payer-balance-check alert — OPERATOR (cron-job.org)
- It's `/api/cron/cadence-payer-balance-check`, fired every 30 min by cron-job.org; Telegrams when balance < 0.05 FLOW. It's read-only (spends no gas) but has paged every 30 min since the wallet hit 0 — pure noise for a dormant capability, and the main thing the daytime monitor keeps re-flagging.
- ACTION: pause (don't delete) the cron-job.org entry. Leave the route in place so reviving is just un-pausing + funding.
- Add a one-liner to CLAUDE.md: "payer wallet `0x73f55c4450b8d466` intentionally empty + balance-check cron paused while Cadence-write features (breaks / Cart / Trade Hub) are shelved. To revive: fund > 0.05 FLOW + un-pause the cron."

## 3. Find any auto-runner of the cleanup — OPERATOR (your machine)
- Verified NOT scheduled anywhere we control: no edge function, no GitHub Action, no cron-job.org pipeline entry, and no Cowork scheduled task runs the cleanup. The repo schedules nothing.
- So if cleanup txns keep hitting Flowscan from `0x73f55c4450b8d466` without you running the script, the trigger is a LOCAL job on your machine. Check `crontab -l` (and Windows Task Scheduler / any launchd) for anything referencing `flow`, `cleanup`, or `cleanup-storefront-wallets`. Kill it.
- Do NOT refill the wallet — it's at 0 and the drain is stopped. A token buffer only matters if/when you revive a write feature.

## 4. Daytime-monitor noise (separate, same goal: signal not noise)
- **Q7 git infra (highest-leverage):** give the autonomous passes a sandbox-native bot clone that syncs via origin, instead of operating on the Windows-mounted `.git`. The recurring stale `.git/index.lock` that keeps blocking the passes is a flaky sandbox view of the mount, not a real lock (your own `git push` succeeded right through it). A native clone removes the whole class of failure.
- **Cron-rush transient timeouts:** P1 shipped today (evm-transfers-ingest watchlist 60→150m). Q5 (rebase the smoke sales-lag check to last-successful-run instead of newest `sales.sold_at`) is still queued — ships the rest of the 00:00/06:00/12:00Z false-positives.

END STATE: cleanup machinery deleted (drain can't restart from the repo), payer alert paused (monitor stops crying wolf over a dead capability), local trigger found + killed, and the passes get a clean git surface. Reversible everywhere — nothing here touches a live product path.
