-- audit_20261107_og_cards_bucket
--
-- Stored social cards (lib/og/card-store.ts). WHY (2026-11-07): a pasted
-- rippackscity.com/profile/<u> link showed NO preview in Discord. The page
-- answers in ~0.2 s, but its card renders on demand and slowly — Vercel
-- observability, week to 11-07: /api/og/profile p50 10.8 s (p95 to 26 s),
-- /api/og/trophy-case p50 7.5 s — longer than a link-preview crawler waits.
-- The rendered PNG now lives here, served in well under a second and
-- re-rendered in the background when older than 10 minutes.
--
-- Objects: `profile/<handle>.png`, `trophy-case/<handle>.png`,
-- `trophy-case/<handle>/<challenge-slug>.png` (handle lower-cased).
-- Written by: the two OG routes, service role only — there is NO anon/
-- authenticated write policy, and none is needed. Read by: those routes,
-- through the public object URL (a public bucket serves reads without a
-- storage.objects SELECT policy, so none is added). Content: the same public
-- card image any visitor already gets from /api/og/*; nothing private.
-- Same shape as 20261101163315_audit_20261101_ipfs_thumb_mirror_bucket.
-- No function, no view.
--
-- Revert: delete from storage.objects where bucket_id = 'og-cards';
--         delete from storage.buckets where id = 'og-cards';
--         (the routes fall back to rendering on a store miss, so they keep working.)

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('og-cards', 'og-cards', true, 5242880, array['image/png'])
on conflict (id) do nothing;
