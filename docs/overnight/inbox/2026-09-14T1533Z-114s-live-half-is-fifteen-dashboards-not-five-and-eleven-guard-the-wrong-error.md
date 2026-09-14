# 🚨 #114's live half is **FIFTEEN** dashboards, not five — and eleven of them "handle errors" against a shape the server never sends

*Filed 2026-09-14 ~08:33 AM PT by Claude Code (desktop). **READ-ONLY — nothing was published, and nothing in Claude Desktop's artifact store was modified.** Re-derived with a committed instrument, `scripts/audit-cowork-artifact-failure-handling.mjs`, so the number below is falsifiable rather than quoted.*

---

## 1 · The correction, and why it matters more than the arithmetic

Register **#114** says, in its own words:

> the **FIVE LIVE** dashboards still carry the old helper and cannot be reached from any session on this box

**Measured by walking Claude Desktop's artifact store: it is 15.** Every one of the fifteen carries an
`extractRows` helper, and **15 of 15** fail to throw on the failure shape the live Supabase MCP server
actually returns.

⛔ **The consequence of the undercount is not "a number is wrong" — it is that the stated fix completes
and leaves the estate broken.** A Cowork desktop session doing exactly what #114 asks would patch five
dashboards, mark #114 resolved, and ten would keep rendering a failed read as "no data".

## 2 · The measurement

`node scripts/audit-cowork-artifact-failure-handling.mjs`, run 2026-09-14 08:3x AM PT against
`~/OneDrive/Documents/Claude/Artifacts`:

| artifact | throws on `{error:{…}}` | throws on unreadable | call-site `isError` |
|---|---|---|---|
| rpc-cross-collection | NO | NO | yes |
| rpc-deploys-and-cost | NO | NO | yes |
| **rpc-growth-funnel** | NO | NO | **NO** |
| rpc-live-health | NO | NO | yes |
| rpc-moment-fmv-ev-dialin | NO | NO | yes |
| rpc-my-wallet | NO | NO | yes |
| rpc-offers-intelligence | NO | NO | yes |
| rpc-pack-lifecycle | NO | NO | yes |
| **rpc-qa-scorecard** | NO | NO | **NO** |
| **rpc-rewards-console** | NO | NO | **NO** |
| rpc-set-challenge-roi | NO | NO | yes |
| rpc-tracked-fmv-confidence | NO | NO | yes |
| rpc-traction | NO | NO | yes |
| rpc-trophy-ladder | NO | NO | yes |
| **rtr-pack-finder** | NO | NO | **NO** |

**15 carrying the helper · 15 blind to `{error:{…}}` · 4 fully blind.**

## 3 · ⭐ THE FINDING UNDER THE COUNT: eleven are guarded against the failure that does not happen

Eleven of the fifteen **do** check `isError` at the call site:

```js
const r = await window.cowork.callMcpTool(TOOL, {...});
if (r && r.isError) throw new Error(JSON.stringify(r));   // reads as error handling
return extractRows(r);
```

⛔ **`isError` is not the shape a missing relation returns.** #114's own measurement against the live
server records it: a missing relation comes back as **`{error:{name,message}}`**, which this guard does
not match and which the old helper passes through to `return [raw]` — one junk row, no throw.

🚨 **So those eleven are worse than the four, not better.** The four fully-blind ones are obviously
unguarded. The eleven carry a line that *reads* as error handling, survives review because it reads that
way, and is pointed at a shape the server does not send. **This is the same class CLAUDE.md already
names — a vacuous assertion that reads as coverage — one layer down, in a guard rather than a test.**

⚠ **The practical trap for whoever fixes this:** do not grep for artifacts that "lack an `isError`
check". That query returns **4** and looks like a small job. The property is *"does the helper throw on
`{error:{…}}`"*, and it returns **15**.

## 4 · What is reachable from here, and what is not — tested, not assumed

#114 says these "cannot be reached from any session on this box". **That is half right, and the half
that is wrong is worth writing down so nobody re-tests it:**

- ✅ **Readable.** The store is a plain directory on this machine, `~/OneDrive/Documents/Claude/Artifacts/<name>/index.html`,
  with a `versions/` history beside each. Claude Code on the desktop reads it fine — that is how the
  table above was produced.
- ⛔ **Not publishable from here.** Republishing is `update_artifact`, a **Cowork** tool. This box's
  Claude Code `Artifact` tool addresses a *different* system (claude.ai/code) — verified by listing it:
  7 artifacts came back, **none of them these**. So the two artifact systems are disjoint and this
  session cannot republish a Cowork dashboard.
- ⛔ **And hand-editing the store was deliberately NOT done.** Writing `index.html` directly would bypass
  the app's versioning and thumbnailing and desync its own index — an unsupported mutation of another
  application's storage, with no way to verify the result from here. **The files are evidence, not a
  deploy channel.**

## 5 · The pickup

1. **From a Cowork DESKTOP session:** copy the fixed helper out of
   [`docs/cowork-skills/rpc-insights-health.html`](../../cowork-skills/rpc-insights-health.html) into
   **all fifteen**, then `update_artifact` each. ⚠ **Not five.**
2. **Start with the four fully-blind** (`rpc-growth-funnel`, `rpc-qa-scorecard`, `rpc-rewards-console`,
   `rtr-pack-finder`) — they have no second line of defence at all.
3. **Verify by re-running the instrument, not by counting commits:**
   `node scripts/audit-cowork-artifact-failure-handling.mjs` — it exits **0** only when every artifact
   throws on `{error:{…}}`, **1** while any is vulnerable, and **2** if the store is missing or empty
   (so a machine without the store fails loudly instead of reporting a clean estate it never read).

⚠ **Controls were taken, both directions.** Positive: pointed at the repo's two FIXED helpers it reports
`yes/yes`, 0 vulnerable, exit 0 — so it can report a pass and is not a checker that only ever says NO.
Negative: an empty directory exits 2 with `not a clean estate`, not a green run.

⚠ Every figure here is a dated sample. **Re-run the script; do not quote this table.**

---

## 6 · ⚠ The one edit that belongs in the SKILL and could NOT be made from here

**`rpc-artifact-ops/SKILL.md` is where this remediation actually belongs** — it is what a Cowork session
loads when it touches an artifact, and today it states the `extractRows` rule for **new** work only, so
nothing tells a session the *existing* estate is still broken.

⛔ **That edit was attempted and reverted, deliberately.** `npm run skills:pack` cannot run on this box:
there is no `zip` (Git for Windows ships `zipgrep`/`zipinfo` only), so the packer refuses rather than
deleting ten bundles it cannot rewrite. `unzip` *is* present, so `skills:bundles:check` runs and goes RED
— the guard works, the documented repair does not. Leaving SKILL.md edited without repacking would have
shipped the bundle-drift defect the guard exists to catch (and which survived 2026-05-30 → 2026-08-24).
Full write-up in [tooling-gotchas.md](../../reference/tooling-gotchas.md).

👉 **From a Linux session** (CI `ubuntu-latest` has both halves), insert this bullet immediately after the
existing `extractRows` bullet's *"a hand-written one will reproduce the defect."*, then
`node scripts/pack-cowork-skill.mjs rpc-artifact-ops` and confirm `skills:bundles:check` reads 10/10:

```markdown
- 🚨 **THE LIVE ESTATE IS NOT FIXED YET, AND IT IS 15 ARTIFACTS, NOT THE "five" #114 first said.** Only the three `docs/cowork-skills/*.html` repo copies carry the corrected helper. Re-derived 2026-09-14 by walking Claude Desktop's artifact store: **15 carry an `extractRows` helper and 15 of 15 still fail to throw on `{error:{…}}`.** ⚠ **Eleven of them DO check `isError` at the call site** — which reads as error handling, survives review for exactly that reason, and is pointed at a shape the server does not send. **So do NOT scope this job by grepping for a missing `isError` check: that returns 4 and looks small.** The property is *does the helper throw on `{error:{…}}`*. Start with the four blind at both layers: `rpc-growth-funnel`, `rpc-qa-scorecard`, `rpc-rewards-console`, `rtr-pack-finder`. **Measure, do not count commits:** `node scripts/audit-cowork-artifact-failure-handling.mjs` → **0** clean · **1** vulnerable · **2** store missing/empty.
```
