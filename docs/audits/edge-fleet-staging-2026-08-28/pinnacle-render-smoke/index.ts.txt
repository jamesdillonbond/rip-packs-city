// pinnacle-render-smoke — RETIRED 2026-07-14. STEP-0 answer: Upstream 403 —
// assets.disneypinnacle.com blocks Cloudflare Workers egress too. The
// passthrough premise is DISPROVEN; browser-harvest (pinnacle_render_cache)
// is the permanent fill.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ error: "gone", retired: "2026-07-14" }), { status: 410, headers: { "content-type": "application/json" } }));
