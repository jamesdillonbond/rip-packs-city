# The static-extension bypass is REAL — but the proof it ships with is not, and the control test settles it

Filed 2026-08-15 11:38 PT (18:38Z), Claude Code interactive, from Trevor's Windows box.
**Read this before committing `proxy.ts`'s new `STATIC_ROOT_ASSETS` comment, the test-file
comment, `docs/handoff-2026-08-13-static-ext-auth-bypass.md`, or the paste-ready ledger entry —
all four currently assert a severity that measurement disproves.**

Nothing here disputes the FIX. Ship it. This is about what the record will claim.

---

## TL;DR

| claim | verdict |
|---|---|
| The auth wall does not stand for paths ending in a static extension | ✅ **CONFIRMED**, by evidence independent of the collection pages |
| "`GET /topshot.png` served the entire gated collection page to an anonymous visitor" | ⛔ **DISPROVED** — it reproduces with no vulnerability at all |
| "a read of a gated product surface by an unauthenticated visitor" | ⛔ **DISPROVED** — that surface is public by design |
| Any confirmed data exposure | ⛔ **NONE FOUND** on the three routes the handoff names |

**Class: defense-in-depth failure, not a live breach.** Still worth fixing — see "Why ship it anyway".

---

## What is actually true, and how it was proven

`/api/mcp/keys/<uuid>` — a genuinely gated route — behaves like this anonymously:

```
GET /api/mcp/keys/3f8b2c1a-…-444455556666       -> 307  Location: /login?next=…
GET /api/mcp/keys/3f8b2c1a-…-444455556666.png   -> 405  Method Not Allowed
```

**A 405 cannot come from the auth wall.** The wall's answer is the 307. So the suffixed request
was passed through to the route handler. That is the whole finding, and it stands on its own —
it involves no collection page and no assumption about what any page renders.

## What is not true, and why the original proof looked conclusive

The handoff's headline evidence was `/topshot.png` returning a page with heading
**"NBA Top Shot — Overview"** and live market data. That observation is CORRECT. The inference
drawn from it is not.

Measured live:

```
/topshot.png                 -> 307  Location: /topshot.png/overview        (15 B redirect)
/topshot.png/overview        -> 200  h1="NBA Top Shot — Overview"  26 $-figures   80,299 B
```

The bypass bought **the redirect**. The page came from the next hop — and that next hop is public
**by design**, at `proxy.ts:464`:

```ts
/^\/[^/]+\/overview$/.test(pathname)   // ── Public per-collection overview landing
```

That regex is deliberately `[^/]+`, i.e. **any** collection segment. So `/topshot.png/overview` is
public because of the overview rule, not because of `STATIC_EXT_RX`.

### The control test — this is the part that settles it

If the overview rule is doing the work, the demo must reproduce with the vulnerability removed
from the URL entirely. It does:

```
/topshot/overview              -> 200  h1="NBA Top Shot — Overview"  26 $-figures   80,263 B
/totally-bogus-slug/overview   -> 200  h1="NBA Top Shot — Overview"  26 $-figures   80,363 B
```

**No `.png`. No bypass. Identical page.** An unrecognised collection segment falls back to Top
Shot — the same fallback CLAUDE.md already documents for the `ufc` vs `ufc-strike` slug trap.

And the real surface was never gated to begin with:

```
/nba-top-shot/overview   -> 200 anonymous, 153,967 B, same h1, same 26 $-figures
/nba-top-shot            -> 307 -> /login          (only the BARE root is gated)
```

The collection read tabs were un-gated by the 2026-07-17 soft launch. So the bypass served
**strictly less** than what an anonymous visitor could already fetch legitimately (80 KB fallback
vs the 154 KB real page).

## The other two named routes: no exposure found

- `/analytics/wallets/0xbd94…` → 307 `/login`; **`…​.png` → 404.** Wall bypassed, handler rejects.
- `/api/mcp/keys/[keyId]` → the route exports **only `DELETE`**, and it calls `getCurrentUser()`
  itself (`app/api/mcp/keys/[keyId]/route.ts:16,41`). Hence the 405 on GET. It gates itself.

So of the three routes the handoff highlights as "the ones that matter most", none is
demonstrably exploitable. The handoff's own scope caveat was right and should be promoted to the
headline rather than left as a footnote: **411 is a predicate-level count, not 411 leaks.**

## Why ship it anyway

The wall should stand. Today every gated dynamic route that the suffix reaches happens to carry
its own auth check or reject the malformed param — that is luck plus good habits, not
architecture. The next gated `[param]` route added without an internal `getCurrentUser()` is
exposed the day it lands, and nothing would catch it. Fix + regression test are correct; only the
severity wording needs changing.

**Suggested framing for the record:** *"the auth wall does not stand for any path ending in a
static-asset extension — confirmed by a gated route answering 405 where its bare form answers 307.
No data exposure was confirmed on the routes checked; the collection-page 'leak' originally filed
as proof is served by the deliberate `/<collection>/overview` public rule and reproduces without
the bypass."*

## The method lesson, which is the transferable part

The original finding followed a redirect, saw a 200 with a big body and real market data, and read
it as the gated page. **The missing step was the control**: fetch the same thing without the
vulnerability. One request (`/topshot/overview`) would have shown the demo was independent of the
bypass.

This is the same shape the cloud session that filed it had itself written up hours earlier
("a non-empty result is not a correct result"), and the same shape as the `NEXTJS-1Z` double
attribution — **a real observation attached to the wrong mechanism.** It is also why
`proxy.ts:464` matters here: the page was public two rules above the one under suspicion, and
nobody read down.

⚠ Related, and NOT part of this finding — worth its own look: `/^\/[^/]+\/overview$/` accepts any
segment, so `/totally-bogus-slug/overview` renders a full Top Shot page at 200. That is a
duplicate-content / crawler surface (arbitrarily many URLs serving one page), not a security
issue. Deliberate or not, it is unbounded.

## Reproduce

PowerShell, no session, `-UseBasicParsing` (Git Bash `curl` fails silently here):

```powershell
Invoke-WebRequest 'https://www.rippackscity.com/topshot/overview' -UseBasicParsing
Invoke-WebRequest 'https://www.rippackscity.com/api/mcp/keys/3f8b2c1a-1111-4222-8333-444455556666.png' -UseBasicParsing
```
