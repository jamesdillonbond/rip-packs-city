-- REVERT PATH for the 2026-09-14 `sales` parallel -> base repair.
--
-- Executed:  SELECT public.remap_topshot_parallel_to_base_misattributed();  -- returned 37
-- Effect:    37 Top Shot `sales` rows moved off a PARALLEL edition (external_id like '%::%')
--            onto its BASE edition (split_part(external_id,'::',1)).
-- Captured:  the (sale_id, old_edition_id) pairs BELOW were read from the live DB in the same
--            session, from the function's own predicate re-expressed as a SELECT, immediately
--            BEFORE the UPDATE ran. The dry run counted 37; the UPDATE returned 37.
--
-- There is no audit TABLE for this function (unlike the wmc sibling, which writes
-- `audit_20260911_wmc_parallel_to_base_rekey`). This file IS the revert path.
--
-- 33 distinct old editions across 37 sales -- four editions appear twice, which is why the
-- revert must be keyed per SALE, not per edition.
--
-- To revert:
--   BEGIN;
--   <the UPDATE below>
--   -- expect: UPDATE 37
--   COMMIT;
--
-- ⚠ Reverting restores rows the trust-board metric `topshot_impossible_parallel_serials`
--   counts as breaches: the metric would go 0 -> 37 (WARN threshold is 3).

UPDATE public.sales s
   SET edition_id = v.old_edition_id
  FROM (VALUES
('016bbfc2-c7ca-4a83-8347-7c0f20d30d68'::uuid,'f752adb5-2222-4efc-ab07-bf9d069d1aa8'::uuid),
('0419db07-cb11-4b41-b768-1c4aba8b370a'::uuid,'abbad49f-dcca-42e0-9481-fa9b65bf39de'::uuid),
('0696e7a1-a8a3-44cd-98ec-13b48afd9ea3'::uuid,'7d09c23a-6298-4f2b-b79c-fe44834bf921'::uuid),
('16ec850f-eafb-42fa-81ab-b7c5d2f75771'::uuid,'ad3222fe-5dda-425c-b4e3-c164e343bdef'::uuid),
('27a30e46-7b86-4e77-9d18-c0abe12cd37f'::uuid,'70434503-d07a-4452-a9cb-893cf439692c'::uuid),
('32d35d93-1302-409d-8a34-02ad5072a623'::uuid,'b5b03e32-3af3-4602-ae53-b5f592a5d470'::uuid),
('3439dbb1-6392-4e1d-94f0-aef7f975d2f2'::uuid,'9274a9db-73db-4025-9099-4f0c7c2078cf'::uuid),
('36e673ad-4d86-4069-b299-adb6ec9fb751'::uuid,'bb3301ee-f0f2-438b-9301-fe7a610d4c14'::uuid),
('3b01bb09-6a39-4d11-91cb-bdc6c4871ba7'::uuid,'7188d133-f46a-418a-9b2b-bac6db7de9dd'::uuid),
('3d9af710-5ae4-4061-8dfa-a3166e832972'::uuid,'0942279c-880c-4a0f-a57c-bda3ae988d97'::uuid),
('459f6a2a-2588-4aa1-957a-ca854b13b1d0'::uuid,'a00ab2cd-16fd-430a-b777-6c7bd65b99dc'::uuid),
('585bdb25-8499-4bff-82dc-3162a1f76456'::uuid,'09251767-2d36-42c0-b032-ad23774fda64'::uuid),
('59e150f3-e26f-4970-8053-d440e5333dda'::uuid,'152075a0-12f8-4a43-9802-949005ea1aeb'::uuid),
('645eaa25-707e-4ce2-b349-3c34559ac16c'::uuid,'260afd22-2be8-4513-8dbe-ae3c5edbc1ff'::uuid),
('720351aa-f858-4c53-bafe-f393833ccdef'::uuid,'fcec0993-540a-4a1f-8cb0-0733881a48aa'::uuid),
('7eb66aaa-a13f-4d8d-9a07-47e418c40f75'::uuid,'83db7ffe-0ad1-49c7-b892-d8fa06505689'::uuid),
('828eb04a-85a0-43e2-b003-328266094bd5'::uuid,'09251767-2d36-42c0-b032-ad23774fda64'::uuid),
('8d12b3ee-27b6-4f55-8204-a22c071c7fae'::uuid,'a5b3cf54-cb7d-46cd-9945-2b7afe7c1887'::uuid),
('98a22de9-a15c-4925-9a42-a86856956fd2'::uuid,'2234d3de-f529-4eb9-933d-f493cc41ecbe'::uuid),
('b1b26a2e-800d-4859-a204-a76de3263dc0'::uuid,'0c5e3e44-aba8-4cb8-90a6-ec075ec7ab66'::uuid),
('b2d69f8b-8187-49c1-b7f4-52d813a2ec8e'::uuid,'ab7f98ed-241d-48af-bb3b-060ec1a3c791'::uuid),
('be2a2e7c-b7f6-4b4a-91c2-cac9082e32ea'::uuid,'abd395cb-5515-4f31-aac4-946ad778fbb6'::uuid),
('c027b55c-5cb3-4156-9930-a2837712054f'::uuid,'152075a0-12f8-4a43-9802-949005ea1aeb'::uuid),
('c0358032-f125-4cd6-af31-f54dfbfccaa5'::uuid,'2234d3de-f529-4eb9-933d-f493cc41ecbe'::uuid),
('cd5e5b13-41f0-4f82-821a-39d77e8560bb'::uuid,'1363d646-a8e5-4b54-b099-e479371e912a'::uuid),
('e209b65b-bc14-40cc-8a46-22d02d124a5a'::uuid,'bc1db264-4cc7-4c46-96bb-cc4b0defcc68'::uuid),
('e4b34f55-bef2-41e3-9ae5-c5abd064dc23'::uuid,'a5665a10-83dd-4bfe-a5dc-8d3abea4a241'::uuid),
('e6ef85aa-01ac-49d9-9df9-e62d5471ce67'::uuid,'0efccf74-82a6-4b4d-b46f-b784f5357625'::uuid),
('e816958a-33a0-43d1-b361-7cb4a5cf6600'::uuid,'a1342b9f-6e24-4dac-804a-233a8fbf1860'::uuid),
('e88dd260-cd4d-40b6-b6fe-6514f12acdee'::uuid,'e16ae942-7608-47ab-a51c-4a9c09f32fcd'::uuid),
('e928a387-b187-4447-8c4d-470d51b157b8'::uuid,'ecf79e25-d3d5-41ec-ac75-a995be56532c'::uuid),
('ed18c52f-1c2f-40db-994b-20745c91af94'::uuid,'a0ec526f-a7fd-4f75-bafb-964c57a59ab6'::uuid),
('efd5bfed-cbe4-4b97-ade5-786c757153c5'::uuid,'7d09c23a-6298-4f2b-b79c-fe44834bf921'::uuid),
('f153e42b-4b09-4b0d-b89a-a06740609bf1'::uuid,'054afe75-9ee0-40de-bec9-f19c9133324a'::uuid),
('f3b273a6-e5b5-4d93-a3da-ed1ba9becbf9'::uuid,'2dbf4789-8655-42e8-92cf-22f59e063ccc'::uuid),
('f570e01d-9dac-45ee-9d23-69037815de6f'::uuid,'3289d46e-7984-472d-882b-d6e87cd106c1'::uuid),
('f694cfbc-d189-429e-8e08-b38d0c2c3852'::uuid,'a98a86e6-9543-444f-b1ac-ea349e150e93'::uuid)
  ) AS v(sale_id, old_edition_id)
 WHERE s.id = v.sale_id;
