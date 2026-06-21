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

## Before writing

- Skim `docs/overnight/ledger.md` so the handoff doesn't collide with queued/declined items or with the nightly autonomous pass (which won't touch files committed in the last 24-48h).
- If the work should be paused (launch / risky refactor), note whether `docs/FREEZE.md` should exist.
