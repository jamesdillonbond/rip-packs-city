-- audit_20261115_allday_badge_zero_offer_to_null
--
-- CAUSE (monthly deep audit 2026-11-15, finding C2): 3,213 of 5,607 All Day badge_editions rows
-- stored highest_offer = 0 and NONE stored NULL — a $0 "best offer" is the fabricated-zero shape
-- (CLAUDE.md honesty canon), not a bid. The writer, app/api/cron/allday-badge-ingest/route.ts,
-- mapped `r.highest_offer ?? null`, under a 08-27 comment saying upstream nulls the field; that
-- stopped being true. Same commit changes it to `|| null`, matching atlas_editions_drain's
-- NULLIF(highestOfferCents, 0). Readers today guard `> 0` (get_moment_best_offer,
-- get_wallet_edition_bid_total, /api/best-offers, edition/moment pages) so nothing rendered $0;
-- get_edition_high_offer and /api/badges price_gap could have.
--
-- EVIDENCE (2026-11-15 ~2:45 AM PT): All Day rows n=5,607 · highest_offer=0 3,213 · >0 2,387 ·
-- NULL 0. Top Shot 14,881 rows / 0 zeros; Golazos 218 / 0 zeros.
--
-- WHAT: archive the affected ids, then NULL the zeros. Top Shot / Golazos untouched.
--
-- REVERT:
--   UPDATE public.badge_editions be SET highest_offer = 0
--     FROM flowty_archive.audit_20261115_allday_zero_offer a
--    WHERE be.id = a.id AND be.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'
--      AND be.highest_offer IS NULL;
--   DROP TABLE flowty_archive.audit_20261115_allday_zero_offer;

CREATE TABLE IF NOT EXISTS flowty_archive.audit_20261115_allday_zero_offer (
  id          text        PRIMARY KEY,
  archived_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE flowty_archive.audit_20261115_allday_zero_offer ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON flowty_archive.audit_20261115_allday_zero_offer FROM PUBLIC, anon, authenticated;

INSERT INTO flowty_archive.audit_20261115_allday_zero_offer (id)
SELECT id::text FROM public.badge_editions
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND highest_offer = 0
ON CONFLICT (id) DO NOTHING;

UPDATE public.badge_editions
   SET highest_offer = NULL
 WHERE collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070' AND highest_offer = 0;
