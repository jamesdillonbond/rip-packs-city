import { describe, it, expect } from "vitest"
import { singleRetryLabel, type PlayerResolution } from "@/lib/concierge/player-identity"

// #207 — the spelling an accent-sensitive ILIKE RPC should be re-asked with.
const one = (labels: string[]): PlayerResolution => ({
  status: "one", query: "q", query_slug: "q", matched_via: "exact", namesakes: [], aliases: [], identity: null, relations: [], matched_query_as: "exact",
  player: { id: "p", name: labels[0] ?? "X", slug: "x", team: null, edition_count: 1, labels },
})

describe("singleRetryLabel", () => {
  it("one person, one label that differs from the typed text → that label", () => {
    expect(singleRetryLabel(one(["Luka Dončić"]), "luka doncic")).toBe("Luka Dončić")
  })
  it("the typed text verbatim → null (nothing to retry)", () => {
    expect(singleRetryLabel(one(["Luka Dončić"]), " Luka Dončić ")).toBeNull()
  })
  it("a person carrying several labels → null (one ILIKE cannot ask for all of them)", () => {
    expect(singleRetryLabel(one(["Josh Allen", "Josh Hines-Allen"]), "josh allen")).toBeNull()
  })
  it("ambiguous, none and unavailable resolutions → null (caller keeps its behaviour)", () => {
    expect(singleRetryLabel({ status: "ambiguous", query: "q", query_slug: "q", candidates: [], note: "" }, "q")).toBeNull()
    expect(singleRetryLabel({ status: "none", query: "q" }, "q")).toBeNull()
    expect(singleRetryLabel({ status: "unavailable", query: "q", error: "timeout" }, "q")).toBeNull()
    expect(singleRetryLabel(null, "q")).toBeNull()
  })
})
