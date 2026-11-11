// lib/giveaways/wallet-cache.ts
//
// A giveaway Moment the chain shows in its winner's account goes into that
// winner's wallet cache (`wallet_moments_cache`), named, at once.
//
// ── THE CASE THIS WAS WRITTEN FROM (2026-11-10, Dame Time reward packs) ────
// The vault delivered rrx69's pack in seconds, but his collection page showed
// both Moments as "—" / "Unknown Set" / "#-/-" ×2. A delivered Moment is a
// transfer, not a sale, so no sales lane writes it; the collection page's own
// walk found the two new ids, could not name them (Top Shot GraphQL answered
// 530 for every moment), and cached them as bare id-only rows. The other three
// winners' caches did not have the Moments at all.
//
// The pack row already knows everything the cache needs (edition key, serial,
// names, tier, art), and Verify has just read the chain, so this writes:
//   - a NEW row for a Moment the cache lacks, stamped with the wallet's EXISTING
//     newest `last_seen_at` (stamping now() would make every older row fail the
//     "seen within a day of the newest" freshness test — database.md, wmc rule);
//   - names onto an EXISTING row only where its edition_key is still NULL (a
//     bare stub); a named row is a walk's, and is left alone;
// then runs the same NULL-only metadata fill every walk runs.
//
// Never throws: a failed cache write is reported (`error`), never a reason to
// fail the verify that called it — the chain, not the cache, is the record of
// delivery. Scoped by collection_id on every read and write (#142).

import type { SupabaseClient } from "@supabase/supabase-js"
import type { PoolRow } from "@/lib/giveaways/store"

export interface DeliveredMoment {
  recipient: string
  m: PoolRow
  locked: boolean | null
}

export interface CacheWriteReport {
  /** Rows inserted or named. */
  written: number
  error: string | null
}

const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/

export async function recordDeliveredInWalletCache(
  db: SupabaseClient,
  collectionId: string,
  delivered: DeliveredMoment[],
): Promise<CacheWriteReport> {
  const report: CacheWriteReport = { written: 0, error: null }
  const fail = (msg: string) => {
    report.error ??= msg
  }
  const byWallet = new Map<string, DeliveredMoment[]>()
  for (const d of delivered) {
    const w = d.recipient.toLowerCase() // a Flow address (hex): lower-casing is safe here
    if (!FLOW_ADDRESS.test(w) || !d.m.edition_key) continue
    byWallet.set(w, [...(byWallet.get(w) ?? []), d])
  }
  const sb = db as any
  for (const [wallet, items] of byWallet) {
    try {
      const ids = items.map((d) => d.m.moment_id)
      const existingRes = await sb
        .from("wallet_moments_cache")
        .select("moment_id, edition_key")
        .eq("wallet_address", wallet)
        .eq("collection_id", collectionId)
        .in("moment_id", ids)
      if (existingRes.error) {
        fail(`${wallet}: existing read: ${existingRes.error.message}`)
        continue
      }
      const existing = new Map<string, string | null>(
        ((existingRes.data ?? []) as { moment_id: string; edition_key: string | null }[]).map((r) => [String(r.moment_id), r.edition_key]),
      )
      const fresh = items.filter((d) => !existing.has(d.m.moment_id))
      const stubs = items.filter((d) => existing.has(d.m.moment_id) && existing.get(d.m.moment_id) == null)
      if (fresh.length === 0 && stubs.length === 0) continue

      const named = (d: DeliveredMoment) => ({
        edition_key: d.m.edition_key,
        serial_number: d.m.serial_number,
        player_name: d.m.player_name,
        set_name: d.m.set_name,
        team_name: d.m.team_name,
        tier: d.m.tier,
        image_url: d.m.image_url,
        acquired_at: d.m.delivered_at,
        ...(d.locked != null ? { is_locked: d.locked, lock_checked_at: new Date().toISOString() } : {}),
      })

      if (fresh.length) {
        // the wallet's existing walk anchor; only an empty cache takes now()
        const anchorRes = await sb
          .from("wallet_moments_cache")
          .select("last_seen_at")
          .eq("wallet_address", wallet)
          .eq("collection_id", collectionId)
          .not("last_seen_at", "is", null)
          .order("last_seen_at", { ascending: false })
          .limit(1)
        if (anchorRes.error) {
          fail(`${wallet}: anchor read: ${anchorRes.error.message}`)
        } else {
          const anchor = ((anchorRes.data ?? [])[0] as { last_seen_at?: string } | undefined)?.last_seen_at ?? new Date().toISOString()
          const rows = fresh.map((d) => ({
            wallet_address: wallet,
            collection_id: collectionId,
            moment_id: d.m.moment_id,
            last_seen_at: anchor,
            ...named(d),
          }))
          const ins = await sb
            .from("wallet_moments_cache")
            .upsert(rows, { onConflict: "wallet_address,collection_id,moment_id", ignoreDuplicates: true })
            .select("moment_id")
          if (ins.error) fail(`${wallet}: insert: ${ins.error.message}`)
          else report.written += Array.isArray(ins.data) ? ins.data.length : 0
        }
      }

      for (const d of stubs) {
        const up = await sb
          .from("wallet_moments_cache")
          .update(named(d))
          .eq("wallet_address", wallet)
          .eq("collection_id", collectionId)
          .eq("moment_id", d.m.moment_id)
          .is("edition_key", null)
          .select("moment_id")
        if (up.error) fail(`${wallet}: name stub ${d.m.moment_id}: ${up.error.message}`)
        else report.written += Array.isArray(up.data) ? up.data.length : 0
      }

      const fill = await sb.rpc("backfill_wmc_metadata_from_editions", { p_wallet_address: wallet, p_collection_id: collectionId })
      if (fill.error) fail(`${wallet}: metadata fill: ${fill.error.message}`)
    } catch (e) {
      fail(`${wallet}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return report
}
