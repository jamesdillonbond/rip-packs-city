HANDOFF — Recurring git locks (infra) + three small follow-ups
Date 2026-05-31. Mixed: ITEM 1 is infra (Trevor's call, not a code commit); ITEM 2 is a small CC code change; ITEMS 3-4 are dispositions/pointers. Your file inspection wins over this doc.

GUARDRAILS (for the code item): direct to main, no branches/PRs; PowerShell git + verify push (git rev-list --count origin/main..HEAD = 0); no CRLF string-replace patches (full-file writes); npx tsc --noEmit clean before push.

=====================================================================
ITEM 1 — Recurring .git/index.lock + .git/HEAD.lock (root cause + durable fix) [INFRA / TREVOR]
=====================================================================
ROOT CAUSE (confirmed via .git/logs/HEAD reflog, 2026-05-31): the Cowork scheduled-task sandbox shares Trevor's REAL working .git at C:\Users\TDill\rip-packs-city. The reflog shows commits by BOTH:
  - Trevor <tdillonbond@gmail.com>  (offset -0700)  = Windows / Claude Code
  - rpc-daytime-monitor <monitor@rippackscity.com>  (offset +0000)  = the scheduled sandbox
…interleaved against the same repo. No custom hooks (.git/hooks is all .sample). The daytime-monitor and nightly-pass tasks run `git pull --rebase` + commit; when that collides with a concurrent Windows commit, OR the sandbox is killed mid-rebase, git has already created index.lock / HEAD.lock and never cleans them up. The sandbox then cannot `rm` them (`Operation not permitted` — the lock files are owned by the Windows uid / the .git mount denies the unlink), so they persist until Trevor clears them on Windows (Remove-Item .git\index.lock, .git\HEAD.lock). The stray .git/.rpc_write_test + .git/__wtest files are leftover writability-probes from prior runs — a symptom, not the cause.

DURABLE FIX (the right one): give the scheduled-task runner its OWN clone of the repo — a separate checkout that pulls from / pushes to origin — instead of operating inside the mounted Windows working tree. Once the sandbox has its own .git, its pulls/commits/crashes can never lock Trevor's repo; the only shared point becomes origin, which handles concurrency correctly (push rejects cleanly, you re-pull). This ALSO removes the second half of the current limitation: with a private clone + GitHub credentials, the nightly pass could actually push code to main like Claude Code does, instead of being structurally limited to DB-migrations + artifacts + on-disk docs.

REJECTED ALTERNATIVE (do not bother): an in-sandbox "clear the stale lock if no git process owns it" guard in the task prompts. Two reasons it fails: (a) the sandbox can't reliably unlink the locks at all (the EPERM above), so the guard often can't run; (b) an age-based variant risks deleting a lock that a concurrent Windows commit legitimately holds, which could corrupt Trevor's in-progress commit. The shared-.git arrangement is the problem; stop sharing rather than paper over the lock.

INTERIM (until the runner is re-pointed): nothing the sandbox can do — when a lock is orphaned, Trevor clears it on Windows with the Remove-Item one-liner. The daytime-monitor prompt was updated 2026-05-31 to note that a failed push is non-fatal (the inbox file still lands on disk for the night pass), so a locked repo degrades gracefully rather than erroring.

=====================================================================
ITEM 2 — C1: gate the AllDay listings-indexer Sentry capture (mirror the pinnacle Q4 fix) [CC CODE]
=====================================================================
FILE: app/api/allday-listings-indexer/route.ts
WHY: Sentry issue JAVASCRIPT-NEXTJS-15 (`listing_resolution_failures_inserted`) is unresolved, 1006 events over 20 days, last seen 4h ago, and its current culprit is `POST /api/allday-listings-indexer`. The Q4 fix (commit 48f5a98) rate/reason-gated this captureMessage for the two PINNACLE routes only and explicitly left the AllDay indexer untouched — so the AllDay route still fires the capture per tick whenever it inserts any listing_resolution_failures rows. The AllDay standing backlog is tiny (3 unresolved rows; reasons cadence_fallback_cap_hit, wmc_miss_no_seller_cadence_attempt), so this is NOT a data problem — it's pure Sentry noise (~50 events/day) that masks any real spike and burns quota.
CHANGE: mirror exactly what 48f5a98 did for the pinnacle routes. Find the Sentry.captureMessage("listing_resolution_failures_inserted", …) call in this route and gate it so it only fires on a genuine spike (e.g. > 25 new failures inserted in a single tick) OR an unexpected/unknown failure reason — not on every tick that inserts 1-2 routine rows. Keep the failure-row inserts themselves (they're the data of record); only gate the Sentry capture. Match the threshold/shape 48f5a98 used so the two indexers behave identically. AllDay editions are editions-backed (legit reasons), so do NOT rename reasons or change resolution logic here — this is purely the capture gate.
REVERT: git revert the commit.
VERIFY: npx tsc --noEmit clean; deploy READY. Then in Sentry, NEXTJS-15 stops accruing AllDay events every tick — mark it resolved and confirm it stays quiet 24h (only re-opens on a real spike). pipeline_runs for allday-listings-indexer unchanged (still ok=true, same cadence); listing_resolution_failures still gets its rows.

=====================================================================
ITEM 3 — DEP0169 url.parse() deprecation [NO ACTION — disposition]
=====================================================================
The daytime monitor logged a DEP0169 `url.parse()` deprecation warning in the Vercel logs. Confirmed 2026-05-31 it is NOT RPC code: the only `url` import anywhere in the repo is `fileURLToPath` (the modern, non-deprecated API) in scripts/dapper-csv-classify.mjs. The deprecated url.parse() call is inside a transitive node_modules dependency, so there is nothing to fix in RPC code — it will clear on the relevant dependency upgrade. Do not spend time on it. Recommend Trevor add it to the ledger's "Declined — do not re-suggest" section (that heading is Trevor's to edit) so it's formally suppressed; the daytime monitor already self-suppresses it (its inbox notes it as upstream / not-re-logged).

=====================================================================
ITEM 4 — Entity-page onError image fallback [ALREADY HANDED OFF — still open]
=====================================================================
The broken-thumbnail / dead-CDN onError fallback for the player hero + entity grid tiles is already specified in docs/handoff-2026-05-31-entity-polish.md (ITEM 1: a small ImgWithFallback client component for the player portrait, EditionsGridPaginated tile, and PlayersGridPaginated portrait; mirror the existing PackThumb tier-aware fallback). Verified 2026-05-31 it is NOT yet shipped (no onError / ImgWithFallback in components/entity). Low priority / cosmetic. No new handoff needed — pick it up from that doc when convenient.

=====================================================================
EXPECTED END STATE
=====================================================================
ITEM 1: scheduled runner re-pointed to its own clone → no more orphaned locks in Trevor's repo, and (with creds) the night pass can push code. ITEM 2: AllDay capture gated → NEXTJS-15 goes quiet, real spikes still page. ITEM 3: closed, no action. ITEM 4: tracked in the entity-polish handoff, pick up when convenient.
