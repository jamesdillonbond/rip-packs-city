// The residential Panini runner's watchdog verdict (scripts/panini-stall-watchdog.mjs), as posted to
// /api/cron/panini-ingest under `stall`. Parsed whole or not at all: a half-read report would log a
// phase or duration the runner never sent.
export type StallReport = { kind: "stall" | "slept"; phase: string; detail: string | null; minutes: number }

/** The runner's watchdog verdict, or null when absent or malformed (never logged half-read). */
export function parseStall(v: unknown): StallReport | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (o.kind !== "stall" && o.kind !== "slept") return null;
  const minutes = Number(o.kind === "stall" ? o.idle_min : o.gap_min);
  if (!Number.isFinite(minutes) || typeof o.phase !== "string") return null;
  return {
    kind: o.kind,
    phase: o.phase.slice(0, 40),
    detail: typeof o.detail === "string" ? o.detail.slice(0, 120) : null,
    minutes: Math.round(minutes),
  };
}
