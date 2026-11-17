// allday-consumer-gql-smoke — RETIRED 2026-07-16. Answer: the consumer GQL
// 403-blocks (WAF block page) even through the topshot-proxy CF worker — the
// server-side lane is dead; the home-machine residential lane is the fill.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
Deno.serve(() => new Response(JSON.stringify({ error: "gone", retired: "2026-07-16" }), { status: 410, headers: { "content-type": "application/json" } }));
