// allday-unmapped-bridge — RETIRED 2026-07-16 after the browser-relay drain
// (6,539 AllDay sales recovered; 2,199 dead ids retired; targets fn now 0).
// Permanently stubbed; re-deploy from git history for a future browser drain.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ error: "gone", retired: "2026-07-16" }), { status: 410, headers: { "content-type": "application/json" } }));
