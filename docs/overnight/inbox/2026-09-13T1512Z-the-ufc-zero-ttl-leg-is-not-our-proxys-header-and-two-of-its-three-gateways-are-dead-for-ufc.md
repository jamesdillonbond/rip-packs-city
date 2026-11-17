# The UFC "zero edge caching" leg is NOT our proxy's header — and two of its three gateways are dead for UFC

**Filed:** 2026-09-13 ~08:12 PT (Claude Code, cloud) · **READ-ONLY — nothing shipped, and nothing here should be shipped without the one production probe named at the end.**

Answers the named next step the 09-13 Cowork close-out attached to its parked UFC item: *"check whether the proxy sets that header itself before assuming ipfs.io does."*

## 1 · It does not. Our proxy has exactly one `Cache-Control`, and no per-collection branch at all

`app/api/public/ipfs-media/[cid]/route.ts` sets **one** header, on its success path:

```
Cache-Control: public, max-age=86400, s-maxage=31536000, immutable
```

`max-age=0` and `must-revalidate` appear **nowhere in the file**, and the route keys on the **CID** — it races a fixed gateway list and knows nothing about which collection asked. ⛔ **So the asymmetry the close-out described — Dapper CIDs `immutable`, ipfs.io CIDs `max-age=0` — cannot be a policy of ours, because there is no branch that could express it.**

⚠ **And `public, max-age=0, must-revalidate` is the Next image optimizer's own header SHAPE** (`public, max-age=<computed>, must-revalidate`), so that reading came off the `/_next/image` leg rather than off the proxy. ⭐ **The close-out's own Pinnacle row is the control**: upstream `public` with no `max-age` → **4 h**, the `minimumCacheTTL` floor. A *successful* optimize lands on the floor, never on 0. **A computed 0 therefore means the optimizer produced no cacheable derivative for that input — not that the upstream declared no caching.**

👉 So the correct question is not "who set `max-age=0`" but **"what did our proxy answer for that CID at that moment"**, and every non-200 path in the route returns `new NextResponse(null, { status })` with no headers of its own.

## 2 · Which gateway actually serves UFC art, measured today

All **518** UFC Strike editions address their art as `https://ipfs.io/ipfs/<cid>` (518 of 518 rows, 0 on `ipfs.dapperlabs.com`), so this proxy is the whole collection's art path. Two CIDs sampled with `abs(hashtext(...)) % 97` (not a `LIMIT` off physical order), each gateway probed with `Range: bytes=0-0` from the **database's** egress via `net.http_get`:

| gateway (in `GATEWAYS` order) | status | body |
|---|---|---|
| `ipfs.dapperlabs.com` | **403** ×2 | *"The owner of this gateway does not have this content pinned to their Pinata account"* |
| `gateway.pinata.cloud` | **206 image/png** ×2 | real bytes |
| `ipfs.io` | **429** ×2 | ⭐ *"This IPFS gateway is switching to a service worker gateway only. See https://gatewaychanges.ipfs.io …"* |

⭐ **The ipfs.io reading is new information and it is not a rate limit.** That 429 is a **retirement notice** for path-based recursive serving — which supersedes this route's own header note (*"ipfs.io — no response at all, 25 s, from two different networks"*, 2026-08-24). It answers, badly, rather than not at all.

⭐ **So the fan-out has exactly ONE working leg for this collection, and it is the third entry — the one the route's header says "was passed over for being slower than Dapper, on a sample where Dapper could not lose."** That comment is now load-bearing in a way it did not claim to be: for UFC, `gateway.pinata.cloud` is not a fallback, it is the only source.

⚠ **This REFUTES the hypothesis I formed from the code read** (that all gateways refuse UFC, so the 518 render no art and cost nothing). One of three serves them. Recorded because the wrong version was one probe away from being filed as a finding.

## 3 · What is still not established, and the single probe that settles it

⚠ **`net.http_get` runs from Supabase's egress IP, not Vercel's, and a 403/429 on a public gateway is IP- and account-reputation-dependent.** This is a datacenter sample; it is **not** a measurement of what production's fetch gets.

**The discriminating probe — one request, needs egress this sandbox does not have** (policy-denied to `www.rippackscity.com`, `ipfs.io` and `assets.nbatopshot.com` alike, so curl here reads `000` for live and dead art identically):

```
GET https://www.rippackscity.com/api/public/ipfs-media/<any UFC cid>   → read the STATUS and Cache-Control
```

- **200 + the immutable header** → cards render, the `max-age=0` was an optimizer error path or the >8 MB redirect branch, and the honest finding is **redundancy**: two of three legs are dead for UFC and nothing watches that.
- **Non-200** (the route passes through the first non-401/403 answer, so most likely **429**) → **no UFC Strike OG art is rendering at all**, which is a content defect rather than a bill one, and the fix is a gateway that has the CIDs — not a TTL.

## 4 · What NOT to do with this

⛔ **Do not add a `minimumCacheTTL` or a header tweak for UFC on the strength of the close-out's table.** At 16 transformations in the closed cycle it is still a **$0** problem either way, and if §3 comes back non-200 the TTL change would be tuning the cache of a response that has no bytes in it.

⛔ **Do not drop `ipfs.io` from `GATEWAYS` yet either.** It is the only leg with a published deprecation path, but each entry is an SSRF-relevant constant paired with a `proxy.ts` CSP `img-src`/`media-src` allowance, and a UFC market that has been closed since 2026-05-13 does not earn a rushed edit to a shared art path.

---

## ✅ ANSWERED THE SAME DAY — and the answer is BOTH branches, which is why it mattered

**Appended 2026-09-13 ~08:5x PT.** The filing above named one probe as the thing that would settle it and said this sandbox could not run it. ⭐ **It could — through the DATABASE's egress** (`net.http_get` against our own domain), which is the same instrument the filing used for the gateways and which I did not think to point at our own route. *The missing measurement was one line away from the one I had already taken.*

**Three fresh UFC CIDs through `/api/public/ipfs-media/`, production:**

| probe | status | `Cache-Control` | `x-vercel-cache` |
|---|---|---|---|
| CID A | **200** | `public, max-age=86400, immutable` | MISS (a real origin fetch) |
| CID A, repeated | **200** | same | **HIT** |
| CID B | **200** | same | MISS |
| CID C | **429** | ⭐ **`public, max-age=0, must-revalidate`** | MISS |
| `/_next/image` over CID A | **200** | `public, max-age=86400, immutable` | MISS |

⭐ **So the "zero edge caching" reading is REFUTED and REPRODUCED at the same time.** The edge caches UFC art for 24 h (MISS→HIT on the same url), and `max-age=0, must-revalidate` is exactly what the route's FAILURE path returns — the framework default on a response that sets no header of its own. **It was never a caching policy; it was a failure, rendered.** The gateway sample explains the failure: of the three legs, dapperlabs 403s these CIDs and ipfs.io now answers a **retirement notice**, so every UFC render depends on `gateway.pinata.cloud` alone, and a public gateway rate-limits.

🚨 **AND THE ONE-LEVEL-UP DEFECT IS THE ONE WORTH HAVING FOUND.** Every OG card ships `s-maxage=3600, stale-while-revalidate=86400`, so a card that loses its art to a 429 is **published blank and served blank for up to 25 hours** — on the surface where the cold fetch is usually the share that mattered. ✅ **Fixed and shipped the same session:** `ogCacheHeaders(degraded)` caches an art-less-but-wanted card for **60 s with no `stale-while-revalidate`**. Register **#106**.

⚠ **Two corrections to my own text above, in place rather than by re-filing:**

1. *"Do not act on this yet"* was right about the TTL and wrong about the item — there WAS something to act on, one level up from where both of us were looking.
2. The hypothesis I recorded as refuted (*"every gateway refuses UFC, so the 518 render nothing"*) was refuted correctly, but the sampling that refuted it was **2 CIDs**. At 3 CIDs one failed. **The honest shape is intermittent, not binary** — and an intermittent art failure is precisely the kind the long cache made permanent.
