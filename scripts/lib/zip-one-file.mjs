// A small deterministic ZIP writer, in pure Node (single- and multi-entry).
//
// 2026-09-24: generalised from one entry to many so a skill bundle can carry its
// references/ directory — rpc-surface-qa's installed copy has two reference files that
// the SKILL.md-only bundle silently dropped, so a re-upload of the repo bundle would
// have uninstalled them. zipOneFile() is kept as a byte-identical wrapper.
//
// ⛔ WHY THIS EXISTS (2026-09-18). `scripts/pack-cowork-skill.mjs` shelled out to
// `zip`, and `__tests__/cowork-skill-bundles-match-their-source.test.ts` built its
// drift fixtures the same way. Git for Windows ships `zipgrep`/`zipinfo` but NOT
// `zip`, so on Trevor's box the packer refused to run and FIVE of the guard's nine
// arms skipped — the test said so itself: *"an environment gap on this machine,
// not a passing guard."* The documented repair for a live defect was Linux-only.
//
// ⭐ ONE IMPLEMENTATION, TWO CALLERS, ON PURPOSE. The packer and the test's fixture
// builder must agree about what a bundle looks like; two hand-rolled writers could
// drift, and a fixture that differs from the real artifact tests the wrong thing.
//
// ⚠ DETERMINISTIC BY CONSTRUCTION, and the limit is worth stating: every field
// here is fixed — no mtime from the filesystem, no extra fields, no creator
// version — so re-packing unchanged content is byte-identical. ACROSS writers it
// is not: output differs from `zip -jqX` for the same text, so a Linux re-pack
// churns the bytes back. That is a DIFF cost, never a correctness one, because
// `check-cowork-skill-bundles.mjs` compares NORMALIZED TEXT and never bytes.

import { deflateRawSync, crc32 } from "node:zlib";

// 2026-08-24 00:00:00, matching the packer's FIXED_MTIME.
const DOS_DATE = ((2026 - 1980) << 9) | (8 << 5) | 24;
const DOS_TIME = 0;

/**
 * Build a ZIP archive containing one or more entries, in the order given.
 * Every field is fixed (no mtime, no extra fields), so the same entries produce
 * the same bytes. Entry names may carry a directory ("references/x.md").
 * @param {{name: string, content: Buffer|string}[]} entries
 * @returns {Buffer}
 */
export function zipFiles(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error("zipFiles: at least one entry is required");
  }
  const seen = new Set();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    if (seen.has(entry.name)) throw new Error(`zipFiles: duplicate entry ${entry.name}`);
    seen.add(entry.name);
    const body = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const name = Buffer.from(entry.name, "utf8");
    // Fall back to STORE when deflate does not help, exactly as `zip` does.
    const deflated = deflateRawSync(body, { level: 9 });
    const useStore = deflated.length >= body.length;
    const data = useStore ? body : deflated;
    const method = useStore ? 0 : 8;
    const sum = crc32(body) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field — the `-X` in `zip -jqX`

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42); // local header offset of this entry

    locals.push(local, name, data);
    centrals.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = centrals.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

/**
 * Build a ZIP archive containing exactly one entry (the original API; byte-identical
 * to zipFiles([{ name, content }])).
 * @param {string} entryName  name inside the archive (e.g. "SKILL.md")
 * @param {Buffer|string} content
 * @returns {Buffer}
 */
export function zipOneFile(entryName, content) {
  return zipFiles([{ name: entryName, content }]);
}
