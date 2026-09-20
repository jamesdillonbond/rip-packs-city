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
