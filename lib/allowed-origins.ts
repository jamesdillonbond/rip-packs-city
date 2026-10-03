// The site's own origins. Shared by proxy.ts (CORS header on the public API
// paths) and /api/support-chat (browser-origin check on an anonymous POST) so
// the two cannot drift — a list that claims to mirror another is an untested
// claim; one list is not.
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://rip-packs-city.vercel.app",
  "https://rippackscity.com",
  "https://www.rippackscity.com",
  "http://localhost:3000",
];
