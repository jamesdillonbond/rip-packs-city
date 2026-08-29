// badge-icon-cache-put — RETIRED 2026-07-14 after harvesting 7 TS momentTags
// + 8 AllDay badgesV3 icons (browser-rasterized 128px PNGs, badge_icon_cache).
// Permanently stubbed; re-deploy from git history for future harvests.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ error: "gone", retired: "2026-07-14" }), { status: 410, headers: { "content-type": "application/json" } }));
