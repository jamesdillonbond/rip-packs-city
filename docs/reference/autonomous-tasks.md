<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

# Autonomous Cowork tasks (full)

## What Cowork can reach (displaced from CLAUDE.md 2026-09-14, VERBATIM)

> Cowork has a push-capable clone, Supabase MCP (read+write), Vercel/Sentry, Chrome and scheduled-task/artifact tools.

⭐ **This is the premise behind CLAUDE.md's WORKING STYLE rule** (*"If you identify a task you have the tools to do, DO IT in the same turn"*): the sentence enumerating the tools moved here so the RULE could stay in the memory file, which sits at its character cap. ⚠ **It is a dated sample like every other number in these docs** — the set has changed before (the sandbox shell has been down since 2026-09-08, which removed `bash`/`git` from that list without removing the MCP or file-tool halves). **Re-derive what you actually have before concluding you cannot do something.**

## Autonomous Cowork tasks (READ before/while building)

Two scheduled Cowork tasks run autonomously against this repo. Any Claude Code or human session should know they exist and coordinate via the shared ledger so daytime work doesn't duplicate or collide with them.

- **`rpc-daytime-monitor`** — READ-ONLY, every ~3h (≈8am–11pm local). Sweeps health (`pipeline_runs`, sentinel, Sentry, advisors, Vercel deploys), validates the live Cowork dashboards, and appends candidate work to `docs/overnight/inbox/` (one timestamped file per run). Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox plus its own review and autonomously ships ≤4 genuinely-low-risk changes to `main` (collision-gated, CI/typecheck-gated, each independently verified by a fresh subagent), repairs broken artifacts, runs a post-ship regression watch with auto-revert, then writes `docs/handoff-<YYYY-MM-DD>-overnight-pass.md` and a morning digest. Off-limits (queued, never auto-shipped): hot/payer wallet, secrets/env, auth & lockdown (`proxy.ts`), destructive SQL, FMV/ingest/pricing/pack-EV/concierge/sniper route logic, and gated work (chain-two, Phase F). 🚨 **AND ANYTHING THAT RE-OPENS METERED SPEND — above all `unpause_project`.** On 2026-09-10 a **Vercel SPEND-CAP pause** (confirmed by Trevor) took the site and ~20 HTTP lanes down for ~10 h; `unpause_project` was one call away and using it would have re-opened spend against a cap that had genuinely been hit. ⛔ **A `DEPLOYMENT_PAUSED` 503 is a BUDGET state, not an outage to fix: escalate, never unpause.** ⚠ And the cap was raised only SLIGHTLY afterwards, so **this can recur** — see #76 for the blast radius and why no detector caught it.

Shared state lives in `docs/overnight/`:
- `ledger.md` — rolling record of queued / shipped / declined items, each shipped item with its revert path. The **"Declined — do not re-suggest"** heading is Trevor's: add an item there to stop the pass proposing it.
- `inbox/` — monitor → night-pass handoff. ⛔ **APPEND-ONLY since 2026-08-17 — do NOT archive after draining** (it used to say so; see "The inbox-archival instruction conflicts with `INDEX.md`" below). Every new filing needs its `INDEX.md` entry in the same commit.

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


## 🚨 The inbox-archival instruction conflicts with `INDEX.md`, and the forbidden reading is the only executable one (2026-09-02)

The 2026-09-02 overnight handoff queued, for a push-capable run:

> *"A push-capable run (Claude Code / desktop) should `git mv` consumed filings into
> `docs/overnight/inbox/archive/` and commit."*

`docs/overnight/inbox/INDEX.md` says the opposite, and is the more specific authority:

> *"Archiving by date was considered and **rejected**… moving a filing that was never acted on would
> silently remove it from that queue, and nothing would ever surface it again. A date is not a
> drained-determination, and **no per-item drained state exists to read**. **Archiving is Trevor's
> call, not a chore.**"*

⭐ **The dangerous part is the qualifier.** "`git mv` **consumed** filings" is exactly the right
instruction — and nothing in the repo can tell you which filings are consumed. So the only
mechanically available reading is *by date*, which is the rejected one, and a queued item that says
"356 filings back to 08-09" points straight at it. **An instruction whose only executable
interpretation is the forbidden one will eventually be executed** — by a session that reads the
handoff and not the INDEX header.

⛔ A push-capable session checked this on 2026-09-02, was able to do it, and did not.

### What would actually unblock it

⛔ **SUPERSEDED — there is nothing to unblock: the inbox is append-only (focus.md, 2026-08-17) and `__tests__/inbox-is-append-only-since-the-rule.test.ts` enforces it. A per-item marker is how a filing is RETIRED IN PLACE, not a licence to move it.** On 2026-10-04 a Cowork pass read the paragraph below as the go-ahead, archived 47 marked filings, and turned `main` red until `815c984` restored them. Kept below as history.

A **per-item drained marker** written by whichever pass acts on a filing — front-matter, or a
trailing `## Drained <date> — <what shipped>` section. Archiving then becomes mechanical: move
anything with a marker older than N days. Until that exists the determination cannot be made from the
filesystem, and the answer stays "Trevor's call".

⚠ And archiving is never a bare `git mv`: **`INDEX.md` carries 4 CI assertions, two of them COUNTS**,
so a filing's INDEX entry must be deleted in the same commit or
`__tests__/inbox-index-lists-every-filing.test.ts` reds. `docs/overnight/inbox/archive/` already
exists — the directory was never the blocker.

🚨 **And since 2026-09-03 a filing's CONTENT is guarded too, not just its existence.** All
four assertions above are about *which* files and *how many*; a rewrite-in-place that keeps the file
keeps the count, and on 2026-09-03 one silently deleted an 84-line `## ⛔ CORRECTION` block from a
filing another session had just corrected. `scripts/find-clobbered-inbox-corrections.mjs` + the
`inbox-guard` CI job now compare HEAD~1 vs HEAD and fail when a correction's TEXT disappears
(renaming and moving it are free; `[inbox-correction-retracted]` opts a genuine retraction out).
**Editing an inbox filing follows the ledger rule: re-read it from disk immediately before writing,
and splice — never write back a copy read earlier in the session.** Full case, including the two
detector designs that failed on the real data:
[ledger-discipline.md](ledger-discipline.md).

## The two tasks, in one line each (moved verbatim from CLAUDE.md, 2026-09-19)

- **`rpc-daytime-monitor`** — READ-ONLY, ~3-hourly. Sweeps health, files candidates to `docs/overnight/inbox/`. Ships nothing.
- **`rpc-nightly-autonomous-pass`** — 1am local. Drains the inbox, ships ≤4 low-risk changes to `main` (collision- and CI-gated, each verified by a fresh subagent), writes a handoff + digest. Off-limits (hot wallet, secrets, auth, destructive SQL, **metered SPEND**): this file.

## Scheduled-task inventory and where the nightly pass actually runs (re-derived 2026-09-24)

- **Local Cowork scheduled tasks** (prompts at `C:\Users\TDill\Claude\Scheduled\<id>\SKILL.md`; change them only with `update_scheduled_task`, full prompt). **Enabled:** `rpc-context-hygiene` (8th/24th), `rpc-monthly-memory-consolidation`, `rpc-monthly-strategy-review`, `rpc-monthly-deep-audit`, `rpc-autonomous-pass` (manual only). **Disabled locally:** `rpc-nightly-autonomous-pass`, `rpc-daytime-monitor`, the weekly health check/report, data-quality sweep, surface QA, dependency digest, flow-ecosystem watch, pending-signups watch, panini-freshness-check.
- **Deleted 2026-09-24** (their SKILL.md files remain on disk): `rpc-pat-expiry-reminder` (fired 08-31), `rpc-rewards-weekly-pulse`, `rpc-trust-health-watch`, `rpc-cross-collection-refresh`, `ts-backfill-drain-serial-fmv-watch` (all absorbed elsewhere).
- ⚠ **The nightly pass still fires** (e.g. 1:11 AM PT 09-24) while the local task is disabled. It is the **claude.ai cloud trigger**: cloud nightly (health + DB, cannot push, repo-set 403), desktop weekly. A Cowork session cannot see or edit that trigger's prompt. If it carries the old `remote.origin.pushurl` harvest it will keep reporting NO-PUSH; the fix is Trevor's (update it, or retire it and enable the local task).
- **Prompt fixes landed 2026-09-24 in the local tasks:** push via the mount's `.rpc-git-cred` (nightly, monitor, hygiene, deep audit); no inbox archival; session entries to `docs/sessions/`, not CLAUDE.md; every monitor filing ships with its `INDEX.md` entry plus `fix-inbox-index-counts.mjs`; swallowed-heading expectation 0; the strategy review reads the roadmap files instead of CLAUDE.md sections that no longer exist.
- **Installed skills drift from `docs/cowork-skills/`.** On 09-24, 8 of 11 installed RPC skills were behind the repo, including `rpc-edge-fn-deploy` without the rotator recipe. `check-cowork-skill-bundles.mjs` only proves repo bundle == repo source. Compare installed copies at `/sessions/<s>/mnt/.claude/skills/<name>/SKILL.md` against the repo, check each diff's DIRECTION before calling the repo newer, and hand Trevor the `.skill` bundles (one click each via `present_files`).

## Ready queue + idle labels — keep the Claude Code lane fed (added 2026-10-09)

**The failure:** 10-05 → 10-09 five night-pass handoffs read "GREEN, 0 shipped" while a P1 (`chain-arrival-pack-pulls`) aged to five nights under "Queued for Trevor / Claude Code". The work had a queue but no executor: nothing put that section in front of a Claude Code session, and a daytime session cleared it in one sitting once one looked. Commits to `main` fell from 100–400/day to 11, 2, 1, 3 over 10-05 → 10-08. (Trigger: a LinkedIn post on multi-agent idle time. Its point holds here: an empty or unseen queue is a planning problem, and an "idle" label with no reason hides different fixes.)

**Shipped 2026-10-09:**
- Night-pass output contract (`docs/cowork-skills/rpc-nightly-autonomous-pass/SKILL.md` §6, `c1af7af29`): every 0-shipped verdict carries `idle: no-work | routed-to-claude-code | routed-to-trevor | blocked` plus the age of the oldest routed item. Items routed 3+ nights go in the handoff's FIRST line. ⚠ **The installed Cowork task and the claude.ai cloud nightly trigger do NOT have this until Trevor installs `rpc-nightly-autonomous-pass.skill` / pastes the prompt.**
- `npm run ops:ready-queue` (`scripts/report-ready-queue.mjs`, test `__tests__/script-report-ready-queue.test.ts`): prints the numbered queued items from the newest overnight handoff and flags ⚠ STALE at ≥ 3 nights. The handoff is a dated snapshot that daytime sessions do not edit, so the script cross-checks the ledger: an item a LATER heading names with a closing status (APPLIED/SHIPPED/FIXED/DONE/CLOSED/RESOLVED/VERIFIED) prints `✓ likely closed (ledger.md:<line>)`. That is a hint; read the entry. **Run it at the start of any "keep going" / "work what you can" session.**

**✅ DONE 2026-10-09 ~4:30 PM PT (Trevor approved; the hook now runs this line). History: it needed Trevor's explicit approval (the auto-mode classifier refuses hook edits as self-modification; "keep going" did not clear it twice):** make every cloud session print the queue at start. Add this to `.claude/hooks/session-start.sh` just above the final `exit 0`:

```bash
# 5) Surface the night pass's ready queue (dated snapshot — verify against the ledger top).
node scripts/report-ready-queue.mjs 2>/dev/null || true
```

Approval wording that works: Trevor says, in his own words, to edit the session-start hook.
