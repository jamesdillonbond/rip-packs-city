// lib/giveaways/store.ts
//
// Server-side reads and writes for community pack giveaways (v1: one admin).
// Every function takes the service-role client explicitly so routes and tests
// share one path. Tables: supabase/migrations/20260929192842_audit_20260929_community_pack_giveaways.sql
//
// RPC stays read-only: nothing here moves a moment. The admin gifts in the
// Top Shot app; `verifyDeliveries` reads the chain to confirm arrival.

import type { SupabaseClient } from "@supabase/supabase-js"
import { getCollection } from "@/lib/collections"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import {
  PRIZE_VALUE_CAP_USD,
  manifestOf as manifestOfRows,
  sealPool,
  summarizePackValues,
  type PackValueSummary,
} from "@/lib/giveaways/seal"

/** v1 is Top Shot only: the lock script and the delivery check are Top Shot reads. */
export const GIVEAWAY_COLLECTION_ID = getCollection("nba-top-shot")?.supabaseCollectionId ?? ""

export type DropStatus = "draft" | "sealed" | "open" | "closed"

export interface DropRow {
  id: string
  slug: string
  title: string
  description: string | null
  sponsor_name: string
  collection_id: string
  admin_wallet: string
  status: DropStatus
  pack_count: number
  moments_per_pack: number
  seal_hash: string | null
  seal_salt: string | null
  sealed_at: string | null
  opened_at: string | null
  closed_at: string | null
  created_at: string
}

export interface PoolRow {
  moment_id: string
  pack_no: number | null
  slot: number | null
  edition_key: string | null
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  serial_number: number | null
  fmv_usd: number | null
  image_url: string | null
  delivered_at: string | null
  last_checked_at: string | null
  last_check_recipient_holds: boolean | null
  last_check_admin_holds: boolean | null
}

export interface ClaimRow {
  pack_no: number
  user_id: string
  topshot_username: string
  recipient_address: string
  claimed_at: string
}

/** A failure the caller can show the operator or user verbatim (our own copy). */
export class GiveawayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message)
    this.name = "GiveawayError"
  }
}

const DROP_COLUMNS =
  "id, slug, title, description, sponsor_name, collection_id, admin_wallet, status, pack_count, moments_per_pack, seal_hash, seal_salt, sealed_at, opened_at, closed_at, created_at"
const POOL_COLUMNS =
  "moment_id, pack_no, slot, edition_key, player_name, set_name, team_name, tier, serial_number, fmv_usd, image_url, delivered_at, last_checked_at, last_check_recipient_holds, last_check_admin_holds"

function num(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function toPool(rows: Record<string, unknown>[]): PoolRow[] {
  return rows.map((r) => ({ ...(r as unknown as PoolRow), fmv_usd: num(r.fmv_usd) }))
}

export async function listDrops(db: SupabaseClient): Promise<DropRow[]> {
  const { data, error } = await db.from("giveaway_drops").select(DROP_COLUMNS).order("created_at", { ascending: false }).limit(200)
  if (error) throw error
  return (data ?? []) as DropRow[]
}

export async function getDrop(db: SupabaseClient, by: { id: string } | { slug: string }): Promise<DropRow | null> {
  const q = db.from("giveaway_drops").select(DROP_COLUMNS)
  const { data, error } = await ("id" in by ? q.eq("id", by.id) : q.eq("slug", by.slug)).maybeSingle()
  if (error) throw error
  return (data as DropRow | null) ?? null
}

export async function getPool(db: SupabaseClient, dropId: string): Promise<PoolRow[]> {
  const { data, error } = await db
    .from("giveaway_pack_moments")
    .select(POOL_COLUMNS)
    .eq("drop_id", dropId)
    .order("moment_id", { ascending: true })
    .limit(1000)
  if (error) throw error
  return toPool((data ?? []) as Record<string, unknown>[])
}

export async function getClaims(db: SupabaseClient, dropId: string): Promise<ClaimRow[]> {
  const { data, error } = await db
    .from("giveaway_claims")
    .select("pack_no, user_id, topshot_username, recipient_address, claimed_at")
    .eq("drop_id", dropId)
    .order("claimed_at", { ascending: true })
    .limit(1000)
  if (error) throw error
  return (data ?? []) as ClaimRow[]
}

export interface Candidate {
  moment_id: string
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  serial_number: number | null
  fmv_usd: number | null
  image_url: string | null
}

export type ChainState = "giftable" | "locked" | "not_held"

export interface CheckedCandidates {
  wallet: string
  /** Cache says unlocked AND the chain, read now, agrees: the only ones offered. */
  candidates: (Candidate & { chain: "giftable" })[]
  /** Cache said unlocked but the chain says otherwise (the cache's lock flag is stale). */
  excluded: { locked: number; not_held: number }
  /** How many cache rows were checked. */
  cache_count: number
}

/**
 * The picker's list, re-checked on chain. Measured 2026-09-29: moments the
 * cache marked unlocked were LOCKED on chain, so the cache alone would offer
 * moments that cannot be gifted. A failed chain read THROWS — the picker shows
 * an error, never a list it could not verify.
 */
export async function listCheckedCandidates(
  db: SupabaseClient,
  wallet: string,
  read: (address: string, ids: string[]) => Promise<Record<string, Holding>> = readTopShotHoldings,
): Promise<CheckedCandidates> {
  const cached = await listCandidates(db, wallet)
  const holdings = cached.length ? await read(wallet, cached.map((c) => c.moment_id)) : {}
  const excluded = { locked: 0, not_held: 0 }
  const candidates: CheckedCandidates["candidates"] = []
  for (const c of cached) {
    const h = holdings[c.moment_id]
    if (!h?.held) excluded.not_held += 1
    else if (h.locked !== false) excluded.locked += 1
    else candidates.push({ ...c, chain: "giftable" })
  }
  return { wallet, candidates, excluded, cache_count: cached.length }
}

/** The admin's Top Shot moments the CACHE calls held and unlocked — a hint; see listCheckedCandidates. */
export async function listCandidates(db: SupabaseClient, wallet: string): Promise<Candidate[]> {
  const { data, error } = await db
    .from("wallet_moments_cache")
    .select("moment_id, player_name, set_name, team_name, tier, serial_number, fmv_usd, image_url")
    .eq("wallet_address", wallet)
    .eq("collection_id", GIVEAWAY_COLLECTION_ID)
    .eq("is_locked", false)
    .order("moment_id", { ascending: true })
    .limit(1000)
  if (error) throw error
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as Candidate), fmv_usd: num(r.fmv_usd) }))
}

export interface DraftInput {
  slug: string
  title: string
  description: string | null
  sponsor_name: string
  admin_wallet: string
  pack_count: number
  moments_per_pack: number
  moment_ids: string[]
}

/** Postgres "invalid parameter" — the draft/seal functions' own refusals. */
function isRefusal(err: { code?: string } | null): boolean {
  return err?.code === "22023" || err?.code === "23505" || err?.code === "23514"
}

export async function createDraft(db: SupabaseClient, input: DraftInput): Promise<string> {
  const { data, error } = await db.rpc("create_giveaway_draft", {
    p_slug: input.slug,
    p_title: input.title,
    p_description: input.description,
    p_sponsor_name: input.sponsor_name,
    p_collection_id: GIVEAWAY_COLLECTION_ID,
    p_admin_wallet: input.admin_wallet,
    p_pack_count: input.pack_count,
    p_moments_per_pack: input.moments_per_pack,
    p_moment_ids: input.moment_ids,
  })
  if (error) {
    if (isRefusal(error)) throw new GiveawayError(error.message, 400, "refused")
    throw error
  }
  return String(data)
}

export interface SealCheck {
  unpriced: string[]
  not_held: string[]
  locked: string[]
  pool_fmv_usd: number
}

/**
 * Seal a draft. Refuses unless every moment is priced (the prize value must be
 * stated), the total is under the NY/FL registration line, and — read on chain
 * now, not from the cache — the admin still holds every moment and none is locked.
 */
export async function sealDrop(
  db: SupabaseClient,
  drop: DropRow,
  read: (address: string, ids: string[]) => Promise<Record<string, Holding>> = readTopShotHoldings,
): Promise<{ hash: string; check: SealCheck }> {
  if (drop.status !== "draft") throw new GiveawayError(`Only a draft can be sealed (this drop is ${drop.status}).`, 409, "wrong_status")
  const pool = await getPool(db, drop.id)
  const ids = pool.map((p) => p.moment_id)
  const unpriced = pool.filter((p) => p.fmv_usd == null).map((p) => p.moment_id)
  const poolFmv = Math.round(pool.reduce((s, p) => s + (p.fmv_usd ?? 0), 0) * 100) / 100
  const holdings = await read(drop.admin_wallet, ids)
  const check: SealCheck = {
    unpriced,
    not_held: ids.filter((id) => !holdings[id]?.held),
    locked: ids.filter((id) => holdings[id]?.held && holdings[id]?.locked !== false),
    pool_fmv_usd: poolFmv,
  }
  if (check.unpriced.length) {
    throw new GiveawayError(`${check.unpriced.length} moment(s) have no FMV, so the prize value can't be stated: ${check.unpriced.join(", ")}`, 409, "unpriced")
  }
  if (poolFmv > PRIZE_VALUE_CAP_USD) {
    throw new GiveawayError(`Pool FMV $${poolFmv} is over the $${PRIZE_VALUE_CAP_USD} NY/FL registration line.`, 409, "over_cap")
  }
  if (check.not_held.length) {
    throw new GiveawayError(`The admin wallet no longer holds: ${check.not_held.join(", ")}`, 409, "not_held")
  }
  if (check.locked.length) {
    throw new GiveawayError(`Locked on chain (a locked Moment can't be gifted): ${check.locked.join(", ")}`, 409, "locked")
  }
  const sealed = sealPool(ids, drop.pack_count, drop.moments_per_pack)
  const { error } = await db.rpc("seal_giveaway_drop", {
    p_drop_id: drop.id,
    p_assignments: sealed.assignments,
    p_hash: sealed.hash,
    p_salt: sealed.salt,
  })
  if (error) {
    if (isRefusal(error)) throw new GiveawayError(error.message, 409, "refused")
    throw error
  }
  return { hash: sealed.hash, check }
}

/** draft|sealed -> open -> closed. Conditional on the current status, so a stale click is a no-op 409. */
export async function setStatus(db: SupabaseClient, drop: DropRow, to: "open" | "closed"): Promise<void> {
  const from: DropStatus = to === "open" ? "sealed" : "open"
  if (drop.status !== from) throw new GiveawayError(`Can't move a ${drop.status} drop to ${to}.`, 409, "wrong_status")
  const stamp = to === "open" ? { opened_at: new Date().toISOString() } : { closed_at: new Date().toISOString() }
  const { data, error } = await db
    .from("giveaway_drops")
    .update({ status: to, updated_at: new Date().toISOString(), ...stamp })
    .eq("id", drop.id)
    .eq("status", from)
    .select("id")
  if (error) throw error
  if (!data || data.length !== 1) throw new GiveawayError("The drop changed under you; reload.", 409, "wrong_status")
}

export async function deleteDraft(db: SupabaseClient, drop: DropRow): Promise<void> {
  if (drop.status !== "draft") throw new GiveawayError("Only a draft can be deleted.", 409, "wrong_status")
  const { data, error } = await db.from("giveaway_drops").delete().eq("id", drop.id).eq("status", "draft").select("id")
  if (error) throw error
  if (!data || data.length !== 1) throw new GiveawayError("The drop changed under you; reload.", 409, "wrong_status")
}

export interface VerifyReport {
  checked: number
  delivered: number
  pending: number
  /** Neither the recipient nor the admin holds it: moved elsewhere. */
  missing: number
  /** Recipients whose chain read failed; their rows were NOT touched. */
  failed_recipients: string[]
  written: number
  write_error: string | null
}

/**
 * Read the chain for every claimed moment and record what it says. Each
 * recipient is one complete read; a failed read leaves that recipient's rows
 * exactly as they were (never marked pending or missing from a read that did
 * not happen). `written` counts rows actually updated.
 */
export async function verifyDeliveries(
  db: SupabaseClient,
  drop: DropRow,
  read: (address: string, ids: string[]) => Promise<Record<string, Holding>> = readTopShotHoldings,
): Promise<VerifyReport> {
  const [pool, claims] = await Promise.all([getPool(db, drop.id), getClaims(db, drop.id)])
  const recipientByPack = new Map(claims.map((c) => [c.pack_no, c.recipient_address]))
  const byRecipient = new Map<string, PoolRow[]>()
  for (const m of pool) {
    const r = m.pack_no != null ? recipientByPack.get(m.pack_no) : undefined
    if (!r) continue
    byRecipient.set(r, [...(byRecipient.get(r) ?? []), m])
  }

  const report: VerifyReport = { checked: 0, delivered: 0, pending: 0, missing: 0, failed_recipients: [], written: 0, write_error: null }
  const undelivered: PoolRow[] = []
  const results: { m: PoolRow; recipientHolds: boolean }[] = []
  for (const [recipient, moments] of byRecipient) {
    let h: Record<string, Holding>
    try {
      h = await read(recipient, moments.map((m) => m.moment_id))
    } catch {
      report.failed_recipients.push(recipient)
      continue
    }
    for (const m of moments) {
      const holds = h[m.moment_id]?.held === true
      results.push({ m, recipientHolds: holds })
      if (!holds) undelivered.push(m)
    }
  }

  let adminHoldings: Record<string, Holding> | null = null
  if (undelivered.length) {
    try {
      adminHoldings = await read(drop.admin_wallet, undelivered.map((m) => m.moment_id))
    } catch {
      adminHoldings = null
    }
  }

  const now = new Date().toISOString()
  for (const { m, recipientHolds } of results) {
    // An undelivered moment whose admin-side read failed is not classifiable: skip it entirely.
    if (!recipientHolds && adminHoldings == null) {
      report.failed_recipients.push(`${drop.admin_wallet} (for ${m.moment_id})`)
      continue
    }
    const adminHolds = recipientHolds ? false : adminHoldings![m.moment_id]?.held === true
    report.checked += 1
    if (recipientHolds) report.delivered += 1
    else if (adminHolds) report.pending += 1
    else report.missing += 1
    const { data, error } = await db
      .from("giveaway_pack_moments")
      .update({
        last_checked_at: now,
        last_check_recipient_holds: recipientHolds,
        last_check_admin_holds: adminHolds,
        ...(recipientHolds && !m.delivered_at ? { delivered_at: now } : {}),
      })
      .eq("drop_id", drop.id)
      .eq("moment_id", m.moment_id)
      .select("moment_id")
    if (error) {
      report.write_error = error.message
      continue
    }
    report.written += data?.length ?? 0
  }
  return report
}

// ── public view ────────────────────────────────────────────────────────────

export interface PublicPoolMoment {
  moment_id: string
  player_name: string | null
  set_name: string | null
  team_name: string | null
  tier: string | null
  serial_number: number | null
  fmv_usd: number | null
  image_url: string | null
}

export interface MyPackMoment extends PublicPoolMoment {
  slot: number
  delivered: boolean
  last_checked_at: string | null
}

export interface PublicDropView {
  drop: {
    slug: string
    title: string
    description: string | null
    sponsor_name: string
    status: Exclude<DropStatus, "draft">
    pack_count: number
    moments_per_pack: number
    claimed_count: number
    seal_hash: string
    sealed_at: string
    opened_at: string | null
    closed_at: string | null
  }
  /** The whole pool, in a fixed order that reveals nothing about pack assignment. */
  pool: PublicPoolMoment[]
  values: PackValueSummary
  /** Published only after close. */
  verification: { salt: string; manifest: string } | null
  me: { pack_no: number; topshot_username: string; claimed_at: string; moments: MyPackMoment[] } | null
}

function publicMoment(m: PoolRow): PublicPoolMoment {
  return {
    moment_id: m.moment_id,
    player_name: m.player_name,
    set_name: m.set_name,
    team_name: m.team_name,
    tier: m.tier,
    serial_number: m.serial_number,
    fmv_usd: m.fmv_usd,
    image_url: m.image_url,
  }
}

/**
 * The page's data. A draft is not public (404). Pack assignments stay secret
 * until close, except the viewer's own pack. The pool is sorted by FMV then id,
 * never by pack, so its order leaks nothing.
 */
export function buildPublicView(
  drop: DropRow,
  pool: PoolRow[],
  claims: ClaimRow[],
  userId: string | null,
): PublicDropView | null {
  if (drop.status === "draft" || !drop.seal_hash || !drop.sealed_at) return null
  const mine = userId ? claims.find((c) => c.user_id === userId) ?? null : null
  const sorted = pool
    .slice()
    .sort((a, b) => (b.fmv_usd ?? -1) - (a.fmv_usd ?? -1) || a.moment_id.localeCompare(b.moment_id, "en", { numeric: true }))
  let verification: PublicDropView["verification"] = null
  if (drop.status === "closed" && drop.seal_salt) {
    // Rebuilt from the stored assignment — the same function that produced the hash.
    const byPack = pool
      .filter((m) => m.pack_no != null && m.slot != null)
      .map((m) => ({ moment_id: m.moment_id, pack_no: m.pack_no as number, slot: m.slot as number }))
    verification = { salt: drop.seal_salt, manifest: manifestOfRows(byPack) }
  }
  return {
    drop: {
      slug: drop.slug,
      title: drop.title,
      description: drop.description,
      sponsor_name: drop.sponsor_name,
      status: drop.status,
      pack_count: drop.pack_count,
      moments_per_pack: drop.moments_per_pack,
      claimed_count: claims.length,
      seal_hash: drop.seal_hash,
      sealed_at: drop.sealed_at,
      opened_at: drop.opened_at,
      closed_at: drop.closed_at,
    },
    pool: sorted.map(publicMoment),
    values: summarizePackValues(pool),
    verification,
    me: mine
      ? {
          pack_no: mine.pack_no,
          topshot_username: mine.topshot_username,
          claimed_at: mine.claimed_at,
          moments: pool
            .filter((m) => m.pack_no === mine.pack_no)
            .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0))
            .map((m) => ({
              ...publicMoment(m),
              slot: m.slot ?? 0,
              delivered: m.delivered_at != null,
              last_checked_at: m.last_checked_at,
            })),
        }
      : null,
  }
}

export type ClaimOutcome =
  | "claimed"
  | "already_claimed"
  | "not_found"
  | "not_open"
  | "admin_recipient"
  | "recipient_taken"
  | "all_claimed"

export async function claimPack(
  db: SupabaseClient,
  dropId: string,
  userId: string,
  username: string,
  recipient: string,
): Promise<{ outcome: ClaimOutcome; pack_no: number | null }> {
  const { data, error } = await db.rpc("claim_giveaway_pack", {
    p_drop_id: dropId,
    p_user_id: userId,
    p_username: username,
    p_recipient: recipient,
  })
  if (error) throw error
  const row = Array.isArray(data) ? data[0] : data
  if (!row || typeof row.outcome !== "string") throw new Error("claim_giveaway_pack returned no outcome")
  return { outcome: row.outcome as ClaimOutcome, pack_no: row.pack_no ?? null }
}
