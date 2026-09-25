-- 2026-09-25 (PT) — 48 Top Shot pack distributions (dist 8734–8869) had no
-- name. `searchPackNft` (Dapper GraphQL, 530 since ~08-28) never named them, so
-- the pack page, the pack-history table ("bought 09-23 · Pack #8825 · —") and
-- alert copy fell back to "NBA Top Shot Pack #<id>", and known-issues #137(d)
-- filed it as "nothing to do on our side". The names are ON CHAIN: every
-- Dapper distribution is registered with the Pack Distribution Service
-- contract (PDS, 0xb6f2481eba4df97b), and PDS.getDistInfo(distId) returns the
-- title, tier and slot count. The 48 rows below were read through Flow REST
-- at 2:20 AM PT 09-25 (48 of 48 answered; the values are the chain's — the
-- description with its HTML tags stripped, since pack_table_rows reads it as text).
-- The daily route /api/cron/topshot-pack-dist-names-onchain keeps this true
-- for every distribution created from here on.
--
-- Fill-only: `title` where NULL/empty; metadata keys `tier`,
-- `number_of_pack_slots`, `description` only where NULL/absent. Counts and
-- images are untouched (their writer is a different pipeline).
-- Revert: the pre-image is in audit_20260925_ts_pack_dist_names_backup
-- (drop after 2026-10-01); UPDATE … SET title = b.title, metadata = b.metadata
-- FROM that table.

CREATE TABLE IF NOT EXISTS public.audit_20260925_ts_pack_dist_names_backup AS
SELECT id, dist_id, title, metadata, updated_at
FROM public.pack_distributions
WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
  AND (title IS NULL OR title = '');
ALTER TABLE public.audit_20260925_ts_pack_dist_names_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_ts_pack_dist_names_backup FROM PUBLIC, anon, authenticated;

WITH chain(dist_id, title, tier, slots, description) AS (VALUES
  ('8734', 'WNBA Origins Set Completion Reward Pack', 'legendary', 2, 'Collectors earned this pack by completing the Series 2025-26 WNBA Origins Legendary Set!'),
  ('8735', 'WNBA Legacy Trail Chance Hit', 'common', 3, 'The WNBA''s first tip-off was June 21, 1997 — and a Lisa Leslie Moment from that inaugural season is in this pack. So is A''ja Wilson. So is Caitlin Clark. Legacy Trail puts 15 of the greatest to ever play alongside 15 of the best playing right now, one Moment at a time. The legends who built it: Lisa Leslie, Cynthia Cooper, Tamika Catchings, Sheryl Swoopes, Lauren Jackson, Teresa Weatherspoon, Chamique Holdsclaw, Yolanda Griffith, Seimone Augustus, Cappie Pondexter, Ticha Penicheiro, Katie Smith, Becky Hammon, Deanna Nolan and Elena Delle Donne. The ones writing the next chapter: A''ja Wilson, Caitlin Clark, Paige Bueckers, Breanna Stewart, Sabrina Ionescu, Napheesa Collier, Alyssa Thomas, Jonquel Jones, Chelsea Gray, Kayla McBride, Brittney Griner, Jewell Loyd, Nneka Ogwumike, Kelsey Mitchell and DeWanna Bonner.'),
  ('8748', 'Historical Chance Hit: Anthology Edition', 'common', 3, 'Mark your calendar! Run It Back returns on August 25th featuring Anthology, Rookies, Game Winners, and Moments from the greatest players in NBA history!'),
  ('8749', 'Historical Chance Hit: Series 1 & Deck The Hoops', 'common', 3, 'Mark your calendar! Run It Back returns on August 25th featuring Anthology, Rookies, Game Winners, and Moments from the greatest players in NBA history!'),
  ('8750', 'Run It Back: Origins Standard Pack', 'rare', 1, NULL),
  ('8751', 'Run It Back: Origins Box', 'rare', 7, 'Each Box contains 7 packs! 2 Box Toppers - Containing 1 Moment each Each Box Topper contains 1 Moment minted /199 or less 5 Standard Packs - Containing 1 Moment each Each pack contains 1 Rare or higher tier Moment'),
  ('8752', 'Run It Back: Origins Case', 'legendary', 8, 'Each Case contains 8 Case exclusive packs! 3 Case Toppers - Containing 1 Moment each Each Case Topper contains 1 Moment minted /10 or less 5 Premium Packs - Containing 10 Moments each Each Premium Pack contains 10 Rare or higher tier Moments'),
  ('8753', 'Run It Back: Origins Case Topper', 'rare', 1, 'Each Case contains 3 Case Toppers!'),
  ('8754', 'Run It Back: Origins Premium Pack', 'rare', 10, 'Each Case contains 5 Premium Packs!'),
  ('8755', 'Run It Back: Origins Box Topper', 'rare', 1, 'Each Box contains 2 Box Toppers!'),
  ('8756', 'Run It Back: Origins Premium Chance Hit', 'rare', 1, 'Each Premium Chance Hit Pack contains 1 Rare or higher tier Moment'),
  ('8757', 'Run It Back: Origins Chance Hit', 'common', 3, 'Each Pack contains 3 Moments. Look for top Moments from NBA history featuring Hall of Famers, Rookies, and Greats of the Game!'),
  ('8767', 'Heroes & Rookies', 'common', 3, 'Mark your calendar! Run It Back returns on August 25th featuring Anthology, Rookies, Game Winners, and Moments from the greatest players in NBA history!'),
  ('8768', 'Run It Back: Vault Pack', 'rare', 5, 'Chase the biggest Moments from the NBA history in this Run It Back: Origins Vault Pack! Each pack contains 2 guaranteed Rares or better.'),
  ('8769', 'Spotlight: Caitlin Clark', 'common', 3, 'Rookie Revelation is coming soon! Take a look back at one of the most iconic Rookie Revelation Moments in NBA Top Shot history: the Caitlin Clark Legendary Rookie Revelation - and see if you can pull it from this pack!'),
  ('8770', 'WNBA Rookie Revelation Pack', 'rare', 5, 'Each Pack Contains the Following 5 Moments: 1 Guaranteed Hit Ultimate (0.2%), Legendary (15.95%), Rare Parallel (12.84%), or Rare MGLE (including Rookies) or autographed Signature Style (71%) 1 Bag Work Standard (78%) or Parallel (22%) 1 Hustle & Show Standard (78%) or Parallel (22%) 2 Base Set Standard (89%) or Parallel (11%)'),
  ('8771', 'WNBA Rookie Revelation Box', 'rare', 6, 'Boxes Contain 1 Box topper - 1 Moment Each: Ultimate (10%) Rookie Revelation (90% - including 18% chance at a Galactic /5 or Omega /1) 5 standard packs - 1 Guaranteed Rare or Higher Tier Hit Per Pack 1 Guaranteed Hit Ultimate (0.2%), Legendary (15.95%), Rare Parallel (12.84%), or Rare MGLE (including Rookies) or standard pack exclusive autographed Signature Style (71%) 1 Bag Work Standard (78%) or Parallel (22%) 1 Hustle & Show Standard (78%) or Parallel (22%) 2 Base Set Standard (89%) or Parallel (11%)'),
  ('8772', 'WNBA Rookie Revelation Courtside Box', 'rare', 6, 'Box Contents 1 Courtside Exclusive Case Topper Containing 1 of the following hits: 41.2% Ultimate - Rookie Ultimate /1 (5.8%), Throne Room /1 (5.8%), or Supernova /10 (29.4%) 58.8% Rookie Revelation Parallel - Omega /1 (5.8%) or Galactic /5 (52.9%) 5 Standard Packs containing the following 5 Moments: 1 Guaranteed Hit Ultimate (0.2%), Legendary (15.95%), Rare Parallel (12.84%), or Rare MGLE (including Rookies) or autographed Signature Style (71%) 1 Bag Work Standard (78%) or Parallel (22%) 1 Hustle & Show Standard (78%) or Parallel (22%) 2 Base Set Standard (89%) or Parallel (11%)'),
  ('8773', 'WNBA Rookie Revelation Case', 'legendary', 12, 'Each Case Contains: 1 Case Topper 1 Premium Pack 10 Standard Packs Each Case guarantees: Guaranteed 1/1 in every Case 2 Rookie Revelation or Ultimate Moments 2 Guaranteed Rookie Metallic Gold LE parallels Guaranteed Holo Icon parallel'),
  ('8774', 'Spotlight: Paige Bueckers', 'common', 3, 'Rookie Revelation is coming soon! Take a look back at one of the most iconic Rookie Revelation Moments in NBA Top Shot history: the Paige Buecker Legendary Rookie Revelation - and see if you can pull it from this pack!'),
  ('8775', 'Spotlight: WNBA Rookie Revelation', 'common', 3, 'Rookie Revelation is coming soon! Take a look back at some of the most iconic Rookie Revelation Moments in NBA Top Shot history: featuring Moments from Dominique Malonga, Angel Reese, Cameron Brink, Rickea Jackson & more - and see if you can pull them from this pack!'),
  ('8776', 'Spotlight: WNBA Holo Icon', 'common', 3, 'Along with Rookie Revelation, the final Moments from Holo Icon release on 9/23! Take a look back at some of the most iconic Holo Icon Moments in NBA Top Shot history: featuring Moments from A''ja Wilson, Napheesa Collier, Angel Reese, Sabrina Ionescu, & more - and see if you can pull them from this pack!'),
  ('8777', 'Spotlight: WNBA Metallic Gold', 'common', 3, 'Along with Rookie Revelation, the final Moments from Metallic Gold LE release on 9/23! Take a look back at some of the most iconic Metallic Gold LE Moments in NBA Top Shot history: featuring Moments from Caitlin Clark, Napheesa Collier, Angel Reese, & more - and see if you can pull them from this pack!'),
  ('8778', 'Spotlight: WNBA Rare Rookies', 'common', 3, 'Rookie Revelation drops on 9/23! Take a look back at some of the most iconic Rare Rookies in NBA Top Shot history: featuring Moments from Caitlin Clark, Olivia, Angel Reese, & more - and see if you can pull them from this pack!'),
  ('8779', 'WNBA Hustle & Show Challenge Reward Pack', 'common', 2, 'Earned by completing the WNBA Hustle & Show Set Challenge. Contains 2 Moments.'),
  ('8780', 'WNBA Rookie Revelation Premium Pack', 'rare', 5, NULL),
  ('8781', 'WNBA Rookie Revelation Box Topper', 'rare', 1, NULL),
  ('8783', 'WNBA Rookie Revelation Chance Hit Pack', 'common', 5, NULL),
  ('8785', 'WNBA Rookie Revelation Trade Ticket Pack', 'common', 3, NULL),
  ('8786', 'WNBA Rookie Revelation Challenge Reward Pack', 'legendary', 2, 'Earned by completing the WNBA Rookie Revelation Set Challenge. Contains 2 Moments.'),
  ('8787', 'WNBA Ascension Challenge Reward Pack', 'legendary', 2, 'Earned by completing the WNBA Ascension Set Challenge. Contains 2 Moments.'),
  ('8788', 'WNBA Fresh Gems Challenge Reward Pack', 'rare', 2, 'Earned by completing the WNBA Fresh Gems Set Challenge. Contains 2 Moments.'),
  ('8793', 'WNBA Rookie Debut Challenge Reward Pack', 'common', 2, 'Earned by completing the WNBA Rookie Debut Set Challenge. Contains 2 Moments.'),
  ('8794', 'WNBA Hoop Vision Challenge Reward Pack', 'common', 2, 'Earned by completing the WNBA Hoop Vision Set Challenge. Contains 2 Moments.'),
  ('8796', 'WNBA Bag Work Challenge Reward Pack', 'common', 2, 'Earned by completing the WNBA Bag Work Set Challenge. Contains 2 Moments.'),
  ('8811', 'Atlanta Dream Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Atlanta Dream seasonal leaderboard. Contains 1 Moment.'),
  ('8813', 'Chicago Sky Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Chicago Sky seasonal leaderboard. Contains 1 Moment.'),
  ('8814', 'Connecticut Sun Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Connecticut Sun seasonal leaderboard. Contains 1 Moment.'),
  ('8817', 'Indiana Fever Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Indiana Fever seasonal leaderboard. Contains 1 Moment.'),
  ('8818', 'Los Angeles Sparks Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Los Angeles Sparks seasonal leaderboard. Contains 1 Moment.'),
  ('8822', 'Minnesota Lynx Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Minnesota Lynx seasonal leaderboard. Contains 1 Moment.'),
  ('8823', 'Toronto Tempo Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Toronto Tempo seasonal leaderboard. Contains 1 Moment.'),
  ('8825', 'Portland Fire Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Portland Fire seasonal leaderboard. Contains 1 Moment.'),
  ('8826', 'Seattle Storm Seasonal Leaderboard Snapshot 2', 'rare', 1, 'Awarded for placement on the Seattle Storm seasonal leaderboard. Contains 1 Moment.'),
  ('8840', 'Noémie Brochant #1 Serial Rookie Revelation Reward Pack', 'legendary', 1, 'Awarded for finishing #1 on the Noémie Brochant leaderboard. Contains the serial #1 Noémie Brochant Rookie Revelation Moment.'),
  ('8864', 'Olivia Miles MGLE Reward Pack', 'rare', 1, 'Awarded for placement on the Olivia Miles Metallic Gold LE leaderboard. Contains 1 Olivia Miles Metallic Gold LE Moment.'),
  ('8868', 'Spotlight: WNBA Legendary Rookies', 'common', 3, 'Rookie Revelation drops on 9/23! Take a look back at some of the most iconic Legendary Rookies in NBA Top Shot history: featuring Moments from Caitlin Clark, Paige Bueckers, & more - and see if you can pull them from this pack!'),
  ('8869', 'WNBA Rookie Revelation Case Topper', 'legendary', 1, NULL)
)
UPDATE public.pack_distributions pd
   SET title = c.title,
       -- `||` replaces a key; every key below is added only where the row's value
       -- is NULL/absent, so this is a fill and never an overwrite.
       metadata = coalesce(pd.metadata, '{}'::jsonb)
                  || CASE WHEN (pd.metadata->>'tier') IS NULL AND c.tier IS NOT NULL THEN jsonb_build_object('tier', c.tier) ELSE '{}'::jsonb END
                  || CASE WHEN (pd.metadata->>'number_of_pack_slots') IS NULL AND c.slots IS NOT NULL THEN jsonb_build_object('number_of_pack_slots', c.slots) ELSE '{}'::jsonb END
                  || CASE WHEN (pd.metadata->>'description') IS NULL AND c.description IS NOT NULL THEN jsonb_build_object('description', c.description) ELSE '{}'::jsonb END,
       updated_at = now()
  FROM chain c
 WHERE pd.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND pd.dist_id = c.dist_id
   AND (pd.title IS NULL OR pd.title = '');

DO $$
DECLARE v_left int; v_named int;
BEGIN
  SELECT count(*) INTO v_left FROM public.pack_distributions
   WHERE collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd' AND (title IS NULL OR title = '');
  SELECT count(*) INTO v_named FROM public.pack_distributions pd
   JOIN public.audit_20260925_ts_pack_dist_names_backup b ON b.id = pd.id
   WHERE pd.title IS NOT NULL AND pd.title <> '';
  IF v_named <> (SELECT count(*) FROM public.audit_20260925_ts_pack_dist_names_backup) THEN
    RAISE EXCEPTION 'named % of % backed-up rows', v_named, (SELECT count(*) FROM public.audit_20260925_ts_pack_dist_names_backup);
  END IF;
  RAISE NOTICE 'named % rows; % Top Shot distributions still unnamed', v_named, v_left;
END $$;
