# 🚨 DEP0169 root-caused at last: it is `node-fetch` via `cross-fetch`, NOT the Flow SDK — and it fires on USE, not on import

**Filed 2026-09-05 10:46 PT (17:46Z), Claude Code (Trevor's box, interactive). MEASUREMENT ONLY — nothing shipped.**

This repo's record has described the platform's **#1 runtime-error group** as *"something in that chain calls the deprecated `url.parse()`"* since it was first ranked. It is now named exactly, by the diagnostic the warning itself recommends and that nobody had run.

---

## 1. The measurement

```
node --trace-deprecation  →  importing @onflow/fcl alone emits NOTHING
```

⭐ **That negative result is the important one**, because it refutes the model everyone (me included) had been using. Patching `url.parse` to print its own caller gives the answer on the first request:

```
at parseURL     node_modules/node-fetch/lib/index.js:1168
at new Request  node_modules/node-fetch/lib/index.js:1210
at fetch        node_modules/node-fetch/lib/index.js:1447
(node:5604) [DEP0169] DeprecationWarning: `url.parse()` …
```

**`node-fetch@2.7.0` calls `url.parse()` on EVERY request. Node emits the deprecation on the first one per process.**

## 2. The chain, and what it is not

```
@onflow/fcl@1.21.9 ──→ cross-fetch@4.1.0 ──→ node-fetch@2.7.0     ← the runtime path
@onflow/fcl → @onflow/fcl-wc → @walletconnect/… → cross-fetch@3.2.0 → (deduped)
@sentry/nextjs → @sentry/bundler-plugin-core → @sentry/cli → (deduped)  ← BUILD-time only
```

⛔ **`node-fetch` is not a direct dependency** — nothing in `package.json` asks for it, and there are no `overrides`. ⛔ **And it is not "the Flow SDK calling `url.parse`"**: fcl calls `fetch`, `cross-fetch` polyfills that to `node-fetch` on Node, and `node-fetch` v2 is what reaches for the legacy API.

⚠ **`engines.node` is `24.x`, where native `fetch` has existed since 18** — so the polyfill is redundant at runtime. That is upstream's packaging choice, not ours.

## 3. What this corrects, and what it confirms

| earlier claim | status |
|---|---|
| *"every cold start of a route importing fcl logs one"* | ⚠ **Wrong mechanism.** It fires on the first `node-fetch` REQUEST, not on import — a route that imports fcl and never calls out stays silent. |
| *"the group's `routes` field lists exactly the two importers"* | ⛔ Already corrected earlier today; an 8-hour window now lists **eight** routes. ⚠ Still not authoritative — that field is documented as SMEARED. |
| the `ufc-enrichment-drain` fix | ✅ **Confirmed, and now for the right reason.** It stopped loading fcl at all, so it never reaches `node-fetch`. Zero events for that route across three confirmed post-deploy executions. |

## 4. Why it still matters

Over an 8 h ISO window it is **112 events of ~190 — 59% of the entire runtime-error surface** — and it is a **warning, not a failure**. The cost is signal: the surface an operator reads to answer *"why is production erroring"* is still mostly this. That was the whole point of the earlier fix, and removing one route removed one route's share.

## 5. The options, with the risk that makes this Trevor's call

⛔ **Nothing shipped, deliberately.** Every remedy touches the network layer of a load-bearing SDK:

1. **npm `overrides` to force `node-fetch@3`** — v3 uses the WHATWG URL API. ⚠ It is **ESM-only**, and `cross-fetch@4` expects the CJS v2. Likely breaks the SDK outright.
2. **Alias `cross-fetch` → a native-`fetch` shim** in the Next build. Plausible on Node 24, and the most surgical. ⚠ It silently changes what every Flow call uses for transport — the failure mode would be *Flow requests behaving differently*, not a build error.
3. **`NODE_OPTIONS=--no-deprecation`** — ⛔ hides **all** deprecations including future real ones. Trades a known noise for an unknown blindness.
4. **Accept it** and treat DEP0169 as a known constant when reading the error surface. Zero risk, zero benefit.

👉 **My read: (2) is the only one with a real payoff, and it is not worth doing blind.** It wants a probe first — alias it in a preview deploy and confirm a Flow script round-trips — which is exactly the kind of thing to do deliberately rather than at the end of a long session.

## 5b. ADDENDUM — the cheap option is foreclosed, and the expensive one is smaller than it looked

Two follow-up checks, both changing the decision.

### ⛔ A version bump does NOT fix it

`@onflow/fcl` installed **1.21.9**, latest **1.21.11**, and **the latest still declares `cross-fetch: ^4.0.0`**. There is **no 2.x line** — the published versions end at 1.21.11. **So "just upgrade the SDK" is not available**, and anyone who reaches for it first (as I would have) should stop here.

### ⭐ `cross-fetch` never checks for native `fetch` — and its whole surface is 15 lines

`cross-fetch@4.1.0`'s node entry (`dist/node-ponyfill.js`) opens with an **unconditional** require:

```js
const nodeFetch = require('node-fetch')
const realFetch = nodeFetch.default || nodeFetch
const fetch = function (url, options) {
  if (/^\/\//.test(url)) { url = 'https:' + url }   // schemaless-URI parity with the browser
  return realFetch.call(this, url, options)
}
module.exports = exports = fetch
exports.fetch = fetch
exports.Headers = nodeFetch.Headers
exports.Request = nodeFetch.Request
exports.Response = nodeFetch.Response
```

**There is no native-fetch branch.** On `engines.node = 24.x`, where `fetch` has been global since 18, every Flow call still goes through node-fetch v2 purely because this file says so.

👉 **This makes option (2) much more tractable than §5 implied.** A replacement shim has an **enumerable** contract — it must preserve exactly four things:

1. the **schemaless-URI rewrite** (`//host` → `https://host`) — the one behaviour cross-fetch adds;
2. `Headers`, `Request`, `Response` as named exports;
3. both the **default** export and the `.fetch` named export (callers use both shapes);
4. `this`-binding on the call (`realFetch.call(this, …)`).

⚠ **It is still not a blind swap.** Native `fetch` (undici) and node-fetch v2 differ in real ways — error types, redirect and body-stream semantics, header casing — and this sits under **every Flow read on the platform**. The probe from §5 stands: alias it in a **preview deploy** and confirm a Flow script round-trips before it goes near production. **What changed is that the shim is now a known 15-line contract rather than a leap.**

## 6. Falsifiers

1. Re-run the patch probe (`url.parse` wrapper + an fcl network call). If the stack no longer shows `node-fetch`, the chain changed.
2. `npm ls node-fetch` — if it ever appears as a direct dependency, §2's conclusion is stale.
3. If DEP0169 events appear on a route with **no** outbound HTTP at all, the on-USE model in §1 is wrong.

⚠ Dated samples. Re-derive before quoting.
