-- UFC Strike editions minted only on Aptos (UFC Strike edition numbers 631-638), added to the existing ufc_strike collection,
-- plus Emerald Key (397) recorded as a pack insert (a key, not a highlight Moment -> no edition).
-- Metadata source: each Aptos collection's IPFS metadata (creator 0x80f686c7...6cdb), read 2026-11-15 PT.
-- Revert: UPDATE ufc_aptos_collections SET edition_id=NULL, mapped_by=NULL, collection_name=NULL WHERE ufc_set_id BETWEEN 631 AND 638 OR ufc_set_id=397;
--         DELETE FROM editions WHERE collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023' AND external_id IN (<the 8 below>);  (delete guard: needs the rpc guard bypass)
--         DELETE FROM sets/players rows with external_id in the lists below.
ALTER TABLE public.ufc_aptos_collections DROP CONSTRAINT ufc_aptos_collections_mapped_by_check;
ALTER TABLE public.ufc_aptos_collections ADD CONSTRAINT ufc_aptos_collections_mapped_by_check
  CHECK (mapped_by IN ('flow_set_id','new_on_aptos','pack_insert'));

INSERT INTO public.players (external_id, collection_id, collection, name, first_name, last_name)
VALUES ('ufc_strike-steve-garcia','9b4824a8-736d-4a96-b450-8dcc0c46b023','ufc_strike','Steve Garcia','Steve','Garcia'),
       ('ufc_strike-mark-coleman','9b4824a8-736d-4a96-b450-8dcc0c46b023','ufc_strike','Mark Coleman','Mark','Coleman');

INSERT INTO public.sets (external_id, collection_id, name)
VALUES ('ufc_strike-set-vechain-ufc-322-ko-tko','9b4824a8-736d-4a96-b450-8dcc0c46b023','VECHAIN UFC 322 KO TKO'),
       ('ufc_strike-set-ufc-319-decision','9b4824a8-736d-4a96-b450-8dcc0c46b023','UFC 319 DECISION'),
       ('ufc_strike-set-ufc-fight-night-dern-vs-ribas-2-submission','9b4824a8-736d-4a96-b450-8dcc0c46b023','UFC FIGHT NIGHT DERN VS RIBAS 2 SUBMISSION'),
       ('ufc_strike-set-ufc-fight-night-garcia-vs-onama-ko-tko','9b4824a8-736d-4a96-b450-8dcc0c46b023','UFC FIGHT NIGHT GARCIA VS ONAMA KO TKO'),
       ('ufc_strike-set-ufc-311-submission','9b4824a8-736d-4a96-b450-8dcc0c46b023','UFC 311 SUBMISSION'),
       ('ufc_strike-set-ufc-10-ko-tko','9b4824a8-736d-4a96-b450-8dcc0c46b023','UFC 10 KO TKO');

WITH n(set_no, ext, pname, sname, tier, circ, play, img, vid, descr) AS (VALUES
 (631,'MARK-COLEMAN-UFC-10-KO-TKO-241','Mark Coleman','UFC 10 KO TKO','EPIC',241,'KO/TKO','bafybeidjz2ja5u7b36chhmgiw75ukn5l6q227m6wnvgplcgpkrhoap673m','bafybeif7ihv4mhz5tphbbxv2filiflxq44ivanms7wn64hkwxzexx4xj7a',
  $d$Making his UFC debut, powerhouse wrestler Mark "The Hammer" Coleman collided with former champion Don Frye in the tournament final at UFC 10. After landing heavy strikes along the cage, Coleman dragged Frye to the mat and unleashed headbutts from top position to earn the TKO victory and become tournament champion.$d$),
 (632,'ALEX-PEREIRA-UFC-300-KO-TKO-111','Alex Pereira','UFC 300 KO TKO','EPIC',111,'KO/TKO','bafybeie2zksf7ogzxshx74oxcon6f2vb7ic7manbgioizz3bblvueqq5ce','bafybeiegz5br74of4bmui4gnkjdqfz5hzc544jgqdffl4ukb25rwtwdiwu',
  $d$Defending his light heavyweight crown on the historic UFC 300 stage, Alex "Poatan" Pereira faced off against former champion Jamahal Hill in the main event. After brushing off a brief referee check following a low blow, Pereira uncorked his signature left hook to score a thunderous first-round knockout and further solidify his dominance atop the division.$d$),
 (633,'MACKENZIE-DERN-UFC-FIGHT-NIGHT-DERN-VS-RIBAS-2-SUBMISSION-147','Mackenzie Dern','UFC FIGHT NIGHT DERN VS RIBAS 2 SUBMISSION','EPIC',147,'Submission','bafybeid3dvoi6zwj73uj5uzkpmrjbonwzb6vdk3vnttkf6ouuruolren7y','bafybeiem6qpwenxpecnulktfaiwbmahnidzwmloz3szgh6editmwwfdoj4',
  $d$Seeking redemption after falling short in their first fight, Mackenzie Dern entered her rematch with Amanda Ribas at UFC Fight Night: Dern vs Ribas 2 determined to even the score. After a back-and-forth battle across the first three rounds, Dern snatched up an armbar with just four seconds left in the third to secure the submission victory and even the score.$d$),
 (634,'ISLAM-MAKHACHEV-UFC-311-SUBMISSION-117','Islam Makhachev','UFC 311 SUBMISSION','EPIC',117,'Submission','bafybeibj6ad3hudyqw7c7kofvuagxlnbfyp5qofltsb2pph3xn6oxxijfu','bafybeiaeb73iodpmnmdcb77rkidlf35kiqugywtvdftj2k7rko3rokjste',
  $d$Lightweight champion Islam Makhachev put his title on the line against short-notice opponent Renato Moicano at UFC 311. Makhachev imposed his grappling dominance early, snatching Moicano's neck in a scramble before locking in a D'Arce choke to earn the first-round submission victory, his second straight win by D'Arce choke.$d$),
 (635,'BO-NICKAL-VECHAIN-UFC-322-KO-TKO-873','Bo Nickal','VECHAIN UFC 322 KO TKO','RARE',873,'KO/TKO','bafybeifcqaok7oc37w6xighr5t2kmqiardiis2utuz2dqbyvvmrsehqzci','bafybeidbcfu67fyoauiw3y3tpnyvymu4tb7fvxe654fjw3ir42v4kyclxy',
  $d$Standout wrestler Bo Nickal silenced critics and got back in the win column by knocking out elite grappler Rodolfo Vieira at UFC 322, punctuating his comeback with a vicious third-round head kick for a walk-off knockout.$d$),
 (636,'STEVE-GARCIA-UFC-FIGHT-NIGHT-GARCIA-VS-ONAMA-KO-TKO-566','Steve Garcia','UFC FIGHT NIGHT GARCIA VS ONAMA KO TKO','RARE',566,'KO/TKO','bafybeiewahda6s2nut6btivmia5ckcoq3pgslseeqcvzgegvipnlxkon64','bafybeifp3ftigxrc26m3gsys2dfk2lecspsafsppzoy2srnpwcai4x5ri4',
  $d$Featherweight knockout artist Steve "Mean Machine" Garcia defeated David Onama in the main event of UFC Fight Night 263, staggering him early and forcing the stoppage at 3:34 of the first round.$d$),
 (637,'CARLOS-PRATES-VECHAIN-UFC-322-KO-TKO-309','Carlos Prates','VECHAIN UFC 322 KO TKO','EPIC',309,'KO/TKO','bafybeidrxmp7sd4vbrhdive25avi7hj4gf4qxtrkdtahztihmqgm6dhnre','bafybeicmvql7m5renn4lcr2jbjpm4e6lcvgrv5aamynw5madh224vfgjom',
  $d$Rising contender Carlos "The Nightmare" Prates faced former champion Leon Edwards at UFC 322 and ended it with a devastating straight left in the second round, becoming the first person to stop Edwards with strikes.$d$),
 (638,'KHAMZAT-CHIMAEV-UFC-319-DECISION-97','Khamzat Chimaev','UFC 319 DECISION','CHAMPION',97,'Decision','bafybeicepizinukktswtt7c2kwtfsyyxcg6ibqd5hiriz5nalju3gvhm2a','bafybeig22apmpls6tg52ltlmrzlmao4q5psvmkaop7zugkcddl3xb2adke',
  $d$In a high-stakes clash at UFC 319, Khamzat "Borz" Chimaev challenged champion Dricus du Plessis for the middleweight title, amassing nearly 22 minutes of ground control to earn a dominant unanimous decision victory.$d$)
), ins AS (
INSERT INTO public.editions (external_id, collection_id, collection, player_id, player_name, set_id, set_name, tier, series, edition_kind,
                             circulation_count, play_type, name, thumbnail_url, video_url, description, badges, reward_indicators)
SELECT n.ext, '9b4824a8-736d-4a96-b450-8dcc0c46b023', 'ufc_strike', p.id, n.pname, s.id, n.sname, n.tier::tier_type, 3, 'LE',
       n.circ, n.play, initcap(lower(n.pname || ' ' || n.sname)), 'https://ipfs.io/ipfs/'||n.img, 'https://ipfs.io/ipfs/'||n.vid, n.descr, '{}', '{}'
  FROM n
  JOIN public.players p ON p.collection='ufc_strike' AND p.name = n.pname
  JOIN public.sets s ON s.collection_id='9b4824a8-736d-4a96-b450-8dcc0c46b023' AND s.name = n.sname
RETURNING id, external_id)
UPDATE public.ufc_aptos_collections a
   SET edition_id = ins.id, mapped_by = 'new_on_aptos'
  FROM ins JOIN n ON n.ext = ins.external_id
 WHERE a.ufc_set_id = n.set_no;

UPDATE public.ufc_aptos_collections SET mapped_by = 'pack_insert', collection_name = 'EMERALD KEY' WHERE ufc_set_id = 397;
UPDATE public.ufc_aptos_collections a SET collection_name = e.player_name || ' | ' || e.set_name
  FROM public.editions e WHERE e.id = a.edition_id AND a.mapped_by = 'new_on_aptos';