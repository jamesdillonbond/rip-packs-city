import { describe, it, expect, vi, beforeEach } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// 2026-11-23: "Did this pack pay?" on Pinnacle pack pages. The drop's row is found by dist id (a "<X> Standard"
// sub-pool shows its whole drop); a failed read never renders a verdict; a dist not on the board renders nothing.

let rpcResult: { data: unknown; error: unknown } = { data: null, error: null }
vi.mock("@/lib/supabase", () => {
  const admin = { rpc: async () => rpcResult }
  return { supabaseAdmin: admin, supabase: admin }
})

import PinnacleDropReality, { dropForDist } from "@/components/pinnacle/PinnacleDropReality"

const drop = {
  drop_name: "Summer Sunset - Standard", price_usd: 4.99, dist_ids: ["8871", "8872", "8873"], packs_opened: 2411,
  first_open_at: "2026-09-25T16:00:30Z", last_open_at: "2026-10-02T15:59:59Z", n_at_open: 2410, n_at_open_rebuilt: 0, avg_value_at_open: 26.58,
  n_today: 2410, avg_value_today: 16.11, median_value_today: 9, best_pull_today: 80, pct_today_at_or_above_price: 100,
}

beforeEach(() => { rpcResult = { data: null, error: null } })

async function render(distId: string): Promise<string> {
  const el = (await PinnacleDropReality({ distId })) as ReactElement | null
  return el ? renderToStaticMarkup(el) : ""
}

describe("PinnacleDropReality", () => {
  it("finds the drop for a sub-pool dist and says it is the whole pack", async () => {
    expect(dropForDist([drop], "8872")?.drop_name).toBe("Summer Sunset - Standard")
    expect(dropForDist([drop], "9999")).toBeNull()
    rpcResult = { data: { since: "x", min_opens: 25, drops: [drop] }, error: null }
    const html = await render("8872")
    expect(html).toContain("Did this pack pay?")
    expect(html).toContain("3.23× the price")
    expect(html).toContain("3 pools")
    expect(html).toContain("/insights/pinnacle-pack-reality")
  })
  it("renders nothing for a dist the board does not cover", async () => {
    rpcResult = { data: { since: "x", min_opens: 25, drops: [drop] }, error: null }
    expect(await render("9999")).toBe("")
  })
  it("a failed read says so and gives no verdict", async () => {
    rpcResult = { data: null, error: { message: "down" } }
    const html = await render("8872")
    expect(html).toContain("Couldn")
    expect(html).not.toContain("× the price")
  })
  it("is mounted on Pinnacle pack pages only", () => {
    const src = readFileSync(join(process.cwd(), "app/(collections)/[collection]/pack/dist/[distId]/page.tsx"), "utf8")
    expect(src).toMatch(/collection === "disney-pinnacle" && \(\s*<Suspense fallback=\{null\}>\s*<PinnacleDropReality distId=\{distId\} \/>/)
  })
})
