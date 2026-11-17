// The Packs board reads the WHOLE board, page by page (2026-11-14, packs review).
//
// It used to fetch ONE page of 500 and sort / filter it in the browser as if it were the whole
// board (3,202 Top Shot and 3,228 All Day packs that day): the cheapest-first default and every
// price / +EV filter ran over the 500 packs with the best value ratio. A board that cannot be read
// whole is an ERROR, never a shorter board.

export const PACK_BOARD_PAGE = 1000
export const PACK_BOARD_MAX_PAGES = 10

export async function fetchAllPackRows<R, T extends { rows: R[]; total: number }>(
  fetchPage: (offset: number, limit: number) => Promise<T>,
  page = PACK_BOARD_PAGE,
  maxPages = PACK_BOARD_MAX_PAGES,
): Promise<T> {
  let first: T | null = null
  const all: R[] = []
  for (let p = 0; p < maxPages; p++) {
    const json = await fetchPage(p * page, page)
    if (!first) first = json
    const batch = json.rows ?? []
    all.push(...batch)
    if (batch.length < page || all.length >= (first.total ?? 0)) return { ...first, rows: all }
  }
  throw new Error("Too many packs to load at once — narrow the filter and try again.")
}
