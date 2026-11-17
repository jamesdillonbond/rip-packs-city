import { describe, it, expect } from "vitest"
import { verdict } from "../scripts/git-unstick-index-lock.mjs"

// The decision rule for clearing a .git/index.lock, pinned as a pure function.
//
// ⛔ WHY THE REFUSALS MATTER MORE THAN THE SUCCESS. This script DELETES a file
// git uses to serialise writes. Getting "stale" wrong on a lock a parallel
// session is really holding corrupts that session's index. So every arm below is
// a REFUSAL except one, and the one success requires all three signals to agree.
//
// ⭐ The rule is not age-based, deliberately: the 2026-09-05 recurrence was a
// 0-byte lock only 76 SECONDS old, so "a real in-flight lock is seconds old"
// argues to leave it — wrongly. Age is a hint; these three are the verdict.

const FROZEN = 1_700_000_000_000

describe("git-unstick verdict", () => {
  it("declares STALE only when all three signals agree", () => {
    const v = verdict({ bytes: 0, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(true)
    expect(v.reasons).toEqual([])
  })

  it("REFUSES when the lock has content — a live git wrote to it", () => {
    const v = verdict({ bytes: 42, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("42 bytes")
  })

  it("REFUSES when a git process is running — there IS a holder", () => {
    const v = verdict({ bytes: 0, procs: 1, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("git process")
  })

  // 🚨 THE FAIL-CLOSED ARM. If the process probe itself breaks, "no processes
  // found" and "could not look" are the same value unless this is explicit —
  // and treating a broken probe as an all-clear is exactly the shape that turns
  // a diagnostic into a data-loss tool.
  it("REFUSES when the process probe FAILED — a broken probe is not an all-clear", () => {
    const v = verdict({ bytes: 0, procs: null, mtimeA: FROZEN, mtimeB: FROZEN })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("refusing to guess")
  })

  it("REFUSES when the mtime advanced — something is progressing", () => {
    const v = verdict({ bytes: 0, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN + 1000 })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("mtime advanced")
  })

  it("names EVERY disagreeing signal, not just the first", () => {
    const v = verdict({ bytes: 9, procs: 2, mtimeA: FROZEN, mtimeB: FROZEN + 1 })
    expect(v.stale).toBe(false)
    expect(v.reasons.length).toBe(3)
  })
})

// ── Not only index.lock (2026-09-18) ────────────────────────────────────────
// A Cowork commit against the mount left a stale `.git/HEAD.lock` for ~40 min:
// the commit had SUCCEEDED and only the cleanup unlink failed (the mount refuses
// deletes until approved). That lock is not zero bytes — it holds the new ref
// value, identical to the target it became. So signal 1 has a second, narrower
// satisfier for ref-style locks: content EQUAL to the target's. Content that
// differs is still a write in flight and is still refused.
describe("git-unstick: ref-style locks and the walk", () => {
  it("a ref lock whose content equals its target is STALE (a finished write whose cleanup died)", () => {
    const v = verdict({ bytes: 41, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN, contentMatchesTarget: true })
    expect(v.stale).toBe(true)
  })

  it("REFUSES a ref lock whose content differs from its target — that is a write in flight", () => {
    const v = verdict({ bytes: 41, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN, contentMatchesTarget: false })
    expect(v.stale).toBe(false)
    expect(v.reasons.join(" ")).toContain("differs from its target")
  })

  it("content equality does NOT override the other two signals", () => {
    expect(verdict({ bytes: 41, procs: 1, mtimeA: FROZEN, mtimeB: FROZEN, contentMatchesTarget: true }).stale).toBe(false)
    expect(verdict({ bytes: 41, procs: 0, mtimeA: FROZEN, mtimeB: FROZEN + 1, contentMatchesTarget: true }).stale).toBe(false)
  })

  it("walks every *.lock under .git except objects/ — index, HEAD, packed-refs and ref locks alike", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { findLocks } = await import("../scripts/git-unstick-index-lock.mjs")
    const dir = mkdtempSync(join(tmpdir(), "unstick-"))
    mkdirSync(join(dir, "refs", "heads"), { recursive: true })
    mkdirSync(join(dir, "objects", "pack"), { recursive: true })
    for (const f of ["index.lock", "HEAD.lock", "packed-refs.lock", "refs/heads/main.lock", "objects/pack/x.lock", "HEAD", "config"]) {
      writeFileSync(join(dir, f), "")
    }
    expect(findLocks(dir)).toEqual(["HEAD.lock", "index.lock", "packed-refs.lock", "refs/heads/main.lock"])
  })

  it("NO-CHANGE CONTROL: a clean git dir yields no candidates", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { findLocks } = await import("../scripts/git-unstick-index-lock.mjs")
    const dir = mkdtempSync(join(tmpdir(), "unstick-clean-"))
    writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n")
    expect(findLocks(dir)).toEqual([])
  })
})
