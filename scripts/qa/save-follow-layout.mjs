// scripts/qa/save-follow-layout.mjs — the binder's save-as-mine confirm and
// + Follow, rendered SIGNED IN at 390 / 767 / 1280 px with no account (2026-11-16).
//
//   node scripts/qa/save-follow-layout.mjs [wallet-or-username]   (default: sdb)
//
// How: Playwright answers /api/profile/me, saved-wallets (GET) and
// followed-wallets (GET) inside the browser, so the signed-in buttons render;
// every write (POST/DELETE, resolve-and-associate) is ABORTED, so nothing
// reaches RPC. Prints, per width: the confirm card's box, Search's height and
// line, Follow's line, and horizontal overflow; saves /tmp/confirm-<width>.png.
// PASS = card on its own line below Search/Follow (card.y > searchY), Search
// ~35 px tall (not stretched to the card), overflow 0.
import { chromium } from "playwright"
const who = process.argv[2] || "sdb"
const b = await chromium.launch()
for (const width of [390, 767, 1280]) {
  const p = await b.newPage({ viewport: { width, height: 900 } })
  await p.route("**/api/profile/me*", (r) => r.fulfill({ json: { user: { id: "qa" } } }))
  await p.route("**/api/profile/saved-wallets*", (r) => r.request().method() === "GET" ? r.fulfill({ json: { wallets: [] } }) : r.abort())
  await p.route("**/api/profile/followed-wallets*", (r) => r.request().method() === "GET" ? r.fulfill({ json: { authed: true, following: false, own: false } }) : r.abort())
  await p.route("**/api/profile/**", (r) => (r.request().method() === "GET" ? r.fallback() : r.abort()))
  await p.route("**/api/profile/resolve-and-associate*", (r) => r.abort())
  await p.goto("https://www.rippackscity.com/nba-top-shot/collection?wallet=" + encodeURIComponent(who), { waitUntil: "domcontentloaded", timeout: 60000 })
  const btn = p.getByRole("button", { name: "This is my collection", exact: true })
  await btn.waitFor({ timeout: 90000 })
  await btn.scrollIntoViewIfNeeded()
  await btn.click()
  const card = p.getByTestId("own-wallet-confirm")
  await card.waitFor()
  const box = await card.boundingBox()
  const search = await p.getByRole("button", { name: "Search", exact: true }).boundingBox()
  const follow = await p.getByRole("button", { name: /Follow/ }).last().boundingBox()
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  console.log(JSON.stringify({ width, card: box && { x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width) }, searchH: search && Math.round(search.height), searchY: search && Math.round(search.y), followY: follow && Math.round(follow.y), overflow }))
  await card.screenshot({ path: `/tmp/confirm-${width}.png` })
  await p.close()
}
await b.close()
