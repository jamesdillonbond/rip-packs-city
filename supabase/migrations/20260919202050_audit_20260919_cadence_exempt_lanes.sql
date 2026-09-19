-- Lanes whose RUN COUNT is not a health metric, so "cadence collapse" cannot apply.
--
-- ── WHY A TABLE AND NOT A `NOT LIKE` IN THE FUNCTION ───────────────────────
-- CLAUDE.md: prefer a ban at zero over an allowlist, and make SUPPRESSION the
-- curated list. The population stays every lane; this is the curated exception,
-- and it is required to carry its own reasoning:
--   * `reason`   — WHY run count cannot measure this lane's health
--   * `evidence` — the MEASUREMENT that establishes it (a filed decision with
--                  no number in it is the tell CLAUDE.md names for a weak one)
--   * `review_by`— an expiry, because a suppression list that grows silently
--                  forever is how an alarm dies. ⛔ Past `review_by` the row
--                  STOPS SUPPRESSING and the lane fires again. Fail-loud is the
--                  correct direction: the alternative is an exemption nobody
--                  ever re-examines, which is exactly the "filed DECISION NOT TO
--                  ACT that nobody re-checks" this repo keeps paying for.
--
-- ⚠ The CHECKs on reason/evidence length are not decoration. An exemption whose
-- justification is "noisy" is indistinguishable from one that was never thought
-- about, and this table's whole value is that a reader can audit the decision
-- without re-deriving it.
CREATE TABLE IF NOT EXISTS public.cadence_exempt_lanes (
  pipeline_pattern text PRIMARY KEY,
  reason           text        NOT NULL,
  evidence         text        NOT NULL,
  review_by        date        NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cadence_exempt_reason_is_stated   CHECK (length(btrim(reason))   >= 30),
  CONSTRAINT cadence_exempt_evidence_is_stated CHECK (length(btrim(evidence)) >= 30)
);

COMMENT ON TABLE public.cadence_exempt_lanes IS
  'Lanes exempt from check_pipeline_cadence_collapse() scoring because their run count tracks DEMAND, not health. Past review_by a row stops suppressing and the lane fires again.';

ALTER TABLE public.cadence_exempt_lanes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cadence_exempt_lanes FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cadence_exempt_lanes TO service_role;
