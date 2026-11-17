-- Seed LOW-confidence FMV snapshots for editions with zero FMV coverage.
-- Uses badge_editions price data (avg_sale_price or low_ask) as proxy values.
-- Only inserts for editions that have NO existing fmv_snapshots row.

INSERT INTO fmv_snapshots (edition_id, fmv_usd, confidence, computed_at)
SELECT e.id,
       COALESCE(NULLIF(be.avg_sale_price, 0), NULLIF(be.low_ask, 0)),
       'LOW',
       NOW()
FROM editions e
JOIN badge_editions be ON be.id = e.external_id
WHERE NOT EXISTS (
    SELECT 1 FROM fmv_snapshots f WHERE f.edition_id = e.id
)
AND (be.avg_sale_price > 0 OR be.low_ask > 0)
ON CONFLICT DO NOTHING;
