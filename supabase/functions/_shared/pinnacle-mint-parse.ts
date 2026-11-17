// Extracted, vitest-testable copies of the Disney Pinnacle mint/deposit CDC
// decoders that live inline in supabase/functions/ingest-pinnacle-mints/index.ts.
// That edge function ingests every Pinnacle NFT mint (render_id / edition_id) and
// its first deposit (owner) straight off the Flow event stream — a silent decode
// regression drops mints from the catalog and mis-attributes owners, invisible
// until the Pinnacle surface goes stale.
//
// Deno edge functions run outside the vitest coverage toolchain, so — matching
// the pack-ev-edition.ts precedent — the pure logic is mirrored here, unit
// tested, and pinned by a source-drift guard (__tests__/edge-pinnacle-mint-parse
// .test.ts) that fails CI if the inline edge copy and this copy diverge.
//
// The extract* bodies below are byte-identical (whitespace-normalized) to the
// edge fn's inline versions; only the shared unwrapCdc dependency is imported
// rather than re-declared.

// NOTE: extensionless import — this module is consumed by vitest/tsc only (the
// edge fn keeps its own inline copy; see the drift guard). tsc rejects a `.ts`
// specifier and Deno never loads this file, so extensionless is correct here.
import { unwrapCdc } from "./cdc"

export function extractMint(payloadBase64: string): { nftId: string; renderId: string | null; editionId: number | null } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const u = unwrapCdc(raw) as Record<string, unknown>
    const id = u?.id
    if (id === undefined || id === null) return null
    const nftId = String(id)
    if (!nftId) return null
    const renderRaw = u?.renderID
    const editionRaw = u?.editionID
    const renderId = renderRaw === undefined || renderRaw === null ? null : String(renderRaw)
    const editionId = editionRaw === undefined || editionRaw === null ? null : Number(editionRaw)
    return { nftId, renderId, editionId: Number.isFinite(editionId as number) ? (editionId as number) : null }
  } catch (err) {
    console.log(`[ingest-pinnacle-mints] mint decode err: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

export function extractDeposit(payloadBase64: string): { nftId: string; to: string } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const u = unwrapCdc(raw) as Record<string, unknown>
    const id = u?.id
    const to = u?.to
    if (id === undefined || id === null || to === undefined || to === null) return null
    const nftId = String(id)
    const toAddr = String(to).toLowerCase()
    if (!nftId || !toAddr.startsWith("0x")) return null
    return { nftId, to: toAddr }
  } catch (err) {
    console.log(`[ingest-pinnacle-mints] deposit decode err: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}
