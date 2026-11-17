// lib/verify-challenge-target.ts
//
// 2026-11-15: the $999 cap in app/api/profile/verify-challenge/route.ts (computeChallengeAmount) means a Moment worth more than ~$99.90 would be
// asked to list at under 10× its value — close enough to market that someone could
// buy it. Never pick such a target. (Measured 11-15: every unverified wallet's pick
// was worth ≤ $0.19, so this changes nothing today; it keeps the promise
// "nobody will buy it" true for a wallet whose cheapest Moment is expensive.)
export const MAX_SAFE_TARGET_FMV = 99.9;
export function isSafeChallengeTarget(fmvUsd: number | null): boolean {
  return !(Number.isFinite(fmvUsd as number) && (fmvUsd as number) > MAX_SAFE_TARGET_FMV);
}

