-- audit_20261108_ufc_slug_aliases_three
--
-- Three more fighters whose UFC.com slug is not the card's name, found by probing once the lane finished
-- (2026-11-08): Sharabutdin Magomedov -> shara-magomedov, Waldo Cortes -> waldo-cortes-acosta, Quinton
-- Jackson -> rampage-jackson (the earlier quinton-rampage-jackson guess was not found). Every page still
-- has to pass ufc-dob-agrees / ufc-event-confirmed before anything publishes. Chael Sonnen's page
-- answers 403 to automated clients and is NOT worked around. Joselyn Edwards has no UFC.com page.
-- Base: live prosrc md5 5f3d481c3504d223994494e0717e11a8 (= 20261109004555 body), re-read 2026-11-08.
--
-- Revert: re-apply the 20261109004555 body of ufc_slug_alternates.

create or replace function public.ufc_slug_alternates(p_label text)
returns text[] language sql immutable
set search_path = pg_catalog, public
as $$
  with base as (select public.rpc_name_slug(p_label) as s),
  explicit(k, v) as (values
    ('shogun-rua', 'mauricio-rua'), ('renato-carneiro', 'renato-moicano'), ('jailton-malhadinho', 'jailton-almeida'),
    ('maria-godinez-gonzalez', 'loopy-godinez'), ('mayra-bueno', 'mayra-bueno-silva'), ('jair-rozenstruik', 'jairzinho-rozenstruik'),
    ('natalia-cristina-da-silva', 'natalia-silva'), ('quinton-jackson', 'quinton-rampage-jackson'), ('raul-rosas', 'raul-rosas-jr'),
    ('mingyang-zhang', 'zhang-mingyang'), ('daniel-hooker', 'dan-hooker'), ('stephen-erceg', 'steve-erceg'),
    ('nicholas-maximov', 'nick-maximov'), ('sean-o-malley', 'sean-omalley'), ('da-mon-blackshear', 'damon-blackshear'),
    ('sharabutdin-magomedov', 'shara-magomedov'), ('waldo-cortes', 'waldo-cortes-acosta'), ('quinton-jackson', 'rampage-jackson')),
  short(f, t) as (values ('daniel', 'dan'), ('stephen', 'steve'), ('nicholas', 'nick'), ('michael', 'mike'), ('christopher', 'chris'),
                         ('alexander', 'alex'), ('joseph', 'joe'), ('matthew', 'matt'), ('anthony', 'tony'), ('william', 'will')),
  cand as (
    select v as alt, 1 as ord from explicit, base where k = base.s
    union all select public.rpc_name_slug(replace(p_label, '''', '')), 2 from base
    union all select base.s || '-jr', 3 from base
    union all select regexp_replace(base.s, '^' || f || '-', t || '-'), 4 from base, short where base.s like f || '-%'
    union all select split_part(base.s, '-', 1) || '-' || reverse(split_part(reverse(base.s), '-', 1)), 5 from base
  )
  select coalesce(array_agg(alt order by ord) filter (where alt is not null and alt <> (select s from base)), '{}')
    from (select distinct on (alt) alt, ord from cand order by alt, ord) d
$$;
revoke all on function public.ufc_slug_alternates(text) from public, anon, authenticated;
-- anon-exec: revoked (ufc_slug_alternates) — REVOKE FROM PUBLIC, anon, authenticated re-stated; owner-only; verified anon=false via has_function_privilege 2026-11-08.

-- Re-queue the three with their new alternates.
update public.ufc_athlete_bio u
   set alt_slugs = a.alts[2:], ufc_slug = a.alts[1], status = 'pending', attempts = 0, request_id = null
  from (select name_slug, public.ufc_slug_alternates(player_label) as alts from public.ufc_athlete_bio
         where status = 'not_found' and name_slug in ('sharabutdin-magomedov', 'waldo-cortes', 'quinton-jackson')) a
 where u.name_slug = a.name_slug and cardinality(a.alts) > 0;
