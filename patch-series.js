const fs = require('fs');
const file = "app/(collections)/[collection]/collection/page.tsx";
let c = fs.readFileSync(file, 'utf8');

// 1. Replace SERIES_INT_TO_SEASON values with proper Top Shot display names
const oldMap = `const SERIES_INT_TO_SEASON: Record<number, string> = {
  0: "2019-20", 1: "2019-20", 2: "2020-21", 3: "2021",
  4: "2021-22", 5: "2022-23", 6: "2023-24", 7: "2024-25", 8: "2025-26",
}`;
const newMap = `const SERIES_INT_TO_SEASON: Record<number, string> = {
  0: "Beta", 1: "Series 1", 2: "Series 2", 3: "Summer 2021",
  4: "Series 3", 5: "Series 4", 6: "Series 2023-24", 7: "Series 2024-25", 8: "Series 2025-26",
}`;
if (c.includes(oldMap)) {
  c = c.replace(oldMap, newMap);
  console.log('1 SERIES_INT_TO_SEASON updated to display names');
} else { console.error('FAIL: SERIES_INT_TO_SEASON map not found'); process.exit(1); }

// 2. Wire seriesIntToSeason into the main table Series column (line 961 area)
const oldSeriesCell = `<td className="p-3 text-zinc-400 text-sm hidden sm:table-cell">{row.series ?? "—"}</td>`;
const newSeriesCell = `<td className="p-3 text-zinc-400 text-sm hidden sm:table-cell">{seriesIntToSeason(row.series) || row.series || "—"}</td>`;
if (c.includes(oldSeriesCell)) {
  c = c.replace(oldSeriesCell, newSeriesCell);
  console.log('2 Series column wired to display names');
} else { console.log('WARN: Series column cell not found - check manually'); }

// 3. Fix the expanded panel to show display name only (currently shows raw + season)
const oldExpandedSeries = `<div>Series: {row.series ?? "-"} ({seriesIntToSeason(row.series) || "—"})</div>`;
const newExpandedSeries = `<div>Series: {seriesIntToSeason(row.series) || row.series || "—"}</div>`;
if (c.includes(oldExpandedSeries)) {
  c = c.replace(oldExpandedSeries, newExpandedSeries);
  console.log('3 Expanded panel series display cleaned up');
} else { console.log('WARN: expanded panel series not found - check manually'); }

fs.writeFileSync(file, c, 'utf8');
console.log('Done. Lines:', c.split('\n').length);
