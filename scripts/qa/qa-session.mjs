#!/usr/bin/env node
// scripts/qa/qa-session.mjs — mint a Playwright storageState for a SIGNED-IN sweep.
//
// WHY THIS EXISTS. mobile-sweep.mjs can run signed in via RPC_QA_STATE, but
// nothing produced that file. The obvious route — read the session out of a
// signed-in Chrome — is CLOSED: the browser extension blocks auth-shaped
// localStorage keys outright ("[BLOCKED: Sensitive key]"), by design. And the
// login UI is magic-link only, so a headless browser cannot complete it.
//
// So this goes through the password grant, which IS enabled on this project
// (probed 2026-09-20: a bogus credential returns invalid_credentials, not a
// disabled-provider error).
//
// ⚠ IT DOES NOT GUESS THE COOKIE FORMAT. RPC uses @supabase/ssr's
// createBrowserClient, which keeps the session in CHUNKED, base64-encoded
// COOKIES whose layout is an internal detail of that package. This calls the
// package itself with a capturing cookie jar, so whatever it writes is what
// gets saved — no hand-rolled codec to drift out of date.
//
// CREDENTIALS come from .env.local (already gitignored) or the environment:
//   RPC_QA_EMAIL=...
//   RPC_QA_PASSWORD=...
// They are never printed, and never written into the output file beyond the
// session cookies themselves. Use a DEDICATED QA ACCOUNT, never a real one.
//
// USAGE
//   node scripts/qa/qa-session.mjs [out.json]          # default: _to_delete/qa-state.json
//   RPC_QA_STATE=_to_delete/qa-state.json node scripts/qa/mobile-sweep.mjs paths.txt out.jsonl shots mobile
//
// Delete the state file (and the QA account, if it was created for one pass)
// when the pass closes.

import fs from "node:fs";
import path from "node:path";
import { createServerClient } from "@supabase/ssr";

const OUT = process.argv[2] || "_to_delete/qa-state.json";

// .env.local without a dotenv dependency. Only the two keys we need.
function fromEnvLocal(key) {
  if (process.env[key]) return process.env[key];
  for (const f of [".env.local", ".env"]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const URL_ = fromEnvLocal("NEXT_PUBLIC_SUPABASE_URL") || "https://bxcqstmqfzmuolpuynti.supabase.co";
const KEY = fromEnvLocal("NEXT_PUBLIC_SUPABASE_ANON_KEY");
const EMAIL = fromEnvLocal("RPC_QA_EMAIL");
const PASSWORD = fromEnvLocal("RPC_QA_PASSWORD");

const missing = [["NEXT_PUBLIC_SUPABASE_ANON_KEY", KEY], ["RPC_QA_EMAIL", EMAIL], ["RPC_QA_PASSWORD", PASSWORD]]
  .filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error("missing: " + missing.join(", ") + "\nPut them in .env.local (gitignored) and re-run.");
  process.exit(2);
}

const jar = [];
const supabase = createServerClient(URL_, KEY, {
  cookies: { getAll: () => [], setAll: (cookies) => jar.push(...cookies) },
});

const { data, error } = await supabase.auth.signInWithPassword({ email: EMAIL, password: PASSWORD });
if (error) {
  // Never echo the credential, and never the token.
  console.error("sign-in failed: " + error.message);
  process.exit(1);
}
if (!jar.length) {
  console.error("sign-in succeeded but the client wrote NO cookies — @supabase/ssr's storage contract changed. Do not fall back to a hand-written cookie; fix this script.");
  process.exit(1);
}

const host = new global.URL(process.env.RPC_QA_BASE || "https://www.rippackscity.com").hostname;
const state = {
  cookies: jar.map((c) => ({
    name: c.name,
    value: c.value,
    domain: host,
    path: (c.options && c.options.path) || "/",
    expires: Math.floor(Date.now() / 1000) + 60 * 60 * 8,
    httpOnly: false,
    secure: true,
    sameSite: "Lax",
  })),
  origins: [],
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(state, null, 1), { mode: 0o600 });
console.log(`wrote ${OUT} — ${state.cookies.length} cookie(s), user ${data.user?.id?.slice(0, 8)}…, expires in 8h`);
