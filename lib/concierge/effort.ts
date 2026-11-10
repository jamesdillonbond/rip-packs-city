// Effort (2026-11-09). Sonnet 5.5 defaults to `high` on the API when a request
// names none, which is how the concierge ran until today without anyone choosing
// it; Anthropic's model guide starts interactive chat at `low`/`medium`. 98-99 %
// of a concierge turn's wall-clock is the model (tools are <150 ms), so effort is
// the latency lever. Set explicitly so the choice is visible and reversible: the
// `CONCIERGE_EFFORT` env var overrides this default without a deploy of code.
export const EFFORT_LEVELS = ["low", "medium", "high"] as const;
export type ConciergeEffort = (typeof EFFORT_LEVELS)[number];
// 2026-11-09 replay (8 real user questions, high vs medium, prod): same tools on
// 7 of 8, answers equivalent in substance, model time -20 % (56.3 s -> 45.3 s
// summed) and output tokens -23 % (6,322 -> 4,846). Medium also asked before
// logging feedback where high logged it unasked. Flip back with CONCIERGE_EFFORT=high.
export const DEFAULT_CONCIERGE_EFFORT: ConciergeEffort = "medium";
export function conciergeEffort(): ConciergeEffort {
  const env = (process.env.CONCIERGE_EFFORT ?? "").trim().toLowerCase();
  return (EFFORT_LEVELS as readonly string[]).includes(env) ? (env as ConciergeEffort) : DEFAULT_CONCIERGE_EFFORT;
}
// A request may LOWER effort (never raise it) with `x-rpc-concierge-effort` —
// the A/B replay harness for this setting. Downward-only means the header cannot
// buy a dearer answer than the default, so it needs no secret.
export function resolveConciergeEffort(header: string | null, base: ConciergeEffort = conciergeEffort()): ConciergeEffort {
  const want = (header ?? "").trim().toLowerCase();
  const wi = (EFFORT_LEVELS as readonly string[]).indexOf(want);
  const bi = EFFORT_LEVELS.indexOf(base);
  return wi >= 0 && wi < bi ? EFFORT_LEVELS[wi] : base;
}
