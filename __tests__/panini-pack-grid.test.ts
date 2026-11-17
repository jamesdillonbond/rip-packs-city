import { describe, it, expect } from "vitest"
import { isPackishEvidence, subpackUrlsFromHtml, packGridCandidates } from "../scripts/panini-pack-grid.mjs"
import { paniniPackType } from "@/lib/chains/panini/ingest-normalize"
import { packLabel } from "@/lib/panini/pack-market"

// Secondary-market pack discovery (2026-10-03, Trevor: "plenty of other packs selling on the
// secondary"). panini_pack_pages had 4 pages because pack links were only found on pages the CARD
// walk visits, and the evidence list that should have shown a missed pack link was full of
// /packcard- CARD links every run.
const B = "https://nft.paniniamerica.net"

describe("panini pack grid discovery", () => {
  it("a /packcard- CARD link is not pack evidence; a real pack-ish link is", () => {
    expect(isPackishEvidence(`${B}/packcard-2332_486997_12689313_257__1_1.html`)).toBe(false)
    expect(isPackishEvidence(`${B}/marketplace/packs.html`)).toBe(true)
    expect(isPackishEvidence(`${B}/marketplace/nfts.html`)).toBe(false)
  })

  it("finds subpack listings anywhere in the HTML, deduped, as full .html URLs", () => {
    const html = `<a href="/marketplace-details/subpack-5270763-1038.html">x</a>
      <div data-to="marketplace-details/subpack-5294230-1039"></div>
      <a href="${B}/marketplace-details/subpack-5270763-1038.html">dup</a>`
    expect(subpackUrlsFromHtml(html).sort()).toEqual([
      `${B}/marketplace-details/subpack-5270763-1038.html`,
      `${B}/marketplace-details/subpack-5294230-1039.html`,
    ])
    expect(subpackUrlsFromHtml(undefined)).toEqual([])
  })

  it("candidates: pack-marketplace nav links first, never a card or a single pack page, guess last", () => {
    const c = packGridCandidates([
      `${B}/marketplace/nfts.html`,
      `${B}/packcard-2332_1_2_3__1_1.html`,
      `${B}/marketplace-details/subpack-5270763-1038.html`,
      `${B}/pack-2026_Panini_NFT_Prizm_WNBA_Packs`,
      `${B}/marketplace/packs.html?sport=Soccer`,
      "https://evil.example/marketplace/packs.html",
    ])
    expect(c).toEqual([`${B}/marketplace/packs.html?sport=Soccer`, `${B}/marketplace/packs.html`])
  })

  it("one listing per sport after the bare one (the bare listing is Basketball only, measured 10-03)", () => {
    expect(packGridCandidates([], [], 8, ["Football", "Womens Basketball", " ", 3 as unknown as string])).toEqual([
      `${B}/marketplace/packs.html`,
      `${B}/marketplace/packs.html?sport=Football`,
      `${B}/marketplace/packs.html?sport=Womens%20Basketball`,
    ])
  })

  it("candidates are capped (each one is a page load) and always include the conventional guess when room", () => {
    expect(packGridCandidates([])).toEqual([`${B}/marketplace/packs.html`])
    const many = Array.from({ length: 10 }, (_, i) => `${B}/marketplace/packs-${i}.html`)
    expect(packGridCandidates(many)).toHaveLength(4)
  })
})

describe("pack type from the pack's own name", () => {
  it("keeps the two modeled products' types unchanged (no-change control)", () => {
    expect(paniniPackType("2026 Panini NFT Prizm World Cup Soccer Packs", "1038")).toBe("hobby")
    expect(paniniPackType("2026 Panini NFT Prizm World Cup Soccer FOTL Packs", "1039")).toBe("fotl")
    expect(paniniPackType("2026 Panini NFT Prizm WNBA Packs", "1056")).toBe("hobby")
    expect(paniniPackType("2026 Panini NFT Prizm WNBA FOTL Packs", "1055")).toBe("fotl")
  })

  it("an un-typed secondary pack is just a 'pack' — Hobby is claimed only for the modeled standard packs", () => {
    expect(paniniPackType("2020-21 Panini NFT Blockchain Prizm NBA Red Mosaic Packs", "1")).toBe("pack")
    expect(paniniPackType("2021-22 Panini NFT Blockchain NBA Prizm Gold Vinyl Parallel Pack", "155")).toBe("pack")
    expect(packLabel("pack")).toBe("Pack")
  })

  it("a Blaster / Mega pack is no longer labelled Hobby", () => {
    expect(paniniPackType("2025 Panini NFT Donruss Football Blaster Packs", "900")).toBe("blaster")
    expect(paniniPackType("2025 Panini NFT Prizm Basketball Mega Box", "901")).toBe("mega")
    expect(packLabel("blaster")).toBe("Blaster")
    expect(packLabel("fotl")).toBe("FOTL")
    expect(packLabel("hobby")).toBe("Hobby")
  })
})
