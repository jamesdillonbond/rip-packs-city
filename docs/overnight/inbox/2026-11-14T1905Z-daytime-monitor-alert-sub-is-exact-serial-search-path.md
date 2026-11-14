# alert_sub_is_exact_serial(integer,integer,uuid[]) has a mutable search_path (function_search_path_mutable advisory)

**Filed:** 2026-11-14 ~19:05Z (daytime health monitor)
**Source:** `rpc_ops_snapshot().function_search_path_drift` — one entry, `object_name = alert_sub_is_exact_serial(integer,integer,uuid[])`, `security_definer = false`. The function was created this morning in the exact-serial pass-3 ship (ledger 2026-11-14 · `audit_20261114_deal_alerts_exact_serial_listings`); it is the one narrow-window test helper and shipped without a `search_path` pin.

**What it is:** The function has no `search_path` in `proconfig`, so it resolves unqualified names against the CALLER's `search_path`. It is SECURITY **INVOKER**, so this is a correctness / advisory issue (`function_search_path_mutable`), **not** a privilege escalation.

**Risk read:** LOW. Advisory only. The helper is a per-row test called inside `dispatch_due_deal_alerts` / `build_deal_alerts_for_subscription` (pass 3). Nothing is mispriced or leaking; it is unpinned search_path hygiene on a brand-new function.

**Suggested action (night pass — judgment call, MEASURE FIRST):** either
1. `ALTER FUNCTION public.alert_sub_is_exact_serial(integer, integer, uuid[]) SET search_path = public, pg_temp;` — an ALTER (proconfig only, no body rewrite); **or**
2. add the search_path-exempt comment per migration `20261026001400` if inlining matters more.

⚠ A `SET` clause stops inlining of a per-row SQL helper. Because this runs once per candidate row inside the dispatcher, confirm the dispatcher's per-tick cost is not regressed (budget 90 s; recent ticks ~1.4 s) BEFORE pinning. If the inlining cost outweighs the advisory, take the comment-exempt path (option 2) instead. Not a spell-time reading — measured on a quiet DB.

## Resolution — 2026-11-14 ~11:26 AM PT (Claude Code cloud)

- **Option 2 taken** (comment-exempt, `20261114192649_audit_20261114_alert_sub_is_exact_serial_search_path_exempt`). The body names no relation (parameter comparisons + one uuid literal), so a `SET search_path` could change nothing it resolves and would only stop inlining; no body change, so there is no dispatcher cost to measure.
- Read back: anon / authenticated EXECUTE false; `check_function_search_path_drift()` length **0**.
