import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// Source-level guard for a silent DATA-LOSS class fixed on 2026-07-25.
//
// A PostgREST/Postgres batch insert is ALL-OR-NOTHING: if ANY row in the batch
// violates a unique constraint the whole statement fails with 23505 and NONE of
// the batch is written. So this shape — which was live in FIVE forward sales
// indexers (candy, golazos, allday, ufc on both `sales` and `unmapped_sales`,
// and the topshot `sales-indexer`) — silently discarded every genuinely-new row
// that happened to share a batch with one duplicate:
//
//     const { error } = await supabaseAdmin.from("sales").insert(batch)
//     if (error) {
//       if (error.code === "23505") {
//         // dupes — already recorded      <-- WRONG: the NEW rows are gone too
//       } else {
//         ...row-by-row retry...           <-- unreachable for the dupe case
//       }
//     }
//
// On a cursored indexer the loss is PERMANENT: nothing lands, yet the block /
// high-water cursor advances past those rows anyway, so they are never retried.
//
// The fixed idiom logs only non-dupe errors and ALWAYS falls through to the
// row-by-row retry, so real duplicates fail individually and new rows land:
//
//     if (error.code !== "23505") console.log(...)
//     for (const row of batch) { ...insert(row)... }
//
// SCOPE: deliberately limited to `app/api/*sales-indexer/route.ts` — the
// copy-paste family the bug actually spread through, where `!== "23505"` is now
// the canonical shape. The `app/api/cron/*-sales-history-backfill` routes use a
// DIFFERENT but CORRECT idiom (`else if (code === "23505") { ...row-by-row... }`,
// i.e. the positive branch *is* the retry) and are intentionally not matched
// here — flagging them would be a false positive.
//
// This is a SOURCE property test rather than a behavioural fixture on purpose:
// the defect is a one-line branch trivially reintroduced by copy-paste across
// sibling indexers (exactly how it spread to five files), while a per-route
// end-to-end duplicate fixture for these Flow-CDC block-scanning routes would be
// far more machinery than the invariant it protects. It is directory-driven, so
// a NEW sales indexer added later is covered automatically.

const API_DIR = join(process.cwd(), "app", "api")

/** `app/api/*sales-indexer/route.ts` — the forward-indexer family. */
function salesIndexerRoutes(): { rel: string; src: string }[] {
  return readdirSync(API_DIR)
    .filter((d) => d.endsWith("sales-indexer"))
    .map((d) => ({ dir: d, path: join(API_DIR, d, "route.ts") }))
    .filter(({ path }) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    .map(({ dir, path }) => ({ rel: `app/api/${dir}/route.ts`, src: readFileSync(path, "utf8") }))
}

const POSITIVE_23505 = /(?:error|insertErr|err)\.code\s*===\s*"23505"/

describe("sales indexers — a 23505 must never swallow the batch", () => {
  it("is wired to the real indexer files (guard cannot silently detach)", () => {
    const rels = salesIndexerRoutes().map((f) => f.rel)
    for (const expected of [
      "app/api/sales-indexer/route.ts",
      "app/api/allday-sales-indexer/route.ts",
      "app/api/golazos-sales-indexer/route.ts",
      "app/api/ufc-sales-indexer/route.ts",
      "app/api/candy-sales-indexer/route.ts",
    ]) {
      expect(rels).toContain(expected)
    }
  })

  it("covers every known batch-insert site (8 across 5 routes as of 2026-07-25)", () => {
    const sites = salesIndexerRoutes().flatMap(({ rel, src }) =>
      src.split("\n").reduce<string[]>((acc, line, i) => {
        if (line.includes(".insert(batch)")) acc.push(`${rel}:${i + 1}`)
        return acc
      }, []),
    )
    // pinnacle-sales-indexer is excluded by construction: it uses
    // `.upsert(batch, { onConflict: "id", ignoreDuplicates: true })`, which does
    // not raise 23505 on a duplicate, so it has no all-or-nothing loss.
    expect(sites.length).toBeGreaterThanOrEqual(8)
  })

  it("no batch-insert error handler branches positively on 23505", () => {
    const offenders: string[] = []

    for (const { rel, src } of salesIndexerRoutes()) {
      const lines = src.split("\n")
      lines.forEach((line, idx) => {
        if (!line.includes(".insert(batch)")) return
        // The handler for this batch insert lives immediately below it.
        const handler = lines.slice(idx, idx + 14).join("\n")
        if (POSITIVE_23505.test(handler)) offenders.push(`${rel}:${idx + 1}`)
      })
    }

    expect(
      offenders,
      "A batch insert is all-or-nothing, so a positive `code === \"23505\"` branch " +
        "drops every co-batched NEW row (permanently — the cursor still advances). " +
        "Log non-dupe errors via `code !== \"23505\"` and ALWAYS fall through to the " +
        `row-by-row retry. Offending sites:\n${offenders.join("\n")}`,
    ).toEqual([])
  })

  it("every batch-insert site keeps a row-by-row retry reachable on error", () => {
    const missing: string[] = []

    for (const { rel, src } of salesIndexerRoutes()) {
      const lines = src.split("\n")
      lines.forEach((line, idx) => {
        if (!line.includes(".insert(batch)")) return
        const handler = lines.slice(idx, idx + 20).join("\n")
        const hasRetry =
          /\.insert\((?:row|sale|r)\)/.test(handler) || /insertIndividually\(/.test(handler)
        if (!hasRetry) missing.push(`${rel}:${idx + 1}`)
      })
    }

    expect(
      missing,
      `These batch inserts have no row-by-row retry, so any batch-level error loses ` +
        `the whole batch:\n${missing.join("\n")}`,
    ).toEqual([])
  })
})
