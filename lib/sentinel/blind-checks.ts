// How many sentinel checks could not be evaluated AT ALL, as its own arm.
//
// ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
// Every check in `app/api/sentinel/route.ts` that dies on a statement timeout,
// a pool exhaustion or an abort degrades itself to `warn` with an
// "INCONCLUSIVE (db saturated)" detail rather than paging. ⭐ **That per-check
// rule is CORRECT and it was earned** — the route's own header records two
// false CRITICAL pages (2026-06-10, 2026-07-16) where a timeout was reported as
// data loss while sales were flowing normally. Nothing here changes it.
//
// The gap is one level up. The overall status is computed with
// `checks.some(c => c.status === "warn")`, so **ONE warn and THIRTEEN warns
// produce the identical `WARN`**, and the GHA gate only fails the job on
// `CRITICAL`. So a total measurement blackout is scored exactly like a single
// routine niggle, and the badge stays green.
//
// ⭐ **Each check reasons correctly in isolation and no check can see the
// population.** "My query timed out, that is not data loss" is right. "Six of us
// timed out at once" is a different statement, it is much stronger evidence, and
// before this arm nothing in the system could make it.
//
// ── MEASURED, 2026-09-09 ────────────────────────────────────────────────────
// The instance ran 5-10x degraded for nine hours (fleet median pipeline duration
// 3,085 ms at 08Z to 30,921 ms at 18Z, against a flat 09-07 and 09-08 at the
// same hours), pg_cron logged 270+ `job startup timeout` failures against
// `max_worker_processes = 6`, and `ts-listings-atlas-sync` ran 113 times against
// 268 the day before. The 18:47Z sweep reported SIX of sixteen checks
// INCONCLUSIVE — including `Trust Health`, the master arm. Overall status: WARN.
// GHA: green. `ops_alert_dedup`: empty for fourteen hours.
//
// ── WHY THIS ARM CANNOT BE BLINDED THE WAY THE OTHERS WERE ──────────────────
// ⭐ It issues NO query. Its input is the other checks' failure to answer, so it
// is the one arm that gets MORE informative as the database gets worse — the
// opposite of every check it summarises.
//
// ── THRESHOLD, AND WHY IT IS NOT INVENTED ───────────────────────────────────
// The sentinel report is not persisted anywhere (only `sentinel_threshold_config`
// is read), so there is NO distribution of historical inconclusive counts to fit
// a threshold to. Rather than invent one, the arm is anchored on the only two
// data points that exist, one in each direction:
//   • NEGATIVE — the 2026-06-10 false page the route's header describes as
//     "4 parts timeout noise, 0 parts data loss". Read as four inconclusive
//     checks judged, correctly, to be noise. The threshold must NOT fire there.
//   • POSITIVE — 2026-09-09, six inconclusive during a nine-hour real incident.
//     The threshold MUST fire there.
// `ceil(evaluated / 3)` with a floor of 5 gives 6 on today's 16 checks: it fires
// on the positive anchor and stays quiet on the negative one. ⚠ Two anchors is a
// weak basis and is stated as such — which is the other half of this arm's job:
// **the detail line reports the count on EVERY run, including at `ok`, so the
// distribution this threshold should have been fitted to starts accumulating in
// the sentinel logs from now on.** Re-derive it before trusting the 6.
//
// ── WHY IT NEVER PAGES ──────────────────────────────────────────────────────
// ⛔ This arm is CAPPED AT `warn` and can never return `critical`. Escalating a
// blackout to CRITICAL is precisely the 2026-06-10 mistake, one level up. It
// also honours the convention already stated twice in the sentinel route: a
// permanently-warn arm drags the whole report to WARN and desensitises every
// other arm, so below the threshold this is `ok` AND VISIBLE, never a silent
// skip and never a chronic warn.

/** The marker the sentinel route stamps on a check it could not evaluate. */
export const INCONCLUSIVE_MARKER = "INCONCLUSIVE";

/**
 * ⚠ THE MARKER ALONE IS NOT ENOUGH, AND THIS ARM WAS WRONG BEFORE IT SHIPPED.
 *
 * Checked against the REAL 2026-09-09 18:47Z sweep rather than against a
 * fixture I wrote, and the count came out at FOUR, not six — below this arm's
 * own threshold. It would have stayed silent on the very incident that
 * motivated it. Two checks timed out with the identical saturation error and
 * were never labelled:
 *   "FMV Confidence (canonical TS)" — "RPC error (canceling statement due to statement timeout)"
 *   "Edition Coverage"             — "Coverage RPC error: canceling statement due to statement timeout"
 * Both build their detail by hand instead of prefixing `INCONCLUSIVE`.
 *
 * ⭐ So the arm keys on the CONDITION, not the LABEL. A check is blind if it
 * says so OR if its detail carries the saturation signature — the same class the
 * route's own `isSaturationError()` recognises. Anchoring on a string somebody
 * has to remember to prepend is the "guard that names its instances" trap: the
 * two unlabelled checks are not an oversight to go fix and forget, they are
 * proof that the label will drift again.
 */
const SATURATION_SIGNATURE =
  /statement timeout|canceling statement|connection pool|timeout acquiring|connection terminated|upstream request timeout|fetch failed|operation was aborted|57014/i;

/** Could this check not be evaluated at all? Condition-based, not label-based. */
export function isBlind(detail: string | undefined | null): boolean {
  const d = detail ?? "";
  return d.includes(INCONCLUSIVE_MARKER) || SATURATION_SIGNATURE.test(d);
}

export interface BlindCheckInput {
  name: string;
  status: "ok" | "warn" | "critical";
  detail: string;
}

export interface BlindCheckSummary {
  /** Checks carrying the inconclusive marker, excluding config-disabled ones. */
  blind: number;
  /** Checks considered (excludes config-disabled and this arm itself). */
  evaluated: number;
  /** Count at or above which this arm warns. */
  threshold: number;
  status: "ok" | "warn";
  detail: string;
  names: string[];
}

/** This arm's own name — excluded from its own population. */
export const BLIND_CHECK_NAME = "Measurement Blackout";

const FRACTION = 3; // one third
const FLOOR = 5;

/** Threshold: a third of the evaluated checks, never below the floor. */
export function blindThreshold(evaluated: number): number {
  return Math.max(FLOOR, Math.ceil(evaluated / FRACTION));
}

/**
 * Summarise how many checks could not be evaluated.
 *
 * @param checks   the assembled sentinel checks
 * @param disabled names of checks forced to ok by config (excluded from the
 *   population — they are deliberately outside the measurement set, and counting
 *   them would let a permanently-disabled inconclusive check inflate this arm
 *   forever, which is the chronic-warn failure the route warns about).
 */
export function summariseBlindChecks(
  checks: readonly BlindCheckInput[],
  disabled: ReadonlySet<string> = new Set(),
): BlindCheckSummary {
  const population = checks.filter((c) => c.name !== BLIND_CHECK_NAME && !disabled.has(c.name));
  const blindOnes = population.filter((c) => isBlind(c.detail));
  const evaluated = population.length;
  const threshold = blindThreshold(evaluated);
  const blind = blindOnes.length;
  // ⛔ Never "critical" — see the header. The cap is structural, not a policy
  // that a future edit can drift past without failing a test that names it.
  const status: "ok" | "warn" = blind >= threshold ? "warn" : "ok";
  const detail =
    blind === 0
      ? `All ${evaluated} checks were evaluated (0 inconclusive).`
      : `${blind} of ${evaluated} checks could not be evaluated (threshold ${threshold}): ${blindOnes
          .map((c) => c.name)
          .join(", ")}. A check that times out is not data loss on its own — but this many at once means the database could not answer, so every OTHER 'ok' in this report is weaker than it looks.`;
  return { blind, evaluated, threshold, status, detail, names: blindOnes.map((c) => c.name) };
}
