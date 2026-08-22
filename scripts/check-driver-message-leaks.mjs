#!/usr/bin/env node
// Driver-message leak guard (2026-08-22).
//
// WHY THIS EXISTS. lib/api-error.ts was written because /api/sets caught its
// error, pulled `err.message`, and returned it to the browser — so under the
// disk-IO band the flagship Set Tracker showed anonymous visitors:
//
//     ERROR
//     canceling statement due to statement timeout
//
// Two defects at once: the page is dead, and internal database detail leaks.
// The helper exists; the discipline of using it did not hold. Measured
// 2026-08-22 by grepping the EXPRESSION rather than the file: 73 sites across
// 57 route files.
//
// ── WHY THIS IS NOT A BAN ON THE EXPRESSION ──
// Most of those 73 are CORRECT. /api/admin/** and /api/cron/** and the
// token-gated ingest routes are operator surface reached with a secret, never
// by a browser; there a driver message is diagnostic, not a leak. Banning the
// expression outright would red ~66 correct sites and the guard would be
// switched off. This is the "same expression, opposite correctness" split the
// project already records for the swallowed-`error` population.
//
// ── ⚠ THE EXCLUSION IS PER HANDLER, NOT PER FILE, AND THAT IS THE POINT ──
// A file-level auth grep is exactly the mistake CLAUDE.md records: "a FILE-level
// secret grep defended a per-HANDLER exclusion, so a gated POST vouched for the
// ungated GET beside it." Measured here: 4 GET handlers leaked while their
// file's POST was token-gated — seed-golazos-badges, seed-allday-badges,
// badge-sync, allday-pack-listings. A file-scoped guard would have called every
// one of them clean. All four fixed in the commit that added this file.
//
// So: split each route into its exported handlers, and ask of EACH one whether
// IT is gated. Ban at population zero for the ungated ones.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

const rootFlag = process.argv.indexOf("--root");
const ROOT = rootFlag !== -1 ? process.argv[rootFlag + 1] : ".";
const IS_LIVE = rootFlag === -1;
const API_DIR = join(ROOT, "app/api");

// A driver message handed to the client.
const LEAK =
  /NextResponse\.json\(\s*\{[^}]*\berror\s*:\s*(?:err|e|error|ex)\b[^}]*?\.message[^}]*\}/gs;

// An operator credential check. Any of these INSIDE a handler (or in the module
// preamble, which runs for every handler) means that handler is not
// browser-reachable without a secret.
const GATE =
  /INGEST_SECRET_TOKEN|CRON_SECRET|RPC_ADMIN_TOKEN|verifyAdminRequest|requireAdmin|assertAdmin|verifyCronAuth|requireOwnedKey/;

const HANDLER = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD)\s*\(/gm;

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(API_DIR);
const violations = [];
let handlersInspected = 0;
let gatedLeaks = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const marks = [...src.matchAll(HANDLER)].map((m) => ({ at: m.index, verb: m[1] }));
  if (marks.length === 0) continue;
  const preambleGated = GATE.test(src.slice(0, marks[0].at));
  for (let i = 0; i < marks.length; i++) {
    handlersInspected++;
    const a = marks[i].at;
    const b = i + 1 < marks.length ? marks[i + 1].at : src.length;
    const body = src.slice(a, b);
    const leaks = body.match(LEAK);
    if (!leaks) continue;
    if (preambleGated || GATE.test(body)) {
      gatedLeaks += leaks.length;   // operator surface — diagnostic, not a leak
      continue;
    }
    violations.push({ file, verb: marks[i].verb, count: leaks.length });
  }
}

// ⚠ ASSERT THE COUNT IT INSPECTED. check-tree-corruption.mjs shipped as pure
// theatre because its default mode inspected NOTHING on a CI checkout and still
// exited 0. Floors are far below the real population (~450 files, ~600 handlers
// as of 2026-08-22) so ordinary pruning does not trip them.
if (handlersInspected === 0) {
  console.error(
    `Driver-message leak guard INSPECTED NOTHING (0 handlers under ${API_DIR}). ` +
      `The guard is broken or running from the wrong directory — FAILING, not passing.`
  );
  process.exit(1);
}
if (IS_LIVE && handlersInspected < 100) {
  console.error(
    `Driver-message leak guard found only ${handlersInspected} handlers — implausibly ` +
      `few for app/api. The walk or the handler regex has broken; FAILING.`
  );
  process.exit(1);
}
// The gated population is the guard's own positive control: if it ever reads 0,
// the GATE or LEAK regex has stopped matching and the "clean" result is empty.
if (IS_LIVE && gatedLeaks === 0) {
  console.error(
    `Driver-message leak guard saw 0 gated leak sites. That is the POSITIVE ` +
      `CONTROL and it should be ~66 — the detector has stopped matching, so a ` +
      `clean result here would be meaningless. FAILING.`
  );
  process.exit(1);
}

if (violations.length > 0) {
  console.error(
    `\nDriver-message leak guard: ${violations.length} UNGATED handler(s) return a ` +
      `raw driver message to the client.\n`
  );
  for (const v of violations) console.error(`  ${v.verb.padEnd(6)} ${v.file}  (${v.count})`);
  console.error(
    `\nUnder the disk-IO band that message is Postgres's own text, e.g. ` +
      `"canceling statement due to statement timeout", rendered to whoever asked.\n` +
      `Use apiErrorResponse(err, "<tag>") from lib/api-error.ts — it logs the ` +
      `detail server-side and returns a stable, publishable code.\n` +
      `⚠ If you believe the handler is operator-only, the gate must be in THAT ` +
      `handler (or the module preamble) — a sibling gated POST does not cover it.\n`
  );
  process.exit(1);
}

console.log(
  `Driver-message leak guard: ${handlersInspected} handler(s) inspected, ` +
    `0 ungated leaks (${gatedLeaks} gated operator sites ignored by design).`
);
