import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import path from "path"

// ARCHITECTURE GUARD — PostgREST 1000-row cap regression pins.
//
// PostgREST caps every read at 1000 rows and CLAMPS an explicit `.limit(N>1000)`
// down to 1000; a *bare* unbounded `.select()` clamps at 1000 too. Reading raw
// `fmv_snapshots` ordered `computed_at DESC` and de-duping latest-per-edition in
// JS is the classic trap — ~4,200 TS snapshots/day means the 1000-row window
// only covers a few hundred editions, so editions past the window silently
// vanish. The count-vs-length trap is the sibling: request `{count:"exact"}`
// then read `rows.length` for a total and the "total" silently caps at 1000.
//
// This class bit production at least four times (CLAUDE.md 2026-07-19/20):
//   - rtr/lock-roi whale wmc ranked over only the first 1000 of a wallet's moments
//   - profile/watchlist + watchlist dropped FMV/floor for collectors past the cap
//     (a null floor there also makes `below_target` read false — alerts stop firing)
//   - concierge FMV distribution dropped ~34% of editions from p10/p50/p90
//   - market/loadEditionLookup mapped only 1000 of ~19k TS editions (null links + no badges)
//   - profile/market-pulse `snapshotsToday` reported 4,243 as exactly 1000 (count-vs-length)
//   - sets-db accumulator never called `.set()` → 0 owned / 0% completion for 3 months
//
// Each was fixed by switching to the `fmv_current` view (DISTINCT ON
// (edition_id) latest, <=1 row/edition), `.range()` pagination, or reading the
// returned `count` with `head:true`. This guard reads each fixed route/lib
// source and asserts the safe pattern is still present, so a refactor that
// reintroduces the raw-DESC / length-as-total read fails here instead of in prod.

const REPO = process.cwd()
const read = (...p: string[]) => readFileSync(path.join(REPO, ...p), "utf8")

describe("invariant: PostgREST 1000-row cap fixes stay fixed", () => {
  it("rtr/lock-roi reads current FMV from fmv_current and pages wmc with .range()", () => {
    const src = read("app", "api", "rtr", "lock-roi", "route.ts")
    // latest-per-edition FMV must come from the DISTINCT ON view, not a raw
    // fmv_snapshots DESC scan that clamps at 1000.
    expect(src).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
    // the whale-wmc read must paginate, or a 5,320-moment wallet is ranked over
    // only its first 1000 moments.
    expect(src).toMatch(/\.range\(/)
  })

  // Both watchlist routes now read fmv_current through the chunked helper
  // selectInChunks(client, "fmv_current", …) rather than a bare .from(...) — the
  // helper runs the .in() in 500-value slices so an uncapped watchlist can't lose
  // FMV/floor past the 1000-row cap. Either form (direct .from or the helper's
  // "fmv_current" table arg) satisfies the invariant: read fmv_current, never
  // raw fmv_snapshots.
  const READS_FMV_CURRENT =
    /\.from\(\s*["']fmv_current["']\s*\)|selectInChunks\([^)]*["']fmv_current["']/

  it("profile/watchlist reads FMV from fmv_current (no size-cap on a watchlist)", () => {
    const src = read("app", "api", "profile", "watchlist", "route.ts")
    expect(src).toMatch(READS_FMV_CURRENT)
  })

  it("watchlist reads FMV from fmv_current (no size-cap on a watchlist)", () => {
    const src = read("app", "api", "watchlist", "route.ts")
    expect(src).toMatch(READS_FMV_CURRENT)
  })

  it("concierge FMV distribution reads the multi-edition set from fmv_current", () => {
    const src = read("lib", "concierge", "fmv-distribution.ts")
    // the distribution (many-edition) path must use fmv_current; the single
    // edition path legitimately keeps a raw fmv_snapshots read with .limit(1).
    expect(src).toMatch(/\.from\(\s*["']fmv_current["']\s*\)/)
    expect(src).toMatch(/\.limit\(\s*1\s*\)/)
  })

  it("profile/market-pulse counts snapshots via count+head, never rows.length", () => {
    const src = read("app", "api", "profile", "market-pulse", "route.ts")
    // must request an exact head count and assign from `count`, not `.length`.
    expect(src).toMatch(/count:\s*["']exact["']/)
    expect(src).toMatch(/head:\s*true/)
    // ⚠ Assigned from `count` — the FALLBACK is deliberately not pinned. This read
    // `count \?\? 0` and was widened when that `?? 0` was fixed to `?? null`: a
    // failed count published a hard 0, i.e. "nothing was snapshotted today", from
    // our own outage. The property this guard exists for is count-not-.length, and
    // pinning the exact fallback made it fire on a strictly better spelling.
    expect(src).toMatch(/snapshotsToday\s*=\s*(?:\w+\s*\?\s*null\s*:\s*)?count\s*\?\?\s*(?:0|null)/)
    // guard the specific regression: snapshotsToday must never be set from a
    // .length read of a fetched snapshot array.
    expect(src).not.toMatch(/snapshotsToday\s*=\s*\w*[Ss]naps?\w*\.length/)
  })

  it("market/loadEditionLookup pages the full catalog with .range() (not a 1000-row slice)", () => {
    const src = read("app", "api", "market", "route.ts")
    expect(src).toMatch(/function loadEditionLookup/)
    // the lookup builder must paginate; a bare .select() would map only 1000 of ~19k editions.
    expect(src).toMatch(/\.range\(/)
  })

  it("sniper-feed's All Day FMV map is bounded by an edition-id list", () => {
    const src = read("app", "api", "sniper-feed", "route.ts")
    // 2026-07-25: the AllDay leg built its FMV map from a raw, UNBOUNDED
    // `fmv_snapshots.eq(collection_id).order(computed_at DESC)` read, justified
    // by a comment claiming AD had "~341 rows". Live: 306,895 snapshot rows over
    // 6,190 editions, so the 1000-row cap left the map holding only a few
    // hundred editions — and since a missing FMV now EXCLUDES a listing rather
    // than pricing it off its own ask, a truncated map drops most of the board.
    // This slipped past the preventive guard below because that allowlist is
    // per-FILE and this route was listed for its other, .in()-bounded TS read.
    //
    // ⚠ NARROWED TO THE FUNCTION 2026-09-02. This used to assert
    // `.from("fmv_current")` and `.range(` against the WHOLE FILE, which is the
    // vacuous shape this repo keeps re-learning: when the All Day leg moved off
    // the view entirely, both patterns still matched — the Top Shot leg's
    // `fmv_current` read and the jersey read's `.range(` — so a case titled for
    // All Day would have gone on passing with the All Day read deleted. Slice the
    // function the title names.
    const start = src.indexOf("async function computeAllDaySniperFeed(")
    expect(start, "computeAllDaySniperFeed not found").toBeGreaterThan(-1)
    const body = src.slice(start, src.indexOf("\n}\n", start))
    expect(body).toMatch(/get_editions_latest_fmv/)
    expect(body).toMatch(/p_edition_ids:\s*chunk/)
    // the editions read that now carries the cap is itself keyset-paged
    expect(body).toMatch(/\.gt\(\s*["']id["']\s*,\s*edCursor\s*\)/)
    // and the stale premise must not come back
    expect(src).not.toMatch(/fmv_snapshots is small for AllDay/)
  })

  it("sets-db writes the owned-by-set accumulator back into the Map (.set())", () => {
    const src = read("app", "api", "sets-db", "route.ts")
    // the 3-month 0%-completion bug: the code built `const list = map.get(id) ?? []`
    // and pushed, but never `map.set(id, list)`, so a fresh key was discarded.
    expect(src).toMatch(/ownedBySet\.set\(/)
  })
})

// PREVENTIVE GUARD (the sibling of the regression pins above).
//
// The pins above lock the ALREADY-FIXED sites. This block stops the NEXT one:
// it freezes the set of files that read raw `fmv_snapshots` ordered
// `computed_at DESC` and fails when a new file joins that set. Reading raw
// fmv_snapshots DESC and de-duping latest-per-edition in JS is the exact trap
// that bit prod repeatedly — the 1000-row window covers only a few hundred of
// ~26k editions, so any read that spans more than a bounded edition set silently
// drops rows. `fmv_current` (DISTINCT ON (edition_id) ... computed_at DESC,
// <=1 row/edition) is the safe replacement for cross-edition reads.
//
// This guard does NOT try to judge safety statically (many of the allowlisted
// files ARE safe — they scope to one edition via .eq("edition_id") / .limit(1)).
// It makes every NEW raw-DESC fmv_snapshots read a conscious, reviewed decision:
// when this test fails on your file, either
//   (a) switch the read to `fmv_current` (the default answer for anything that
//       spans multiple editions), or
//   (b) if the read is genuinely bounded to one edition / a small .in() set,
//       add the file to RAW_FMV_DESC_ALLOWLIST below with a one-line reason.
const RAW_FMV_DESC_ALLOWLIST: ReadonlySet<string> = new Set([
  // "app/api/alerts/route.ts" — REMOVED 2026-08-09 (deep-audit D27). It was the
  // multi-edition case this allowlist warns about: a raw fmv_snapshots DESC read
  // deduped first-wins in JS, against ~87 daily rows per edition and a 1000-row
  // cap, so the window covered ~11 editions. Now reads fmv_current, chunked.
  "app/api/cron/compute-laliga-pack-ev/route.ts",
  "app/api/cron/stale-fmv-monitor/route.ts",
  "app/api/edition-floor/route.ts",
  "app/api/edition-history/route.ts",
  "app/api/fmv-recalc/route.ts",
  "app/api/fmv/demo/route.ts",
  "app/api/fmv/route.ts",
  "app/api/sentinel/route.ts",
  "app/api/sniper-feed/route.ts",
  "app/api/support-chat/route.ts",
  "lib/concierge/fmv-distribution.ts",
  // lib/market-sources.ts removed 2026-07-27: getSupabaseMarketMap no longer
  // reads a raw global fmv_snapshots DESC window — it now scopes to the
  // requested editions via the fmv_current view.
  // wallet/seed removed 2026-07-31: its enrichStandard FMV read moved to the
  // fmv_current view + chunked .in(). Its editions lookup was also unchunked
  // AND dropped the error, so a failed/capped lookup silently degraded to
  // "no editions matched" and the caller wrote bare rows (edition_key NULL,
  // serial NULL) for every moment — 5,426/5,477 on one wallet.
  // Removed 2026-07-29 (migrated to the fmv_current view — the 1000-row-cap fix):
  // allday-pack-ev, allday-wallet-search, cache-refresh, golazos-sniper-feed,
  // pack-ev, wallet-search. sniper-feed + fmv/route STAY: they retain a legitimate
  // raw fmv_snapshots read the guard still matches (fmv/route GET is .limit(1);
  // sniper-feed keeps "fmv_snapshots" confidenceSource literals + an unrelated
  // ingested_at DESC).
])

function walkTs(dir: string, acc: string[] = []): string[] {
  let entries: import("fs").Dirent[]
  try {
    entries = readdirSync(path.join(REPO, dir), { withFileTypes: true })
  } catch {
    return acc
  }
  for (const e of entries) {
    const rel = `${dir}/${e.name}`
    if (e.isDirectory()) walkTs(rel, acc)
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) acc.push(rel)
  }
  return acc
}

describe("preventive guard: no NEW raw fmv_snapshots DESC reads outside the allowlist", () => {
  it("every file reading fmv_snapshots ordered computed_at DESC is on the reviewed allowlist", () => {
    const files = [...walkTs("app/api"), ...walkTs("lib")]
    const offenders: string[] = []
    for (const rel of files) {
      const src = readFileSync(path.join(REPO, rel), "utf8")
      const readsFmvSnapshots = /["']fmv_snapshots["']/.test(src)
      const ordersDesc = /ascending:\s*false/.test(src)
      const touchesComputedAt = /computed_at/.test(src)
      if (readsFmvSnapshots && ordersDesc && touchesComputedAt && !RAW_FMV_DESC_ALLOWLIST.has(rel)) {
        offenders.push(rel)
      }
    }
    expect(
      offenders,
      `New raw fmv_snapshots DESC read(s) detected: ${offenders.join(", ")}. ` +
        `Use the fmv_current view (DISTINCT ON (edition_id) latest) for cross-edition reads, ` +
        `or add the file to RAW_FMV_DESC_ALLOWLIST with a one-line justification if it is bounded to a single edition.`,
    ).toEqual([])
  })

  it("the allowlist has no stale entries (every allowlisted file still matches the pattern)", () => {
    // keeps the allowlist honest: a file that stopped reading raw DESC (e.g.
    // migrated to fmv_current) must be removed so it can't mask a future regression.
    const stale: string[] = []
    for (const rel of RAW_FMV_DESC_ALLOWLIST) {
      let src: string
      try {
        src = readFileSync(path.join(REPO, rel), "utf8")
      } catch {
        stale.push(`${rel} (missing)`)
        continue
      }
      const matches =
        /["']fmv_snapshots["']/.test(src) && /ascending:\s*false/.test(src) && /computed_at/.test(src)
      if (!matches) stale.push(rel)
    }
    expect(stale, `Stale RAW_FMV_DESC_ALLOWLIST entries — remove them: ${stale.join(", ")}`).toEqual([])
  })
})
