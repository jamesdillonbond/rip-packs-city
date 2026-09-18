# Handoff — dependency CVE bumps (2026-09-18)

## Context

From the bi-weekly cleanliness digest. Cowork has **no git credentials this session**
(`git push` → `could not read Username`), so these package bumps can't be shipped from here —
they need Claude Code on Trevor's machine. Nothing else in the digest needed action: security
posture is clean (0/0/0, 3 benign SECDEF fns) and no index qualified for a strictly-safe drop.

Current HEAD: `6859d22b6` on `main`. There are **no open `dependabot/*` branches** on origin
(`git ls-remote --heads`), so the critical Next.js advisory has **not** auto-PR'd yet — this
is a manual bump, not a merge.

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search`
on any disagreement — adapt to the actual file shape.

---

## Item 1 — 🚨 CRITICAL: bump `next` 16.2.9 → 16.3.5 (do this one)

**Why.** `next` 16.2.9 is inside the affected range (`9.3.4-canary.0 – 16.3.2`) of a critical
advisory bundle — 11 CVEs including **unauthenticated RCE via AVIF in the Image Optimization
API** (GHSA-2xp9-vwfh-vxw4), SSRF in Server Actions & rewrites (GHSA-89xv-2m56-2m9x /
GHSA-p9j2-gv94-2wf4), response-body cache confusion, DoS, and unauthenticated disclosure of
internal Server Function endpoints (GHSA-955p-x3mx-jcvp). (The Windows-host RCE
GHSA-p293-qw3h-jr36 CVSS 9.0 is mooted by Linux/Vercel prod, but the rest are relevant.)

**Fix is a non-major bump.** `npm audit` reports `fixAvailable: next@16.3.5, isSemVerMajor:
false`. A `--dry-run` install (verified in-sandbox, no writes) resolves cleanly and as a side
effect **removes the vulnerable `postcss` 8.4.31, bumps `nanoid` 3.3.11 → 3.3.19, and pulls
`sharp` 0.35.4** — so this single bump also clears the postcss, nanoid, and (bundled) sharp
HIGH advisories.

**Commands (PowerShell / Git Bash on Windows):**
```
npm install next@16.3.5
npx tsc --noEmit          # expect clean
npm run test:coverage     # primary gate
npm run build             # confirm prod build succeeds (Image Opt / OG unaffected)
```
Ledger-first, then code (docs-only tip suppresses the Vercel deploy). Commit both
`package.json` + `package-lock.json`.

**Revert path:** `git revert <this commit>` (restores `next@16.2.9` + the prior lockfile).
No DB half.

**Verify after deploy:** Vercel deploy reaches READY (check per-commit, not just latest),
smoke test green, and an OG card + an `/insights` board render (Image Optimization path is
what the CVEs touch).

---

## Item 2 — HIGH, but SEMVER-MAJOR: `@vercel/og` 0.11.1 → 1.0.2 (separate, test OG first)

**Why.** `@vercel/og` 0.11.1 carries `sharp` (libvips/libheif image CVEs). Fix is
`@vercel/og@1.0.2` — **a major bump** that changes the satori/OG rendering internals.

**Risk.** RPC's OG cards are non-trivial (`lib/og/*`, `brandFonts()`, per-board empty copy).
A major `@vercel/og` bump can change font loading and layout behavior, so **do not bundle this
with Item 1.** Bump it on its own, then eyeball several rendered OG cards (public entity page,
an insights board, a degraded/empty board) before relying on it. If Item 1's bundled `sharp`
0.35.4 already clears the sharp advisory (confirm with `npm audit --omit=dev` after Item 1),
Item 2 is optional/deferrable.

**Commands:**
```
npm install @vercel/og@1.0.2
npx tsc --noEmit
npm run build
# then manually verify OG cards render with correct fonts/branding
```
**Revert path:** `git revert <that commit>`.

---

## Item 3 — remaining advisories (note only, no action needed now)

- `@onflow/fcl` cluster (moderate) — **no upstream fix available**; carry as accepted.
- `@anthropic-ai/sdk` 0.81.0 (moderate, insecure default file perms in local FS memory tool) —
  fix 0.126.0 is a major bump; not urgent, batch with a future SDK upgrade.
- `brace-expansion` / `browserslist` / `defu` / `fast-uri` / `ws` (HIGH, transitive) — run
  `npm audit fix` after Items 1–2 and re-check; most clear via the framework bump. Avoid
  `npm audit fix --force` (it will pull the `@vercel/og` major without OG testing).

---

## Guardrails (repeat every handoff)

- Direct to `main`, **no branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch
  is pre-checked-out, `git checkout main` first.
- Commit via PowerShell/Git Bash `git`; re-verify the push with
  `git rev-list --count origin/main..HEAD` (expect 0). Don't use backticks in `-m`.
- Commit the **ledger entry before the code** so the code commit is the tip and auto-deploys.
- Watch the Vercel deploy reach READY **per commit**; an ERRORed deploy is superseded silently
  by the next push.

## Expected end state

`next@16.3.5` on `main`, deploy READY, `npm audit --omit=dev` down from 1 critical / 9 high to
(at most) the `@onflow/fcl` moderates + whatever Item 2/3 you defer. Ledger entry recorded with
the `git revert` path.
