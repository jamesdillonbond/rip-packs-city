# The driver-message leak has a SIXTH spelling, and both shared guards are blind to it by construction

> ## ✅ RESOLVED 2026-08-15 — swept the same session, in a second pass
>
> Every **user-reachable** site is fixed and the spelling is in the shared helper,
> so all three guards now catch it. **The user-reachable population is ZERO.**
> What is left (22 sites / 11 files) is operator-secret gated by the guard's own
> `isOperatorSurface` rule, where a driver message reaches someone holding the
> token — that is the documented, intended exclusion, not a backlog.
>
> **Four corrections to what this note originally said, each worth more than the fix:**
>
> 1. **The population was 35 sites / 20 files, not "~20 / ~15".** The first count
>    came from a shell grep with a narrower key list.
> 2. ⚠ **My first scanner reported WRONG LINE NUMBERS** — it stripped `//` lines
>    by *removing* them before splitting, so every offset shifted. I nearly
>    triaged against them; the tell was context that contained no leak at all.
>    **Blank comment lines, never delete them.**
> 3. **`stripe/webhook` was not covered by the operator rule** (it gates on a
>    Stripe signature, not a shared secret). Fixed the route rather than widening
>    `OPERATOR_SECRET_RE` — loosening an exclusion is the dangerous direction, and
>    the guard's own test says the exclusion is sound only while every excluded
>    route really requires a secret.
> 4. ⚠ **`/api/owned-flow-ids` is ANON-reachable** (`isPublicPath` → true) and was
>    publishing FCL/Cadence text to anonymous visitors. It is the sharpest site in
>    the batch, and the *anon* guard had been running green over it for exactly
>    the sibling-key reason described below.
>
> ⚠ **One existing test asserted the leak as the contract** —
> `api-rtr-lock-roi` pinned `body.detail === "wmc down"`. Repointed to assert the
> absence of the driver string plus the stable code. Same class as the 59 tests
> recorded in CLAUDE.md, two of them titled *"500s and surfaces the message"*.
>
> The triage in "Recommended fix" below was followed as written and all three
> traps in it were real. Kept for the reasoning.

**Filed 2026-08-15 23:41Z (16:41 PDT), Claude Code.** Found while fixing the
`/panini-blockchain/sniper` surface.

## The finding

`__tests__/helpers/driver-message-leak.ts` is the single source of truth for "what
does a published driver message look like". It enumerates **five** spellings, and
its own header records why it exists: the anon guard once shipped with four where
its predecessor had five, and the missing inline-ternary form was still live on 12
sites. The lesson written at the time was *"diff the new guard's PATTERN SET
against the old one's, not just its coverage."*

**Every one of those five is keyed on the `error:` field.** Excerpted:

```
/\b(?:error|details|message)\s*:\s*…\.message\b/      (1) direct
/\berror\s*:\s*String\(\s*(?:err|e|…)\b/              (2) stringified
/\berror\s*:\s*`[^`]*\$\{…\.message/                  (3) interpolated
/\berror\s*:\s*…\s+instanceof\s+Error\s*\?\s*…/       (4b) inline ternary
`\berror\s*:\s*(?:<collected vars>)\b`                (4) indirect
```

The sixth spelling puts the message in a **sibling key** while `error:` holds a
fixed, safe string:

```ts
const message = err instanceof Error ? err.message : "Unknown error"
return NextResponse.json(
  { error: "Failed to fetch listings", detail: message },   // ← leaks here
  { status: 502 }
)
```

Trace it against the patterns and every one misses:

- `direct` wants `error|details|message` followed by `<id>.message`. The key here
  is `detail` (**singular** — `details` is in the set, `detail` is not), and the
  value is a bare identifier, not `x.message`.
- The `indirect` scan *does* collect `message` as a leaking variable, but then
  builds `\berror\s*:\s*(?:message)\b` — and on this line `error:` is followed by
  a string literal. It looks in the right file, at the right line, for the right
  variable, in the wrong field.

So **both** `anon-api-no-driver-message-leak-guard` and
`authed-api-no-driver-message-leak-guard` run green over it. This is the same
shape as every other guard-scope finding in CLAUDE.md — *a mechanism's own
derivation decides what it is able to observe* — one level in from the usual
version: not "which files does it scan" but "which FIELD does it look at".

## Population (measured 2026-08-15, ~20 sites / ~15 files)

```
app/api/panini/listings/route.ts            ← FIXED
app/api/panini/market-stats/route.ts        ← FIXED
app/api/owned-flow-ids/route.ts
app/api/cost-basis-backfill/route.ts
app/api/cost-basis-gql-backfill/route.ts
app/api/ufc-wallet-scan/route.ts
app/api/wallet-preflight/route.ts
app/api/fast-break/{uses,lineup,today,optimize}/route.ts
app/api/rtr/lock-roi/route.ts
app/api/rtr/state/route.ts                  (×2)
app/api/pinnacle/resolve-buyers/route.ts    (`reason:`)
app/api/admin/backfill-topshot-onchain-art/route.ts   (`reason:`)
app/api/admin/drain-topshot-misattribution/route.ts
app/api/admin/discover-moment-descriptors/route.ts
app/api/smoke-test/route.ts                 (×3)
```

`reason:` and `hint:` are the same class under different names — enumerate the
key, not just the value.

## Recommended fix, and the three traps in it

1. **Add the spelling to `__tests__/helpers/driver-message-leak.ts`**, not to a
   new guard. That is the file's stated contract: "adding a spelling here widens
   every guard at once."

2. ⚠ **Triage the `/api/admin/**` and `/api/smoke-test` sites separately.** The
   authed guard already excludes operator-secret surfaces on the documented
   grounds that *the only routes where a driver message is acceptable are ones
   gated on a shared OPERATOR SECRET, where the reader is holding the token.*
   Several of the sites above are exactly that, so the sweep should shrink the
   list before touching code — and `smoke-test`'s `detail` is arguably its whole
   product.

3. ⚠ **Do NOT route these through `apiErrorResponse` mechanically.** Several
   deliberately return **502** to say the failure is UPSTREAM (OpenSea, Dapper
   GQL, Flow REST). `safeApiError` only knows Postgres and would classify them
   `internal` → **500**, losing the "did WE break?" signal. CLAUDE.md already
   records that exact 502→500 flattening as a regression caught by tests when
   this class was last swept mechanically. The minimal correct fix is to **drop
   the field and `console.log` the detail**, keeping the status.

4. ⚠ **`pinnacle/resolve-buyers` and `backfill-topshot-onchain-art` put the
   message inside a per-row `errors[]` array**, not the top-level body. Same leak,
   but a fix that only rewrites the top-level return will miss them.

## Why it was not swept here

The session that found it was fixing one page's honesty defects. A ~15-file
codemod on error-handling paths is the shape that has already produced two
recorded regressions in this repo (a 502 flattened to 500; a silently dropped
`rows: []`), and CLAUDE.md's rule for it is exact matches on `(file, line)`, never
a broad regex. It wants its own pass, with the triage in step 2 done first.

**Containment in the meantime:** the two panini routes are pinned by
`__tests__/api-panini-listings-honesty.test.ts`, which asserts the sibling-key
shape is absent from *both* files — a local guard, not a general one.
