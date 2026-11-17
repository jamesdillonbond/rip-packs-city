-- audit_20260729_wallet_capability_tier_view
--
-- RECOVERED 2026-07-31 (PT) from supabase_migrations.schema_migrations version
-- 20260729235724, verbatim. Applied via Supabase MCP with no repo file and no
-- ledger entry. See docs/overnight/ledger.md 2026-07-31.
--
-- Revert: DROP VIEW public.v_wallet_capability_tier;

-- v_wallet_capability_tier — resolves a Flow address to what it can actually DO,
-- from the live Hybrid Custody graph in linked_accounts.
--
-- WHY. Trevor's product ruling 2026-07-29: a Dapper Wallet sign-in should grant
-- READ-ONLY capability (it is a custodial child account — it cannot meaningfully
-- sign), while a self-custody Flow Wallet linked as the Hybrid Custody PARENT is
-- what unlocks advanced/transacting capability. Today nothing in the app enforces
-- that: linked_accounts is live (99 active links, 95 distinct parents, latest
-- event 2026-07-29 02:33Z) but is read by only two narrow routes
-- (app/api/gift/children, app/api/profile/verify-link) and never used to gate
-- what a signed-in wallet is offered.
--
-- This view makes the tier a single canonical answer instead of a rule
-- re-implemented per surface.
--
-- SEMANTICS, deliberately conservative:
--   role 'parent'     — address is the active parent of >=1 child. Self-custody.
--   role 'child'      — address is an active child of >=1 parent (Dapper-custodial).
--   role 'standalone' — appears in linked_accounts but has no ACTIVE link either way
--                       (i.e. every link it had is active=false).
--   capability_tier 'advanced'  — a parent. It can sign for itself and act on its
--                                 children's assets.
--   capability_tier 'read_only' — a child, or a standalone. A child alone cannot
--                                 transact; its parent must.
--
-- ABSENCE IS NOT read_only. An address with NO row here is simply UNKNOWN to the
-- Hybrid Custody indexer — it may be an ordinary self-custody wallet that never
-- linked anything. Callers MUST treat "no row" as unknown and decide separately;
-- do not LEFT JOIN this and coalesce to 'read_only'. That would silently downgrade
-- every normal wallet on the platform.
--
-- relationship is 'restricted' on all 126 rows today (the only value the indexer
-- has ever written). If an 'owned'/unrestricted relationship type ever appears,
-- revisit — an unrestricted child has broader rights than this view assumes.
--
-- Consumer is filed as handoff item 17 (docs/handoff-2026-07-29-wallet-capability.md).
-- If that has not shipped, either finish it or drop this view — do not leave it
-- unread (cf. the PANINI_PUBLIC-with-zero-consumers trap, 2026-07-28).
--
-- REVERT: DROP VIEW public.v_wallet_capability_tier;

CREATE OR REPLACE VIEW public.v_wallet_capability_tier AS
WITH addrs AS (
  SELECT parent_addr AS address FROM public.linked_accounts WHERE parent_addr IS NOT NULL
  UNION
  SELECT child_addr  AS address FROM public.linked_accounts WHERE child_addr  IS NOT NULL
), rolled AS (
  SELECT a.address,
         EXISTS (SELECT 1 FROM public.linked_accounts l
                  WHERE l.parent_addr = a.address AND l.active) AS is_active_parent,
         EXISTS (SELECT 1 FROM public.linked_accounts l
                  WHERE l.child_addr  = a.address AND l.active) AS is_active_child,
         (SELECT count(*) FROM public.linked_accounts l
                  WHERE l.parent_addr = a.address AND l.active) AS active_children,
         (SELECT min(l.parent_addr) FROM public.linked_accounts l
                  WHERE l.child_addr = a.address AND l.active) AS active_parent_addr,
         (SELECT max(l.last_event_at) FROM public.linked_accounts l
                  WHERE l.parent_addr = a.address OR l.child_addr = a.address) AS last_link_event_at
  FROM addrs a
)
SELECT address,
       CASE WHEN is_active_parent THEN 'parent'
            WHEN is_active_child  THEN 'child'
            ELSE 'standalone' END AS role,
       CASE WHEN is_active_parent THEN 'advanced'
            ELSE 'read_only' END AS capability_tier,
       is_active_parent,
       is_active_child,
       active_children,
       active_parent_addr,
       last_link_event_at
FROM rolled;

ALTER VIEW public.v_wallet_capability_tier SET (security_invoker = on);
REVOKE ALL ON public.v_wallet_capability_tier FROM anon, authenticated;

COMMENT ON VIEW public.v_wallet_capability_tier IS
 'Resolves a Flow address to capability tier from the Hybrid Custody graph: parent (self-custody, advanced) vs child (Dapper-custodial, read_only). An address with NO row is UNKNOWN, not read_only — never coalesce absence to read_only or every ordinary wallet gets downgraded. See docs/handoff-2026-07-29-wallet-capability.md.';
