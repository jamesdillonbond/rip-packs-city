// Pure helpers for the interactive Moment slab (components/InteractiveSlab.tsx).
//
// 2026-11-25 (Trevor, "Build it"): collectors asked Top Shot to bring back the
// interactive Moment ("I need to caress my momes" — @coultin, 11-24). RPC gives
// every Moment detail page a slab you can drag, spin, flip and tilt. These are
// the parts with no DOM in them, kept here so the angle math and the flag are
// pinned by tests rather than by eye.

/** The query parameter that turns the slab on (`?slab=1`) or off (`?slab=0`) for this browser. */
export const SLAB_QUERY_PARAM = "slab"
/** localStorage key that remembers a `?slab=1` opt-in across page views. */
export const SLAB_STORAGE_KEY = "rpc:slab3d"

/**
 * Whether the interactive slab is on. A build-time default (NEXT_PUBLIC_MOMENT_SLAB_3D)
 * turns it on for everyone; otherwise a viewer opts in with `?slab=1`, which is
 * remembered. `?slab=0` always wins, so a viewer can turn it off again.
 */
export function slabEnabled(input: {
  envDefault: string | undefined
  queryValue: string | null
  storedValue: string | null
}): boolean {
  if (input.queryValue === "0") return false
  if (input.queryValue === "1") return true
  if (input.storedValue === "0") return false
  if (input.storedValue === "1") return true
  return input.envDefault === "1"
}

/** Angle in degrees folded into [0, 360). */
export function normalizeDeg(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  const r = deg % 360
  return r < 0 ? r + 360 : r
}

/** True when the slab's back faces the viewer (rotation between 90° and 270°). */
export function showingBack(rotY: number): boolean {
  const n = normalizeDeg(rotY)
  return n > 90 && n < 270
}

/** The nearest resting angle — a multiple of 180°, so the slab always settles face-on. */
export function nearestRest(rotY: number): number {
  if (!Number.isFinite(rotY)) return 0
  return Math.round(rotY / 180) * 180
}

/** The resting angle one flip away from the nearest rest, in the given direction. */
export function flipTarget(rotY: number, direction: 1 | -1 = 1): number {
  return nearestRest(rotY) + 180 * direction
}

export function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return 0
  return Math.min(hi, Math.max(lo, v))
}

/**
 * Phone tilt → slab tilt. `beta` is front-back, `gamma` left-right (degrees,
 * from DeviceOrientationEvent), each measured from the pose the phone was in
 * when tilt was switched on, so the slab starts flat however the phone is held.
 */
export function tiltFromOrientation(
  beta: number | null,
  gamma: number | null,
  base: { beta: number; gamma: number },
  maxDeg = 18,
): { x: number; y: number } {
  if (beta == null || gamma == null || !Number.isFinite(beta) || !Number.isFinite(gamma)) return { x: 0, y: 0 }
  return {
    x: clamp(-(beta - base.beta) * 0.6, -maxDeg, maxDeg),
    y: clamp((gamma - base.gamma) * 0.8, -maxDeg, maxDeg),
  }
}

/** Special-serial finish for the slab — #1 beats jersey beats perfect, as everywhere else on RPC. */
export type SlabFinish = "first" | "jersey" | "perfect" | null

export function finishFromBadges(badgeTypes: ReadonlyArray<string>): SlabFinish {
  if (badgeTypes.includes("first_serial")) return "first"
  if (badgeTypes.includes("jersey_match")) return "jersey"
  if (badgeTypes.includes("perfect_mint")) return "perfect"
  return null
}

export const FINISH_LABEL: Record<Exclude<SlabFinish, null>, string> = {
  first: "#1 Serial",
  jersey: "Jersey Serial",
  perfect: "Perfect Serial",
}
