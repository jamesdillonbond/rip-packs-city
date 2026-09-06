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
