import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { toRip } from "@/supabase/functions/_shared/pack-opens-rip-parse"

// Pins backfill-pack-opens-api's node→rip map — the parser that decides which
// pack opens land in `pack_rips` and what pull count each carries. This edge fn
// had ZERO test reference before this file. A wrong moments_pulled mis-states
// every open on the pack-open analytics surface.

const CID = "dee28451-5d62-409e-a1ad-a83f763ac070"

describe("toRip — GraphQL pack node → pack_rips row", () => {
  it("maps a well-formed opened node", () => {
    const rip = toRip(CID, {
      id: 12345,
      owner_address: "0xABCDEF0011223344",
      nfts: "1,2,3,4,5",
      dist_id: 88,
      metadata_updated_at: {
        transaction_hash: "0xdeadbeef",
        block_time: "2026-04-15T00:00:00Z",
        block_height: 61930346,
      },
    })
    expect(rip).toEqual({
      collection_id: CID,
      pack_nft_id: "12345",
      opener_address: "0xabcdef0011223344", // single 0x, lowercased
      moments_pulled: 5, // comma-count
      tx_hash: "0xdeadbeef",
      block_height: 61930346,
      sealed_at: "2026-04-15T00:00:00Z",
      dist_id: "88",
    })
  })

  it("normalizes an owner that already lacks 0x (adds exactly one)", () => {
    const rip = toRip(CID, {
      id: 1,
      owner_address: "ABC123",
      nfts: "9",
      metadata_updated_at: { transaction_hash: "0xt", block_time: "t" },
    })
    expect(rip?.opener_address).toBe("0xabc123")
  })

  it("moments_pulled is 0 for an empty nfts string, and null block_height/dist_id are preserved", () => {
    const rip = toRip(CID, {
      id: 2,
      owner_address: "0x1",
      nfts: "",
      metadata_updated_at: { transaction_hash: "0xt", block_time: "t" },
    })
    expect(rip?.moments_pulled).toBe(0)
    expect(rip?.block_height).toBeNull()
    expect(rip?.dist_id).toBeNull()
  })

  it("counts a single-moment pull as 1 (no trailing-comma inflation)", () => {
    const rip = toRip(CID, {
      id: 3,
      owner_address: "0x1",
      nfts: "42",
      metadata_updated_at: { transaction_hash: "0xt", block_time: "t" },
    })
    expect(rip?.moments_pulled).toBe(1)
  })

  it("SKIPS (null) a node with no transaction_hash, no block_time, or no owner", () => {
    const mu = { transaction_hash: "0xt", block_time: "t" }
    expect(toRip(CID, { id: 1, owner_address: "0x1", metadata_updated_at: null })).toBeNull()
    expect(toRip(CID, { id: 1, owner_address: "0x1", metadata_updated_at: { block_time: "t" } })).toBeNull()
    expect(toRip(CID, { id: 1, owner_address: "0x1", metadata_updated_at: { transaction_hash: "0xt" } })).toBeNull()
    expect(toRip(CID, { id: 1, owner_address: null, metadata_updated_at: mu })).toBeNull()
    expect(toRip(CID, {})).toBeNull()
  })
})

describe("edge-fn source-drift guard — backfill-pack-opens-api inline toRip", () => {
  const root = process.cwd()
  const norm = (s: string) => s.replace(/\s+/g, " ").trim()
  const edgeSrc = norm(
    readFileSync(path.join(root, "supabase/functions/backfill-pack-opens-api/index.ts"), "utf8"),
  )
  const importsShared = /from\s+["'][^"']*_shared\/pack-opens-rip-parse/.test(edgeSrc)
  const OWNER_NORM = norm('"0x" + String(owner).toLowerCase().replace(/^0x/, "")')
  const PULL_COUNT = norm('nfts ? nfts.split(",").length : 0')

  it.each([
    ["opener_address normalize", OWNER_NORM],
    ["moments_pulled count", PULL_COUNT],
  ])("edge fn imports _shared, or carries the inline %s verbatim", (_label, expr) => {
    expect(importsShared || edgeSrc.includes(expr)).toBe(true)
  })
})
