# Handoff → Claude Code: sync buyer-link docs to the `/share` market-wallet route

_Authored 2026-11-12 by the weekly Cowork surface-QA pass. Two tiny documentation
edits — no functional change, no migration, no edge function. Handed off (not shipped
in-pass) because Item 1 touches route `.tsx` and the QA pass does not run the
render/test loop that change wants._

## Context

- The 2026-11-12 weekly surface QA flagged that pack-surface **buyer links point at
  `/share/<addr>`**, not the `/analytics/wallets/<addr>` the QA checklist still expects.
- Investigation: this is **correct and intentional.** `lib/analytics/wallet-href.ts`
  (dated 2026-10-25) splits wallet links by context —
  `marketWalletHref()` → `/share/<addr>` (public holdings card) for buyers/sellers/holders,
  `loanWalletHref()` → `/analytics/wallets/<addr>` (Flowty loan profile) for borrower/lender.
  The pack dist page imports `marketWalletHref` (line 103) and renders buyer links through
  it. The 10-25 change fixed an anon `/login` bounce — the loan profile was sign-in-only then.
- So **nothing is broken.** This handoff only syncs two pieces of stale *documentation* that
  now contradict the shipped code, so (a) the weekly QA stops false-flagging and (b) a code
  comment stops lying to the next reader.
- HEAD at authoring: `origin/main` (the laptop working tree was 19 commits behind origin at
  authoring time — unrelated; these are additive docs). Verify live HEAD before committing.

## Item 1 (priority 1) — stale comment contradicts the code

- **File:** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` — verified exists.
  Imports `marketWalletHref` at line 103; the `ShortWallet` component (~line 2058) renders the
  buyer link as `href={marketWalletHref(address.toLowerCase())}` → `/share/<addr>`. The comment
  right above the href (~line 2064) *already* says MARKET context / holdings card, correctly.
- **The defect:** the block comment ~lines 2050–2052 still says buyers link to
  `/analytics/wallets/<addr>`. It was not updated when the 10-25 change landed, so it now
  contradicts both the code and the correct comment eight lines below it. Comment-only; no
  behavior to change.
- **Current text (anchor):**

  ```
  // Top Purchases (highest price) + Recent Purchases (newest). Buyer renders as a
  // short wallet linking to /analytics/wallets/<addr> — the differentiator over
  // Top Shot's own drop page, where the buyer is a dead-end name. Coverage is
  ```

- **Change:** replace the middle line so it reads (keep it a comment, match surrounding CRLF):

  ```
  // short wallet linking to /share/<addr> (the holdings card, not the loan profile —
  // lib/analytics/wallet-href.ts, 2026-10-25) — the differentiator over
  ```

  i.e. the `/analytics/wallets/<addr>` phrase becomes `/share/<addr>` with the holdings-card
  note; the rest of the sentence ("the differentiator over / Top Shot's own drop page…") is
  unchanged.
- **Revert:** `git revert <commit>`, or restore the original comment text above.
- **Verify:** `npx tsc --noEmit` clean (comment-only → no type impact); Vercel deploy READY.

## Item 2 (priority 2) — QA checklist expectation is stale

- **File:** `docs/cowork-skills/rpc-surface-qa/references/surface-checklist.md` — verified
  exists. Line 66.
- **Current:**
  `    tier bars + partial-coverage caption; buyer links point at `/analytics/wallets/<addr>`.`
- **Change to:**
  `    tier bars + partial-coverage caption; buyer links point at `/share/<addr>` (market holdings card, per lib/analytics/wallet-href.ts 2026-10-25; /analytics/wallets/ is the loan profile).`
- Pure doc change — **Cowork can also ship this directly** if you'd rather not round-trip it.
- **Revert:** restore the original line.
- **Verify:** none (doc only).

## Informational — no action

- `/sitemap.xml` now sums to **117,303 URLs** across 9 children (all 200, each under the
  50K/file limit), up from the ~33K Aug-2026 baseline. Healthy entity growth — entity pages
  are self-canonical + `index,follow` + JSON-LD. Flagging the magnitude only, in case the
  jump is unexpected.

## Guardrails (repeat every handoff)

- Direct to `main`, no branches, no PRs. If a `claude/*` branch is pre-checked-out, switch to
  `main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op).
  Re-verify: `git rev-list --count origin/main..HEAD` → `0` after push.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- This no-push note is specific to the cloud QA session; **Trevor's machine + Claude Code push
  normally via Git Credential Manager / `gh auth setup-git`** — never the dead PAT in
  `remote.origin.pushurl` (burned + removed 2026-08-16). Commit these files as usual.
- Expect a `docs/overnight/ledger.md` top-insertion conflict only if you add a ledger entry;
  these two edits don't strictly need one (additive docs). If you do, re-splice above
  upstream's newest `### ` heading, never hand-edit conflict markers.
- **Claude Code's direct file inspection wins over this doc and over
  `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

## Expected end state

Two doc/comment lines synced to the `/share` market-wallet route on `main`, `npx tsc --noEmit`
clean, Vercel READY, and the weekly surface QA no longer false-flags pack buyer links. No
functional change to the product.
