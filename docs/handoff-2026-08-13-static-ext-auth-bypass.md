# The auth wall does not stand for a static-extension suffix (2026-08-13)

> ⛔ **SEVERITY CORRECTED 2026-08-15 — READ THIS BEFORE THE BODY.** The heading below said
> "**LIVE AUTH BYPASS**" and "**Severity: live on production**". The *bypass* is real and confirmed
> (`/api/mcp/keys/<uuid>` → 307, `…<uuid>.png` → **405**, a status the wall cannot produce). The
> *severity* is not: this is **defense-in-depth, with no confirmed data exposure**. Every
> "reproduce" block below reproduces **without the vulnerability**, because the pages it reaches
> are public by design. See `docs/overnight/inbox/2026-08-15T1838Z-static-ext-bypass-is-real-but-its-headline-proof-is-not.md`
> for the control tests. Kept unedited below as the incident record.

**Severity as originally filed (OVERSTATED — see above): live on production, anonymous, no
credentials, trivially reproducible.**
Found while auditing the latent `STATIC_EXT_RX` exposure that `6eb7b0e5` correctly declined to
widen. It is not latent. It is exploitable now.

> ✅ **CLOSED 2026-08-15 — the fix is on `main`.** This document is kept as the incident record;
> the canonical account is the `2026-08-15` ledger entry. Read the rest in the past tense.
>
> ⚠ **It sat here for two days, and that is the transferable part.** The patch below was correct
> and complete on 2026-08-13, but `*.patch` is gitignored, so the only trace in `git status` was
> two stray untracked `.md` files — and all three documents describe the fix in a tone that reads
> as *done*. **A fix that cannot be pushed is not a fix.** When a session ends unable to push a
> SECURITY change, the status belongs where someone will trip over it (the ledger, `CLAUDE.md`),
> not only in a handoff that has to be found first.
>
> ⚠ Re-verified live on 2026-08-15 before shipping — the wall was still bypassed. My own first
> "second confirmed path" (`/profile/edit` → 307 vs `/profile/edit.css` → 200, 29,789 B) was
> **WRONG in the identical way**: that path routes to the public `/profile/[username]`, and the
> no-bypass control `/profile/zzz-no-such-user-9931` returns *more* bytes. **The missing step, both
> times, was one request without the vulnerability.**

**Status (2026-08-13, historical):** patch ready and verified, NOT pushed (cloud proxy 403 +
device shell down). Applies cleanly to a fresh clone of `main`.

---

## Reproduce

```
GET https://www.rippackscity.com/topshot      → redirects to /login   (gated, correct)
GET https://www.rippackscity.com/topshot.png  → 200, the full page    (bypass)
```

Confirmed by anonymous fetch on **2026-08-13**. `/topshot.png` returned the real gated surface —
heading **"NBA Top Shot — Overview"**, live 24h sales volume, FMV, marketplace asks, badge intel.
This is a read of a gated product surface by an unauthenticated visitor.

## Mechanism

Three things compose, none of which is wrong alone:

1. **`proxy.ts:47` was an unanchored suffix test** — `/\.(?:png|jpe?g|svg|webp|ico|css|js)$/i`,
   applied to the whole pathname. Any path ending in one of those extensions is public.
2. **Next matches a dynamic segment regardless of dots.** `/topshot.png` routes to
   `app/(collections)/[collection]` with `collection = "topshot.png"`.
3. **The resolver tolerates the suffix** and renders the page anyway. This is the ingredient I
   initially assumed was absent — I expected a failed lookup and a 404. Production says otherwise.

`6eb7b0e5`'s comment already identified (1) as a property of the existing entries and consciously
declined to widen the class. That judgement was right. What it did not do — reasonably, it was
fixing fonts — was check whether the property was already being exercised. It was.

## Blast radius (measured, not estimated)

Exercised `isPublicPath` directly by bundling `proxy.ts` with its runtime deps stubbed — it is a
pure `(pathname, method)` predicate, so this is the real function, not a reimplementation.

**411 gated route/method/extension combinations flip from gated to public.** Every leaf dynamic
route is affected. The ones that matter most:

| route | notes |
|---|---|
| `/[collection]` and all nested collection pages | the confirmed live exposure |
| `/analytics/wallets/[address]` | per-wallet holdings + analytics |
| `/analytics/sets/[set_id]`, `/analytics/sales/[collection]`, `/analytics/loans/[collection]` | gated analytics |
| `/api/mcp/keys/[keyId]` | **API key management**, GET/POST/DELETE |
| `/api/analytics/*` | gated JSON |
| `/edition/[id]`, `/share/[wallet]` | |

⚠ **Scope limit — what I did NOT test.** I verified the *predicate* flips for all 411, and
verified *end-to-end anonymous data return* for exactly one (`/topshot.png`). The others require
the handler to tolerate a suffixed identifier the way the collection resolver does; for
UUID/address lookups it will usually 404. **Do not read 411 as 411 confirmed data leaks — read it
as 411 places the auth wall does not stand, one of which is confirmed to leak.** `/api/mcp/keys`
is the one I would re-check by hand first.

## The fix

`STATIC_EXT_RX` → **`STATIC_ROOT_ASSETS`, an exact `Set` of the seven real root assets.**

⛔ **Anchoring the regex to a single root segment is NOT sufficient, and I tried that first.**
`/^\/[^/]+\.(?:png|…)$/` closes 384 of the 411 — but the collection pages live at the URL **root**,
the same namespace as the root static assets, so `/topshot.png` still matches it. The one case
confirmed live survives the obvious fix. Nothing about the *shape* of the path distinguishes an
asset from a collection slug, so only an exact allowlist separates them. The patch comment says
this so the next person doesn't re-derive the weaker fix.

`/_next/*` is already returned public by the line above the test, and fonts keep their own
directory-scoped `FONT_ASSET_RX`, so neither is affected.

**Cost:** a new file dropped into `public/` root is gated until added to the set. Correct trade for
a namespace shared with a dynamic route — new assets should go under `/img/`, which the matcher
already excludes from the proxy entirely.

## Verification

Differential over both bundles (before vs after), same corpus:

| check | result |
|---|---|
| bypass paths closed | **411** |
| bypass paths still open | **none** |
| real static assets regressed to gated | **none** |
| legitimately-public sitemap paths broken | **none** |

Spot check, before → after: `/topshot.png` true→false · `/analytics/wallets/0xabc123.png`
true→false · `/api/mcp/keys/<uuid>.png` true→false · `/rip-packs-city-logo.png` true→**true** ·
`/fonts/Anton-Regular.ttf` true→**true** · `/_next/static/chunks/main.js` true→**true**.

⚠ **One instrument error caught mid-audit, recorded because it nearly became the finding.** My
first sweep substituted a placeholder (`probe`) for every dynamic param. That produces paths that
don't match allowlist branches keyed on real ID shapes, so routes looked *gated* when their real
form is *public* — `/sitemap/probe` reads gated while `/sitemap/5.xml` is legitimately public.
Re-running with realistic values (`/topshot`, a real-shaped wallet, a real-shaped UUID) is what
made the result trustworthy. The bypass survived that correction; the sitemap "finding" did not.

## Tests

`__tests__/proxy-is-public-path.test.ts` gains a `describe` block: seven gated paths × eight
extensions × both cases, each with a positive control asserting the bare path is gated first, plus
eight rows asserting real assets stay public. **These rows fail against the anchored-regex fix as
well as against the original** — that is deliberate, so the weaker fix can't pass.

## Revert

`git revert <sha>`. No DB, no migration, no deploy coupling. Reverting restores the bypass — if
something breaks, prefer adding the missing path to `STATIC_ROOT_ASSETS` over reverting.

## Ordering

Ledger entry before code, per CLAUDE.md. Paste-ready entry delivered alongside this doc.
