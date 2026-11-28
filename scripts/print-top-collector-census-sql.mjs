#!/usr/bin/env node
// Prints the Dune SQL for one Top Collector census (lib/dune/top-collector-census.ts) so the saved Dune
// query can be kept identical. Usage: npx tsx scripts/print-top-collector-census-sql.mjs topshot
import { CENSUS_CONFIGS, censusSql } from "../lib/dune/top-collector-census.ts"
const key = process.argv[2]
const cfg = CENSUS_CONFIGS[key]
if (!cfg) {
  console.error(`usage: print-top-collector-census-sql.mjs <${Object.keys(CENSUS_CONFIGS).join("|")}>`)
  process.exit(2)
}
process.stdout.write(censusSql(cfg))
