import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"

// 2026-11-13. A collector's eight "serial 111 / 333 / …" deal alerts HAD their
// serial range saved (alert_subscriptions.min_serial = max_serial = 111), but the
// concierge's `manage_deal_subscriptions` list selected no serial columns — so the
// model, reading rows with no min_serial field, told the collector "None of them
// has a serial limit saved" (support_conversations 12524). An omitted field reads
// as an absent value.
//
// DERIVED, not curated: the population is every `v_sub.<column>` the LIVE
// dispatcher (the newest migration defining dispatch_due_deal_alerts) reads. A
// filter added to the dispatcher later reddens this until the concierge can see
// it too.

const root = process.cwd()
const migDir = path.join(root, "supabase/migrations")

function latestDispatcherMigration(): string {
  const files = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort()
  const hits = files.filter((f) =>
    /CREATE OR REPLACE FUNCTION public\.dispatch_due_deal_alerts\(/.test(readFileSync(path.join(migDir, f), "utf8")),
  )
  expect(hits.length).toBeGreaterThan(0)
  return readFileSync(path.join(migDir, hits[hits.length - 1]), "utf8")
}

function listSelectColumns(): string[] {
  const src = readFileSync(path.join(root, "app/api/support-chat/route.ts"), "utf8")
  const i = src.indexOf('if (toolName === "manage_deal_subscriptions")')
  expect(i).toBeGreaterThan(-1)
  const j = src.indexOf('if (action === "list")', i)
  expect(j).toBeGreaterThan(i)
  const m = /\.select\("([^"]+)"\)/.exec(src.slice(j, j + 2000))
  expect(m).not.toBeNull()
  return m![1].split(",").map((c) => c.trim())
}

// Plumbing the dispatcher reads that is not a filter a collector set.
const NOT_FILTERS = new Set(["id", "owner_key", "active", "label", "channels", "notify_mode"])

describe("the concierge's deal-alert list shows every filter the dispatcher applies", () => {
  it("selects every v_sub column the newest dispatcher reads", () => {
    const body = latestDispatcherMigration()
    const filters = [...new Set([...body.matchAll(/v_sub\.([a-z_]+)/g)].map((m) => m[1]))].filter(
      (c) => !NOT_FILTERS.has(c),
    )
    // not vacuous: the serial pair is the live miss, and there are many more
    expect(filters).toContain("min_serial")
    expect(filters).toContain("max_serial")
    expect(filters.length).toBeGreaterThanOrEqual(12)
    const cols = new Set(listSelectColumns())
    const missing = filters.filter((c) => !cols.has(c))
    expect(missing).toEqual([])
  })
})
