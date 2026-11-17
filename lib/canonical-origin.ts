// lib/canonical-origin.ts
//
// The production site origin for SERVER-SIDE self-calls from a Vercel Cron route.
//
// ⚠ Never derive that origin from the cron request (`new URL(req.url).origin`): Vercel Cron calls
// the production DEPLOYMENT url (rip-packs-city-<hash>-….vercel.app), and this project's SSO
// protection covers deployment urls (`prod_deployment_urls_and_all_previews`), so a POST back to
// that origin is answered HTTP 401 by Vercel before our route runs. Found 2026-11-10 when every
// wallet-backfill resume 401'd (#245). Guard: __tests__/cron-routes-never-call-back-to-the-request-origin.test.ts
export const CANONICAL_ORIGIN = "https://www.rippackscity.com"
