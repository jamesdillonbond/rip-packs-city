import { describe, it, expect } from "vitest"
import { pullHref } from "@/lib/pack-detail/pull-href"
import { lifecycleRpcFor } from "@/lib/pack-detail/lifecycle-rpc"

// 2026-10-19: Golazos and Pinnacle have no per-NFT `moments` rows, so the pack
// page's /moment/<nft_id> link 404'd for every one of their pulls.
describe("pullHref", () => {
  it("Top Shot / All Day pulls keep the moment link", () => {
    expect(pullHref("nba-top-shot", { nft_id: "123" })).toBe("/nba-top-shot/moment/123")
    expect(pullHref("nfl-all-day", { nft_id: "9" })).toBe("/nfl-all-day/moment/9")
  })
  it("Golazos pulls link the edition page by external_id, never /moment/<nft_id>", () => {
    const h = pullHref("laliga-golazos", { nft_id: "669430769", edition_key: "9" })
    expect(h).toBe("/laliga-golazos/edition/9")
    expect(h).not.toContain("/moment/")
  })
  it("Pinnacle pulls link the per-pin page by render_id", () => {
    expect(pullHref("disney-pinnacle", { nft_id: "67070212072151", edition_key: "LEEV1-D23-SORC-E6" }))
      .toBe("/pinnacle/moment/LEEV1-D23-SORC-E6")
  })
  it("no key → no link, never a guessed one", () => {
    expect(pullHref("laliga-golazos", { nft_id: "1" })).toBeNull()
    expect(pullHref("disney-pinnacle", { nft_id: "1", edition_key: null })).toBeNull()
  })
})

describe("lifecycleRpcFor", () => {
  it("routes each collection to the RPC that reads its own pack tables", () => {
    expect(lifecycleRpcFor("7dd9dd11-e8b6-45c4-ac99-71331f959714")).toBe("get_pinnacle_pack_lifecycle")
    expect(lifecycleRpcFor("06248cc4-b85f-47cd-af67-1855d14acd75")).toBe("get_golazos_pack_lifecycle")
    expect(lifecycleRpcFor("95f28a17-224a-4025-96ad-adf8a4c63bfd")).toBe("get_pack_lifecycle")
    expect(lifecycleRpcFor(null)).toBe("get_pack_lifecycle")
  })
})
