-- #116 repair (2026-09-25 PT). The chain adjudicated it on 09-24
-- (docs/audits/i116-chain-adjudication-2026-09-24.md): editions.circulation_count
-- is RIGHT and these rows are MISATTRIBUTED. For each of the 241 moments read
-- on-chain (borrowMoment(id).data -> setID, playID, serialNumber, subedition),
-- every Top Shot `sales` row and `moments` row for that nft_id is re-pointed to
-- the chain's edition and serial. Example: $0.35-$3 De'Andre Hunter "Clamps"
-- (226:7541, COMMON) sales that were filed under Giannis "Cosmic" (8:62,
-- LEGENDARY /49). The ~1,330 impossible-serial moments with no known holder are
-- NOT touched (no chain read).
--
-- Dry run 09-25 8:4x AM PT, same predicates: 241 chain rows, 0 unresolved
-- editions, 0 chain serials above circulation, 284 sales + 136 moments to change
-- (the audit's figures), 0 moments (edition_id, serial_number) collisions; 20 of
-- the sales sold in the last 90 d, 2 in the last 30 d (those editions re-price on
-- fmv-recalc's next pass).
--
-- Backups (RLS on, service_role only): audit_20260925_i116_sales_backup,
-- audit_20260925_i116_moments_backup.
-- Revert:
--   UPDATE sales s SET edition_id = b.edition_id, serial_number = b.serial_number
--     FROM audit_20260925_i116_sales_backup b WHERE s.id = b.id AND s.sold_at = b.sold_at;
--   UPDATE moments m SET edition_id = b.edition_id, serial_number = b.serial_number
--     FROM audit_20260925_i116_moments_backup b WHERE m.id = b.id;

CREATE TEMP TABLE i116_chain (nft_id text PRIMARY KEY, setplay text NOT NULL, serial int NOT NULL, sub int) ON COMMIT DROP;
INSERT INTO i116_chain (nft_id, setplay, serial, sub) VALUES
('64168','2:75',291,NULL),
('163997','11:17',65,NULL),
('195149','2:77',912,NULL),
('317869','2:174',658,NULL),
('318475','2:115',1515,NULL),
('325092','2:54',1545,NULL),
('327300','2:39',1543,NULL),
('359845','2:244',24,NULL),
('372601','2:173',862,NULL),
('382187','2:228',527,NULL),
('386731','2:42',1854,NULL),
('401730','2:115',1809,NULL),
('406903','2:115',1879,NULL),
('410388','2:115',1902,NULL),
('410415','2:115',1929,NULL),
('431506','2:213',1067,NULL),
('431514','2:213',1075,NULL),
('436089','2:213',1159,NULL),
('437992','2:115',2044,NULL),
('448574','2:100',2032,NULL),
('454018','2:115',2103,NULL),
('470970','2:211',1452,NULL),
('478462','2:245',1076,NULL),
('480373','2:195',888,NULL),
('481948','2:233',1193,NULL),
('488979','2:213',1549,NULL),
('489043','2:211',1560,NULL),
('489332','5:113',16,NULL),
('501736','2:115',2280,NULL),
('507341','2:245',1355,NULL),
('511071','2:108',2316,NULL),
('518413','2:233',1549,NULL),
('518439','2:233',1575,NULL),
('526159','2:229',1608,NULL),
('530949','2:108',2381,NULL),
('532751','2:213',1857,NULL),
('534686','2:213',1875,NULL),
('536215','2:213',1884,NULL),
('536219','2:213',1888,NULL),
('536221','2:213',1890,NULL),
('554064','2:213',1988,NULL),
('562796','2:229',1739,NULL),
('566075','2:115',2511,NULL),
('568912','2:213',2045,NULL),
('573992','2:115',2597,NULL),
('574133','2:229',1814,NULL),
('588289','2:115',2620,NULL),
('588476','2:115',2627,NULL),
('597711','2:213',2150,NULL),
('597730','2:213',2169,NULL),
('597756','2:213',2195,NULL),
('597841','2:213',2280,NULL),
('601785','2:233',1895,NULL),
('609417','2:229',1943,NULL),
('612593','2:115',2668,NULL),
('612626','2:115',2701,NULL),
('618652','2:190',1439,NULL),
('631390','2:115',2847,NULL),
('631485','2:190',1496,NULL),
('641142','2:213',2378,NULL),
('646375','2:213',2392,NULL),
('713881','2:233',2351,NULL),
('751944','2:190',1839,NULL),
('751981','2:190',1876,NULL),
('758795','2:233',2523,NULL),
('766623','25:345',23,NULL),
('812436','2:233',2703,NULL),
('816478','2:229',2636,NULL),
('816860','2:190',2076,NULL),
('816960','2:190',2176,NULL),
('822247','2:233',2759,NULL),
('826450','24:329',177,NULL),
('885608','26:393',2084,NULL),
('951436','2:229',2824,NULL),
('956143','2:320',1019,NULL),
('956192','2:320',1068,NULL),
('963808','2:225',2900,NULL),
('970216','2:229',2903,NULL),
('981045','29:431',365,NULL),
('982240','29:451',312,NULL),
('982252','29:451',324,NULL),
('982959','29:451',406,NULL),
('983048','29:451',495,NULL),
('987571','29:454',404,NULL),
('987627','29:454',460,NULL),
('987662','29:454',495,NULL),
('1108453','5:88',39,NULL),
('1112469','2:229',2976,NULL),
('1113755','2:190',2351,NULL),
('1115096','2:190',2372,NULL),
('1121579','2:190',2435,NULL),
('1122026','2:190',2447,NULL),
('1122551','2:233',3024,NULL),
('1124428','2:320',1253,NULL),
('1136365','2:320',1309,NULL),
('1137911','2:190',2543,NULL),
('1142395','2:320',1343,NULL),
('1142415','2:320',1363,NULL),
('1144072','2:320',1394,NULL),
('1144094','2:320',1416,NULL),
('1144251','2:190',2602,NULL),
('1144253','2:190',2604,NULL),
('1144263','2:190',2614,NULL),
('1146901','2:320',1443,NULL),
('1146904','2:320',1446,NULL),
('1146912','2:320',1454,NULL),
('1150661','2:233',3139,NULL),
('1155324','2:320',1478,NULL),
('1159755','2:46',3982,NULL),
('1560603','32:520',3380,NULL),
('1601310','26:467',8962,NULL),
('1816689','26:467',10003,NULL),
('1817814','26:467',10253,NULL),
('1824026','26:467',10964,NULL),
('1829476','26:467',11662,NULL),
('2726992','33:626',5012,NULL),
('6023055','35:816',611,NULL),
('7618059','35:827',111,NULL),
('7633567','29:910',363,NULL),
('7926608','26:930',9472,NULL),
('7930397','26:930',9761,NULL),
('7930506','26:930',9870,NULL),
('7937312','26:930',10801,NULL),
('7956725','26:930',11339,NULL),
('7971313','26:930',11552,NULL),
('8822000','29:996',355,NULL),
('10500664','38:1069',811,NULL),
('10512362','38:1077',1709,NULL),
('10512390','38:1077',1737,NULL),
('10513332','38:1078',879,NULL),
('10513347','38:1078',894,NULL),
('10513421','38:1078',968,NULL),
('10513961','38:1078',1508,NULL),
('10529301','38:1088',648,NULL),
('10529842','38:1088',1189,NULL),
('10530397','38:1088',1744,NULL),
('10552532','38:1101',479,NULL),
('10552678','38:1101',625,NULL),
('10552851','38:1101',798,NULL),
('10553699','38:1101',1646,NULL),
('10553709','38:1101',1656,NULL),
('10553828','38:1101',1775,NULL),
('10577734','38:1118',481,NULL),
('10577812','38:1118',559,NULL),
('10578440','38:1118',1187,NULL),
('10578826','38:1118',1573,NULL),
('12354960','26:1190',21012,NULL),
('13926137','26:1220',39693,NULL),
('14681208','29:1245',440,NULL),
('21940550','51:1776',12345,NULL),
('22010769','51:1776',41814,NULL),
('24105033','51:1823',52325,NULL),
('26173505','51:1898',44244,NULL),
('26189389','51:1898',49878,NULL),
('29455826','54:2098',536,NULL),
('29456201','54:2098',661,NULL),
('33461410','51:2272',16706,NULL),
('33513788','51:2272',43334,NULL),
('35774532','54:2510',563,NULL),
('35775059','54:2510',715,NULL),
('39166976','94:3214',873,0),
('42232054','99:3749',300,0),
('42417884','94:3867',756,0),
('42417898','94:3867',770,0),
('42417987','94:3867',859,0),
('42417988','94:3867',860,0),
('42418016','94:3867',888,0),
('43433853','117:4125',216,0),
('43434385','117:4125',399,0),
('43434421','117:4125',435,0),
('43937558','124:4360',4250,0),
('43945046','124:4360',6738,0),
('43945513','124:4360',6805,0),
('43945532','124:4360',6824,0),
('43946169','124:4360',7011,0),
('43949994','124:4360',7486,0),
('43953179','124:4360',7671,0),
('43958468','124:4360',7910,0),
('43958474','124:4360',7916,0),
('46077558','130:4926',312,0),
('46078163','130:4926',467,0),
('46202280','124:4945',7959,0),
('48752804','100:6366',445,0),
('50429732','226:7541',83,0),
('50429851','226:7541',102,0),
('50429863','226:7541',114,0),
('50429864','226:7541',115,0),
('50429870','226:7541',121,0),
('50429874','226:7541',125,0),
('50429878','226:7541',129,0),
('50429915','226:7541',166,0),
('50429938','226:7541',189,0),
('50429939','226:7541',190,0),
('50430118','226:7541',219,0),
('50430122','226:7541',223,0),
('50430126','226:7541',227,0),
('50430145','226:7541',246,0),
('50433702','226:7541',254,0),
('50433703','226:7541',255,0),
('50433719','226:7541',271,0),
('50433723','226:7541',275,0),
('50434755','226:7541',307,0),
('50434758','226:7541',310,0),
('50434779','226:7541',331,0),
('50434794','226:7541',346,0),
('50434795','226:7541',347,0),
('50434798','226:7541',350,0),
('50435011','226:7541',363,0),
('50435048','226:7541',400,0),
('50436479','226:7541',431,0),
('50436497','226:7541',449,0),
('50439819','226:7541',476,0),
('50442151','226:7541',510,0),
('50442168','226:7541',527,0),
('50442173','226:7541',532,0),
('50442178','226:7541',537,0),
('50442904','226:7541',563,0),
('50442914','226:7541',573,0),
('50442934','226:7541',593,0),
('50442936','226:7541',595,0),
('50442940','226:7541',599,0),
('50445243','226:7541',54,17),
('50445260','226:7541',71,17),
('50445276','226:7541',87,17),
('50445277','226:7541',88,17),
('50445670','226:7541',682,0),
('50445674','226:7541',686,0),
('50446091','226:7541',703,0),
('50446688','226:7541',751,0),
('50446710','226:7541',773,0),
('50446731','226:7541',794,0),
('50447617','226:7541',833,0),
('50449898','226:7541',868,0),
('50449916','226:7541',886,0),
('50449924','226:7541',894,0),
('50449929','226:7541',899,0),
('50450000','226:7541',920,0),
('50450026','226:7541',946,0),
('50450252','226:7541',972,0),
('50681009','218:7629',3693,0),
('52547184','259:8950',94,17);

CREATE TEMP TABLE i116_tgt ON COMMIT DROP AS
SELECT c.nft_id, c.serial, e.id AS edition_id
  FROM i116_chain c
  JOIN public.editions e
    ON e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
   AND e.external_id = CASE WHEN coalesce(c.sub, 0) = 0 THEN c.setplay ELSE c.setplay || '::' || c.sub END;

CREATE TABLE IF NOT EXISTS public.audit_20260925_i116_sales_backup AS
  SELECT s.id, s.sold_at, s.nft_id, s.edition_id, s.serial_number, now() AS backed_up_at
    FROM public.sales s WHERE false;
ALTER TABLE public.audit_20260925_i116_sales_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_i116_sales_backup FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.audit_20260925_i116_moments_backup AS
  SELECT m.id, m.nft_id, m.edition_id, m.serial_number, now() AS backed_up_at
    FROM public.moments m WHERE false;
ALTER TABLE public.audit_20260925_i116_moments_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260925_i116_moments_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  v_tgt int; v_sb int; v_mb int; v_su int; v_mu int; v_bad int;
BEGIN
  SELECT count(*) INTO v_tgt FROM i116_tgt;
  IF v_tgt <> 241 THEN RAISE EXCEPTION 'expected 241 resolved chain rows, got %', v_tgt; END IF;

  INSERT INTO public.audit_20260925_i116_sales_backup (id, sold_at, nft_id, edition_id, serial_number, backed_up_at)
  SELECT s.id, s.sold_at, s.nft_id, s.edition_id, s.serial_number, now()
    FROM public.sales s JOIN i116_tgt t ON t.nft_id = s.nft_id
   WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND (s.edition_id IS DISTINCT FROM t.edition_id OR s.serial_number IS DISTINCT FROM t.serial);
  GET DIAGNOSTICS v_sb = ROW_COUNT;

  INSERT INTO public.audit_20260925_i116_moments_backup (id, nft_id, edition_id, serial_number, backed_up_at)
  SELECT m.id, m.nft_id, m.edition_id, m.serial_number, now()
    FROM public.moments m JOIN i116_tgt t ON t.nft_id = m.nft_id
   WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND (m.edition_id IS DISTINCT FROM t.edition_id OR m.serial_number IS DISTINCT FROM t.serial);
  GET DIAGNOSTICS v_mb = ROW_COUNT;

  IF v_sb <> 284 OR v_mb <> 136 THEN
    RAISE EXCEPTION 'backup counts drifted from the dry run: sales % (want 284), moments % (want 136)', v_sb, v_mb;
  END IF;

  UPDATE public.sales s
     SET edition_id = t.edition_id, serial_number = t.serial
    FROM i116_tgt t, public.audit_20260925_i116_sales_backup b
   WHERE b.id = s.id AND b.sold_at = s.sold_at AND t.nft_id = s.nft_id
     AND s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  GET DIAGNOSTICS v_su = ROW_COUNT;

  UPDATE public.moments m
     SET edition_id = t.edition_id, serial_number = t.serial
    FROM i116_tgt t, public.audit_20260925_i116_moments_backup b
   WHERE b.id = m.id AND t.nft_id = m.nft_id;
  GET DIAGNOSTICS v_mu = ROW_COUNT;

  IF v_su <> v_sb OR v_mu <> v_mb THEN
    RAISE EXCEPTION 'updated % sales / % moments, backed up % / %', v_su, v_mu, v_sb, v_mb;
  END IF;

  -- Post-condition: every Top Shot sale and moment for these nft_ids sits on the chain edition and serial.
  SELECT count(*) INTO v_bad
    FROM public.sales s JOIN i116_tgt t ON t.nft_id = s.nft_id
   WHERE s.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND (s.edition_id IS DISTINCT FROM t.edition_id OR s.serial_number IS DISTINCT FROM t.serial);
  IF v_bad <> 0 THEN RAISE EXCEPTION '% sales still off the chain edition/serial', v_bad; END IF;

  SELECT count(*) INTO v_bad
    FROM public.moments m JOIN i116_tgt t ON t.nft_id = m.nft_id
   WHERE m.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND (m.edition_id IS DISTINCT FROM t.edition_id OR m.serial_number IS DISTINCT FROM t.serial);
  IF v_bad <> 0 THEN RAISE EXCEPTION '% moments still off the chain edition/serial', v_bad; END IF;

  RAISE NOTICE 'i116 repair: % sales, % moments re-pointed to the chain edition', v_su, v_mu;
END $$;
