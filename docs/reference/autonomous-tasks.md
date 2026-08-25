<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

# Autonomous Cowork tasks (full)

## Autonomous Cowork tasks (READ before/while building)

Two scheduled Cowork tasks run autonomously against this repo. Any Claude Code or human session should know they exist and coordinate via the shared ledger so daytime work doesn't duplicate or collide with them.

- **`rpc-daytime-monitor`** — READ-ONLY, every ~3h (≈8am–11pm local). Sweeps health (`pipeline_runs`, sentinel, Sentry, advisors, Vercel deploys), validates the live Cowork dashboards, and appends candidate work to `docs/overnight/inbox/` (one timestamped file per run). Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox plus its own review and autonomously ships ≤4 genuinely-low-risk changes to `main` (collision-gated, CI/typecheck-gated, each independently verified by a fresh subagent), repairs broken artifacts, runs a post-ship regression watch with auto-revert, then writes `docs/handoff-<YYYY-MM-DD>-overnight-pass.md` and a morning digest. Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth & lockdown (`proxy.ts`), destructive SQL, FMV/ingest/pricing/pack-EV/concierge/sniper route logic, and gated work (chain-two, Phase F).

Shared state lives in `docs/overnight/`:
- `ledger.md` — rolling record of queued / shipped / declined items, each shipped item with its revert path. The **"Declined — do not re-suggest"** heading is Trevor's: add an item there to stop the pass proposing it.
- `inbox/` — monitor → night-pass handoff (archived to `inbox/archive/` after draining).

### ⚠ When the night pass CANNOT push (added 2026-08-25) — leave a COMMIT, not loose files

The pass has run NO-PUSH on consecutive nights. Its artifacts (`ledger.md` entry, `metrics-latest.json`,
`docs/handoff-<date>-overnight-pass.md`) are written to the mounted tree and flagged *uncommitted*, which
means **they are invisible to `git log` and survive only until a human happens to notice them.** On
2026-08-25 a Claude Code session found the previous night's artifacts sitting unstaged and committed them by
hand; nothing in the repo would have surfaced them otherwise.

**Contract when push is refused:**

1. ⚠ **Record the ERROR STRING verbatim, and classify the mode from it** — `access denied by the git proxy …
   authorized repository set` (**CLOUD**, nothing local helps) vs `could not read Username for
   'https://github.com'` (**DESKTOP/bridge**). The 2026-08-25 handoff labelled itself "cloud" while quoting
   the desktop string. Full table + a four-command diagnostic:
   [tooling-gotchas.md](tooling-gotchas.md) → *Pushing from a sandbox*.
2. **Say plainly, in the handoff's first line, that a push-capable session must commit the artifacts** — and
   name them. "Flagged uncommitted" reads as bookkeeping; "these three files are unpushed work" reads as an
   action.
3. ⚠ **If you build a bundle or patch, build it against `origin/main`, NOT local `HEAD`.** Bundles are
   incremental, and one built from local HEAD fails on the recipient with a missing-prerequisite error.
4. ⛔ **Never re-embed a PAT to get around it** — it burned a real token on 2026-08-16, and `gh` carries the
   `workflow` scope a PAT lacks.

ⓘ **The standing fix is not credential-side.** Upstream `anthropics/claude-code#76248` (still OPEN, re-checked
2026-08-25) confirms the cloud 403 is *intended isolation*; the only remedy is **creating the session with the
repo attached as a source**. So a scheduled task created without the repo attached will refuse every night
until it is re-created with it — **that is an operator action, not something the pass can fix from inside.**


- `metrics-latest.json` — health baseline for overnight deltas + the post-ship regression watch.
- `focus.md` — optional; write a line here to steer the next night's priorities (e.g. "prioritize FMV throughput", "leave the pack pipeline alone").
- `.lock` — concurrency guard so two runs never commit at once.

Coordinating your own work: skim `ledger.md` before a session so you don't duplicate or collide; the night pass will not edit files committed in the last 24–48h. To halt all autonomous shipping (before a launch or during a risky refactor), create `docs/FREEZE.md` — both tasks drop to read-only while it exists. The weekly Monday `rpc-weekly-health-check` lists everything shipped autonomously in the prior 7 days, each with its revert command, so it can be reviewed or rolled back. The full task prompts live in Cowork (Scheduled), not in this repo.

