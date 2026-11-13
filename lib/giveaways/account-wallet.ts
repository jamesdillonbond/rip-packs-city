// lib/giveaways/account-wallet.ts
//
// The Top Shot wallet already saved on a signed-in RPC account, so a winner can
// claim with one click instead of typing a username or connecting Flow Wallet
// (Trevor, 2026-11-10: "They should just be able to be logged in, the wallet is
// already confirmed to be them, and they just claim from there").
//
// An account holds ONE Dapper wallet (2026-11-07 rule), saved per collection in
// `saved_wallets`. The drop's collection picks the row. Three answers, never
// two: a wallet · none on the account · the read failed (thrown, so the caller
// reports "try again", never "you have no wallet"). More than one distinct
// Flow wallet for the collection is `none` with reason "ambiguous": the claimer
// then picks with the username / Flow Wallet paths, and nothing is guessed.

const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/

export type AccountWallet = { address: string; username: string | null }
export type AccountWalletResult = { wallet: AccountWallet } | { wallet: null; reason: "none" | "ambiguous" }

interface SavedWalletsReader {
  from(table: "saved_wallets"): {
    select(cols: string): {
      eq(col: string, v: string): {
        eq(col: string, v: string): PromiseLike<{ data: unknown; error: { message: string } | null }>
      }
    }
  }
}

export async function accountTopShotWallet(db: SavedWalletsReader, userId: string, collectionId: string): Promise<AccountWalletResult> {
  const { data, error } = await db.from("saved_wallets").select("wallet_addr, username").eq("user_id", userId).eq("collection_id", collectionId)
  if (error) throw new Error(`saved_wallets read failed: ${error.message}`)
  const rows = Array.isArray(data) ? (data as { wallet_addr?: unknown; username?: unknown }[]) : []
  const byAddress = new Map<string, string | null>()
  for (const r of rows) {
    // a Flow address: hex is case-insensitive, so lower-casing is safe HERE (lib/address.ts rules)
    const addr = typeof r.wallet_addr === "string" ? r.wallet_addr.trim().toLowerCase() : ""
    if (!FLOW_ADDRESS.test(addr)) continue
    const name = typeof r.username === "string" && r.username.trim() ? r.username.trim() : null
    if (!byAddress.has(addr) || (byAddress.get(addr) == null && name)) byAddress.set(addr, name)
  }
  if (byAddress.size === 0) return { wallet: null, reason: "none" }
  if (byAddress.size > 1) return { wallet: null, reason: "ambiguous" }
  const [[address, username]] = [...byAddress.entries()]
  return { wallet: { address, username } }
}

/**
 * 2026-11-13 (review): the username path names a wallet by a TYPED username, so a signed-in account
 * with no saved wallet could claim under someone else's Top Shot username — the pack then goes to that
 * wallet and its real owner's own claim answers "that account already claimed". Refuse the typed path
 * when the wallet is VERIFIED (proved, `verified_at`) on ANOTHER RPC account: its owner claims from there.
 * Only a verified row counts — anyone can save an address unproven, and that must not block the owner.
 * A failed read throws (the caller answers "try again", never "go ahead").
 */
export async function walletVerifiedElsewhere(db: unknown, userId: string, address: string): Promise<boolean> {
  const bare = address.toLowerCase().replace(/^0x/, "")
  const { data, error } = await (db as {
    from(t: "saved_wallets"): {
      select(c: string): {
        in(col: string, v: string[]): {
          not(col: string, op: string, v: null): {
            neq(col: string, v: string): { limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }> }
          }
        }
      }
    }
  })
    .from("saved_wallets")
    .select("user_id")
    .in("wallet_addr", [`0x${bare}`, bare])
    .not("verified_at", "is", null)
    .neq("user_id", userId)
    .limit(1)
  if (error) throw new Error(`saved_wallets verified read failed: ${error.message}`)
  return Array.isArray(data) && data.length > 0
}
