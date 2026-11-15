// In-memory twins of the trade-room locked transitions (2026-11-14, known-issues #250).
//
// The SQL functions in supabase/migrations/*_trade_room_state_transitions_lock_the_room_row.sql
// are pinned on their own by supabase/tests/trade_room_locked_transitions.sql (verbatim, drift-
// guarded). These twins let the TypeScript store/route suites run against memorySupabase with the
// same VERDICTS, so those suites test the store's mapping of each verdict — not the SQL again.
// A single-threaded fake cannot race, which is exactly why the lock lives in SQL.

import type { MemoryDb } from "./memory-supabase"

type Row = Record<string, unknown>
const ok = (data: unknown) => ({ data, error: null })

function cosignedInWindow(m: MemoryDb, roomId: unknown, ttlSeconds: number): boolean {
  const since = Date.now() - ttlSeconds * 1000
  return (m.tables.trade_room_relay ?? []).some(
    (r: Row) => r.room_id === roomId && r.signed_at != null && Date.parse(String(r.created_at)) > since,
  )
}

export function withLockedRpcs(m: MemoryDb): MemoryDb {
  const room = (id: unknown) => (m.tables.trade_rooms ?? []).find((r: Row) => r.id === id)
  const now = () => new Date().toISOString()
  m.rpcs.trade_room_cancel_locked = (a) => {
    const r = room(a.p_room_id)
    if (!r) return ok("not_found")
    if (r.status === "sealed") return ok("sealed")
    if (r.status === "cancelled") return ok("ok")
    if (r.status !== a.p_expected_status) return ok("stale")
    if (r.status === "signing" && cosignedInWindow(m, r.id, Number(a.p_relay_ttl_seconds))) return ok("cosigned")
    Object.assign(r, { status: "cancelled", cancelled_by: a.p_cancelled_by, cancel_reason: a.p_reason, updated_at: now() })
    return ok("ok")
  }
  m.rpcs.trade_room_post_signature_locked = (a) => {
    const r = room(a.p_room_id)
    if (!r) return ok("not_found")
    if (r.status !== "signing") return ok("not_signing")
    const rel = (m.tables.trade_room_relay ?? []).find((x: Row) => x.id === a.p_relay_id && x.room_id === a.p_room_id && x.signature == null)
    if (!rel) return ok("already_signed")
    Object.assign(rel, { signature: a.p_signature, key_id: a.p_key_id, signed_at: now() })
    return ok("ok")
  }
  m.rpcs.trade_room_mark_signing_locked = (a) => {
    const r = room(a.p_room_id)
    if (!r) return ok("not_found")
    if (r.version !== a.p_version || !["accepted", "signing"].includes(String(r.status))) return ok("stale")
    const accepted = (m.tables.trade_room_sides ?? []).filter((s: Row) => s.room_id === r.id && (s.side === "a" || s.side === "b") && s.accepted_version === a.p_version).length
    if (accepted !== 2) return ok("not_accepted")
    Object.assign(r, { status: "signing", updated_at: now() })
    return ok("ok")
  }
  m.rpcs.trade_room_unaccept_locked = (a) => {
    const r = room(a.p_room_id)
    if (!r) return ok("not_found")
    if (!["open", "building", "accepted"].includes(String(r.status))) return ok(r.status)
    for (const s of m.tables.trade_room_sides ?? []) if (s.room_id === r.id && s.side === a.p_side) Object.assign(s, { accepted_version: null, updated_at: now() })
    if (r.status === "accepted") Object.assign(r, { status: "building", updated_at: now() })
    return ok("ok")
  }
  m.rpcs.trade_room_signing_ended_locked = (a) => {
    const r = room(a.p_room_id)
    if (!r) return ok("not_found")
    if (r.status !== "signing") return ok("ok")
    if (cosignedInWindow(m, r.id, Number(a.p_relay_ttl_seconds))) return ok("cosigned")
    Object.assign(r, { status: "accepted", updated_at: now() })
    return ok("ok")
  }
  return m
}
