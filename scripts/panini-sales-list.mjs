// scripts/panini-sales-list.mjs — which SALES HISTORY list an nftSalesData request asked for
// (2026-09-28). Pure, so it is tested; the runner drives a live browser and is not.
//
// The SALES HISTORY tab reads two lists per edition: TOP SALES (the 20 highest-priced ever,
// nftSalesData sale_type:"top", pageSize 20 — measured 2026-09-24) and RECENT SALES (the newest
// 20). The runner tags every record with the list its REQUEST named, so the ingest can tell a
// Recent read (which moves panini_sales_reads.complete_since) from a Top read (which does not).
// ⚠ The key names were read off ONE captured request. If Panini names them differently, this
// returns nulls, the records are stored UNTAGGED (still kept as sales, never moving coverage),
// and the runner's end-of-walk line shows `untagged` > 0 — that line is the measurement.

/** { list: "top" | "recent" | null, pageSize: number | null } from a request body. */
export function saleListOf(postData) {
  const s = typeof postData === "string" ? postData : ""
  // Matches sale_type:"top" inside a GraphQL query string (quotes escaped in the JSON body) and
  // "sale_type":"recent" / "saleType":"recent" in a variables object alike.
  const list = /sale_?type\\?"?\s*[:=]\s*\\?"?(top|recent)\b/i.exec(s)
  const size = /page_?size\\?"?\s*[:=]\s*\\?"?(\d{1,4})\b/i.exec(s)
  return {
    list: list ? list[1].toLowerCase() : null,
    pageSize: size ? Number(size[1]) : null,
  }
}

/** Tag records in place with `__list` / `__page_size` (fields the ingest reads; Panini's never start with "__"). */
export function tagSaleRecords(records, postData) {
  const { list, pageSize } = saleListOf(postData)
  for (const r of records) {
    if (!r || typeof r !== "object") continue
    if (list) r.__list = list
    if (pageSize) r.__page_size = pageSize
  }
  return list
}
