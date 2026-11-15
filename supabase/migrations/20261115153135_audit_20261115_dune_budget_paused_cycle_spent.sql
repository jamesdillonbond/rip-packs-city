-- audit_20261115_dune_budget_paused_cycle_spent
--
-- WHAT: the Dune Analyst cycle is spent (3,991.4 / 4,000 credits at ~7:31 AM PT 2026-11-15; the #190
-- transfer-hop query 9129613 v3 alone cost 1,646.7). paused=true stops every lane that honours the switch
-- (the #190 stage route's purchases/provenance/hop lanes) from reading Dune until the reset
-- (billing period ends 2026-12-14 00:00 UTC = Dec 13 4 PM PT).
--
-- REVERT: UPDATE public.dune_budget_state SET paused = false WHERE id = 1;

UPDATE public.dune_budget_state
   SET paused = true,
       note = note || ' | 2026-11-15 ~7:35 AM PT: paused true again — the Analyst cycle is spent (3,991.4 / 4,000 credits; the #190 transfer-hop query 9129613 v3 alone cost 1,646.7). Resume after the reset (billing period ends 2026-12-14 00:00 UTC = Dec 13 4 PM PT). REVERT: paused=false.',
       updated_at = now()
 WHERE id = 1;
