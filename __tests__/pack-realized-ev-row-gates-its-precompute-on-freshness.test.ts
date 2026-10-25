import { describe, it, expect } from "vitest"
import { migrationFiles, newestDefinitions } from "./helpers/migration-defs"

// get_pack_realized_ev_row (the pack page's realized-vs-modeled EV row) reads mv_topshot_pack_rip_values
// since 20261025170047 — 33 ms instead of ~11 s on the largest dist. A precompute read without a freshness
// gate renders a stuck refresh as current numbers, so the function must take the MV only while a
// successful `topshot-pack-rip-values` run is recent, and fall back to the live read otherwise; and the
// refresh must keep logging that run, or the gate can never open (and, worse, a removed gate goes unseen).

describe("get_pack_realized_ev_row gates its precompute on a logged refresh", () => {
  const defs = newestDefinitions(migrationFiles())

  it("reads the MV only behind a pipeline_runs freshness check, with a live fallback", () => {
    const body = defs.get("get_pack_realized_ev_row")?.body ?? ""
    expect(body).toMatch(/mv_topshot_pack_rip_values/)
    expect(body).toMatch(/pipeline_runs[\s\S]*'topshot-pack-rip-values'[\s\S]*\.ok[\s\S]*now\(\)\s*-\s*interval/)
    expect(body).toMatch(/NOT\s+\(SELECT\s+ok\s+FROM\s+fresh\)[\s\S]*topshot_pack_rip_attribution/)
  })

  it("the refresh logs the run the gate reads", () => {
    // the function's own $function$ body only — the migration's DO block after it says RAISE EXCEPTION
    const def = defs.get("refresh_topshot_pack_rip_values")?.body ?? ""
    const body = def.split("$function$")[1] ?? ""
    expect(body).toMatch(/REFRESH\s+MATERIALIZED\s+VIEW\s+CONCURRENTLY\s+public\.mv_topshot_pack_rip_values/i)
    expect((body.match(/log_pipeline_run\('topshot-pack-rip-values'/g) ?? []).length).toBe(1)
    // 20261025170715: a failure must RAISE (cron reads it as failed), never be swallowed into an ok=false row
    expect(body).not.toMatch(/\bEXCEPTION\b/i)
  })
})
