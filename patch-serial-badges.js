const fs = require('fs');

// ── Patch wallet-search/route.ts ──────────────────────────────────────────────
let ws = fs.readFileSync('app/api/wallet-search/route.ts', 'utf8');

// 1. Add jerseyNumber to GraphQL query
ws = ws.replace(
  'badges { type iconSvg }\n            set { leagues }',
  'badges { type iconSvg }\n            set { leagues }\n            play { stats { jerseyNumber } }'
);
console.log(ws.includes('jerseyNumber') ? '1 GraphQL query updated' : 'FAIL: GraphQL query');

// 2. Add jerseyNumber to MintedMomentGraphqlData type
ws = ws.replace(
  'set?: {\n        leagues?: Array<string | null> | null\n      } | null',
  'set?: {\n        leagues?: Array<string | null> | null\n      } | null\n      play?: {\n        stats?: { jerseyNumber?: string | null } | null\n      } | null'
);
console.log(ws.includes('play?: {') ? '2 Type updated' : 'FAIL: type');

// 3. Add jerseyNumber to mapped return object  
ws = ws.replace(
  'tssPoints: null as number | null,',
  'jerseyNumber: m?.play?.stats?.jerseyNumber ? parseInt(m.play.stats.jerseyNumber, 10) : null,\n      tssPoints: null as number | null,'
);
console.log(ws.includes('jerseyNumber: m?.play') ? '3 Return mapping updated' : 'FAIL: return mapping');

fs.writeFileSync('app/api/wallet-search/route.ts', ws, 'utf8');

// ── Patch collection/page.tsx ─────────────────────────────────────────────────
let cp = fs.readFileSync('app/(collections)/[collection]/collection/page.tsx', 'utf8');

// 4. Add jerseyNumber to MomentRow type
cp = cp.replace(
  '  tssPoints?: number | null',
  '  tssPoints?: number | null\n  jerseyNumber?: number | null'
);
console.log(cp.includes('jerseyNumber?: number') ? '4 MomentRow type updated' : 'FAIL: MomentRow type');

// 5. Add SerialBadge component after supadgePillClass function
const serialBadgeComponent = `
function SerialBadge({ serial, mintSize, jerseyNumber }: { serial: number | undefined; mintSize: number | undefined; jerseyNumber: number | null | undefined }) {
  if (!serial) return null
  const tags: { label: string; title: string; color: string }[] = []
  if (serial === 1)
    tags.push({ label: "#1", title: "Serial #1", color: "bg-yellow-950 text-yellow-300 border border-yellow-700" })
  if (jerseyNumber && serial === jerseyNumber)
    tags.push({ label: "JM", title: "Jersey Match — #" + jerseyNumber, color: "bg-teal-950 text-teal-300 border border-teal-700" })
  if (mintSize && serial === mintSize)
    tags.push({ label: "PM", title: "Perfect Mint — #" + serial + "/" + mintSize, color: "bg-violet-950 text-violet-300 border border-violet-700" })
  if (tags.length === 0) return null
  return (
    <span className="flex gap-1 flex-wrap">
      {tags.map(tag => (
        <span key={tag.label} title={tag.title} className={"rounded px-1 py-0.5 text-[10px] font-bold " + tag.color}>
          {tag.label}
        </span>
      ))}
    </span>
  )
}`;

const fnIdx = cp.indexOf('function BadgeIcon(');
cp = cp.slice(0, fnIdx) + serialBadgeComponent + '\n' + cp.slice(fnIdx);
console.log(cp.includes('function SerialBadge(') ? '5 SerialBadge component added' : 'FAIL: SerialBadge');

// 6. Wire jerseyNumber from wallet-search response into MomentRow
// The hydration maps gql fields onto rows - find where other gql fields are mapped
cp = cp.replace(
  'tssPoints: gql.tssPoints,',
  'tssPoints: gql.tssPoints,\n            jerseyNumber: (gql as any).jerseyNumber ?? null,'
);
console.log(cp.includes('jerseyNumber: (gql') ? '6 jerseyNumber wired into row' : 'FAIL: row wiring');

// 7. Add SerialBadge to the Serial/Mint column in the main table
// Find the serial display cell - looks for the serial/mint display
const oldSerialCell = `<td className="p-3">
                      <div className="font-mono text-sm">`;
const newSerialCell = `<td className="p-3">
                      <div className="flex flex-col gap-1">
                      <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} />
                      <div className="font-mono text-sm">`;

if (cp.includes(oldSerialCell)) {
  // Also need to close the extra div - find the closing pattern
  cp = cp.replace(oldSerialCell, newSerialCell);
  console.log('7 SerialBadge wired into table column');
} else {
  console.log('WARN 7: Serial cell pattern not found - needs manual check');
}

fs.writeFileSync('app/(collections)/[collection]/collection/page.tsx', cp, 'utf8');
console.log('Done');
