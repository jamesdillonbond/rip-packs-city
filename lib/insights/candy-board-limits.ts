// Row ceilings shared by the Candy MLB board's server read (lib/insights/candy-board.ts)
// and its client table (app/insights/candy-mlb/CandyBoardClient.tsx). Kept free of
// server imports so the client bundle can read it.

/** Ceiling for the paged Holders read, and the Holders table's slice cap. */
export const HOLDERS_MAX_ROWS = 5000
