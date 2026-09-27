// app/api/pinnacle-sniper-feed/route.ts
// Alias for /api/pinnacle-sniper — re-exports the same handler.
// No in-app caller since the bespoke Pinnacle pages were retired (2026-09-27);
// kept as a public alias — the shared Sniper reads /api/sniper-feed.

export const dynamic = "force-dynamic"
export const maxDuration = 25

export { GET } from "../pinnacle-sniper/route"
