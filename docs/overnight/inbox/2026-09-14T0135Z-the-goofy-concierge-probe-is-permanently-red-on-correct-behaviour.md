# The Pinnacle Goofy concierge probe is PERMANENTLY RED on correct behaviour — and the reason code it prints is not the reason

**Filed 2026-09-13 ~6:35 PM PT (2026-09-14 01:35Z), Cowork cloud. READ-ONLY — nothing shipped.**
Found while resolving whether `RPC Smoke Concierge Daily` still fails; it does not.

## 1 · The timeout item is CLOSED

A console test run at **6:32 PM PT returned `200 OK` in 16.77 s** — comfortably
inside cron-job.org's 30 s cap, with the live concierge path confirmed executed
(five `/api/support-chat` probes recorded in `smoke_test_results`).

⛔ **This retracts my own 2026-09-13 filing that the entry fails "by
construction".** That rested on a 33,559 ms average **pooled across the
saturation spell**. Split on the change point: 28,746 ms during · 23,570 ms after
· **11,736 ms in the last 90 min**. The entry needs no console change and no
retry. ⚠ It is not immune either — 16.77 s against a 30 s cap is ~44% margin, and
a comparable spell would breach it. The durable lever is query cost (#107), not
the entry.

## 2 · ⛔ The established defect: the probe fails on every run, and the concierge is right

`concierge filters by character name (Pinnacle Goofy probe)` is `soft: true`, so
it never fails the suite — and it has failed **every** concierge run on record
(02:24 AM, 09:10 AM, 06:32 PM on 09-13), always with `fake discount on goofy`.

**The concierge's answer is correct in every particular.** Verified row-by-row
against `pinnacle_catalog` — the table `searchPinnacleDeals` actually reads:

| concierge row | catalog |
|---|---|
| Surf's Up Vol.1 · Silver Sparkle · $1 · FMV $1.28 · `22% under` | Goofy · $1 · $1.28 · 22% ✓ |
| Friends-Giving Vol.1 · Colored Enamel · $1 · $1.24 · `19% under` | Goofy · $1 · $1.24 · 19% ✓ |
| Surf's Up Vol.1 · Standard · $1 · $1.12 · `11% under` | Goofy · $1 · $1.12 · 11% ✓ |
| Americana Vol.1 · Colored Enamel · $1 · $1.00 · `at FMV` | Goofy · 0% ✓ |
| Disney Holiday Vol.1 · Colored Enamel · $1 · $0.90 · `— (slight premium)` | Goofy · **−11%** ✓ |

⭐ Every pin is genuinely **Goofy**, every percentage is arithmetically correct
from the ask and FMV printed in the same row, and the one row trading **above**
FMV is labelled a premium rather than a discount. **This is the surface doing
exactly what the product exists to do.**

## 3 · Why the guard fires, and why its reason code misleads

```
const fakeDiscount = mentionsGoofy && /\d{2,3}\s*%\s*(?:below|off|under)/.test(text);
```

It fires on **any** percentage-under phrasing. But quoting ask-vs-FMV as a
percentage **is the deal-finding product**, so as written the check contradicts
the surface it guards. ⚠ **It cannot distinguish a fabricated discount from a
sourced one**, and the response was showing its work — Ask and FMV printed side
by side in the same row.

⛔ **Deliberately NOT changed.** Loosening a guard is the highest-risk edit class
here, and the right discriminator depends on what this check was *meant* to
prevent — plausibly written when Pinnacle answers were not supposed to quote
percentages at all. **Whoever owns the concierge's output contract should decide
whether the probe or the behaviour is wrong.** Candidate fix if the behaviour is
correct: require the percentage to be **uncorroborated** (no FMV printed for that
row) before calling it fake.

⚠ **`soft: true` is why this survived.** A soft probe that is always red is a
dead instrument — the estate's own rule that *a permanently-red instrument is
indistinguishable from a broken one at a glance*, applied to a probe rather than
an arm. **Either make it able to pass, or retire it.**

## 4 · ⚠ The control that stopped me publishing the opposite

My first pass queried `pinnacle_cached_listings`, found **one** Goofy pin under
$50 against the concierge's eight, and had a confabulation finding half-written.
**That table is frozen at 2026-06-08 with 141 rows, and the router's own source
calls it "the frozen dead-Flowty table" it has no dependency on.** The live
source is `pinnacle_catalog`.

⭐ **Naming the instrument before publishing is what caught it** — a plausible
table name, a plausible-looking answer, and the wrong source entirely. Third
avoided error of the same shape in one session: **a value that looks like the
answer is not the answer until you have checked what produced it.**

---

## ✅ ACTED ON 2026-09-13 ~10:2x PM PT (Claude Code cloud) — §2 and §3 are FIXED; §1 is unchanged

**Appended, not rewritten** (append-only convention, so this cannot silently clobber the filing).

This filing deliberately left the decision to *"whoever owns the concierge's output
contract"*. **It did not need a product decision after all — the intent is recorded in
the commit that added the check.** `657ab80c6` ("Pinnacle FMV must join by (character,
set, variant) — `edition_key` alone leaked Minnie's FMV onto Goofy") says the probe was
tightened so that *"a 'Goofy at $1, FMV ~$29 → 97% off' response now fails on the
FMV-leak and fake-discount patterns instead of passing because 'Goofy' appeared
somewhere in the text."* The shape it was built for is a **leaked FMV**; banning
percentages outright was never the contract. ⭐ **The filing's own candidate fix —
"require the percentage to be uncorroborated" — was the right instinct, and the commit
message is what made it safe to act on without asking.**

**Shipped** (`b86c18361`): `uncorroboratedDiscountClaims(text)`, exported from
`app/api/smoke-test/route.ts`, returns the discount percentages a response states that
**its own printed figures cannot produce**. Strict where the evidence is present (a line
printing ≥2 money figures must support its own percentage from a pair on THAT line),
lenient where it is not (prose restating the table is corroborated by any line in the
response) — because a false positive is exactly what made the old check worthless.

⚠ **`fmvLeak` is UNCHANGED, deliberately.** A leaked FMV is arithmetically
self-consistent ((29−1)/29 = 97%), so a corroboration test passes it by design and must
not pretend otherwise. Two different claims, two different instruments; the original
defect is still caught, and `__tests__/smoke-goofy-probe-discount-corroboration.test.ts`
pins that split explicitly. Mutation-proven both ways.

⭐ **This filing's §2 table is what made the fix verifiable** — but the test's first case
is the **raw `body_excerpt` `smoke_test_results` stored for the 01:32Z run**, read back
from the live DB, rather than the summary table. A shape argument is what made the old
check wrong.

⚠ **Still `soft: true`**, and that is correct: a live LLM call should not page on model
flakiness. What changed is that it can now **pass**.

⛔ **§1 (the 30 s cron-job.org margin) is untouched** — it needs no console change and no
retry, exactly as this filing concluded, and the durable lever is still query cost (#107).
