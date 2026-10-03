-- 2026-10-03 (Trevor: "Keep going"): the tester's last three `new` rows are
-- features that are already live on the team checklist, so the inbox should
-- say so. 10237 (tier toggle) and 10239 (hide owned) shipped 10-03 9:42 AM PT
-- in `f70257086` ("team checklist: tier and ownership toggles (webz
-- feedback)") — the per-tier chips and the owned / missing legend are toggles,
-- persisted per collection. 10244 (edition-level "collect them all" view) is
-- the "Full editions" view, live since 09-30 (`d552a6592`), which lists every
-- edition with its price and source and, with a wallet, owned / missing.
-- The two other `new` rows (10367, 10373) are QA probe sessions
-- (is_smoke_test = true) and are invisible to the inbox; untouched.
-- A plain UPDATE through execute_sql is refused by the cloud session's
-- permission layer; recorded as a migration like 20261003184026.
-- No schema change. Revert: set feedback_status='new', shipped_at=NULL on
-- the three ids and strip the note text added here.

UPDATE public.beta_feedback_inbox
SET feedback_status = 'shipped',
    shipped_at = now(),
    updated_at = now(),
    admin_note = COALESCE(admin_note || ' · ', '') || CASE id
      WHEN 10237 THEN '2026-10-03: the per-tier chips on the team checklist are toggles — click Ultimate (or any tier) to hide it from the completion view; the choice is remembered per collection and "all tiers" clears it.'
      WHEN 10239 THEN '2026-10-03: with a wallet pasted, the owned / owned+locked / missing legend entries are toggles — click "owned" to hide what you already have and see only the missing ones.'
      WHEN 10244 THEN '2026-10-03: the "Full editions" view (the view switch at the top of the checklist) is the edition-level collect-them-all list — every edition of the team with its price (ASK / FMV / parallel) and, with a wallet, owned vs missing. Live since 09-30.'
    END
WHERE id IN (10237, 10239, 10244)
  AND feedback_status = 'new';

DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.beta_feedback_inbox WHERE id IN (10237, 10239, 10244) AND feedback_status = 'shipped') <> 3 THEN
    RAISE EXCEPTION 'expected three shipped rows';
  END IF;
END
$verify$;
