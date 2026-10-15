-- audit_20261014 — beta_feedback_inbox triage: 10367 and 10373 were logged on
-- 10-03 for problems already reported and shipped (10247, 10237). Re-verified
-- live 2026-10-14 ~5:05 PM PT: get_team_checklist(Top Shot, 'detroit-pistons',
-- 'all_time') paged to completion returns 381 editions with Series 1 =
-- 6 LEGENDARY / 9 RARE / 8 COMMON, the reporter's exact expectation.
-- Applied through the dashboard SQL editor (the MCP held it), Trevor's OK.
-- REVERT: UPDATE public.beta_feedback_inbox SET feedback_status='new',
--   duplicate_of=NULL, admin_note=NULL WHERE id IN (10367,10373);
UPDATE public.beta_feedback_inbox
SET feedback_status = 'duplicate',
    duplicate_of = CASE id WHEN 10367 THEN 10247 WHEN 10373 THEN 10237 END,
    updated_at = now(),
    admin_note = CASE id
      WHEN 10367 THEN '2026-10-14: duplicate of #10247 (shipped 10-03). Re-verified live 2026-10-14 ~5:05 PM PT: the Pistons all-time checklist, read to completion (381 editions), shows Series 1 as 6 Legendary / 9 Rare / 8 Common, exactly the expected counts.'
      WHEN 10373 THEN '2026-10-14: duplicate of #10237 (shipped 10-03): the per-tier chips on the team checklist are toggles; click Ultimate to hide it, and the choice is remembered.'
    END
WHERE id IN (10367, 10373) AND feedback_status = 'new';
