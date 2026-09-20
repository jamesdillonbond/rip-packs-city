"use client"

// Client-side username resolver for the analytics surface.
//
// useResolveUsernames(addrs) batches the unique addresses into a single
// /api/analytics/wallets/resolve-usernames call and returns a flat
// { addr → username } map. Addresses with no entry are simply absent
// from the map so callers can fall back to the truncated address.
//
// Cached per-render via useMemo on the input list, plus a session-wide
// in-memory cache so repeat renders / repeated mounts don't re-fetch
// already-known addresses.

import { useEffect, useMemo, useState } from "react"

import { isSolanaAddress } from "@/lib/address"

const SESSION_CACHE = new Map<string, string>()
const NEGATIVE_CACHE = new Set<string>()

const FLOW_ADDR_RE = /^0x[0-9a-f]{16}$/i
const MAX_PER_CALL = 100

function normalize(addrs: string[]): string[] {
  const out = new Set<string>()
  for (const a of addrs) {
    const lower = (a || "").toLowerCase().trim()
    if (FLOW_ADDR_RE.test(lower)) out.add(lower)
  }
  return Array.from(out)
}

export function useResolveUsernames(addrs: string[]): Record<string, string> {
  const normalized = useMemo(() => normalize(addrs), [addrs])
  const cacheKey = useMemo(() => normalized.join(","), [normalized])

  // Snapshot whatever we already have in the session cache so the first
  // render doesn't blink. State changes when the network call returns.
  const initial = useMemo(() => {
    const out: Record<string, string> = {}
    for (const a of normalized) {
      const cached = SESSION_CACHE.get(a)
      if (cached) out[a] = cached
    }
    return out
  }, [normalized])

  const [resolved, setResolved] = useState<Record<string, string>>(initial)

  useEffect(() => {
    setResolved(initial)
    // Only fetch the addresses we haven't already attempted to resolve.
    const missing = normalized.filter(
      (a) => !SESSION_CACHE.has(a) && !NEGATIVE_CACHE.has(a)
    )
    if (missing.length === 0) return

    let cancelled = false
    const batches: string[][] = []
    for (let i = 0; i < missing.length; i += MAX_PER_CALL) {
      batches.push(missing.slice(i, i + MAX_PER_CALL))
    }

    Promise.all(
      batches.map((batch) =>
        fetch(
          `/api/analytics/wallets/resolve-usernames?addrs=${encodeURIComponent(batch.join(","))}`
        )
          .then((r) => (r.ok ? r.json() : { usernames: {} }))
          .catch(() => ({ usernames: {} }))
      )
    )
      .then((results) => {
        if (cancelled) return
        const merged: Record<string, string> = {}
        for (const r of results) {
          const usernames = (r as { usernames?: Record<string, string> })?.usernames ?? {}
          for (const [addr, username] of Object.entries(usernames)) {
            const lower = addr.toLowerCase()
            SESSION_CACHE.set(lower, username)
            merged[lower] = username
          }
        }
        // Mark addrs we asked about but didn't get back as negative-cached.
        for (const a of missing) {
          if (!SESSION_CACHE.has(a)) NEGATIVE_CACHE.add(a)
        }
        setResolved((prev) => ({ ...prev, ...merged }))
      })
      .catch(() => {
        // soft-fail — caller falls back to truncated addresses
      })

    return () => {
      cancelled = true
    }
    // cacheKey captures normalized identity; we deliberately key the effect
    // on it so identical addrs lists don't re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey])

  return resolved
}

// ⛔ CHAIN-SCOPED, 2026-09-20 — the client half of the same defect fixed in
// lib/flowty-username.ts the same hour, and a textbook instance of CLAUDE.md's
// "grep for the EXPRESSION, not the file": these two bodies are copy-paste
// twins, so fixing only the one that showed the symptom would have left the
// other to re-introduce it on the next surface.
//
// Solana base58 is CASE-SENSITIVE. Folding it does not normalise a Candy key,
// it destroys it — and because this fallback RENDERS what it folded, the result
// is a fabricated identity, not an honest absence.
//
// ⚠ `normalize()` above still admits Flow addresses ONLY, and that stays: there
// is no Solana @handle source to resolve against, so a Candy wallet is never
// asked about. That is an honest absence — it reaches `truncateAddress` and must
// come out with its case intact.
//
// ⚠ THE HEX PATH IS BYTE-IDENTICAL, fold included; the test pins it as its own
// no-change arm.

export function truncateAddress(addr: string): string {
  const raw = addr || ""
  if (isSolanaAddress(raw)) {
    const b58 = raw.trim()
    return b58.length <= 10 ? b58 : b58.slice(0, 6) + "…" + b58.slice(-4)
  }
  const a = raw.toLowerCase()
  if (!a.startsWith("0x")) return a
  if (a.length <= 10) return a
  return a.slice(0, 6) + "…" + a.slice(-4)
}

export function displayName(addr: string, names: Record<string, string>): string {
  const raw = addr || ""
  // ⚠ The fallback takes the ORIGINAL address, not the folded key. Handing the
  // folded key to the renderer is exactly what fabricated the Candy identities.
  const key = isSolanaAddress(raw) ? raw.trim() : raw.toLowerCase()
  return names[key] || truncateAddress(raw)
}
