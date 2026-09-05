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

## 5c. ADDENDUM 2 — the shim was PROBED LOCALLY against a real Flow read, with a matched control. It works.

⛔ **Still nothing shipped.** But §5's *"wants a probe first"* has now had its cheap half done, so whoever picks this up starts from evidence rather than from a plan.

**Method:** inject a native-`fetch` shim into `require.cache` for `cross-fetch` **before** `@onflow/fcl` loads, wrap `url.parse` with a counter, then perform a **real Flow mainnet read** (`fcl.send([fcl.getBlock(true)])`).

| run | Flow read | `url.parse` calls | DEP0169 |
|---|---|---:|---|
| **shim injected** | ✅ **OK** — sealed block **163,559,995** | **0** | **none** |
| **control, no shim** | ✅ OK — sealed block 163,560,008 | **2** | **emitted** |

⭐ **The control is what makes the zero mean anything.** Without it, "0 `url.parse` calls" is equally consistent with a counter that never worked — the null-result trap this repo has recorded more than once. The control fires the warning and counts 2, so the instrument demonstrably sees the difference.

⚠ **One honesty note on the control:** it still logs `cross-fetch entries shimmed: 1`, because it was derived from the probe by emptying the injection loop while leaving the log line alone. **That line is wrong in the control run** — what proves the control was genuinely unshimmed is DEP0169 firing and the 2 counted calls, not the log.

**The shim under test, in full** — this is the whole contract from §5b:

```js
const fetchImpl = function (url, options) {
  if (typeof url === "string" && /^\/\//.test(url)) url = "https:" + url; // schemaless parity
  return globalThis.fetch.call(this, url, options);
};
fetchImpl.ponyfill = true;
const mod = fetchImpl;
mod.fetch = fetchImpl;
mod.Headers = globalThis.Headers;
mod.Request = globalThis.Request;
mod.Response = globalThis.Response;
mod.default = fetchImpl;
```

### ⛔ What this does NOT establish

1. **It is a LOCAL Node 24 run, not the Vercel runtime.** The bundler resolves `cross-fetch` at build time; a `require.cache` injection is not what a webpack/turbopack alias does, and only a **preview deploy** proves the alias resolves the same way.
2. **One read path, not all of them.** `getBlock` is a plain GET. It does not exercise script execution with a body, redirects, streaming, or error paths — and node-fetch v2 and undici differ exactly there.
3. **It says nothing about `@onflow/fcl-wc`'s `cross-fetch@3.2.0`**, which resolves separately; only one entry was shimmable from this process.

👉 **So the remaining work is a preview deploy with the alias configured, exercising a Cadence script execution (POST with a body) rather than a block read.** That is a bounded, well-specified task now, which is the whole point of doing the cheap half first.

## 5d. How to run the remaining probe WITHOUT a branch and without touching production

⚠ Worth stating because the obvious reading of *"preview deploy"* collides with a non-negotiable rule — **never create a feature branch** — and a config change committed to `main` auto-deploys to **production**, which is exactly what must not happen for an SDK transport swap.

👉 **The Vercel CLI is installed on Trevor's box** (the session-start hook claiming otherwise is stale — verified 2026-09-05). `vercel deploy` builds the **current working directory**, so the probe runs off a **dirty tree** with nothing committed:

1. add the `cross-fetch` → native-shim alias to the Next config **locally, uncommitted**;
2. `vercel deploy` (no `--prod`) → a preview URL, production untouched;
3. hit a route that performs a **Cadence script execution** (a POST with a body — *not* a block read, which §5c already covered);
4. confirm the script round-trips **and** that DEP0169 stops appearing for that deployment;
5. `git checkout` the config change away.

**No branch, no PR, no production deploy, nothing committed until it is proven.**

⛔ **Keep it read-only.** Exercise a *script execution*, never a transaction — the Cadence service payer wallet is off-limits, and a transport swap is precisely the change you would not want to first exercise against a signing path.

ⓘ **Not done here on purpose.** §5 of this filing says this belongs to a deliberate session rather than the end of a long one, and that judgment was written before the shim probe made the idea attractive. Recording the recipe so the next session starts at step 1 instead of re-deriving whether a probe is even reachable.

## 6. Falsifiers

1. Re-run the patch probe (`url.parse` wrapper + an fcl network call). If the stack no longer shows `node-fetch`, the chain changed.
2. `npm ls node-fetch` — if it ever appears as a direct dependency, §2's conclusion is stale.
3. If DEP0169 events appear on a route with **no** outbound HTTP at all, the on-USE model in §1 is wrong.

⚠ Dated samples. Re-derive before quoting.
