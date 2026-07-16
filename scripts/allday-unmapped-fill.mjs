#!/usr/bin/env node
/**
 * scripts/allday-unmapped-fill.mjs — HOME-MACHINE scheduler script.
 *
 * The AllDay consumer GraphQL (the only owner-independent moment→edition
 * index) WAF-403s every server lane — Vercel, Supabase edge, and even the
 * topshot-proxy Cloudflare Worker (verified 2026-07-16) — but residential
 * curl passes. This drains the unmapped-sales backlog from Trevor's machine:
 *
 *   1. GET /api/admin/allday-unmapped-fill?limit=400 → unresolved nft_ids
 *   2. chunk 40 → curl.exe POST nflallday.com/consumer/graphql
 *      searchMomentNFTsV2(byFlowIDs) → flowID/editionFlowID/serialNumber
 *   3. POST resolved rows back → mapping upsert + sales promotion
 *
 * Uses curl.exe for the GQL hop (the CDN/WAF fingerprints Node's undici —
 * same lesson as pinnacle-render-cache-fill).
 *
 * Usage:  node scripts/allday-unmapped-fill.mjs [--max-batches N]
 * Env:    INGEST_SECRET_TOKEN (or CRON_SECRET) from ../.env.local or process.env
 *
 * Task Scheduler (one-time, PowerShell):
 *   schtasks /Create /TN "RPC AllDay Unmapped Fill" /SC MINUTE /MO 15 ^
 *     /TR "cmd /c cd /d C:\Users\TDill\rip-packs-city && node scripts\allday-unmapped-fill.mjs >> logs\allday-unmapped-fill.log 2>&1"
 */
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = "https://www.rippackscity.com";
const GQL = "https://nflallday.com/consumer/graphql";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const QUERY =
  "query($ids:[Int]!){searchMomentNFTsV2(input:{first:40,filters:{byFlowIDs:$ids}}){edges{node{flowID editionFlowID serialNumber}}}}";
const CHUNK = 40; // consumer GQL hard-caps 40 edges/page
const MAX_BATCHES = (() => {
  const i = process.argv.indexOf("--max-batches");
  return i >= 0 ? Math.max(1, Number(process.argv[i + 1]) || 3) : 3;
})();

function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
  return env;
}
const env = loadEnv();
const TOKEN = env.INGEST_SECRET_TOKEN || env.CRON_SECRET;
if (!TOKEN) {
  console.error("Missing INGEST_SECRET_TOKEN / CRON_SECRET (env or .env.local)");
  process.exit(1);
}
const AUTH = { Authorization: `Bearer ${TOKEN}` };

// GQL via curl.exe (residential + curl fingerprint = the working combination).
function gqlViaCurl(ids) {
  const bodyFile = join(tmpdir(), `rpc-adq-${process.pid}.json`);
  const outFile = join(tmpdir(), `rpc-adr-${process.pid}.json`);
  writeFileSync(bodyFile, JSON.stringify({ query: QUERY, variables: { ids } }));
  try {
    execFileSync(
      "curl.exe",
      ["-s", "--max-time", "30", "-X", "POST", GQL,
       "-H", "Content-Type: application/json",
       "-H", `Origin: https://nflallday.com`,
       "-A", UA,
       "--data", `@${bodyFile}`,
       "-o", outFile],
      { timeout: 40_000 },
    );
    const text = readFileSync(outFile, "utf8");
    try { return { json: JSON.parse(text) }; }
    catch { return { blocked: text.slice(0, 120).replace(/\s+/g, " ") }; }
  } finally {
    try { rmSync(bodyFile); } catch { /* ok */ }
    try { rmSync(outFile); } catch { /* ok */ }
  }
}

async function main() {
  let totalResolved = 0, totalPromoted = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch++) {
    const listRes = await fetch(`${BASE}/api/admin/allday-unmapped-fill?limit=400`, { headers: AUTH });
    if (!listRes.ok) { console.error(`list failed: ${listRes.status}`); process.exit(1); }
    const { targets } = await listRes.json();
    console.log(`[${new Date().toISOString()}] batch ${batch + 1}: targets=${targets.length}`);
    if (targets.length === 0) break;

    const rows = [];
    let gqlBlocked = null;
    for (let i = 0; i < targets.length; i += CHUNK) {
      const ids = targets.slice(i, i + CHUNK).map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 2_147_483_647);
      if (ids.length === 0) continue;
      const r = gqlViaCurl(ids);
      if (r.blocked !== undefined) { gqlBlocked = r.blocked; break; }
      if (Array.isArray(r.json?.errors) && r.json.errors.length > 0) {
        console.error(`  gql errors: ${r.json.errors.map((e) => e.message).join("; ").slice(0, 120)}`);
        continue;
      }
      for (const edge of r.json?.data?.searchMomentNFTsV2?.edges ?? []) {
        const n = edge?.node;
        if (!n?.flowID || n?.editionFlowID == null) continue;
        rows.push({
          nft_id: String(n.flowID),
          edition_external_id: String(n.editionFlowID),
          serial_number: n.serialNumber != null && Number(n.serialNumber) > 0 ? Number(n.serialNumber) : null,
        });
      }
      await new Promise((res) => setTimeout(res, 350));
    }
    if (gqlBlocked !== null) {
      console.error(`  GQL BLOCKED from this machine too: ${gqlBlocked}`);
      process.exit(2);
    }
    console.log(`  resolved ${rows.length}/${targets.length} via consumer GQL`);
    if (rows.length === 0) break; // remaining targets are genuinely unknown to the index

    const putRes = await fetch(`${BASE}/api/admin/allday-unmapped-fill`, {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const putJson = await putRes.json().catch(() => ({}));
    if (!putRes.ok) { console.error(`  put failed: ${putRes.status} ${JSON.stringify(putJson)}`); process.exit(1); }
    console.log(`  mappings=${putJson.mappings_written} promoted=${putJson.sales_promoted}`);
    totalResolved += putJson.mappings_written ?? 0;
    totalPromoted += putJson.sales_promoted ?? 0;
    if (rows.length < targets.length * 0.2 && batch > 0) break; // diminishing returns this run
  }
  console.log(`done: mappings=${totalResolved} promoted=${totalPromoted}`);
}

try { mkdirSync(new URL("../logs", import.meta.url), { recursive: true }); } catch { /* ok */ }
main().catch((e) => { console.error(e); process.exit(1); });
