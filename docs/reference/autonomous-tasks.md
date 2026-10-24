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

### ⭐ Push route for scheduled tasks — CLOUD FIRST (2026-10-23)

**The failure:** the task prompts pushed with `store --file=/sessions/<session>/mnt/rip-packs-city/.rpc-git-cred`. That path exists only when a run lands in the old LOCAL Cowork sandbox. Most runs now land in a **cloud container linked to the laptop**, where the path does not exist, so every such run fell to NO-PUSH and wrote its output onto the laptop's working tree, where nothing commits it. Recovered by hand on 10-15 (10-13/10-14 content) and 10-23 (the 10-19 weekly health report, the 10-21 flow-watch entry, two 10-22 monitor filings, a 10-20 data-quality ledger entry). The laptop tree had also drifted **631 commits** behind `main`, which matters because Task Scheduler runs `scripts/ingest-panini-runner.mjs` from it.

**The route, in order.** ✅ **Applied 2026-10-23 ~10:20–11:05 AM PT** with Trevor's explicit go-ahead ("Yes do it all"). The blocks at the end of this section are now at the top of the nightly pass, daytime monitor, context hygiene and monthly deep audit prompts, and each update came back re-signed by Claude Desktop (Windows). Before that approval, two `update_trigger` attempts were refused by the permission check.
1. **Cloud:** `add_repo` (Claude_Code_Remote connector; `ToolSearch "add_repo"` if deferred) with owner `jamesdillonbond`, repo `rip-packs-city`, access `push` → clone where its result says (normally `/home/claude/rip-packs-city`) → `register_repo_root` → `git push origin HEAD:refs/heads/main`. No credential helper: the session proxy authenticates once the repo is attached. Proven 2026-10-03 and 2026-10-23.
2. **Local sandbox:** the `.rpc-git-cred` store helper, only when that file path actually exists.
3. **Otherwise NO-PUSH:** write to the laptop tree as before AND list every unpushed path at the top of the task result under `UNPUSHED (mount-only):`.

**Stranded-output sweep (nightly pass, every run, when the laptop is reachable):** compare candidate laptop files against `origin/main` by `git hash-object` vs `git rev-parse origin/main:<path>`, never by `git status` on the mount (slow; can hang past 60 s). Candidates are new files under `docs/overnight/inbox/`, `docs/health/` and `docs/handoff-*.md`, plus local edits to `docs/overnight/ledger.md` and `docs/overnight/flow-ecosystem-watch.md`. Commit new files as they are (inbox filings with their `INDEX.md` line + `node scripts/fix-inbox-index-counts.mjs`). For the two edited logs, carry over only the entries absent from origin, spliced by the normal ledger rules. 2026-10-23 example: a three-way `git merge-file` of laptop ↔ old HEAD ↔ origin isolated the one stranded ledger entry. ⛔ Never edit or delete the laptop copies, and never run git against the laptop `.git` from a scheduled task.

**Running a `.cmd` on the laptop from a cloud session (2026-10-23):** File Explorer is grantable only at the CLICK tier (no typing). Open it, click the pinned `rip-packs-city` in the sidebar, scroll, double-click `Rip Packs City` → `cowork-push` → the script, then release the lock and poll the script's own log from the device shell. Writing the log to a file next to the script (`> "%~dp0<name>.log" ( … ) 2>&1`) is what makes the outcome readable without screenshots of a masked console. `cleanup-stale-worktrees.cmd` removed two worktrees (with their node_modules) natively in about 40 s; `rm -rf` over the bridge had managed ~500 entries per 3-minute call.

**Daily laptop pull (2026-10-23, Trevor approved):** `Rip Packs City\cowork-push\pull-main-ff.cmd` now runs `clear-landed-strays.mjs` first. That script deletes untracked docs/ files, and restores modified ones to HEAD, only where the bytes equal `origin/main`'s copy. Those are exactly the files the nightly sweep has already committed, and they would otherwise make every `--ff-only` pull refuse. It never touches a file that differs, and was tested against a scratch clone with both cases. ✅ **The daily pull runs as a Claude scheduled task: `RPC laptop pull main (daily)`** (trig_014mdFHh2m4AYTkYLTF7XxSV, created 2026-10-23 ~11:41 AM PT on Trevor's "You need to take care of this. I'm not going to be at my laptop for a few days"). It fires 5:37 AM PT daily, ahead of the Panini runner's 6 AM tick. It is device-bound to the laptop with the repo folder attached, auto-approve, and sends a push notification. Through the device shell it requests delete permission, runs `clear-landed-strays.mjs`, then `git merge --ff-only` (batched recipe below if that times out). It refuses on local commits or modified tracked files, and never resets or cleans. ⚠ A Cowork session could neither register the Windows-native alternative (`register-daily-pull.cmd`, same folder, "RPC laptop pull main" 5:37 AM; the click was refused as persistence) nor fire the new task on demand ("Cowork Run Routine Now" refused). The first real run is therefore 2026-10-24 5:37 AM. `register-daily-pull.cmd` stays as a laptop-local option for Trevor; running both is harmless (the second finds 0 behind). The by-hand path was verified end to end 2026-10-23 11:08 AM PT (27 files pulled, log in `pull-main-ff.log`). ⚠ **Gotcha:** `create_trigger` with `requires_local_device` but no `folders` came back bound with `folders: []`, so its runs could not have reached the repo. Folders cannot be added afterwards, so it was deleted and recreated with `folders: ["C:\\Users\\TDill\\rip-packs-city"]` (`folders_state: PRESENT`). Always check `derived_state.folders` in the create result.

**Verifying a scheduled-task change after the thread is archived (2026-10-23):** a `send_later` check-in is bound to the session that scheduled it, and once that conversation is archived it never fires. Seven older one-shot check-ins on this account show `ended_reason: auto_disabled_session_gone` with a FAILED last run. Schedule follow-ups that must outlive the thread as standalone one-shot tasks instead: `create_trigger` with `run_once_at`, a self-contained prompt, `requires_local_device: true`, and `folders` named explicitly when it needs the laptop. Then confirm `derived_state.folders_state: PRESENT`. Live ones from this change: `Verify 10-23 push-route + laptop-pull changes (one-shot)` (trig_015z3qDXp9Q2Qkn67rCE3oof, 2026-10-24 6:15 AM PT: did the nightly push from the cloud, did the 5:37 AM pull run) and `Verify surface QA push route (one-shot, 10-29)` (trig_0133TyqEAaUKDtpou5vM4q7i, 2026-10-29 11:15 AM PT). Each fixes what it finds and ledgers its verdict.

**Laptop tree sync (Trevor or an interactive session, not a scheduled task):** `Rip Packs City\cowork-push\pull-main-ff.cmd` (refuses on a dirty tree). From the VM shell, a single `git merge --ff-only` over hundreds of commits runs past the bridge's 180 s call cap, and background processes die at call end. What worked on 2026-10-23: `git checkout origin/main -- <60-path batches>` + `git rm` of the deleted paths, then `git update-ref refs/heads/main <origin sha> <old sha>`. That is resumable, and each batch took seconds.

**Prompt blocks as applied 2026-10-23 (the rest of each prompt was kept verbatim; per-task wording differs only in the clone path it replaces):**

- **All four pushing tasks** (`Rpc nightly autonomous pass` trig_01ANm9nPL2WqknwMaJedfaAA, `Rpc daytime monitor` trig_01H9peMNj7LWJndZRrrbuAFA, `Rpc context hygiene` trig_01Y5BeP9NXCwDhoUezH6MdX3, `Rpc monthly deep audit` trig_01DB3MXrE3YZMtN4YpxpoKxN):

  > ⭐ PUSH ROUTE (added 2026-10-23 — SUPERSEDES the `.rpc-git-cred` push route below wherever they conflict): these runs usually execute in a CLOUD container linked to Trevor's laptop, where `/sessions/<session>/mnt/rip-packs-city/.rpc-git-cred` does NOT exist, which is why NO-PUSH runs kept stranding output on the laptop's working tree. Push in this order: (1) CLOUD — call `add_repo` (Claude_Code_Remote connector; ToolSearch "add_repo" if deferred) with owner "jamesdillonbond", repo "rip-packs-city", access "push"; clone where its result says (normally /home/claude/rip-packs-city), call `register_repo_root`, use that clone as your working clone, and push with plain `git push origin HEAD:refs/heads/main` (no credential helper). (2) LOCAL SANDBOX — only if the cred file path exists, use the store-helper command below. (3) Only if both fail is the run NO-PUSH: list every unpushed path at the TOP of your result under "UNPUSHED (mount-only):". The laptop tree is `$HOME/mnt/rip-packs-city` via the device shell tool when cloud-linked; never run git against its `.git`. Recipe: docs/reference/autonomous-tasks.md → "Push route for scheduled tasks — CLOUD FIRST".

- **Nightly pass only, appended to that block:**

  > STRANDED-OUTPUT SWEEP (every run, when the laptop is reachable and push works): other tasks (daytime monitor, flow-ecosystem watch, weekly health report, data-quality sweep, surface QA, dependency digest) sometimes write files onto the laptop tree without pushing. Compare by `git hash-object <laptop file>` vs `git rev-parse origin/main:<path>` in your clone, never `git status` on the mount. Candidates are new files under docs/overnight/inbox/, docs/health/ and docs/handoff-*.md, plus local edits to docs/overnight/ledger.md and docs/overnight/flow-ecosystem-watch.md. Commit new files as they are (inbox filings with their INDEX.md line + `node scripts/fix-inbox-index-counts.mjs`). For edited logs carry over ONLY entries absent from origin (a 3-way `git merge-file` isolates them), spliced by the ledger rules. Commit as "docs: commit stranded task output (<paths>)", push, ledger it, and name it in the digest. Never edit or delete the laptop copies.

✅ **Closed 2026-10-23 ~12:40 PM PT: `Rpc surface qa` (trig_01EJxZDcuDpWcerHpKrYKgt8, Thursdays 9:15 AM PT) now carries the CLOUD-FIRST push block,** including a note that the nightly sweep does not cover `docs/cowork-skills/`. Its prompt had said "commit + ledger" with no push route. Applied once Trevor switched the session to manual approval; earlier attempts had been refused by the auto-approval check. A check-in at 11:15 AM PT 10-29 (in the session that made the change) verifies its first run left nothing on the laptop.

The flow-ecosystem watch and weekly health report have no git step at all ("do not touch git"), so their output always lands on the laptop tree. The nightly sweep is what carries it to `main`; their prompts need no change.


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

> ⏱ **2026-10-20 ~3:30 PM PT (Cowork cloud, laptop linked): three task prompts rewritten for the new dashboard estate (#114).** `Rpc daytime monitor` §1b now validates the 11 claude.ai dashboards from their repo sources (`docs/cowork-skills/<name>.html`, object-existence check in one statement) instead of `list_artifacts`; `Rpc nightly autonomous pass` repairs one by editing the source, republishing with the Artifact tool and committing the same bytes; `Rpc surface qa` Part 1 lists the 11 and drops the long-deferred items fixed that day. Each update came back "prompt re-signed by Claude Desktop (Windows)", so all three still require that computer. `Rpc weekly health check` step 10 still carries the 06-12 estate note; it is informational only and was left as is.

- **Local Cowork scheduled tasks** (prompts at `C:\Users\TDill\Claude\Scheduled\<id>\SKILL.md`; change them only with `update_scheduled_task`, full prompt). **Enabled:** `rpc-context-hygiene` (8th/24th), `rpc-monthly-memory-consolidation`, `rpc-monthly-strategy-review`, `rpc-monthly-deep-audit`, `rpc-autonomous-pass` (manual only). **Disabled locally:** `rpc-nightly-autonomous-pass`, `rpc-daytime-monitor`, the weekly health check/report, data-quality sweep, surface QA, dependency digest, flow-ecosystem watch, pending-signups watch, panini-freshness-check.
- **Deleted 2026-09-24** (their SKILL.md files remain on disk): `rpc-pat-expiry-reminder` (fired 08-31), `rpc-rewards-weekly-pulse`, `rpc-trust-health-watch`, `rpc-cross-collection-refresh`, `ts-backfill-drain-serial-fmv-watch` (all absorbed elsewhere).
- ⚠ **The nightly pass still fires** (e.g. 1:11 AM PT 09-24) while the local task is disabled. It is the **claude.ai cloud trigger**: cloud nightly (health + DB, cannot push, repo-set 403), desktop weekly. A Cowork session cannot see or edit that trigger's prompt. If it carries the old `remote.origin.pushurl` harvest it will keep reporting NO-PUSH; the fix is Trevor's (update it, or retire it and enable the local task). ⏱ **2026-10-23 correction:** a cloud Cowork session CAN read every recurring task's prompt with `list_triggers` (Claude_Code_Remote connector; 14 recurring RPC tasks, all device-bound to the laptop). It cannot rewrite them: `update_trigger` with a prompt was refused twice that day by the permission check ("Cowork Scheduled Task Write"), so prompt edits are Trevor's, from the task's settings. The blocks to paste are in "Push route for scheduled tasks — CLOUD FIRST" above.
- **Prompt fixes landed 2026-09-24 in the local tasks:** push via the mount's `.rpc-git-cred` (nightly, monitor, hygiene, deep audit); no inbox archival; session entries to `docs/sessions/`, not CLAUDE.md; every monitor filing ships with its `INDEX.md` entry plus `fix-inbox-index-counts.mjs`; swallowed-heading expectation 0; the strategy review reads the roadmap files instead of CLAUDE.md sections that no longer exist.
- **Installed skills drift from `docs/cowork-skills/`.** On 09-24, 8 of 11 installed RPC skills were behind the repo, including `rpc-edge-fn-deploy` without the rotator recipe. `check-cowork-skill-bundles.mjs` only proves repo bundle == repo source. Compare installed copies at `/sessions/<s>/mnt/.claude/skills/<name>/SKILL.md` against the repo, check each diff's DIRECTION before calling the repo newer, and hand Trevor the `.skill` bundles (one click each via `present_files`).

## Ready queue + idle labels — keep the Claude Code lane fed (added 2026-10-09)

**The failure:** 10-05 → 10-09 five night-pass handoffs read "GREEN, 0 shipped" while a P1 (`chain-arrival-pack-pulls`) aged to five nights under "Queued for Trevor / Claude Code". The work had a queue but no executor: nothing put that section in front of a Claude Code session, and a daytime session cleared it in one sitting once one looked. Commits to `main` fell from 100–400/day to 11, 2, 1, 3 over 10-05 → 10-08. (Trigger: a LinkedIn post on multi-agent idle time. Its point holds here: an empty or unseen queue is a planning problem, and an "idle" label with no reason hides different fixes.)

**Shipped 2026-10-09:**
- Night-pass output contract (`docs/cowork-skills/rpc-nightly-autonomous-pass/SKILL.md` §6, `c1af7af29`): every 0-shipped verdict carries `idle: no-work | routed-to-claude-code | routed-to-trevor | blocked` plus the age of the oldest routed item. Items routed 3+ nights go in the handoff's FIRST line. ⚠ **The installed Cowork task and the claude.ai cloud nightly trigger do NOT have this until Trevor installs `rpc-nightly-autonomous-pass.skill` / pastes the prompt.**
- `npm run ops:ready-queue` (`scripts/report-ready-queue.mjs`, test `__tests__/script-report-ready-queue.test.ts`): prints the numbered queued items from the newest overnight handoff and flags ⚠ STALE at ≥ 3 nights. The handoff is a dated snapshot that daytime sessions do not edit, so the script cross-checks the ledger: an item a LATER heading names with a closing status (APPLIED/SHIPPED/FIXED/DONE/CLOSED/RESOLVED/VERIFIED) prints `✓ likely closed (ledger.md:<line>)`. That is a hint; read the entry. **Run it at the start of any "keep going" / "work what you can" session.** ⚠ **2026-10-11: it read the 10-11 handoff as EMPTY** (heading `## Needs your decision / QUEUED`, carried items as `- ` bullets), and three items closed on 10-09 were carried a second night. It now takes any `## … queued` heading (not a RESOLVED recap) and top-level bullets, prints ⚠ when no section is found instead of "nothing queued", and flags `✓ likely closed BEFORE this pass — re-carried` from a 14-day look-back. Keys are matched against a heading's CLAIM (prefix + first bold), not its body. **Night pass: title the section with the word "Queued" and number its items** — the parser tolerates drift, but a numbered list keeps the item ids stable.

- Ledger cross-check (`b586bcb6b`, `4e07555fe`): the night pass's own heading is found by its STATUS PREFIX (text before the first `**`). Whole-line matching broke twice on 10-09 (testing-and-ci.md, end). The night-pass skill's §1 Orient now runs the script, and the open items it prints are the carried queue.

**✅ DONE 2026-10-09 ~4:30 PM PT (Trevor approved; the hook now runs this line). History: it needed Trevor's explicit approval (the auto-mode classifier refuses hook edits as self-modification; "keep going" did not clear it twice):** make every cloud session print the queue at start. Add this to `.claude/hooks/session-start.sh` just above the final `exit 0`:

```bash
# 5) Surface the night pass's ready queue (dated snapshot — verify against the ledger top).
node scripts/report-ready-queue.mjs 2>/dev/null || true
```

Approval wording that works: Trevor says, in his own words, to edit the session-start hook.

**⭐ 2026-10-18 — the ready queue now reads focus.md VERDICTS, and LOCAL sessions run it too.** The 10-18 night pass re-carried two items the 10-17 steer had ruled stale (#23/#25 as its FIRST-LINE oldest item; "Windows mount behind origin") and proposed a bulk inbox archive the skill forbids: the cross-check above only reads ledger HEADINGS. A focus.md line shaped exactly

```
- **"<item title as the pass wrote it>" is CLOSED|DONE|DECLINED|WRONG** — reason …
```

is now matched against each carried item (a shared #id is decisive when the verdict has one; otherwise ≥ 4 significant words and ≥ 60 % of the verdict title). CLOSED / DONE / DECLINED print `⛔ … do NOT re-carry` (re-carry only a still-open part an item bundles, e.g. the drop_scratch residue inside #23/#25). **WRONG** means a claim inside the item was refuted, not the item: it keeps the item OPEN even under a ledger ✓ — #58 had read "likely closed" off the heading that unscheduled its indexers, so the print said "0 still open" while Trevor's API key was the open part. **To retire a carried item for good, write the verdict in that shape** (`9d31f6622`, `__tests__/script-report-ready-queue.test.ts`). The session-start hook's local branch (10-17) runs the same print on the Windows box.
