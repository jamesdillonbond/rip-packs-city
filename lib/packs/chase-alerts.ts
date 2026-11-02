// lib/packs/chase-alerts.ts
//
// Pack-chase watches (pack_chase_watches, migration 20261102150737): "tell me when
// this Top Shot pack's Legendary / Ultimate / Rare density per sealed pack reaches
// N× its launch rate". Run as a leg of alerts-dispatch; deliveries go through the
// existing alert_deliveries outbox as alert_kind 'pack_digest' and the per-channel
// senders render them (lib/alerts/format.ts).
//
// EDGE-TRIGGERED: a watch fires once when its condition becomes true (armed → false)
// and re-arms only when a VALID reading says the condition is false again.
//
// HONESTY (CLAUDE.md):
//   · A reading that is missing, stale, or refuted by our observed on-chain opens is
//     UNKNOWN — it neither fires nor re-arms. Unknown is never "condition false".
//   · ORDER: the delivery rows are written FIRST; the watch is disarmed only after
//     they landed. A failed enqueue leaves the watch armed for the next tick. The
//     dedup bucket is (watch, PT day), so a failed disarm cannot double-send today.
//   · Every count the run reports means rows WRITTEN, each paired with its error.

import { atlasTierCounts, type AtlasDistCountsInput } from "@/lib/pack-dist/tier-counts"
import { CHASE_MAX_AGE_DAYS, tierDensity, type ChaseTier } from "@/lib/packs/chase-odds"

export interface ChaseWatch {
  id: string
  owner_key: string
  dist_id: string
  title: string | null
  tier: ChaseTier
  min_vs_launch: number
  armed: boolean
}

export interface ChaseReading {
  remaining: number
  original: number
  unopened: number
  totalPacks: number
  per100Now: number
  per100Launch: number
  vsLaunch: number
  asOf: string
  title: string | null
}

export type ChaseDecision = "fire" | "rearm" | "hold"

/** Pure: what to do with one watch given its reading (null = unknown). */
export function decideChaseWatch(w: Pick<ChaseWatch, "armed" | "min_vs_launch">, reading: ChaseReading | null): ChaseDecision {
  if (!reading) return "hold"
  const met = reading.remaining > 0 && reading.vsLaunch >= Number(w.min_vs_launch)
  if (met && w.armed) return "fire"
  if (!met && !w.armed) return "rearm"
  return "hold"
}

/** Pure: a validated reading for one dist/tier, or null when it is not knowable. */
export function readingFor(
  atlas: (AtlasDistCountsInput & { title?: string | null }) | undefined,
  observedOpened: number | string | null | undefined,
  tier: ChaseTier,
  nowMs: number,
): ChaseReading | null {
  if (!atlas) return null
  const t = typeof atlas.summary_fetched_at === "string" ? Date.parse(atlas.summary_fetched_at) : NaN
  if (!Number.isFinite(t) || nowMs - t > CHASE_MAX_AGE_DAYS * 86_400_000) return null
  const counts = atlasTierCounts(atlas, observedOpened ?? null)
  if (!counts) return null
  const remaining = counts.remainingByTier?.[tier]
  const original = counts.originalByTier?.[tier]
  const unopened = counts.totalUnopened as number
  const totalPacks = counts.totalPackCount as number
  const d = tierDensity(remaining, original, unopened, totalPacks)
  if (!d || remaining == null || original == null) return null
  return { remaining, original, unopened, totalPacks, ...d, asOf: counts.updatedAt as string, title: atlas.title ?? null }
}

/** PT calendar day — the dedup bucket, so one watch alerts at most once a day. */
export function ptDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(nowMs))
}

export interface PackChasePayload {
  watch_id: string
  dist_id: string
  title: string
  tier: ChaseTier
  remaining: number
  unopened: number
  total_packs: number
  per100_now: number
  per100_launch: number
  vs_launch: number
  min_vs_launch: number
  as_of: string
}

export interface PackChaseRunResult {
  watches_scanned: number
  fired: number
  rearmed: number
  unknown: number
  no_channel: number
  deliveries_written: number
  enqueue_error: string | null
  state_error: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/**
 * One dispatch pass. Throws only when the watch list itself cannot be read (the
 * caller records ok=false); per-watch failures are counted in the result.
 */
export async function runPackChaseDispatch(
  db: Db,
  getTargets: (ownerKey: string) => Promise<Array<{ channel: string; channel_user_id: string }>>,
  nowMs: number = Date.now(),
): Promise<PackChaseRunResult> {
  const res: PackChaseRunResult = { watches_scanned: 0, fired: 0, rearmed: 0, unknown: 0, no_channel: 0, deliveries_written: 0, enqueue_error: null, state_error: null }

  const { data: watches, error: wErr } = await db
    .from("pack_chase_watches")
    .select("id, owner_key, dist_id, title, tier, min_vs_launch, armed")
    .eq("active", true)
    .order("id", { ascending: true })
    .limit(1000)
  if (wErr) throw new Error(`pack_chase_watches: ${wErr.message}`)
  const list = (watches ?? []) as ChaseWatch[]
  res.watches_scanned = list.length
  if (list.length === 0) return res

  const distIds = [...new Set(list.map((w) => w.dist_id))]
  const [{ data: atlasRows, error: aErr }, { data: metaRows, error: mErr }] = await Promise.all([
    db.from("topshot_atlas_dists")
      .select("dist_id, title, summary_fetched_at, unopened_count, total_pack_count, remaining_by_tier, original_by_tier")
      .in("dist_id", distIds),
    db.from("pack_table_rows")
      .select("dist_id, observed_packs_opened")
      .eq("collection_slug", "nba-top-shot")
      .in("dist_id", distIds),
  ])
  // A failed read makes every reading unknown — hold all, never re-arm or fire.
  if (aErr || mErr) {
    res.unknown = list.length
    res.state_error = `reads: ${(aErr ?? mErr).message}`
    return res
  }
  const atlasById = new Map<string, AtlasDistCountsInput & { title?: string | null }>()
  for (const a of atlasRows ?? []) atlasById.set(a.dist_id, a)
  const observedById = new Map<string, number | string | null>()
  for (const m of metaRows ?? []) observedById.set(m.dist_id, m.observed_packs_opened)

  const day = ptDay(nowMs)
  for (const w of list) {
    const reading = readingFor(atlasById.get(w.dist_id), observedById.get(w.dist_id), w.tier, nowMs)
    const decision = decideChaseWatch(w, reading)
    if (!reading) res.unknown++
    if (decision === "rearm") {
      const { error } = await db.from("pack_chase_watches").update({ armed: true, updated_at: new Date(nowMs).toISOString() }).eq("id", w.id)
      if (error) res.state_error = error.message
      else res.rearmed++
      continue
    }
    if (decision !== "fire" || !reading) continue

    const targets = await getTargets(w.owner_key)
    if (targets.length === 0) {
      // No linked channel: keep it armed so it fires once one is linked.
      res.no_channel++
      continue
    }
    const payload: PackChasePayload = {
      watch_id: w.id,
      dist_id: w.dist_id,
      title: (reading.title || w.title || `Pack #${w.dist_id}`).trim(),
      tier: w.tier,
      remaining: reading.remaining,
      unopened: reading.unopened,
      total_packs: reading.totalPacks,
      per100_now: reading.per100Now,
      per100_launch: reading.per100Launch,
      vs_launch: reading.vsLaunch,
      min_vs_launch: Number(w.min_vs_launch),
      as_of: reading.asOf,
    }
    const rows = targets.map((t) => ({
      owner_key: w.owner_key,
      channel: t.channel,
      channel_user_id: t.channel_user_id,
      alert_kind: "pack_digest",
      subject_key: `pack_chase:${w.dist_id}:${w.tier}`,
      dedup_bucket: `${w.id}:${day}`,
      payload,
      status: "pending",
    }))
    const { data: written, error: insErr } = await db
      .from("alert_deliveries")
      .upsert(rows, { onConflict: "owner_key,channel,alert_kind,subject_key,dedup_bucket", ignoreDuplicates: true })
      .select("id")
    if (insErr) {
      // Not written: stay armed, retry next tick.
      res.enqueue_error = insErr.message
      continue
    }
    res.deliveries_written += (written ?? []).length
    const { error: upErr } = await db
      .from("pack_chase_watches")
      .update({ armed: false, last_fired_at: new Date(nowMs).toISOString(), last_fired_vs: reading.vsLaunch, updated_at: new Date(nowMs).toISOString() })
      .eq("id", w.id)
    if (upErr) res.state_error = upErr.message
    else res.fired++
  }
  return res
}
