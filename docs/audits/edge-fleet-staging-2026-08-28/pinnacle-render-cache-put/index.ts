// pinnacle-render-cache-put — RETIRED 2026-07-14 after the LEV2-LION-CARE-S6
// browser harvest (385KB PNG cached in pinnacle_render_cache). Permanently
// stubbed; re-deploy from git history for future harvests, or wait for the
// pinnacle-proxy worker passthrough (PINNACLE-ART-DATACENTER-BLOCK).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ error: "gone", retired: "2026-07-14" }), { status: 410, headers: { "content-type": "application/json" } }));
