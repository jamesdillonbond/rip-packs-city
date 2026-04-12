// app/api/pinnacle-sniper-feed/route.ts
// Alias for /api/pinnacle-sniper — re-exports the same handler.
// The disney-pinnacle/sniper/page.tsx references this endpoint.

export { GET, dynamic, maxDuration } from "../pinnacle-sniper/route"
