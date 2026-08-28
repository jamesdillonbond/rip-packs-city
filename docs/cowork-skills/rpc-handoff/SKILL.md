---
name: rpc-handoff
description: Use when packaging Rip Packs City work for Claude Code to ship — triggers on "write a handoff", "Claude Code handoff", "hand this off", "package for Claude Code", or whenever a change touches route/.tsx/worker code that Cowork can't push to git itself. Produces a standardized handoff doc (normal markdown, read on desktop) with per-item revert paths.
---

# RPC Claude Code handoff packager

Cowork can ship DB migrations and Supabase edge functions live, but it has no git credentials, so **route code, `.tsx`, and `workers/*` changes must be handed to Claude Code on Trevor's machine.** This skill produces that handoff in the exact format that has proven to work.

## Output rules

- **Normal markdown is fine, including fenced code blocks** — handoffs are read and pasted on desktop (PowerShell / Git Bash), not a phone. Use code fences for multi-line commands or file contents where they aid readability; inline file paths and short identifiers stay inline.
- **Full file replacements, not diffs/snippets** (per CLAUDE.md code conventions). If a change is large, describe the precise edit location by surrounding lines, not a patch.
- **Save to** `docs/handoff-YYYY-MM-DD-<topic>.md` and present it with `present_files`.

## Required sections

1. **Context (2-3 lines).** What's already shipped live by Cowork (migrations/edge fns, with names) vs. what this handoff covers. State the current HEAD commit if known.
2. **Per item, in priority order:**
   - File path(s) touched — **grep/verify they exist first; never inference-write a file list** (real friction was caused by naming non-existent files like `lib/flow-helpers.ts`).
   - What changes and *why* (the root cause, not just the symptom).
   - Verified counts where relevant (caller count via grep, affected row count via a read-only query) — state how you verified.
   - **Exact revert path** (commit to revert, or the inverse migration/command).
   - Expected verification: `npx tsc --noEmit` clean, the Vercel deploy reaching READY, and which smoke test should pass.
3. **Guardrails to repeat in every handoff:**
   - Direct-to-`main`, no branches, no PRs (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, switch to `main` first.
   - Commit via PowerShell `git` on Windows (Git Bash `git commit` can silently no-op). Re-verify the push with `git rev-list --count origin/main..HEAD` (expect 0).
   - `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
   - Vercel Pro `maxDuration` hard cap is **800s** — anything higher sends the deploy to ERROR invisibly.
   - CRLF: don't string-replace-patch on Windows; use full-file writes or `findIndex` on split lines.
4. **Let Claude Code correct false premises.** Add the line: "Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape." (A prior handoff described a wrong file shape and the fix was to let CC adapt.)
5. **Close with** a one-line summary of expected end state (commit on main, deploy READY, metric moved).

## Patch-set delivery — the mode actually in use, and five rules paid for in rework

The "full file replacements" rule above is for *described* changes. In practice most Cowork handoffs
now ship a `git format-patch` set, and every one of these rules cost real rework on Trevor's box.

1. **Give the EXACT absolute path of the `.patch` file, never `path/to/…`.** ⚠ **The patch text
   pasted into chat CAN TRUNCATE mid-file; the delivered file does not.** On 2026-08-28 a 24,065-byte
   patch sat complete in `…\Rip Packs City\cowork-2026-08-28b\` while its pasted copy cut off inside
   `scripts/fix-inbox-index-counts.mjs`, and it was reconstructed by hand from the intact hunks.
   **State in APPLY.md: the file is authoritative, the paste is a preview.** Include the patch's
   **byte size and `sha256`** so a reconstruction can be checked in one command.
2. **Full filenames in the `git am` line — NEVER a `000*` glob.** A glob silently applied 9 of 10
   patches and **exited 0**; it was caught only by counting commits against the manifest.
3. **Any number in a patch that describes MUTABLE state is stale on arrival.** Deriving it correctly
   at authoring time does not help — a patch is a snapshot. Ship the DERIVATION (e.g.
   `npm run inbox:index:fix`) and have the applier run it. `main` moved four times during one session.
4. **Verify by `git am --3way` onto a FRESH CLONE of `origin/main`, then run the guards IN THE
   APPLIED TREE** — not in the authoring tree, and never quote the authoring tree's numbers.
   ⚠ **But a clean clone is blind to untracked working-tree state:** `inbox-index-lists-every-filing`
   read 5/5 in a clone while it was 2/5 red on the box, because an untracked filing does not clone.
   **Say which state a green result proves.**
5. **Expect a ledger conflict on every rebase** — both sides insert at the top of
   `docs/overnight/ledger.md`. Resolve by re-splicing your entries above upstream's newest heading,
   **never by hand-editing conflict markers**, and re-run `find-clobbered-ledger-headings.mjs` against
   `origin/main` afterwards. ⚠ A resolver that re-splices the whole accumulated block on the FIRST
   conflict leaves later commits empty and silently squashes them — check `git rev-list --count`
   against the number of commits you expected.

⛔ **Scope every no-push note.** Write: *"This blocker is specific to this cloud session. Trevor's
machine and Claude Code push normally via the PAT in `remote.origin.pushurl`. Commit these files as
usual."* Omitting it once left two applied migrations uncommitted for ~18 hours.

## Before writing

- Skim `docs/overnight/ledger.md` so the handoff doesn't collide with queued/declined items or with the nightly autonomous pass (which won't touch files committed in the last 24-48h).
- If the work should be paused (launch / risky refactor), note whether `docs/FREEZE.md` should exist.
