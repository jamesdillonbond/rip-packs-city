# Information architecture — one home for every feature (2026-11-06)

**Trevor, 8:01 PM PT:** "The homepage/dashboard is very cluttered with random stuff everywhere. We need to have a more cohesive, organized strategy to home all our features."

This is the strategy. It is deliberately small: **three homes, one job each; one feature taxonomy that every navigation draws from; nothing new built.** Every surface we have today keeps its URL — this moves *entry points*, not pages, so SEO is untouched and every phase is revertible by itself.

---

## 1. Diagnosis (measured, not felt)

| where | what a visitor sees | the problem |
|---|---|---|
| **Global header** | one link per collection (7) + Blog · Analytics · My Teams · Alerts | Collections are *scopes*, not features. Nothing says Market, Packs, Trades, Insights, Collectors. |
| **Mobile bar** | Home · Market · Sniper · My Binder | A *different* four. "My Binder" is not a word used anywhere else. |
| **Dashboard header** | Sniper · Pack History · History · Alerts · Email settings · Edit profile | A *third* nav: two site features (Sniper, Alerts) mixed with four personal pages. |
| **Dashboard body** | public-profile share card → Trophy Case → 3 stat tiles → "Set up alerts" card → "Trade Moments" card → trade-in link → More trophy cases → Saved wallets (+ Panini username) → Favorite collections → Friend activity | **Eleven sections in the order they were built.** Two promo cards in the middle of personal data. The thing it is *for* (what do I own, what is it worth) is the fourth section. |
| **Homepage** | hero → 7 collections → "Things Top Shot won't tell you" → Fast Break → two pitches → Trophy case → signup → "Find your edge" | Eight pitches, no map. A visitor cannot find Trades, Packs, Players, Teams or the 36 insights boards from it. |
| **Reachable from NO nav** | `/trades`, `/trades/block`, `/teams`, `/players`, `/trophy-challenges`, `/market`, pack EV, sets, badges, challenges, hot floors, offers, special serials, rewards, help, 36 of 37 insights boards | ~45 surfaces; most are only found by URL or by a link buried inside another page. |

The cause is not any one decision. Each feature shipped with its own entry point where it was convenient that day, and nothing ever assigned it a *home*.

---

## 2. The model: three homes, one job each

### Home 1 — **Homepage** (`/`, signed out): *"What is this, and where do I start?"*
One promise, the wallet/username search, then **the four pillars as four doors** (below), then proof (live numbers, a real trophy case), then the signup. Not a feature catalogue; the pillars are the catalogue. Everything currently pitched on the homepage (Fast Break, "Things Top Shot won't tell you", trophy case) lives *inside* a pillar, not beside it.

### Home 2 — **Global navigation** (header + mobile bar + footer): *"Take me to the feature."*
Features grouped by the collector's **job**, not by collection and not by when we built them. The same five groups, in the same order, in all three places — the mobile bar shows the first four plus "Me".

| group | job | what lives there (every existing URL, nothing new) |
|---|---|---|
| **Market** | *what is it worth, what should I buy* | `/market` · Sniper (`/<c>/sniper`) · Hot floors · Offers / offer spread · Underpriced serials · Serial premiums · Top sales · Market pulse · Market cap |
| **Packs** | *should I rip, what did I pull* | Pack EV (`/<c>/packs`) · Pack Sniper · Pack drops · Pack reality · Pack market (TS / AD) · Chase left · `/dashboard/packs` (your pack history) |
| **Insights** | *what is happening that the marketplaces won't tell me* | `/insights` as the index, boards grouped under the headings above (squeeze, scarcity, rookies, first mint, set completers, autographs, parallels, account value, new collectors, trade-in, trophies, TC report) |
| **Collectors** | *people, teams, players, challenges* | `/players` · `/teams` (franchise hubs) · `/my-teams` · `/trophy-challenges` · public profiles · special-serial owners · Fast Break |
| **Trade** | *swap, post, trade in* | `/trades` (room) · `/trades/block` · Top Shot This trade-in finder |
| **Me** (avatar) | *my collection* | Dashboard and its tabs (below) · Alerts · Email settings · Edit profile · Help |

Per-collection pages keep the shared `[collection]` tab bar exactly as it is — that bar is the *scope* switch, the header is the *job* switch. Collections move from the header to a **collection switcher** (the existing `CollectionSwitcher` pattern) that persists the choice, so "Top Shot / All Day / …" is one control, not seven links.

### Home 3 — **Dashboard** (`/dashboard`, signed in): *"My collection — what I own, what it's worth, what I'm showing off."*
Five tabs, personal data only. Anything that is a *site feature* leaves (it has a home in the header now); anything that is a *setting* goes to Settings.

| tab | contents (today's sections, re-homed) | leaves the page |
|---|---|---|
| **Overview** (default) | stat tiles **first** (moments · FMV · collections) → Saved wallets + Panini username → Favorite collections as a compact chip row → Friend activity | the "Set up alerts" and "Trade Moments" promo cards (→ header: Me › Alerts, Trade); the trade-in link (→ a one-line "Top Shot This trade-in value" inside the stats) |
| **Trophy Cases** | main case (sort / arrange / captions) → challenge entries → extra cases → public-profile share card (the share belongs *with* the thing being shared) | — |
| **Packs** | today's `/dashboard/packs` | — |
| **History** | today's `/dashboard/history` | — |
| **Settings** | Favorite collections · Email settings (`/dashboard/notifications`) · Edit profile · Saved-wallet management | — |

The dashboard header's six links collapse to the five tabs; Sniper and Alerts stop being dashboard links because the header owns them.

---

## 3. Rules that keep it from re-cluttering

1. **A new feature ships with a home assigned** — one of the five groups, or one dashboard tab — in the same commit, or it does not ship. The registry below is the source: `lib/ia.ts` exports the five groups and every surface's membership; header, mobile bar, footer and `/insights` index all render from it (one registry, three renderers — no hand-curated link lists to drift, per the standing allowlist-vs-registry rule).
2. **Promo cards do not live on the dashboard.** A collector who is signed in is not a prospect. Feature discovery is the header's job.
3. **The homepage pitches pillars, not features.** New features earn a line inside a pillar's door, not a new homepage section.
4. **Each nav shows the same groups in the same order.** Mobile shows fewer, never different ones.
5. **No collection in the global header.** Collection is a scope the switcher holds; it is never a destination of its own.

---

## 4. Phases — each shippable and revertible alone

| phase | what | risk | needs Trevor |
|---|---|---|---|
| **P1 — Dashboard tabs** | Five tabs on `/dashboard`; sections re-homed per §2; promo cards removed; `data-tour-anchor`s kept so the first-run tour still lands; mobile 390 px sweep + e2e | low — one client file, no URL change | the two forks below, then no |
| **P2 — `lib/ia.ts` + header/mobile/footer** | The registry; the five groups rendered in all three navs; collection switcher replaces the seven links; `/insights` index grouped from the same registry | medium — the header is on every page; nav links feed SEO internal linking (keep every current destination reachable within one click; run the sitemap/links guard) | yes — sign off on group names and order |
| **P3 — Homepage** | Four pillar doors replace the eight pitches; proof + signup stay | medium — the h1/SEO copy and the OG card stay; it is the section order and the doors that change | yes — copy |

P1 can start tonight. P2 and P3 are a daytime job each, verified in Trevor's Chrome.

---

## 5. The two forks that are Trevor's

1. **Group names.** `Market · Packs · Insights · Collectors · Trade · Me` is the recommendation. The live alternative is folding Trade into Market (five groups, Trade as a Market sub-item) — cleaner header, but Trade is the one *transactional* thing on a read-only site and arguably earns its own door.
2. **Collections out of the header.** Recommended (they become the switcher). The alternative keeps a slim collections row *under* the header on collection pages only. SEO-neutral either way (collection hubs stay linked from the switcher, footer and homepage doors).

Everything else here is a default I will take unless told otherwise.

---

*Revert for any phase: `git revert` its commit — no DB half in any of them.*
