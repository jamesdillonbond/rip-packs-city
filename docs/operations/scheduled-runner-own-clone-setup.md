# Scheduled-runner own-clone setup (fixes the recurring .git locks)

Date 2026-05-31. Owner: Trevor (one-time infra). Companion to ledger Q7 and `docs/handoff-2026-05-31-git-locks-and-followups.md`.

## The problem (root cause, confirmed via reflog)
The Cowork scheduled tasks `rpc-daytime-monitor` (every ~3h) and `rpc-nightly-autonomous-pass` (nightly) operate inside Trevor's REAL working tree at `C:\Users\TDill\rip-packs-city` — the same `.git` Trevor + Claude Code commit to. The `.git/logs/HEAD` reflog shows commits by both `Trevor <tdillonbond@gmail.com>` (-0700) and `rpc-daytime-monitor <monitor@rippackscity.com>` (+0000) interleaved. When a sandbox `git pull --rebase` collides with a concurrent Windows commit, or the sandbox is killed mid-rebase, it orphans `.git/index.lock` + `.git/HEAD.lock`, which the sandbox then can't remove (`Operation not permitted`). They persist until cleared on Windows. The fix is to stop the two tasks sharing Trevor's `.git`.

## What I've already done (Cowork side — no action needed)
Re-pointed BOTH committing tasks' working directory to **prefer `C:\Users\TDill\rip-packs-city-bot` if it exists, else fall back to the shared repo and behave exactly as today.** This gate is non-breaking: until the clone exists (or if the sandbox can't see it), nothing changes. The switch is automatic once the clone is present and reachable.

The two weekly tasks were intentionally NOT re-pointed: `rpc-weekly-health-check` is read-only (no commits → no locks) and `rpc-weekly-health-report` explicitly never touches git and writes its `PROJECT_HEALTH_<date>.md` into the main tree on purpose (moving it would misplace the report). Neither contributes to the lock problem.

## Your one-time setup
1. **Clone** the repo to a second working copy:
   `git clone https://github.com/jamesdillonbond/rip-packs-city.git C:\Users\TDill\rip-packs-city-bot`
2. **Give that clone push creds.** Configure a credential helper or a PAT so `git push` from the bot clone works non-interactively. (This is also the half that lets the night pass ship CODE again — right now it's stuck in DB-migration + artifact + on-disk-docs mode because it can't push.) Do this yourself — I don't handle credentials.
3. **Verify push works:** from the bot clone, run `git push --dry-run origin main` — it should succeed without prompting.
4. **Reachability check (IMPORTANT — mount-dependent).** The scheduled-task sandbox must be able to SEE `C:\Users\TDill\rip-packs-city-bot`. If scheduled runs only mount your connected `rip-packs-city` folder, a sibling folder may be invisible to them. If so, connect the bot-clone folder to Cowork as a working folder (or place it where the runner already mounts). Confirm on the next scheduled run: the monitor/night-pass output will indicate the bot clone is in use; if it isn't reachable, the tasks silently fall back to the shared repo (no harm, but the locks won't be fixed until the path is reachable).
5. **Keep your main tree pulled.** After the switch, the night pass commits to the bot clone + pushes to `origin` — it no longer writes directly into your working tree. Run `git pull` in `C:\Users\TDill\rip-packs-city` to pick up overnight handoffs/digests/ledger/metrics updates. Also pull before Monday: the `rpc-weekly-health-check` reads your main tree for its "what the night pass shipped this week" section.

## Effect
- The sandbox's git activity hits the bot clone's `.git`, never your working `.git` → no more orphaned `index.lock` / `HEAD.lock` in your repo.
- With push creds, the night pass regains code-shipping (it self-detects push capability via its existing `git push --dry-run` check and exits NO-PUSH mode).
- The monitor → night-pass inbox handoff still works: both use the same bot clone (and back it with origin push/pull), so candidate files flow as before.

## Revert
Tell me to un-gate the two prompts (drop the `rip-packs-city-bot` preference) and they revert to operating in the shared repo exactly as before. No data migration needed — the bot clone is just a second checkout of the same origin.
