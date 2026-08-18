#!/usr/bin/env node
// Find ledger entry headings STAMPED IN A DAY THAT HAS NOT HAPPENED YET.
//
// docs/overnight/ledger.md is dated in PACIFIC time (Trevor operates in PT), but
// almost every writer runs on a UTC clock: CI, the cloud sandbox, the nightly
// pass. Between 17:00 PT and midnight PT, UTC is already on the NEXT DAY, so a
// session that stamps `date -u` writes a heading dated tomorrow. The entry then
// sorts wrong in a newest-first file and reports work on a day that has not
// happened.
//
// Measured 2026-08-17: FOUR entries (4b32934, a18c39a, b7ec40b, 2892f29, all
// authored 17:46-18:21 PT) were stamped 2026-08-18 and interleaved with 08-17
// entries — inside 35 minutes, with the warning already present in BOTH the
// ledger header and CLAUDE.md. The warning is not the fix; this is.
//
// ⚠ THE GUARD MUST DO ITS OWN UTC→PT CONVERSION. This is the whole point. A
// check that asks the host for "today" runs in CI on a UTC clock and computes
// the same wrong date the bug did, so a tomorrow-stamped entry looks like
// today's and the guard passes — it reproduces the exact defect it exists to
// catch. That is also why this is Node and not awk beside its sibling
// find-swallowed-ledger-headings.awk: awk has no timezone database, and the
// obvious shell fallbacks are worse than useless here — CLAUDE.md records that
// `TZ=America/Los_Angeles date` in Git Bash returns UTC labelled `GMT`, and that
// bare `date` there has read a full calendar day ahead. Intl with an explicit
// timeZone is the one form that cannot be silently wrong.
//
// ⚠ Match ^### <ISO date> STRICTLY. A loose "heading dated later than today"
// grep fires on `### <date>` (quoted as a format example in this file's own
// header) and on every `### audit_20260705_*` heading, because those sort above
// a numeric date as strings. Both are false positives; require the date shape.
//
// Usage:
//   node scripts/find-future-dated-ledger-headings.mjs docs/overnight/ledger.md
//     → prints the count (0 when clean)
//   node scripts/find-future-dated-ledger-headings.mjs --show <file>
//     → prints "<line>: <text>" for each offender instead
import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const show = args.includes("--show");
const file = args.find((a) => !a.startsWith("--")) ?? "docs/overnight/ledger.md";

// The authoritative "today", in Pacific, regardless of the host clock's zone.
// ⚠ Assembled from formatToParts, NOT from a locale's format string. Asking for
// "en-CA" and trusting the YYYY-MM-DD shape is a trap: on a small-ICU Node build
// every non-en-US locale silently falls back to en-US, which formats M/D/YYYY —
// the comparison below would then be string-comparing "8/18/2026" and never fire.
// Parts are locale-independent, so this cannot drift.
const parts = Object.fromEntries(
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .map((p) => [p.type, p.value]),
);
const todayPT = `${parts.year}-${parts.month}-${parts.day}`;
if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(todayPT)) {
  console.error(`FATAL: could not derive today's Pacific date (got "${todayPT}"). Refusing to pass silently.`);
  process.exit(2);
}

const offenders = [];
readFileSync(file, "utf8")
  .split("\n")
  .forEach((line, i) => {
    const m = /^### (\d{4}-\d{2}-\d{2})\b/.exec(line);
    if (m && m[1] > todayPT) offenders.push({ n: i + 1, date: m[1], line });
  });

if (show) {
  const utc = new Date().toISOString().slice(0, 10);
  console.error(`today-PT=${todayPT}${utc !== todayPT ? `  (host UTC date is ${utc} — this is exactly the skew that causes the bug)` : ""}`);
  for (const o of offenders) console.log(`${o.n}: ${o.line.slice(0, 200)}`);
} else {
  console.log(offenders.length);
}
