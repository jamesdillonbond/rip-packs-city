-- audit_20261123_allday_draft_pick_voucher_descriptions
--
-- 2026-11-23 (Claude Code cloud; Trevor: "Keep going"). Follow-on to deep-audit R8 (closed today): the 36 All Day
-- "NFL Draft" editions 4102–4137 (set 112, play_type "Draft Pick") are REDEEMABLE DRAFT-PICK VOUCHERS with no player or
-- team on-chain, so their edition page showed a bare "NFL Draft" with nothing explaining what the Moment is.
-- `editions.description` is what the edition page renders (paragraph + <meta description>, lib/edition/description.ts)
-- and it was NULL on all 36. The chain carries the text: AllDay.getPlayData(…).metadata["description"], read
-- 2026-11-23 ~12:25 PM PT through pg_net → Flow REST, 36/36 HTTP 200, two variants (copied verbatim below).
-- lib/editions-hydrate.ts writes description only when upstream has one (no NULL clobber), so the fill persists.
-- Only NULL descriptions are filled; nothing else changes.
-- REVERT: UPDATE public.editions SET description = NULL
--   WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND external_id::int BETWEEN 4102 AND 4137
--     AND description IN ('Use this Moment to earn a Rookie Debut from a player drafted in this round.',
--                         'Use this Moment to earn the Rookie Debut from the selected draft pick.');

UPDATE public.editions
   SET description = 'Use this Moment to earn a Rookie Debut from a player drafted in this round.'
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
   AND external_id IN ('4102','4103','4104','4105')
   AND description IS NULL;

UPDATE public.editions
   SET description = 'Use this Moment to earn the Rookie Debut from the selected draft pick.'
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
   AND external_id IN ('4106','4107','4108','4109','4110','4111','4112','4113','4114','4115','4116','4117','4118','4119',
                       '4120','4121','4122','4123','4124','4125','4126','4127','4128','4129','4130','4131','4132','4133',
                       '4134','4135','4136','4137')
   AND description IS NULL;
