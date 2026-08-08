# Handoff 2026-08-08 — remove wallet SIGN-IN; capture identifiers only

**Trevor's directive (2026-08-08):** users cannot sign into Dapper Wallet without Dapper developer approval, so *no wallet sign-in should be offered anywhere*. RPC asks only for **identifiers**: a Dapper wallet address or Top Shot username, a Panini username, a Candy address. Everything we do with them is public-chain, view-only.

**Shipped live by Cowork before this handoff:** nothing. No migration, no edge function. This handoff is **100% repo work** — `.tsx`, routes, hooks, tests. Cowork has no push credential for this repo.

**Repo tip when this was written:** `133a13a` (`docs(memory): session-close — Sentinel/observability/saturation-fix pass…`). No `docs/FREEZE.md`. Ledger skimmed — no collision with any queued or declined item.

---

## The evidence that makes this safe

Three read-only prod queries. **The FCL sign-in path has never once succeeded in its lifetime.**

| Query | Result |
|---|---|
| `select verification_method, count(*) from saved_wallets group by 1` | `listing_challenge` 5 · `owner_attested` 4 · `NULL` 90. **Zero** `fcl_dapper` / `fcl_blocto` / `fcl_other` / `hybrid_custody_link`. |
| `count(*) from auth.users where email like '%@flow.rip-packs-city.local'` | **0** synthetic wallet-minted users, out of 21 total auth users. |
| `count(*) from fcl_auth_nonces` | **1 ever minted, 0 consumed** (newest `2026-08-08 20:00:30Z`). |

So deleting this path removes a promise the product has been making and never keeping. It deletes no working capability and orphans no account.

**What survives and must NOT be touched:** the listing challenge (`/api/profile/verify-challenge` + `/check`) and `admin_verify_wallet` owner attestation. Neither is a wallet sign-in — the listing challenge asks the user to list a Moment on Top Shot's own site. Those 9 verified wallets came from those two paths. After this handoff the listing challenge becomes the *only* self-serve verification, since Item 5 removes `/api/profile/verify-link`, which the UI currently advertises as "Fastest".

---

## Item 1 — Delete the two client wallet-connect surfaces

There are **two**, not one. The second is easy to miss.

**Files (all verified present):**

- `components/SignInWithDapper.tsx` — **delete.** Sole mount point is `app/dashboard/page.tsx:1176`.
- `components/auth/ConnectButton.tsx` — **delete.** Verified orphan: `grep -rn "ConnectButton" app components` returns only its own definition and a comment in `app/admin/feedback/page.tsx:6`. It is rendered nowhere.
- `app/dashboard/page.tsx` — remove the **second** connect surface, the one inside the verify modal:
  - `import * as fcl from "@onflow/fcl";` (line 12) and `import { configureFcl } from "@/lib/chains/flow/fcl-config";` (line 13)
  - `import SignInWithDapper from "@/components/SignInWithDapper";` (line 11)
  - state `linkLoading` / `linkError` / `linkHint` (the three `useState` lines immediately above the `setInterval(() => setNow(...))` effect, ~1930–1932)
  - the whole `verifyViaLink` `useCallback` (~1939–1986) — it calls `configureFcl({intent:'sign-in'})` → `fcl.authenticate()` → `POST /api/profile/verify-link`
  - the rendered block whose heading is **"Fastest: verify with a linked wallet"**, its `Verify via linked wallet (read-only)` button and the `linkHint` / `linkError` divs (~2087–2110). Delete the whole bordered card; the listing-challenge UI below it stands alone.

**Why:** both call `fcl.authenticate()`, which pops a wallet-connect dialog. The read-only framing on the second one does not change that it is a wallet sign-in.

**Revert:** `git revert <sha>`. Code-only; no DB, no deploy state to unwind.

---

## Item 2 — Rewrite `SignInBanner` as identifier entry

`app/dashboard/page.tsx`, function `SignInBanner` (starts line 1136, runs to the end of its `return` ~1235). It currently leads with `<SignInWithDapper variant="primary" />` under the line *"Sign in with your Dapper wallet for verified ownership across NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle."* (line 1172) and demotes the username field to *"— or use a Top Shot username (unverified) —"*.

Invert it. The identifier IS the product now.

Replace the whole `SignInBanner` function with:

```tsx
// ── Sign-in Banner (no wallets yet) ─────────────────────────────────────────
//
// Identifier entry ONLY. RPC never asks anyone to connect or sign a wallet
// (Trevor, 2026-08-08) — Dapper Wallet sign-in requires Dapper developer
// approval we do not have, and everything RPC reads is public on-chain data.
// We collect a public identifier and read it view-only.
//
// One field, chain-detected. Accepts:
//   0x + 16 hex  → Flow / Dapper address, fans out across all five Flow surfaces
//   base58 32-44 → Candy (Solana) address                [gated on published]
//   anything else→ a username: Top Shot (resolved via GQL) or Panini
// The Panini/Candy hints render only when their collection is published, so an
// unpublished surface is never advertised.

function SignInBanner({
  usernameInput,
  setUsernameInput,
  onUsernameSubmit,
  saving,
  error,
}: {
  usernameInput: string;
  setUsernameInput: (v: string) => void;
  onUsernameSubmit: () => void;
  saving: boolean;
  error: string | null;
}) {
  const paniniLive = !!getPublishedCollection("panini-blockchain");
  const candyLive = !!getPublishedCollection("candy-mlb");

  const accepted = [
    "your Dapper wallet address (0x…)",
    "your Top Shot username",
    paniniLive ? "your Panini username" : null,
    candyLive ? "your Candy wallet address" : null,
  ].filter(Boolean) as string[];

  const placeholder = candyLive
    ? "0x… address, or username"
    : "0x… Dapper address, or Top Shot username";

  return (
    <section
      className="rpc-card-neon rpc-scanlines"
      style={{ position: "relative", padding: "28px 24px", overflow: "hidden" }}
    >
      <div style={{ fontFamily: monoFont, fontSize: 10, color: ACCENT_RED, letterSpacing: "0.2em", textTransform: "uppercase", marginBottom: 8 }}>
        Welcome to Rip Packs City
      </div>
      <div
        style={{
          fontFamily: condensedFont,
          fontWeight: 900,
          fontSize: 44,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          lineHeight: 0.95,
          color: "var(--rpc-text-primary)",
          marginBottom: 10,
        }}
      >
        Track Your Collection
      </div>
      <div style={{ fontFamily: monoFont, fontSize: 13, color: "var(--rpc-text-secondary)", lineHeight: 1.5, marginBottom: 16, maxWidth: 620 }}>
        Paste {accepted.slice(0, -1).join(", ")}
        {accepted.length > 1 ? ", or " : ""}
        {accepted[accepted.length - 1]}. RPC reads public blockchain data only —
        we never ask you to connect or sign a wallet.
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <input
          value={usernameInput}
          onChange={(e) => setUsernameInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") onUsernameSubmit(); }}
          placeholder={placeholder}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          aria-label="Wallet address or username"
          style={{
            flex: 1,
            minWidth: 260,
            padding: "12px 16px",
            background: "var(--rpc-surface)",
            border: `1.5px solid ${ACCENT_RED}88`,
            borderRadius: 8,
            color: "var(--rpc-text-primary)",
            fontFamily: monoFont,
            fontSize: 14,
            letterSpacing: "0.02em",
            outline: "none",
          }}
        />
        <button
          onClick={onUsernameSubmit}
          disabled={saving}
          style={{
            background: "transparent",
            border: `1.5px solid ${ACCENT_RED}`,
            color: ACCENT_RED,
            padding: "12px 24px",
            borderRadius: 8,
            fontFamily: condensedFont,
            fontWeight: 800,
            fontSize: 14,
            letterSpacing: "0.1em",
            textTransform: "uppercase",
            cursor: saving ? "default" : "pointer",
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? "Loading…" : "Load my collection"}
        </button>
      </div>

      {error && (
        <div style={{ color: "var(--rpc-danger)", fontFamily: monoFont, fontSize: 12, marginBottom: 10 }}>
          {error}
        </div>
      )}

      <div style={{ fontFamily: monoFont, fontSize: 11, color: "var(--rpc-text-muted)", lineHeight: 1.5, maxWidth: 620 }}>
        Read-only and unverified — this loads any public collection, including
        one that isn&apos;t yours. To mark a wallet as <em>yours</em>, use the
        verify step once it&apos;s loaded.
      </div>
    </section>
  );
}
```

Add `getPublishedCollection` to the existing `@/lib/collections` import at the top of the file (`getCollection` is already imported from there — verify the exact named-import list before editing).

`spellCheck`/`autoCapitalize`/`autoCorrect` are not cosmetic: mobile Safari auto-capitalises the first letter, which corrupts a base58 Candy address and a mixed-case Panini username.

**The `onUsernameSubmit` handler must now branch.** `resolveAndAssociate` (line 534) currently posts `{ username }` unconditionally. Make it detect the identifier shape with `detectAddressChain` from `@/lib/address` and route:

| Input shape | Route |
|---|---|
| `cadence` (`0x` + 16 hex) | `POST /api/profile/resolve-and-associate` with `{ address }` — see Item 4 |
| `solana` (base58 32–44) | `POST /api/profile/saved-wallets` with the Candy UUID, then `POST /api/wallet-backfill-candy` |
| anything else | `POST /api/profile/resolve-and-associate` with `{ username }` (existing Top Shot GQL path); on its 404, and only when Panini is published, retry as a Panini username |

Keep the existing `startIndexingPoll()` call on every success branch.

**Revert:** `git revert <sha>`.

---

## Item 3 — ⚠ The `.toLowerCase()` that silently corrupts every Candy address

**This is the one real bug in the set, and it blocks Candy capture outright.**

`wallet_moments_cache` already holds **25,375 Candy rows across 395 distinct Solana wallets** — verified live, sample `12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK`. Base58 is **case-sensitive**. Every write path lowercases:

- `app/api/profile/saved-wallets/route.ts` — line **153** (POST), **239**, **291**, and **52** (allow-list auto-attach)
- `app/dashboard/page.tsx` line **574** — `addWallet`: `walletForm.addr.trim().toLowerCase()`

A pasted Candy address is therefore stored mangled and never matches a single wmc row. The saved wallet renders empty and reads as "we have no Candy data", which is false.

`lib/address.ts` already exports the correct primitive and has for some time:

```ts
export function normalizeAddress(value: string): string {
  const trimmed = value.trim();
  return detectAddressChain(trimmed) === "solana" ? trimmed : trimmed.toLowerCase();
}
```

**Fix:** replace each `.toLowerCase()` above with `normalizeAddress(...)`. Grep the whole read path too — `app/api/profile/{top-moments,hero-moment,collection-stats,activity}/route.ts` all lowercase `wallet_addr` before an `.eq()`, so they must move to `normalizeAddress` in the same commit or a correctly-stored Candy address still won't read back.

**Panini is the same class of bug with a different answer.** Verified live on `panini_card_serials` (73,088 rows): `owner` is **100% populated, 2,762 distinct, ZERO EVM-shaped**, samples `RaspySlabs` / `Adlcards` / `scotnic`, max length 16. **Panini identity is a username, not an address** — do not validate it as EVM. And critically: `count(distinct owner) = count(distinct lower(owner)) = 2762`, so **lowercasing is collision-free** and safe — but 51,817 of 73,088 rows are mixed-case, so any exact-match read must join on `lower(owner)`, never on `owner`.

> Correction to a memory note: the Panini raw envelope's `my_public_wallet` key is **not** an address. Verified over the last 3 days of capture — 35,734 rows carry it and every value is the string `"false"`. It is a boolean visibility flag. There is no Panini wallet address anywhere in our data.

**Revert:** `git revert <sha>`. No data migration needed — no Candy or Panini row has ever been written to `saved_wallets` (verified: saved rows exist only for `nba_top_shot` 21, `nfl_all_day` 21, `laliga_golazos` 21, `disney_pinnacle` 21, `ufc_strike` 15).

---

## Item 4 — Per-collection identifier validation, and the address path into `resolve-and-associate`

**4a.** `lib/address.ts` exports `isValidAddressForChain(value, dbChain)` and it is **used nowhere on the saved-wallets path** — verified: the only importers are `app/api/wallet-search/route.ts`, `app/api/profile/recent-searches/route.ts`, `lib/dashboard-format.ts`, and its own test. Wire it into `saved-wallets` POST so a Flow address can't be saved under Candy and vice versa.

Add a username shape to `lib/address.ts` (Panini has no address, so `isValidAddressForChain` alone can't gate it):

```ts
// Panini identity is a USERNAME, not an address — panini_card_serials.owner is
// 100% populated, 2,762 distinct, zero EVM-shaped (verified 2026-08-08), max
// observed length 16. Store lowercased: distinct(owner) == distinct(lower(owner))
// so folding is collision-free, and 71% of rows are mixed-case so every read
// must join on lower(owner).
const PANINI_USERNAME_REGEX = /^[A-Za-z0-9_.-]{2,16}$/;

export function isPaniniUsername(value: string): boolean {
  return PANINI_USERNAME_REGEX.test(value.trim());
}
```

**4b.** Teach `app/api/profile/resolve-and-associate/route.ts` to accept `{ address }` alongside `{ username }`. Everything after the resolve step already runs off a bare `walletAddress` — the `publishedCollections()` × `SEED_SLUGS` fan-out, the `after()` wallet-search dispatch, the UFC branch, and `aggregate_saved_wallet_stats`. So the change is only at the top: when `body.address` is a valid cadence address, set `walletAddress = normalizeAddress(body.address)` and `username = null`, and skip `resolveTopShotUsername`. Keep the quota check on both paths — the comment at line ~110 notes this is the primary "Load my collection" path and previously bypassed the cap.

**4c.** Candy has no fan-out (its address is a different chain). Route it to a single `saved_wallets` row on `209ade70-32c5-4470-bc7c-4793d660f713` plus a `POST /api/wallet-backfill-candy` dispatch. That route is **armed** — `CANDY_MLB_COLLECTION_ADDRESS` is the real `JkJA4yUBweFQdKAWNDhoFj8zHMZrQ1uZEYfjbkc3p8n`, so `candyDiscoveryReady()` returns true. Note `app/api/wallet-backfill-multicollection/route.ts` dispatches to Flow surfaces only (`SYNC_COLLECTIONS` + `FIRE_AND_FORGET_COLLECTIONS`); do **not** add Candy there, it takes a Flow address.

**4d. Honest limitation to encode in the UI, not paper over.** There is **no `wallet-backfill-panini` route** and `wallet_moments_cache` holds **zero** Panini rows (verified). A saved Panini username therefore resolves against `panini_card_serials` (join `lower(owner)`), not wmc. If the read surface isn't built in this pass, the Panini input must not ship — an input that accepts a username and then renders an empty collection is the "timeout renders as $0" failure in a new costume. Either build the `lower(owner)` read or leave Panini gated.

**Revert:** `git revert <sha>`.

---

## Item 5 — Retire the server half

A removed page whose API stays reachable is the trap that has bitten this repo twice. All four verified present:

| Path | Lines | Action |
|---|---|---|
| `app/api/auth/fcl-verify/route.ts` | 212 | delete |
| `app/api/auth/fcl-nonce/route.ts` | 84 | delete |
| `app/api/profile/verify-link/route.ts` | — | delete |
| `lib/chains/flow/fcl-config.ts` | 135 | delete — becomes a full orphan |

`fcl-config.ts` importers are exactly the three call sites this handoff removes (`app/dashboard/page.tsx:13`, `components/SignInWithDapper.tsx:18`, `lib/hooks/useFlowUser.ts:6`) plus its own tests. Verified by grep.

**Do NOT touch, despite the similar names:**

- `lib/breaks/server-authz.ts` — exports its **own separate** `configureFcl()`; it is what `app/api/breaks/[id]/{draft,distribute,validate-recipients}/route.ts` import.
- `lib/chains/flow/flow.ts` `initFcl()` — sets chain config only, no `discovery.*` key. Server read paths need it.
- `@onflow/fcl` itself stays in `package.json`. Every remaining use is **server-side read-only** (`fcl.query` / `fcl.send`) in `wallet-search`, `owned-flow-ids`, `sales-indexer`, `allday-sets`, `cost-basis-backfill`, `cron/ownership-onchain-walk`, and the breaks routes. There is no client-side `fcl.query` anywhere — verified.

**DB follow-up (separate migration, NOT in this commit):** `fcl_auth_nonces`, the `purge_old_fcl_auth_nonces` job, and the `verify_wallet_via_fcl` RPC all go dead once `verify-link` is gone. Drop them **after** the deploy is READY, never in the same window — a dropped table with the route still live is a 500 for anyone mid-flow. `saved_wallets.verification_method`'s CHECK still allows `fcl_dapper|fcl_blocto|fcl_other`; leave the constraint alone (zero rows use them, and narrowing it buys nothing).

**Revert:** `git revert <sha>` restores all four files. The DB objects are untouched by that commit, so the code-side revert is complete on its own.

---

## Item 6 — ⚠ Re-point `useFlowUser` consumers or the Pro badge goes dark for everyone

**Miss this and you ship a silent regression.** `components/auth/ProBadge.tsx` does:

```tsx
const { user } = useFlowUser()
const { isPro, plan } = useProStatus(user.loggedIn ? user.addr : null)
```

`user.addr` comes from `fcl.currentUser`. With sign-in removed nobody ever authenticates to FCL, so `user.loggedIn` is permanently `false`, `useProStatus` gets `null`, `isPro` is always false, and `ProBadge` returns `null` — **for every Pro and Founding member**. It is mounted in `components/GlobalSiteHeader.tsx:25`, `app/my-teams/layout.tsx:31`, and `app/(analytics)/analytics/layout.tsx:49`, so this is site-wide.

Add `lib/hooks/useSessionOwner.ts` (new file — `/api/profile/me` already returns exactly this and never 401s):

```ts
'use client'

import { useEffect, useState } from 'react'

export interface SessionOwner {
  userId: string | null
  walletAddr: string | null
  username: string | null
  email: string | null
  displayName: string | null
  loading: boolean
}

const EMPTY: Omit<SessionOwner, 'loading'> = {
  userId: null, walletAddr: null, username: null, email: null, displayName: null,
}

/**
 * The signed-in user's identity from the cookie-backed Supabase session.
 *
 * Replaces useFlowUser (deleted 2026-08-08): RPC no longer connects wallets, so
 * fcl.currentUser is permanently signed-out and anything keyed on it renders as
 * "not a member". The server is the trust boundary; this is display state only.
 */
export function useSessionOwner(): SessionOwner {
  const [state, setState] = useState<SessionOwner>({ ...EMPTY, loading: true })

  useEffect(() => {
    let cancelled = false
    fetch('/api/profile/me', { cache: 'no-store', credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled) return
        const u = d?.user
        if (!u) { setState({ ...EMPTY, loading: false }); return }
        setState({
          userId: u.id ?? null,
          walletAddr: u.wallet_addr ?? null,
          username: u.username ?? null,
          email: u.email ?? null,
          displayName: u.display_name ?? null,
          loading: false,
        })
      })
      .catch(() => { if (!cancelled) setState({ ...EMPTY, loading: false }) })
    return () => { cancelled = true }
  }, [])

  return state
}
```

Then in `components/auth/ProBadge.tsx` swap the first two lines for:

```tsx
const { walletAddr } = useSessionOwner()
const { isPro, plan } = useProStatus(walletAddr)
```

…and drop the `useFlowUser` import. The rest of the component is unchanged.

`components/SupportChatConnected.tsx` is nearly free — it **already** fetches `/api/profile/me` into `identity` and uses `user.addr` only as a fallback. Delete the `useFlowUser` import and simplify:

```tsx
const ownerKey = identity.username ?? null;
const userWallet = identity.walletAddr ?? null;
const signedIn = !!identity.email;
```

and pass `walletConnected={signedIn}`.

Finally delete `lib/hooks/useFlowUser.ts`.

**Verification that this item worked:** sign in as a Pro/Founding account and confirm the badge still renders in the global header. A green `tsc` will NOT catch this regression — the types stay valid, the badge just silently never shows.

**Revert:** `git revert <sha>`.

---

## Item 7 — Tests and the coverage ratchet

Delete, all verified present in `__tests__/`:

```
component-SignInWithDapper.test.tsx
component-auth-buttons.test.tsx        # ConnectButton
hook-useFlowUser.test.tsx
api-auth-fcl-nonce.test.ts
api-auth-fcl-verify.test.ts
api-auth-fcl-verify-deep.test.ts
chains-fcl-config.test.ts
fcl-discovery-single-owner.test.ts     # pins the single-owner discovery invariant
```

`fcl-discovery-single-owner.test.ts` guards an invariant that stops existing once `fcl-config.ts` is gone — deleting it is correct, not a coverage dodge.

⚠ **The ratchet will move and `tsc` won't tell you.** `vitest.config.ts` carries per-file thresholds (statements 89.3 / branches 75.1 / functions 91.5 / lines 91.6 at line ~726) and `vitest.components.config.ts` its own set. Removing eight well-covered files changes the denominator in both directions. Run the suites, read the actual numbers, and re-baseline the thresholds in the same commit — do not guess.

Add a small regression test in place of the deleted ones: assert no client component imports `@onflow/fcl` (a grep-style test, same shape as the deleted single-owner test). That is the invariant Trevor actually wants pinned — *no wallet sign-in on any surface* — and it will fail loudly if someone reintroduces one.

**Revert:** `git revert <sha>`.

---

## Item 8 — Copy that still promises wallet sign-in

Two sites beyond the banner, both verified:

- `app/dashboard/page.tsx:1172` — *"Sign in with your Dapper wallet for verified ownership across…"*. Replaced wholesale by Item 2.
- `app/api/support-chat/route.ts:795` — the concierge system prompt says: *"…'Sign in with Dapper' is gated on developer access; the FCL button is for self-custody wallets only, not Dapper-custodied Top Shot accounts."* Rewrite to: RPC never asks you to connect or sign a wallet; paste your Dapper address or Top Shot username; verification is the listing challenge. **Leaving this stale means the support bot actively tells users to look for a button that no longer exists.**

Also worth a pass: `CLAUDE.md` "known-issue 0" language and `docs/features/hybrid-custody-verify-path-2026-06-08.md`, which document the removed path as current.

**Revert:** `git revert <sha>`.

---

## Suggested commit order

1. Items 1 + 2 + 8 — the visible ask, self-contained, shippable alone.
2. Item 6 — must land with or before Item 1 or the Pro badge goes dark.
3. Item 3 — the Candy lowercase fix, independently valuable.
4. Items 4 + 5 + 7.

Items 1/2/6/8 together already satisfy Trevor's directive; 3/4/5/7 are the honest completion.

---

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- **Commit via PowerShell `git`** on Windows — Git Bash `git commit` can silently no-op. Re-verify the push with `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash** for the Vercel REST API — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` hard cap is 800s** — anything higher sends the deploy to ERROR invisibly.
- **CRLF:** don't string-replace-patch on Windows. Full-file writes, or `findIndex` on split lines. `app/dashboard/page.tsx` is 2,303 lines — every line number here is an anchor for orientation, not a patch offset.
- ⚠ `git revert <sha>` paths dated before 2026-08-03 are dead shas (history was rewritten). Find commits by message.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** Line numbers were read from a fresh `origin/main` clone at `133a13a` and will drift with any intervening commit.

---

## Expected end state

One or more commits on `main`, Vercel deploy READY, `npx tsc --noEmit` clean, both vitest suites green with re-baselined thresholds. `/dashboard` signed out shows a single identifier field and the line "we never ask you to connect or sign a wallet" — with **zero** `fcl.authenticate()` call sites left in client code (`grep -rn "fcl.authenticate" app components lib` returns nothing). The Pro badge still renders for a Pro account in the global header. `POST /api/auth/fcl-verify` returns 404. A pasted Candy address round-trips through `saved_wallets` with its case intact and matches a wmc row.
