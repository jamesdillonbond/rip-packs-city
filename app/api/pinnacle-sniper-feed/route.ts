// app/api/pinnacle-sniper-feed/route.ts
// Alias for /api/pinnacle-sniper — re-exports the same handler.
// The disney-pinnacle/sniper/page.tsx references this endpoint.

export const dynamic = "force-dynamic"
export const maxDuration = 25

export { GET } from "../pinnacle-sniper/route"
