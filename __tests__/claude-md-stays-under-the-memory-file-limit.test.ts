import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"

// CLAUDE.md is loaded as a memory file, and the limit is
// `max(40000, contextWindow × 0.05 × charsPerToken)` — 40,000 on a standard
// 200k session, which is what the nightly pass, Cowork and every subagent run
// at. Over the limit the whole file is flagged and stops being trustworthy
// context, which is a silent, total loss of the project's memory rather than a
// visible error.
//
// Until this guard, NOTHING in the repo measured that. The limit was enforced
// only by the harness at load time, so a session that pushed the file over
// would see CI green and lose the file. Two sessions were editing CLAUDE.md
// concurrently on 2026-08-22, both within ~100 characters of the ceiling, which
// is what made the gap worth closing.
//
// ⚠ THE UNIT IS THE POINT. The limit is on CHARACTERS; `wc -c` counts BYTES,
// and this file runs several hundred bytes longer than it is characters because
// `⚠ — ·` are multi-byte. `wc -c` once read 40,086 on a file whose true length
// was 39,610 and nearly triggered an emergency trim. `wc -m` is
// platform-dependent. Node's `String.length` is the binding instrument, so that
// is what this asserts.
//
// When this fails, the fix is NOT to delete a rule. It is the one CLAUDE.md
// prescribes for itself: move the displaced text VERBATIM into the matching
// docs/reference/*.md and leave a one-line pointer behind.

const LIMIT = 40_000

// Non-vacuity floor. A truncated, emptied or moved CLAUDE.md would otherwise
// satisfy the ceiling trivially and this guard would reward the failure it
// exists to catch.
const FLOOR = 20_000

describe("CLAUDE.md stays inside the memory-file character limit", () => {
  const raw = readFileSync(path.join(process.cwd(), "CLAUDE.md"), "utf8")

  it("is at or under the 40,000-character limit, measured in characters", () => {
    const chars = raw.length
    expect(
      chars,
      `CLAUDE.md is ${chars} characters, ${chars - LIMIT} over the ${LIMIT} limit. ` +
        `Do not delete a rule to fix this: move text VERBATIM into the matching docs/reference/*.md ` +
        `and leave a one-line pointer, exactly as CLAUDE.md's own header prescribes.`,
    ).toBeLessThanOrEqual(LIMIT)
  })

  it("is still a substantial file, so the ceiling above is not satisfied by an empty one", () => {
    expect(raw.length).toBeGreaterThan(FLOOR)
  })

  it("measures characters, not bytes — the two differ on this file", () => {
    // This is a property of the file, not a preference: if it ever became pure
    // ASCII the two would coincide and the ceiling assertion would be safe
    // under either unit. While they differ, `wc -c` is the wrong instrument and
    // this arm is the evidence for saying so.
    const bytes = Buffer.byteLength(raw, "utf8")
    expect(bytes).toBeGreaterThan(raw.length)
  })
})
