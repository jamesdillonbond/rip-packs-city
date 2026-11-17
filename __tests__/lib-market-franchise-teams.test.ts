import { describe, it, expect } from "vitest"
import { expandFranchiseLabels } from "@/lib/market/franchise-teams"

// A Market team pick covers every label its franchise minted under (2026-10-14):
// "LA Clippers" alone missed 53 "Los Angeles Clippers" editions.

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const supa = (answers: Record<string, { data: unknown; error: { message: string } | null }>) => ({
  rpc: async (_fn: string, args: { p_name: string }) => answers[args.p_name] ?? { data: { status: "none" }, error: null },
})

describe("expandFranchiseLabels", () => {
  it("adds every label of the picked team's franchise", async () => {
    const r = await expandFranchiseLabels(supa({
      "LA Clippers": { data: { status: "one", names: [{ team_name: "LA Clippers" }, { team_name: "Los Angeles Clippers" }, { team_name: "Buffalo Braves" }] }, error: null },
    }), TS, ["LA Clippers"])
    expect(r.labels.sort()).toEqual(["Buffalo Braves", "LA Clippers", "Los Angeles Clippers"])
    expect(r.degraded).toBe(false)
  })

  it("keeps a label that names no franchise (All-Star teams) as picked", async () => {
    const r = await expandFranchiseLabels(supa({}), TS, ["Team LeBron"])
    expect(r).toEqual({ labels: ["Team LeBron"], degraded: false })
  })

  it("a failed resolve degrades to the picked label — never to no team filter", async () => {
    const r = await expandFranchiseLabels(supa({ "Brooklyn Nets": { data: null, error: { message: "timeout" } } }), TS, ["Brooklyn Nets", "Utah Jazz"])
    expect(r.labels.sort()).toEqual(["Brooklyn Nets", "Utah Jazz"])
    expect(r.degraded).toBe(true)
  })

  it("no pick, no reads", async () => {
    let calls = 0
    const r = await expandFranchiseLabels({ rpc: async () => { calls++; return { data: null, error: null } } }, TS, [])
    expect(r).toEqual({ labels: [], degraded: false })
    expect(calls).toBe(0)
  })
})
