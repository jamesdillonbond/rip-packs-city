#!/usr/bin/env node
/**
 * scripts/pinnacle-render-cache-fill.mjs — HOME-MACHINE scheduler script.
 *
 * assets.disneypinnacle.com 403s all datacenter egress but allows residential
 * IPs (verified 2026-07-14), so this runs on Trevor's machine (Windows Task
 * Scheduler, every 15 min — the "fifth scheduler" alongside the Deal Board +
 * AllDay-badge ingests). Loop:
 *   1. GET /api/admin/pinnacle-render-cache-fill  → render_ids trophy slabs
 *      reference that are missing from pinnacle_render_cache
 *   2. fetch each via /api/public/pinnacle-image/<id> (302 → signed CDN URL,
 *      followed from THIS residential IP)
 *   3. box-average downscale to ≤800px (pngjs, pure JS)
 *   4. POST the PNG back to the admin route (service-role upsert)
 *
 * The trophy-case PDF reads the cache first, so any user's newly pinned
 * Pinnacle pin gets real art within one tick.
 *
 * Usage:
 *   node scripts/pinnacle-render-cache-fill.mjs         # fill missing
 *   node scripts/pinnacle-render-cache-fill.mjs --all   # force re-harvest all referenced
 *
 * Env: INGEST_SECRET_TOKEN (or CRON_SECRET) from ../.env.local or process.env.
 *
 * Task Scheduler (one-time, PowerShell):
 *   schtasks /Create /TN "RPC Pinnacle Render Cache Fill" /SC MINUTE /MO 15 ^
 *     /TR "cmd /c cd /d C:\Users\TDill\rip-packs-city && node scripts\pinnacle-render-cache-fill.mjs >> logs\pinnacle-render-fill.log 2>&1"
 */
import { readFileSync, mkdirSync } from "node:fs";
import { PNG } from "pngjs";

const BASE = "https://www.rippackscity.com";
const ALL = process.argv.includes("--all");
const MAX_PER_RUN = 20;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function loadEnv() {
  const env = { ...process.env };
  try {
    const raw = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* .env.local optional */
  }
  return env;
}
const env = loadEnv();
const TOKEN = env.INGEST_SECRET_TOKEN || env.CRON_SECRET;
if (!TOKEN) {
  console.error("Missing INGEST_SECRET_TOKEN / CRON_SECRET (env or .env.local)");
  process.exit(1);
}
const AUTH = { Authorization: `Bearer ${TOKEN}` };

// Box-average downscale of RGBA to maxDim (mirrors the trophy-PDF route).
function downscale(png, maxDim) {
  const { width: w, height: h, data } = png;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  if (scale >= 1) return png;
  const ow = Math.max(1, Math.round(w * scale));
  const oh = Math.max(1, Math.round(h * scale));
  const out = new PNG({ width: ow, height: oh });
  const fx = w / ow, fy = h / oh;
  for (let oy = 0; oy < oh; oy++) {
    const y0 = Math.floor(oy * fy), y1 = Math.min(h, Math.ceil((oy + 1) * fy));
    for (let ox = 0; ox < ow; ox++) {
      const x0 = Math.floor(ox * fx), x1 = Math.min(w, Math.ceil((ox + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        let i = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1; xx++, i += 4) {
          const al = data[i + 3];
          r += data[i] * al; g += data[i + 1] * al; b += data[i + 2] * al; a += al; n++;
        }
      }
      const o = (oy * ow + ox) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a / n);
      }
    }
  }
  return out;
}

async function main() {
  const listRes = await fetch(`${BASE}/api/admin/pinnacle-render-cache-fill${ALL ? "?all=1" : ""}`, {
    headers: AUTH,
  });
  if (!listRes.ok) {
    console.error(`list failed: ${listRes.status} ${await listRes.text()}`);
    process.exit(1);
  }
  const { needed, mode } = await listRes.json();
  console.log(`[${new Date().toISOString()}] mode=${mode} needed=${needed.length}`);
  if (needed.length === 0) return;

  let ok = 0, fail = 0;
  for (const id of needed.slice(0, MAX_PER_RUN)) {
    try {
      const imgRes = await fetch(`${BASE}/api/public/pinnacle-image/${encodeURIComponent(id)}`, {
        redirect: "follow",
        headers: { "User-Agent": UA, Accept: "image/png,image/*" },
      });
      if (!imgRes.ok) throw new Error(`image ${imgRes.status}`);
      const raw = Buffer.from(await imgRes.arrayBuffer());
      let uploadB64;
      if (raw[0] === 0x89 && raw[1] === 0x50) {
        const small = downscale(PNG.sync.read(raw), 800);
        uploadB64 = PNG.sync.write(small).toString("base64");
      } else if (raw[0] === 0xff && raw[1] === 0xd8) {
        uploadB64 = raw.toString("base64"); // jpeg — the PDF route downscales server-side
      } else {
        throw new Error("not png/jpeg");
      }
      const putRes = await fetch(`${BASE}/api/admin/pinnacle-render-cache-fill`, {
        method: "POST",
        headers: { ...AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({ render_id: id, b64: uploadB64 }),
      });
      const putJson = await putRes.json().catch(() => ({}));
      if (!putRes.ok) throw new Error(`put ${putRes.status} ${JSON.stringify(putJson)}`);
      console.log(`  cached ${id} (${putJson.bytes} bytes)`);
      ok++;
    } catch (err) {
      console.error(`  FAILED ${id}: ${err.message}`);
      fail++;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`done: ok=${ok} fail=${fail}`);
  if (fail > 0 && ok === 0) process.exit(1);
}

try { mkdirSync(new URL("../logs", import.meta.url), { recursive: true }); } catch { /* ok */ }
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
