import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join, sep, posix } from "node:path"

// ── Every path-shaped markdown link in LIVE docs must RESOLVE ────────────────
// This project's memory architecture is a bet that CLAUDE.md can stay small
// because the detail moved into docs/reference/*.md with a pointer left behind.
// `scripts/check-memory-doc-links.mjs` guards that bet for CLAUDE.md and
// docs/reference. NOTHING guarded the far larger surface: the ledger, handoffs,
// audits, integrations and inbox filings, which cite each other by path
// constantly.
//
// ⚠ A DEAD POINTER DOES NOT RENDER AS BROKEN — it reads as a detail that was
// never written, which is exactly what CLAUDE.md's header tells a reader NOT to
// conclude ("a rule that feels missing is in one of those files").
//
// ── WHY IT EXISTS: measured rot, and a queued action that would have added more
// Measured 2026-09-02: 88 broken links in live docs, 79 of them mechanically
// repairable to a single unambiguous target. The dominant cause was dated
// handoffs moving from `docs/` to `docs/archive/handoffs/` while every `../`
// citation to them stayed put. All 79 were repaired; this guard is what stops
// the next 79.
//
// The same sweep found the sharper case. `docs/overnight/inbox/` is APPEND-ONLY
// (focus.md, 2026-08-17) because filings are permanent citation targets, and
// `inbox-is-append-only-since-the-rule` bans filings dated on/after the rule
// from `archive/`. But 93 PRE-rule filings are unguarded, 52 of them are cited
// by exact path from outside inbox/, and archiving has ALREADY rotted five
// full-path citations — four of which sit in frozen history or an immutable
// migration and can NEVER be repaired. A handoff on `main` was still queueing
// "archive the backlog" when this was written.
//
// ── WHY FROZEN ROOTS ARE EXCLUDED, AND WHY THAT IS NOT A LOOPHOLE ───────────
// CLAUDE.md: "docs/archive/**, docs/health/** and docs/sessions/** are frozen
// history — never rewrite their links." 164 broken links live there. A guard
// that fired on them could never be cleared by any permitted action, and this
// repo has just diagnosed what that produces: a permanently-red instrument that
// desensitises every reader (the fleet sentinel, CRITICAL for days on one arm).
// So the exclusion is not "these do not matter" — it is "no legal edit clears
// these", which is the only honest reason to exclude anything.
const FROZEN = [
  /^docs\/sessions\//,
  /^docs\/archive\//,
  /^docs\/health\//,
  /^docs\/overnight\/ledger-archive-/,
]

/** Windows `join` emits `\`; every path this file reports or compares is posix. */
const toPosix = (p: string) => p.split(sep).join("/")

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith(".md")) out.push(toPosix(p))
  }
  return out
}

type Link = { file: string; href: string; frozen: boolean; resolves: boolean }

function collectLinks(): { links: Link[]; skippedBare: number } {
  const files = walk("docs")
  if (existsSync("CLAUDE.md")) files.push("CLAUDE.md")

  const links: Link[] = []
  let skippedBare = 0

  for (const file of files) {
    const src = readFileSync(file, "utf8")
    for (const m of src.matchAll(/\]\(([^)\s]+\.md)(?:#[^)\s]*)?\)/g)) {
      const href = m[1]
      if (/^https?:/.test(href)) continue

      // ⚠ Two deliberate skips, both about pointers that are NOT repo paths.
      // `[[name]]`-style bare basenames (546 of them) address the SEPARATE
      // claude.ai project memory store, which this repo does not contain — see
      // the two-memory-stores note. And `.../memory/x.md` is a prose ellipsis,
      // not a relative path. Resolving either against the repo would invent
      // failures for links that were never repo-relative.
      if (href.startsWith("...")) continue
      if (!href.includes("/")) {
        skippedBare++
        continue
      }

      const rel = posix.normalize(posix.join(posix.dirname(file), href))
      links.push({
        file,
        href,
        frozen: FROZEN.some((r) => r.test(file)),
        // repo-root-relative spellings appear too; accept either resolution
        resolves: existsSync(rel) || existsSync(href),
      })
    }
  }
  return { links, skippedBare }
}

describe("markdown links in live docs resolve", () => {
  it("inspects a real population — it cannot pass by looking at nothing", () => {
    const { links, skippedBare } = collectLinks()

    // ⚠ ASSERT THE COUNT INSPECTED. A guard whose walk silently returns [] exits
    // green and reads as coverage; that has happened in this repo (a staged-only
    // default inspected nothing on a CI checkout). 806 path-shaped links were
    // present when this was written — the floor is deliberately well under that
    // so ordinary doc churn does not red it, but far above zero.
    expect(
      links.length,
      `the link walk collected ${links.length} path-shaped links — it should see hundreds. ` +
        `A collapse to ~0 means the walk broke, not that the docs got clean.`,
    ).toBeGreaterThan(500)

    // Both categories must be non-empty, or an exclusion is quietly doing nothing.
    expect(links.some((l) => l.frozen)).toBe(true)
    expect(links.some((l) => !l.frozen)).toBe(true)
    expect(skippedBare).toBeGreaterThan(0)

    // The ledger is the densest citation surface; if it contributes no links the
    // walk has stopped reaching the file this guard most exists for.
    expect(
      links.some((l) => l.file === "docs/overnight/ledger.md"),
      "docs/overnight/ledger.md contributed no links — the walk is not reaching it",
    ).toBe(true)
  })

  it("has no broken path-shaped link in any non-frozen doc", () => {
    const { links } = collectLinks()
    const broken = links
      .filter((l) => !l.frozen && !l.resolves)
      .map((l) => `${l.file}  ->  ${l.href}`)

    // Ban at zero, not a ratchet: measured 0 on 2026-09-02 after repairing 79.
    expect(
      broken,
      `Broken markdown link(s) in live docs. A dead pointer reads as "never written",\n` +
        `not as an error, so nothing else will catch this.\n` +
        `⛔ If a link broke because a file was MOVED, prefer moving it back or leaving a\n` +
        `stub — docs/overnight/inbox/ in particular is APPEND-ONLY precisely because its\n` +
        `filings are cited from immutable migrations and live routes.\n\n` +
        broken.join("\n"),
    ).toEqual([])
  })

  it("leaves frozen history alone — its broken links are excluded, not repaired", () => {
    const { links } = collectLinks()
    const frozenBroken = links.filter((l) => l.frozen && !l.resolves)

    // ⭐ This asserts the EXCLUSION IS LOAD-BEARING. If frozen history ever
    // reaches zero broken links, someone has been rewriting it — which CLAUDE.md
    // forbids — and this test should be revisited rather than silently passing.
    expect(
      frozenBroken.length,
      "frozen history now has ZERO broken links. Either it was rewritten (forbidden) " +
        "or the FROZEN patterns stopped matching. Re-derive before trusting this guard.",
    ).toBeGreaterThan(0)
  })
})
