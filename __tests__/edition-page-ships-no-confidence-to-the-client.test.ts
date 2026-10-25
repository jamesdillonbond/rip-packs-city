import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// 2026-10-25: FmvHistoryChart (a client component) received the raw history rows,
// `confidence` included. It never RENDERS it — so no-user-facing-fmv-confidence, which bans
// rendered shapes, could not see it — but React serializes client props into the page, and
// every edition page's public HTML carried the internal tier word ("STALE" ×5 on
// /nba-top-shot/edition/247:8459::22, read from production). FMV confidence is internal
// (concierge rule 3; the JSON API keeps its field). The server page now nulls it.
//
// ⚠ Narrow by design: a general "no tier inside any client prop" walk would need type
// information. If you pass FMV rows to ANOTHER client component, null `confidence` there too.

const SRC = stripComments(readFileSync("app/(collections)/[collection]/edition/[slug]/page.tsx", "utf8"))

describe("the edition page ships no FMV confidence to the client chart", () => {
  it("passes history rows with confidence nulled, never the raw rows", () => {
    const call = SRC.match(/<FmvHistoryChart[\s\S]*?\/>/)
    expect(call, "FmvHistoryChart call not found").not.toBeNull()
    expect(call![0]).toMatch(/initial=\{history\.rows\.map\(\(r\) => \(\{ \.\.\.r, confidence: null \}\)\)\}/)
    expect(call![0]).not.toMatch(/initial=\{history\.rows\}/)
  })
})
