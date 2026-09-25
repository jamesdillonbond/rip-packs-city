// __tests__/saved-wallet-quota.test.ts
//
// Pins the saved-wallet plan cap to DISTINCT PHYSICAL WALLETS.
//
// The bug: saved_wallets holds one row per (user_id, wallet_addr,
// collection_id), so one Dapper wallet = 5 rows. The old check counted rows
// (`.eq("user_id", …)` with `count: "exact"`), so a free user (cap 1) read
// currentCount = 5 and was blocked immediately after their FIRST wallet.
//
// The `oneDapperWallet` fixture below is the mutation guard: it is 5 rows for a
// SINGLE address, so any implementation that reverts to counting rows returns 5
// and fails the "still allowed at cap 1" assertion.

import { describe, it, expect } from "vitest";
import {
  countDistinctWallets,
  walletAlreadySaved,
  evaluateSavedWalletCap,
} from "@/lib/profile/saved-wallet-quota";

/** What resolve-and-associate writes for ONE wallet: 5 collection rows. */
const oneDapperWallet = [
  { wallet_addr: "0xbd94cade097e50ac" },
  { wallet_addr: "0xbd94cade097e50ac" },
  { wallet_addr: "0xbd94cade097e50ac" },
  { wallet_addr: "0xbd94cade097e50ac" },
  { wallet_addr: "0xbd94cade097e50ac" },
];

describe("countDistinctWallets", () => {
  it("counts one Dapper wallet as 1, not its 5 per-collection rows", () => {
    expect(oneDapperWallet).toHaveLength(5);
    expect(countDistinctWallets(oneDapperWallet)).toBe(1);
  });

  it("counts distinct addresses across multiple wallets", () => {
    expect(
      countDistinctWallets([...oneDapperWallet, { wallet_addr: "0xa3d67b29e104e701" }])
    ).toBe(2);
  });

  it("is case-insensitive so a non-normalized caller cannot double-count", () => {
    expect(
      countDistinctWallets([
        { wallet_addr: "0xBD94CADE097E50AC" },
        { wallet_addr: "0xbd94cade097e50ac" },
      ])
    ).toBe(1);
  });

  it("ignores null/empty addresses and handles null input", () => {
    expect(countDistinctWallets([{ wallet_addr: null }, { wallet_addr: "  " }])).toBe(0);
    expect(countDistinctWallets(null)).toBe(0);
    expect(countDistinctWallets(undefined)).toBe(0);
  });
});

describe("walletAlreadySaved", () => {
  it("detects a re-save regardless of case", () => {
    expect(walletAlreadySaved(oneDapperWallet, "0xBD94CADE097E50AC")).toBe(true);
  });

  it("is false for an unseen wallet and for an empty candidate", () => {
    expect(walletAlreadySaved(oneDapperWallet, "0xa3d67b29e104e701")).toBe(false);
    expect(walletAlreadySaved(oneDapperWallet, "   ")).toBe(false);
  });
});

describe("evaluateSavedWalletCap", () => {
  it("REGRESSION: a free user (cap 1) with one wallet's 5 rows may still re-save it", () => {
    const r = evaluateSavedWalletCap(oneDapperWallet, "0xbd94cade097e50ac", 1);
    expect(r.distinctCount).toBe(1); // a row count would be 5
    expect(r.isReSave).toBe(true);
    expect(r.allowed).toBe(true);
  });

  it("blocks a SECOND distinct wallet at cap 1", () => {
    const r = evaluateSavedWalletCap(oneDapperWallet, "0xa3d67b29e104e701", 1);
    expect(r.distinctCount).toBe(1);
    expect(r.isReSave).toBe(false);
    expect(r.allowed).toBe(false);
  });

  it("allows the FIRST wallet when nothing is saved yet", () => {
    expect(evaluateSavedWalletCap([], "0xbd94cade097e50ac", 1).allowed).toBe(true);
  });

  it("treats a null cap as unlimited (checkFeatureQuota contract)", () => {
    const r = evaluateSavedWalletCap(oneDapperWallet, "0xa3d67b29e104e701", null);
    expect(r.allowed).toBe(true);
  });

  it("allows up to, and blocks beyond, a pro_trial cap of 5", () => {
    const five = ["0xa", "0xb", "0xc", "0xd", "0xe"].map((wallet_addr) => ({ wallet_addr }));
    expect(evaluateSavedWalletCap(five.slice(0, 4), "0xe", 5).allowed).toBe(true);
    expect(evaluateSavedWalletCap(five, "0xf", 5).allowed).toBe(false);
  });
});

// ── The "already saved?" comparison is chain-scoped (2026-09-20) ───────────
//
// ⚠ Folding BOTH sides looks symmetrical and is still wrong for base58: two
// DIFFERENT Candy wallets that differ only in case compared equal, and this
// function's `true` BLOCKS the save. The failure is a refusal to store a wallet
// the collector really owns — the same class as a false empty state, reached
// from the write side.
describe("walletAlreadySaved — base58 case is identity, not noise", () => {
  const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
  const CANDY_CASE_FLIP = CANDY.slice(0, -1) + "k" // a DIFFERENT wallet

  it("does not call a different base58 wallet 'already saved'", () => {
    expect(walletAlreadySaved([{ wallet_addr: CANDY }], CANDY_CASE_FLIP)).toBe(false)
  })

  it("still recognises the SAME base58 wallet", () => {
    expect(walletAlreadySaved([{ wallet_addr: CANDY }], CANDY)).toBe(true)
    expect(walletAlreadySaved([{ wallet_addr: `  ${CANDY}  ` }], CANDY)).toBe(true)
  })

  it("hex no-change arm: Flow stays case-insensitive", () => {
    expect(
      walletAlreadySaved([{ wallet_addr: "0xBD94CADE097E50AC" }], "0xbd94cade097e50ac"),
    ).toBe(true)
    expect(
      walletAlreadySaved([{ wallet_addr: " 0xbd94cade097e50ac " }], "0xBD94CADE097E50AC"),
    ).toBe(true)
  })
})

// ── 2026-09-25: five wallets per user, usernames included ──────────────────
describe("countDistinctWallets — base58 is not folded", () => {
  const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"
  const CANDY_CASE_FLIP = CANDY.slice(0, -1) + "k" // a DIFFERENT wallet

  it("counts two base58 wallets differing only in case as TWO", () => {
    expect(countDistinctWallets([{ wallet_addr: CANDY }, { wallet_addr: CANDY_CASE_FLIP }])).toBe(2)
  })

  it("counts a Flow wallet plus a Candy wallet as two", () => {
    expect(
      countDistinctWallets([{ wallet_addr: "0xbd94cade097e50ac" }, { wallet_addr: CANDY }]),
    ).toBe(2)
  })
})

describe("evaluateSavedWalletCap — the 5-wallet free cap", () => {
  const CANDY = "12J1uhKQcBYauomKvXDP2MA6msT3k8wx8oHHhV8gENAK"

  it("REGRESSION: a free user with one Flow wallet can add a Candy wallet at cap 5", () => {
    const r = evaluateSavedWalletCap([{ wallet_addr: "0xbd94cade097e50ac" }], CANDY, 5)
    expect(r.allowed).toBe(true)
    expect(r.distinctCount).toBe(1)
  })

  it("counts linked usernames toward the same cap", () => {
    const four = ["0xa", "0xb", "0xc", "0xd"].map((wallet_addr) => ({ wallet_addr }))
    expect(evaluateSavedWalletCap(four, "0xe", 5, 0).allowed).toBe(true)
    const r = evaluateSavedWalletCap(four, "0xe", 5, 1)
    expect(r.allowed).toBe(false)
    expect(r.distinctCount).toBe(5)
  })

  it("a re-save still passes when usernames fill the cap", () => {
    const four = ["0xa", "0xb", "0xc", "0xd"].map((wallet_addr) => ({ wallet_addr }))
    expect(evaluateSavedWalletCap(four, "0xa", 5, 3).allowed).toBe(true)
  })
})
