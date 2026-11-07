import { describe, it, expect } from "vitest"
import { migrationFiles, newestDefinitions, type MigrationDef } from "./helpers/migration-defs"

// get_pack_realized_ev_row's `ev` leg (20261107000456) no longer reads the pack_ev_latest VIEW: it walks
// idx_pack_ev_history_collection_dist_time newest-first and stops at the first row passing the view's
// publish guards (dist 8783 cold: 3,354 buffers / 1,470 ms -> 17 / 0.95 ms; equivalence proved over every
// Top Shot dist — the migration header has the numbers).
//
// The price is the one 20260830032541 refused to pay: the guards are now COPIED. get_pack_market_row is
// how a copy drifts. This guard makes the copy un-driftable: the function must contain the view's newest
// FROM … WHERE and its gross_ev expression VERBATIM (whitespace-normalised). Change the view's guards
// without carrying them into the function and this reds.

const norm = (s: string) => s.replace(/\s+/g, " ").trim()

function viewFromWhere(view: MigrationDef): string {
  const b = view.body
  const from = b.search(/\bFROM\s+pack_ev_history\s+h\b/)
  const order = b.search(/\bORDER\s+BY\s+h\.pack_listing_id\b/)
  return from >= 0 && order > from ? norm(b.slice(from, order)) : ""
}

function viewGrossEv(view: MigrationDef): string {
  const m = view.body.match(/CASE\s+WHEN\s+h\.gross_ev\s*=\s*0::numeric[\s\S]*?END::numeric\(10,2\)\s+AS\s+gross_ev\b/)
  return m ? norm(m[0]) : ""
}

describe("get_pack_realized_ev_row's ev leg mirrors pack_ev_latest", () => {
  const defs = newestDefinitions(migrationFiles())
  const view = defs.get("pack_ev_latest")
  const fn = defs.get("get_pack_realized_ev_row")

  it("both objects are defined and live in migrations", () => {
    expect(view?.kind).toBe("VIEW")
    expect(view?.dropped).toBe(false)
    expect(fn?.kind).toBe("FUNCTION")
    expect(fn?.dropped).toBe(false)
  })

  it("the extraction found real text (a vacuous match cannot pass)", () => {
    const fw = viewFromWhere(view!)
    expect(fw.length).toBeGreaterThan(400)
    expect(fw).toMatch(/LEFT JOIN pack_ask_state a/)
    expect(fw).toMatch(/retail_price_usd/)
    expect(fw).toMatch(/3::numeric \* a\.lowest_ask/)
    expect(viewGrossEv(view!)).toMatch(/^CASE WHEN h\.gross_ev = 0::numeric AND h\.edition_count = 0 THEN NULL::numeric ELSE h\.gross_ev END::numeric\(10,2\) AS gross_ev$/)
  })

  it("the function carries the view's FROM … WHERE verbatim", () => {
    expect(norm(fn!.body)).toContain(viewFromWhere(view!))
  })

  it("the function carries the view's gross_ev expression verbatim", () => {
    expect(norm(fn!.body)).toContain(viewGrossEv(view!))
  })

  it("the leg is scoped to this dist and takes the newest row, with a deterministic tiebreak", () => {
    const body = norm(fn!.body)
    expect(body).toMatch(/AND h\.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND h\.dist_id = p_dist_id ORDER BY h\.snapshotted_at DESC, h\.pack_listing_id LIMIT 1/)
    // the old shape must not come back alongside it
    expect(body).not.toMatch(/FROM pack_ev_latest/)
  })
})
