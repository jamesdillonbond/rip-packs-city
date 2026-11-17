import { describe, it, expect } from "vitest"
import { summariseMaintenanceLoad } from "@/lib/sentinel/maintenance-load"

// The state the instance was in on 2026-09-13 from ~10:37 PT: the first-ever
// autovacuum of pg_toast_51873 (net._http_response's 12.4 GB TOAST) in
// IO/DataFileRead for hours, every arm reporting a symptom and none the cause.
// lib/sentinel/maintenance-load.ts carries the argument; these pin the contract.

const idle = (over: Record<string, unknown> = {}) => ({
  vacuums: [],
  clusters: [],
  index_builds: [],
  autovacuum_workers: 0,
  autovacuum_max_workers: 3,
  io_waiters: 1,
  measured_at: "2026-09-13T18:56:01Z",
  ...over,
})

// The real 11:56 PT payload, verbatim from check_maintenance_load().
const toastVacuum = {
  relation: "pg_toast.pg_toast_51873",
  parent: "net._http_response",
  phase: "vacuuming heap",
  heap_blks_total: 1627612,
  heap_blks_scanned: 1627612,
  heap_blks_vacuumed: 1047120,
  index_vacuum_count: 1,
  is_autovacuum: true,
  wait_event_type: "IO",
  running_seconds: 4634,
}

describe("summariseMaintenanceLoad — the population comes before the finding", () => {
  it("an unreadable payload is UNMEASURED, never clean", () => {
    for (const bad of [null, undefined, "nope" as any, 7 as any, {} as any, { vacuums: null } as any]) {
      const v = summariseMaintenanceLoad(bad)
      expect(v.status).toBe("warn")
      expect(v.detail).toMatch(/UNMEASURED/)
    }
  })

  it("nothing in progress is ok, and still reports worker occupancy and IO waiters", () => {
    const v = summariseMaintenanceLoad(idle({ io_waiters: 4 }))
    expect(v.status).toBe("ok")
    expect(v.value).toBe(0)
    expect(v.detail).toMatch(/No vacuum, cluster or index build in progress/)
    expect(v.detail).toMatch(/autovacuum workers 0\/3/)
    expect(v.detail).toMatch(/client IO waiters 4/)
  })
})

describe("summariseMaintenanceLoad — the 2026-09-13 spell, named", () => {
  it("REPLAYS THE 11:56 PT PAYLOAD and warns, naming the TOAST's owner, the phase, the progress and the time", () => {
    const v = summariseMaintenanceLoad(idle({ vacuums: [toastVacuum], autovacuum_workers: 1, io_waiters: 7 }))
    expect(v.status).toBe("warn")
    expect(v.value).toBe(1)
    expect(v.detail).toMatch(/autovacuum pg_toast\.pg_toast_51873 \(net\._http_response\)/)
    expect(v.detail).toMatch(/vacuuming heap 64% \(1,047,120\/1,627,612 blks\)/)
    expect(v.detail).toMatch(/77 min, IO/)
    expect(v.detail).toMatch(/read the symptoms below in this light/)
  })

  it("a short vacuum is ok but is STILL NAMED — the arm speaks at its quiet level", () => {
    const v = summariseMaintenanceLoad(idle({ vacuums: [{ ...toastVacuum, running_seconds: 300 }] }))
    expect(v.status).toBe("ok")
    expect(v.detail).toMatch(/pg_toast_51873/)
    expect(v.detail).not.toMatch(/read the symptoms below/)
  })

  it("the threshold is the config value, in minutes", () => {
    const tenMin = { ...toastVacuum, running_seconds: 600 }
    expect(summariseMaintenanceLoad(idle({ vacuums: [tenMin] }), 30).status).toBe("ok")
    expect(summariseMaintenanceLoad(idle({ vacuums: [tenMin] }), 5).status).toBe("warn")
  })

  it("progress follows the phase: scanning counts scanned blocks, other phases quote none", () => {
    const scanning = summariseMaintenanceLoad(
      idle({ vacuums: [{ ...toastVacuum, phase: "scanning heap", heap_blks_scanned: 813806, running_seconds: 60 }] }),
    )
    expect(scanning.detail).toMatch(/scanning heap 50% \(813,806\/1,627,612 blks\)/)
    const indexes = summariseMaintenanceLoad(idle({ vacuums: [{ ...toastVacuum, phase: "vacuuming indexes", running_seconds: 60 }] }))
    expect(indexes.detail).toMatch(/vacuuming indexes, 1 min/)
    expect(indexes.detail).not.toMatch(/vacuuming indexes \d+%/)
  })

  it("a manual VACUUM is labelled as such, and a table without a TOAST parent is named plainly", () => {
    const v = summariseMaintenanceLoad(
      idle({ vacuums: [{ relation: "public.wallet_moments_cache", parent: null, phase: "vacuuming indexes", is_autovacuum: false, running_seconds: 120 }] }),
    )
    expect(v.detail).toMatch(/VACUUM \(manual\) public\.wallet_moments_cache: vacuuming indexes, 2 min/)
  })

  it("a VACUUM FULL / CLUSTER is named with its lock, and an index build with its progress", () => {
    const v = summariseMaintenanceLoad(
      idle({
        clusters: [{ relation: "net._http_response", command: "VACUUM FULL", phase: "seq scanning heap", heap_blks_total: 2000, heap_blks_scanned: 500, running_seconds: 900 }],
        index_builds: [{ relation: "public.sales_2026", phase: "building index: scanning table", blocks_total: 1000, blocks_done: 250, running_seconds: 30 }],
      }),
    )
    expect(v.value).toBe(2)
    expect(v.detail).toMatch(/VACUUM FULL net\._http_response: seq scanning heap 25%, 15 min — holds ACCESS EXCLUSIVE/)
    expect(v.detail).toMatch(/CREATE INDEX public\.sales_2026: building index: scanning table 25%, 1 min/)
  })

  it("⛔ never critical, however long it has run", () => {
    const v = summariseMaintenanceLoad(idle({ vacuums: [{ ...toastVacuum, running_seconds: 36_000 }] }))
    expect(v.status).toBe("warn")
    expect(v.status).not.toBe("critical")
  })
})
