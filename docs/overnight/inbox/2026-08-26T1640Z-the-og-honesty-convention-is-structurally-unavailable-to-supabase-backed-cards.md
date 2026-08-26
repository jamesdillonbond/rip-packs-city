# The OG honesty convention is structurally UNAVAILABLE to a supabase-backed card — and one card claims "Live" on a failed read because of it

**Filed 2026-08-26 (PT) by Claude Code.** ⭐ **The headline is mostly a NEGATIVE result,
and that is the useful part**: a sweep that looked like it had found 15 defects found ~1,
because the proxy I swept on is not the property.

---

## 1. ⛔ The sweep that mostly falsified itself

Starting from known-issues **#30**'s residual (*"the OG card renders a `Live deals` claim
with no age signal at all"*), I swept all 42 OG routes.

✅ **First, #30's residual is STALE and should be struck.** The Underpriced-#1s card was
fixed in **`d2101312`** — *"fix(og): the Underpriced #1s card must not claim 'Live deals'
over a frozen board"*. It now computes `boardMaxAgeHours(...)` → `boardLivenessLabel(...)`
and **renders it** (line 229), with the three-state handling explicit in the code:
*"null => age unknown => NO liveness claim at all."* Verified computed **and** rendered,
because a computed-but-dropped honesty signal would be its own defect.

⚠ **Then the proxy failed.** Sweeping for "reads data in a try/catch but uses neither
`boardEmptyCopy` nor a `fetched` flag" flags **15 insights cards**. On inspection almost
all of them are **fine**, because they guard at the RENDER site instead:

```jsx
{total > 0 ? `${total} drops scored` : "Public · No signup"}     // pack-drops
{ label: "Pack rips, 60d", value: rips > 0 ? fmtInt(rips) : "—" } // insights (root)
{editions ? `${editions} editions · …` : "<descriptive tagline>"} // panini-squeeze
```

A failed read leaves the counter at its initialiser, the `> 0` test fails, and the card
renders **an em-dash or a neutral description — not a measured zero.** ⭐ **So "does not
use the helper" is not the property; "publishes a number or a claim it did not measure"
is.** Recording this so the next sweep does not re-open 15 non-defects.

ⓘ The many `?? 0` hits in these files are also mostly benign: they are **per-row** display
defaults on rows that were successfully fetched (`Number(r.multiplier ?? 0).toFixed(1)`),
not counts synthesised from a failed read.

## 2. 🚨 The one real instance: `/api/og/insights/candy-mlb`

```ts
const { data } = await sb.from("candy_secondary_board").select("fmv_usd").limit(500)
if (Array.isArray(data) && data.length > 0) { total = …; priced = … }
} catch { /* generic card fallback */ }

const headline = priced != null && total != null && priced > 0
  ? `${priced} of ${total} ICON editions priced off live Solana sales`
  : "Live secondary FMV for the 2026 MLB Base Series"
```

**Two defects, and the second is the repo's named trap:**

1. **A failed read renders a LIVENESS claim.** There is no `fetched` flag, so the
   else-branch is reached identically by *"the board is empty"* and *"we could not read the
   board"* — and what it then asserts is **"Live secondary FMV"**. The sibling card was
   fixed for exactly this shape.
2. ⚠ **The `catch` is nearly dead code.** It destructures `{ data }` and **not `error`**.
   supabase-js **RESOLVES** with `{ data: null, error }` rather than throwing, so a failed
   read never reaches the catch at all — it falls past `Array.isArray(data)` and lands on
   the claim. This is CLAUDE.md's own rule (*"supabase-js RETURNS errors rather than
   throwing… `try-catch` does not help"*) in an OG card.

## 3. ⛔ Why I did NOT ship the fix — the convention cannot accept this card

I wrote the fix (add `fetched`, destructure `error`, use `boardEmptyCopy`) and **reverted
it**, because adopting the helper *enrols the card in a guard it cannot satisfy*.

`__tests__/api-og-insights-empty-vs-unavailable.test.ts` derives its population as
**"every card whose source contains `boardEmptyCopy(`"**, then asserts a shape:

```ts
expect(before).toMatch(/\? \([\s\S]{0,400}$/)          // empty copy is the FIRST ternary arm
expect(src.slice(call)).toMatch(/^[\s\S]{0,400}?\) : \(/) // …whose alternative renders ROWS
expect(src).toMatch(/if \(r\d?\.ok\) \{\n\s+fetched = true/) // fetched set inside a FETCH ok-branch
```

**All three assume a card that self-fetches its own API and renders a JSX rows list.**
`candy-mlb` is neither: it produces a **headline string**, and it reads `supabaseAdmin`
**directly and deliberately** — its own header explains why, and the reason is good:

> *"this surface is launch-gated in proxy.ts — a server-side fetch to its own origin goes
> back THROUGH the proxy and gets 302'd to /login while `CANDY_MLB_PUBLIC` is false, so a
> self-fetching card would silently render the fallback headline for the whole staging
> period and then quietly start working at go-live."*

There is no `r.ok` to put `fetched = true` inside, and no `) : (` rows arm. **So the
honesty helper is reachable only by fetch-shaped cards, and the one card that deviates —
for a documented, correct reason — is the one that cannot adopt it.**

⭐ **That is the durable finding: a convention enforced by a SHAPE excludes the cases that
legitimately have a different shape, and the excluded case is exactly where the defect
survived.** The guard is not wrong; its population predicate ("contains the helper") and
its shape assertion together mean **adopting the helper is all-or-nothing**, so a card that
cannot match the shape is quietly better off not adopting it — which is precisely backwards.

## 4. 👉 What to do, and why it is not a drive-by

Two coherent options; both touch a guard protecting 15 cards, so neither is a side-edit:

1. **Widen the `fetched` assertion** from `if (r.ok) {` to "assigned inside a success
   branch, never at declaration" (the existing `expect(src).not.toMatch(/let fetched = true/)`
   already carries half of that intent), and relax the ternary-arm assertion to allow a
   string headline as well as a JSX rows arm. ⚠ Must be re-proven against all current
   cards — the guard's own comment warns that enumerating spellings *"is the brittle path
   that eventually gets a real card excluded to make a build pass."*
2. **Leave the guard alone and fix candy-mlb without the helper** — destructure `error`,
   add `fetched`, and write two honest strings inline. Smaller blast radius, at the cost of
   the estate having two ways to say the same thing.

⛔ **Not shipped either way.** Option 2 is tempting and I nearly took it, but writing bespoke
honesty copy *specifically to stay outside the guard that enforces honesty copy* is the
wrong instinct, and it is the sort of thing that reads as fine in a diff and rots.
**The measurement and the structural reason are here; the call is a design one.**

⚠ Regardless of the option chosen, **`{ data }` → `{ data, error }` in that card is
unconditionally correct** and could ship on its own — it is currently a `try/catch` that
cannot catch the failure it exists for.
