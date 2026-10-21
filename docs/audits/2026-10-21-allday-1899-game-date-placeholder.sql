-- 2026-10-21 ~10:40 AM PT (Claude Code cloud; Trevor: "Keep going") — All Day "Dynamic" Series 5
-- editions carried game_date 1899-12-30, the zero date of a spreadsheet epoch ("no date"), and
-- player/team pages rendered "Dec 30, 1899" (/nfl-all-day/player/josh-allen,
-- /nfl-all-day/team/denver-broncos). 80 editions, all set_name 'Dynamic', series 5, last written
-- 2026-07-10. The three All Day edition writers now route dateOfMoment through lib/game-date.ts
-- (rejects anything before 1900), so a later sale cannot re-write it.
--
-- FIX (data, UPDATE only): the placeholder becomes NULL (absence), which every reader already handles.
-- REVERT: UPDATE public.editions SET game_date = '1899-12-30'
--           WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND set_name = 'Dynamic'
--             AND series = 5 AND game_date IS NULL AND id = ANY(<the ids this statement returned>);
UPDATE public.editions
   SET game_date = NULL, updated_at = now()
 WHERE game_date = '1899-12-30'
   AND collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
RETURNING id;

-- ── RAN 2026-10-21 10:44 AM PT: 80 rows. Exact revert:
-- UPDATE public.editions SET game_date = '1899-12-30' WHERE id IN (
--   '0139b72e-4c27-4cb2-9b33-f2f8958bf225','013c8880-6afb-4b2a-8218-4454a5d018b7','030965c9-1b77-434d-b711-cc978f81b686','11007b19-6361-4e87-99a6-eee9685ffe3a','15be0a43-bb31-48e8-9dac-8e6d29ef0eb4','16f37295-7c9d-4543-8cbd-23c5b9ec6df0','189e3ebd-e0a2-498c-91f6-ea2736025b55','19d987d4-683c-4fc4-924c-6d3dc00ad40d','1d86fe35-6ef5-47e3-a5e5-42acdc55be7a','2401c111-d39a-48ff-88c0-f9234877870a',
--   '24dc7d4e-d796-4766-b714-9d8129f6c860','2528cbec-ebaf-4007-b6e9-6609a5b10a69','28467452-f296-4f94-bba5-0c696abb9d65','29b6d349-b652-41dc-9d8d-475cf2df082c','2b175225-241f-4091-8aeb-6219374c6abf','2b73ffee-f11b-40f7-bcff-1876fa462455','2dd94c96-ccb2-414d-bcfe-f975ce76cf80','30fd0eb7-c04f-4029-80d2-0d8e56979111','34a3629a-0fa2-4ba0-b234-28f8c30872cd','3953b030-de84-40dd-9643-2e70542b4e72',
--   '41c24dad-6657-4823-a1d3-1f08a9b05206','41eac613-b519-4fa8-b6c2-8c72e4207cc3','429019f9-ae93-42af-b5a3-770935a7e7a9','48a5a2d7-bf66-44a9-a4a7-197fb2cf1007','493a5700-b0bb-4874-bfe7-34ad3ce7e59b','49dea69e-2593-43c4-af9e-f83916f4f2eb','4a49a046-6e64-4ae4-b671-b1171597611e','4f894c35-5614-4e8e-b9ba-2238777f3253','54c7f6f9-884c-4467-b8cf-e981d9ebdc0d','5613d76a-cc67-456d-8dc7-80c92e5d8581',
--   '5646b31e-0457-4078-9e8d-417d23d621f3','59ec78a0-5ae6-4e22-bffa-18a734a75842','6256c444-5c0c-4a7c-bdfd-54922d9e9713','62e8df4d-34fa-4186-853c-9c88f7149010','6443e9df-2a94-457c-b0bd-23e06a153ba2','683d2218-03f2-4b5c-8755-57612b7b857c','685d103c-07d8-47ff-bf76-789fad56aca7','691fcf34-70ab-4274-a1e7-316d85aa3c64','69315f15-e65d-4145-90b6-6206f472bb13','7fb9341f-f45a-4656-ab31-358f17ad1e46',
--   '85d56d68-e488-4495-97b9-072d6e87488d','870f8d79-8d9c-41ab-bd73-0af65b2b5c8e','87fd8487-7ba9-4f82-8498-20dab9ebe6b7','8971e762-304d-46ed-ba22-2b3b371eb796','8b67140c-5c69-4695-ad9c-abd8dca397e1','95ec00ed-8726-4f16-a5de-e629c6cbc7d3','9694bf10-3c6e-490a-ad36-df0c168d6366','96f072da-b79a-4ffd-b9dc-02d5c9b12f3b','9d8889b7-90c4-4286-83f6-a3398337aefc','9dee4ed8-333d-4e54-a602-4ba62f18b0fa',
--   '9ec49bbd-a7a5-4e5f-afb8-18b7ea25b762','aaac1fcd-404a-4d21-8378-3ab13b2a89ac','aafcbe02-b1d6-4ae0-be92-64b666680283','ab55a327-5368-406a-94eb-e9a923a958de','ae81e9ad-daa8-440c-a316-deb190660854','b4a45a94-4795-4e81-86ee-a554aa956525','c290a801-f5ae-46db-9ce8-0cc1048ea6cd','d0bf7e14-9c8d-4b88-adb4-a7f0c5a530ea','d0f6008a-672f-4074-bde0-503efd7bdf76','d46aa9ac-5967-4d5e-9c47-702bb17e123d',
--   'd5291b2a-e2c8-4aed-ad1d-39f775b46368','d5393483-f94c-4cb9-a34d-6a7833537b66','d6ddeaed-3056-4ad3-b4ef-41876cfc1021','da764e83-b5c7-47de-88fc-14b68e4752e4','dacc8526-df53-43a0-95a6-9be86e9c3421','db1c12ba-1c20-4bf2-919b-29f08c98e6dd','dc3c4695-878c-42a8-bbe1-e874a53d48c8','df6ca871-f53b-45ff-94a0-bbb9e985a1bd','e109a027-5a9f-4dc3-88d8-f29847e5a504','e2154fbd-566d-4c7f-bf56-60b7fcc145a7',
--   'e2cf81bf-e9fd-430f-b08a-b9c71d6fef2c','e5655fb9-90a4-4c48-b0a2-4fe841dab16b','eafed5cb-1152-4e7c-ab3e-efdcf918db52','f262dae9-6f42-4b3c-bdb0-870ae44157b5','f2979026-cd5a-4b8a-8c18-2702e1a6b4ca','f55dbdc7-965f-4af0-a1a9-a1b3f620ba64','f7e2d4b1-52b0-4713-a221-8fb88f45e716','fa16a4f8-3627-491b-8a70-29400f1ebfb6','fd6614a6-e685-4167-967f-dae6e8e9a88d','ff9f1e66-dbd3-487a-b09f-d0d2d5826b9d');
