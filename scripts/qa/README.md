# scripts/qa — the true-mobile QA instrument

`mobile-sweep.mjs` drives a real Chromium at a real phone viewport (390 × 844, DPR 3,
touch, mobile UA) over a list of live site paths, appends one measured JSON record per
page, and writes a screenshot per page. It is the only instrument here that sees
LAYOUT: jsdom boxes are zero, HTTP 200 says nothing about a streaming shell, and the
Cowork/Claude-in-Chrome window cannot resize below ~738 px.

## Run it from the Cowork device VM (the proven route to prod, 2026-09-06)

The cloud sandbox's proxy resets the TLS tunnel to prod, so the sweep runs on the
device VM, where the repo mount carries `node_modules/playwright`:

```bash
export PLAYWRIGHT_BROWSERS_PATH=$HOME/pw
export LD_LIBRARY_PATH=$HOME/extralib/usr/lib/x86_64-linux-gnu   # the VM lacks libnss etc.
cd $HOME/mnt/rip-packs-city
mkdir -p _to_delete/qa-shots-$(date +%m%d)
node scripts/qa/mobile-sweep.mjs paths.txt _to_delete/qa-sweep.jsonl _to_delete/qa-shots-$(date +%m%d) mobile
```

Then, from the Cowork session, `device_stage_files` the PNGs and view them with `Read` —
that is what makes the mobile view *inspectable*, not just measured. Keep the run
under `_to_delete/` (gitignored) so nothing lands in the tree.

Signed-in runs: log in once through a magic link in a Playwright context, save
`ctx.storageState({ path })`, and pass it as `RPC_QA_STATE=<path>`. Delete the state
file (and any test account you created) when the pass closes.

## Reading the output honestly

Every counter in a record is a hypothesis; the screenshot is the evidence.

- `sw > iw` — horizontal overflow; `widest` names the first unclipped offender.
- `broken` counts images the browser TRIED and failed (`complete && naturalWidth === 0`).
  A lazy image that never loaded is not counted — do not read a zero as "all art fine".
- `dollarZero` / `unknown` / `undef` — grep hits. "$0" is legitimate on a market-closed
  tile; "Unknown" is legitimate as a Pinnacle variant. Confirm on the PNG.
- `errCopy` — the honest-error phrases. A page that shows one is DEGRADED, not broken;
  a page that shows none and reads a zero may be the real defect (the honesty canon).
- `scanning` — stuck on the route-level `LoadingState`. In the Cowork extension browser
  this is a known reveal artifact; in this headless Chromium it is a real finding.
- A reading taken while the subject changed (a deploy landing mid-sweep) is not a
  reading — check `git log` / the Vercel deploy list against the run's timestamps.

## What it does not do

It does not assert; it measures. `e2e/mobile-layout.spec.ts` carries the pinned
layout assertions that run in CI. This script is the broad sweep you run before a
release or after a layout change, then read.

## ⚠ A green deploy does not mean a CSS change shipped (2026-09-20)

Twice in one afternoon a committed rule in `app/globals.css` reached a READY
production deployment and was **not** in the served stylesheet.

- `7b44062` — chunk rebuilt (97,553 → 97,576 B) but the rule absent. The +23 B
  was Tailwind content-scanning picking up tokens from a `.mjs` edit in the
  same commit.
- `b176156` — chunk **byte-identical** to the previous build. The build log
  showed `Restored build cache from previous deployment` and
  `Compiled successfully in 6.5s`; a cache-warm Turbopack build served the old
  compiled CSS.

Both failures were `cat >>` appends. Both re-lands (`bf38905`, `7946a82`)
rewrote the whole file with `fs.writeFileSync`. **Mechanism is not
established** — treat this as "verify, don't assume", not as a known rule.

### How to check, and the trap in checking

Read the DEPLOYED chunk and grep for the **declarations**, not the at-rule:

```bash
node _to_delete/dumpcss.mjs           # prints the chunk URL, bytes
curl -s <chunk-url> | grep -c "min-height:44px"
```

⚠ **Lightning CSS merges adjacent `@media (pointer:coarse)` blocks into one.**
Counting occurrences of `coarse` therefore stays at 1 no matter how many blocks
you add, and reads as "my rule was dropped" when it shipped fine. That false
alarm cost a whole extra commit. Grep the declaration; and if the chunk is
byte-identical to the previous build, nothing shipped.

Behaviour on prod is the real gate either way — `_to_delete/verify44.mjs` and
`verify16.mjs` measure it.

## Signed-in sweeps

`mobile-sweep.mjs` has always accepted `RPC_QA_STATE`, but nothing produced that
file, so dashboard / trophy case / wallet flows have never been measured at
390px — an anonymous run measures the LOGIN page, not the page named.

`qa-session.mjs` produces it.

```bash
# one-off: a DEDICATED qa account with a password, then in .env.local (gitignored)
#   RPC_QA_EMAIL=...
#   RPC_QA_PASSWORD=...
node scripts/qa/qa-session.mjs                      # -> _to_delete/qa-state.json
RPC_QA_STATE=_to_delete/qa-state.json \
  node scripts/qa/mobile-sweep.mjs paths.txt out.jsonl shots mobile
```

### Two routes that are closed, so nobody re-tries them

- **Reading the session out of a signed-in Chrome.** The browser extension
  blocks auth-shaped localStorage keys outright — they come back as
  `[BLOCKED: Sensitive key]`. By design; not a bug to work around.
- **Driving the login UI headlessly.** Sign-in is magic-link only
  (`sendMagicLink` → `/api/auth/request-magic-link`), so there is no password
  field to fill.

The password GRANT is enabled on the project even though the UI does not expose
it — probed 2026-09-20, a bogus credential returns `invalid_credentials` rather
than a disabled-provider error. That is the route `qa-session.mjs` uses.

⚠ It does **not** hand-write the session cookie. RPC uses `@supabase/ssr`'s
`createBrowserClient`, whose session lives in chunked base64 cookies that are an
internal detail of that package. The script calls the package with a capturing
cookie jar and saves whatever it writes, and **fails loudly if it writes
nothing** rather than falling back to a guess.

Delete `_to_delete/qa-state.json` when the pass closes.

## 320px — the `narrow` mode

```bash
node scripts/qa/mobile-sweep.mjs paths.txt out.jsonl shots narrow   # 320 x 568
```

Same touch/mobile emulation as the 390 run, so a difference between the two runs
is **width and nothing else**. 320 is the floor a responsive layout is expected
to survive and the width where a fixed width, a `min-width` on a table cell or a
long unbroken string shows up **first** — 390 can hide all three.

⚠ `e2e/mobile-layout.spec.ts` claimed from 2026-08-22 that its routes were
"measured clean at both 390px and 320px" while its loop ran **390 only**, for
four weeks. Measured for real 2026-09-20 over all 56 swept pages: overflow 0, no
content loss against the 390 run, no broken art, nothing 390 had not shown. It
is pinned now — a `mobile layout at 320px` describe block, so the claim and the
test cannot drift apart again.

## What the sweep measures that nothing else does

`tapSmall` (44px floor, effective box incl. the `.rpc-tap44` ::after overlay) ·
`zoomInputs` (controls under 16px — iOS zooms on focus and never zooms back;
Chromium reproduces it at NO viewport) · `vh100` (elements whose box equals the
viewport) · `preLen` (innerText read **before** the settle, so "streamed in late"
and "never arrived" stop being the same record).

⚠ `vh100` **v1 was wrong** — it scanned stylesheet TEXT and matched Tailwind's
`@layer utilities` blob (the `.h-screen` *definition*) on 56 of 56 pages: a 100%
hit rate that measured nothing. Quote no v1 number.
