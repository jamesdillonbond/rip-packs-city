// lib/emails/day1-onboarding-recipients.ts
//
// Row shaping for app/api/cron/day1-onboarding (kept out of the route file:
// Next.js route modules may export only handler names).

import type { Day1Segment } from "@/lib/emails/day1-onboarding-email"

export type Day1Candidate = {
  user_id: string
  email: string | null
  username: string | null
  segment: string | null
  fmv_usd: number | string | null
  moment_count: number | string | null
  hours_since_signup: number | string | null
}

/** A finite number from a numeric column (PostgREST returns numeric as a string), else null. */
export function num(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = typeof v === "number" ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** A candidate row the email can be built from, or null (no address / unknown segment). */
export function toRecipient(r: Day1Candidate): {
  userId: string
  email: string
  username: string | null
  segment: Day1Segment
  fmvUsd: number | null
  momentCount: number | null
} | null {
  const email = typeof r.email === "string" ? r.email.trim().toLowerCase() : ""
  if (!r.user_id || !email.includes("@")) return null
  if (r.segment !== "no_wallet" && r.segment !== "wallet") return null
  return { userId: r.user_id, email, username: r.username ?? null, segment: r.segment, fmvUsd: num(r.fmv_usd), momentCount: num(r.moment_count) }
}
