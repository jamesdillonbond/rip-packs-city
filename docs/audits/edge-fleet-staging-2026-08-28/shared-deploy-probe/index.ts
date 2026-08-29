// RETIRED PROBE — safe to delete from the Supabase dashboard.
// Deployed 2026-08-10 (Claude Code) once to PROVE the MCP multi-file
// deploy correctly bundles a `../_shared/` relative dependency (it does:
// the shared file landed at <root>/_shared/ and produced a valid eszip).
// Now inert: returns 410 and imports nothing.
Deno.serve(() => new Response(JSON.stringify({ gone: true, note: "retired shared-deploy-probe; safe to delete" }), { status: 410, headers: { "Content-Type": "application/json" } }))
