#!/usr/bin/env node
/*
 * detect-jsx-space-drop.js — find copy where the JSX transform ate a space.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-07-27 six copy defects were found shipping on public pages, rendering
 * words jammed together:
 *     "only 110 of 125editions have traded"     /insights/candy-mlb
 *     "42 outlier listingspriced >10x ..."      /insights/candy-mlb
 *     "the jersey-matchserial of every edition" /special-serial-owners
 *     "39distinct editions against on-chain"    /insights/pack-drops  (x6 on the page)
 *     "seller'sproceeds - so we show..."        /insights/deals
 *     "is not a guaranteed flip" -> "nota"      /insights/deals
 *
 * Root cause is the build's JSX transform, PROVEN by feeding the verbatim source
 * through Next's own SWC binding and reproducing production in both directions
 * (CandyBoardClient drops the space; PaniniSqueezeClient, byte-identical in shape,
 * keeps it). The fix at each site is an explicit {" "}.
 *
 * CRITICALLY: this class is INVISIBLE to the test suite. vitest transforms with
 * esbuild, which preserves the space, so a jsdom assertion on rendered text passes
 * while production ships the words jammed. All 7,162 tests were green throughout.
 * That is why detection has to go through the real binding, which is what this
 * script does.
 *
 * STATUS: USEFUL BUT NOT SOUND — it OVER-REPORTS. Do not treat its output as a
 * defect list, and do not wire it into CI as a hard gate until the gap below is
 * closed.
 *
 * Spot-checking 5 of its 32 hits against production found 1 real and 4 false.
 *
 * THE REMAINING GAP (diagnosed, not fixed)
 * ----------------------------------------
 * It checks only that an emitted text string starts mid-sentence AND that the
 * source had a space at that boundary. It does NOT check what immediately
 * PRECEDES that string in the emitted children array. When the previous sibling
 * already supplies the space -- either a literal " " child (from an existing
 * {" "}) or a previous string with a trailing space -- the output is correct and
 * the hit is a false positive. In the emitted HTML those look like
 *     "</strong> <!-- -->meets or approaches"   <- FINE, space present
 * versus the real defect
 *     "<em>not</em>a guaranteed flip"           <- JAMMED
 *
 * TO FINISH IT: parse the emitted children sequence (the arguments to each
 * jsx/jsxs call) rather than the flat set of string literals, and flag a text
 * child only when its immediately-preceding sibling is an element call with no
 * " " child between them. Then the output becomes a true defect list and can gate
 * CI.
 *
 * USAGE:  node scripts/detect-jsx-space-drop.js
 */
const fs = require("fs");
const path = require("path");

const BINDING = path.join(
  __dirname,
  "..",
  "node_modules/@next/swc-linux-x64-gnu/next-swc.linux-x64-gnu.node"
);
if (!fs.existsSync(BINDING)) {
  console.error("Next SWC binding not found at " + BINDING + " — run npm install first.");
  process.exit(2);
}
const binding = require(BINDING);
const opts = (f) => ({
  jsc: {
    parser: { syntax: "typescript", tsx: true },
    target: "es2022",
    transform: { react: { runtime: "automatic" } },
  },
  filename: f,
});

// Scan double-quoted JS string literals, honouring escapes. A regex is NOT good
// enough here: an earlier attempt used one and silently skipped most strings in a
// file that was already known to be broken, reporting a clean result.
function stringLiterals(code) {
  const out = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < code.length) {
        if (code[j] === "\\") { buf += code[j] + code[j + 1]; j += 2; continue; }
        if (code[j] === '"') break;
        buf += code[j]; j++;
      }
      try { out.push(JSON.parse('"' + buf + '"')); } catch { /* not a literal */ }
      i = j + 1; continue;
    }
    if (c === "'" || c === "`") {
      const q = c; let j = i + 1;
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === q) break;
        j++;
      }
      i = j + 1; continue;
    }
    i++;
  }
  return out;
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", ".next"].includes(e.name)) walk(p, out);
    } else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

(async () => {
  const roots = ["app", "components"].filter((d) => fs.existsSync(d));
  const files = roots.flatMap((d) => walk(d));
  const findings = [];

  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    if (!/<[A-Za-z]/.test(src)) continue;
    let code;
    try {
      const r = await binding.transform(src, true, Buffer.from(JSON.stringify(opts(f))));
      code = typeof r === "string" ? JSON.parse(r).code : r.code || JSON.parse(r).code;
    } catch { continue; }

    const srcFlat = src.replace(/\s+/g, " ");
    for (const s of stringLiterals(code)) {
      if (s.length < 12 || !/^[a-z]/.test(s)) continue;
      const head = s.slice(0, 34).replace(/\s+/g, " ");
      if (/[=/<>{}]/.test(head)) continue;      // attribute names, urls, class strings
      if (!/\s/.test(head.trim())) continue;    // single token => not prose
      if (/^(aria|data)-/.test(head)) continue;
      const esc = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+");
      if (new RegExp("(?:>|\\}) " + esc).test(srcFlat)) findings.push({ f, head });
    }
  }

  const byFile = {};
  for (const x of findings) (byFile[x.f] ||= []).push(x.head);
  const entries = Object.entries(byFile);
  console.log(`CANDIDATES (over-reports — see header): ${findings.length} in ${entries.length} files`);
  for (const [f, arr] of entries) {
    console.log("\n" + f);
    [...new Set(arr)].forEach((h) => console.log('   "' + h + '"'));
  }
  console.log(
    "\nVerify each against the deployed HTML before fixing: a hit preceded by" +
      '\n"</tag> <!-- -->text" already has its space and is a FALSE POSITIVE.'
  );
})();
