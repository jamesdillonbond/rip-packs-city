// lib/swap-test/swap-wallet.ts
//
// The wallet half of the admin-only two-signer swap test (lib/swap-test/swap-cadence.ts;
// Trevor, 2026-10-03: "Do it all"). Imported ONLY by app/admin/swap-test/SwapTestClient.tsx
// (pinned by __tests__/no-client-wallet-connect.test.ts). RPC never holds a key.
//
// One browser session connects ONE wallet, and the swap needs two signatures, so:
//
//   INITIATOR (wallet A, the session that submits): fcl.mutate with authorizations
//   [wallet A, relayed B]. Wallet A is proposer and payer (or its wallet sponsors the
//   fee — whatever its pre-authz says). When FCL asks for B's PAYLOAD signature, the
//   relayed authorizer posts the signable to /api/admin/swap-test, waits for the
//   co-signer, and hands FCL the signature. Then wallet A signs and FCL submits.
//
//   CO-SIGNER (wallet B, another browser or a phone): reads the signable from the relay,
//   has wallet B sign it as an AUTHORIZER, and posts the signature back.
//
// The payload names authorizers by ADDRESS only, so B's key index is only needed for
// the signature entry; the relayed account takes the key the wallet actually used.
// The whole round trip must finish inside the transaction's reference-block window
// (~10 minutes), or the network rejects it and nothing moves.

import * as fcl from "@onflow/fcl"
import { initFcl } from "@/lib/chains/flow/flow"
import { SWAP_CADENCE, SWAP_GAS_LIMIT } from "@/lib/swap-test/swap-cadence"
import type { SwapPlan } from "@/lib/swap-test/plan"
import { errorText } from "@/lib/giveaways/view-format"
import {
  SealUnconfirmedError,
  SLOW_WALLET_MS,
  isExecutionError,
  slowWalletHint,
  startNetworkTrace,
  walletChannel,
  whenVisible,
} from "@/lib/giveaways/admin-wallet"

export { SealUnconfirmedError }

export { connectFlowWallet, disconnectFlowWallet } from "@/lib/giveaways/flow-wallet-connect"

// One connected wallet PER TAB. FCL keeps the current user in localStorage by default,
// which every tab of a browser profile shares, so a co-signer tab connecting wallet B
// would overwrite the stored session of the tab waiting on wallet A. Set before FCL's
// current-user actor first spawns (it reads the provider once, at spawn).
if (typeof window !== "undefined") fcl.config().put("fcl.storage", fcl.SESSION_STORAGE)

/* eslint-disable @typescript-eslint/no-explicit-any -- FCL's account/signable objects are untyped */

export const sansPrefix = (a: string) => String(a ?? "").toLowerCase().replace(/^0x/, "")

export interface RelayedSignature {
  signature: string
  keyId: number
}

export interface RelayIO {
  /** Stores the signable for the co-signer; resolves to the relay id. */
  post(cosigner: string, signable: Record<string, unknown>): Promise<string>
  /** Resolves when the co-signer has signed (or rejects on timeout/expiry). */
  waitForSignature(id: string): Promise<RelayedSignature>
  /** Called once the relay id exists, so the page can show the co-signer link. */
  onRelay(id: string): void
}

/** A JSON-safe copy of an FCL signable (drops the account objects' functions). */
export function relayable(signable: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(signable)) as Record<string, unknown>
}

/** The authorizer account FCL resolves for wallet B: its signature comes through the relay. */
export function relayedAuthorizer(cosigner: string, io: RelayIO) {
  const addr = sansPrefix(cosigner)
  return async (account: any) => ({
    ...account,
    addr,
    keyId: 0,
    sequenceNum: null,
    signature: null,
    resolve: null,
    async signingFunction(signable: any) {
      const id = await io.post(`0x${addr}`, relayable(signable))
      io.onRelay(id)
      const { signature, keyId } = await io.waitForSignature(id)
      // The payload names B only by address; the signature entry must carry the key
      // that actually signed. `signable.interaction` IS FCL's interaction object.
      const accounts = signable?.interaction?.accounts ?? {}
      for (const k of Object.keys(accounts)) {
        if (sansPrefix(accounts[k]?.addr) === addr && accounts[k]?.role?.authorizer) accounts[k].keyId = keyId
      }
      return { addr, keyId, signature }
    },
  })
}

export interface SendSwapOpts {
  /** Called once wallet A has sat silent for `slowMs`, with where to look. Never while waiting on the co-signer. */
  onSlow?: (hint: string) => void
  slowMs?: number
}

const SEAL_READ_ATTEMPTS = 3

/** Resolves to `fallback` if `p` has not settled within `ms`. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(fallback), ms)
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      () => (clearTimeout(t), resolve(fallback)),
    )
  })
}

/**
 * Initiator: wallet A must be connected. Resolves once the transaction SEALS without
 * error. A transaction that was SUBMITTED but whose seal couldn't be read throws a
 * SealUnconfirmedError (it may well have executed: never say "failed", never resend).
 * The stall hint (shared with the giveaway console) fires only while waiting on wallet
 * A — minutes spent waiting on the co-signer are expected, not a stall.
 */
export async function sendSwap(plan: SwapPlan, io: RelayIO, opts: SendSwapOpts = {}): Promise<{ txId: string }> {
  initFcl()
  const user = (await fcl.currentUser.snapshot()) as { addr?: string | null }
  if (sansPrefix(user?.addr ?? "") !== sansPrefix(plan.a.signer)) {
    throw new Error(`Connect side A's wallet (${plan.a.signer}) first; this session is connected to ${user?.addr ?? "nothing"}.`)
  }
  const trace = startNetworkTrace()
  let onCosigner = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = () => {
    if (timer) clearTimeout(timer)
    if (!opts.onSlow) return
    timer = setTimeout(async () => {
      if (onCosigner) return
      const channel = await within(walletChannel(), 1_500, "unknown" as const)
      if (!onCosigner) opts.onSlow?.(slowWalletHint(channel, trace.waitingOn(), trace.blocked(), { seen: trace.seen(), logged: trace.logged() }))
    }, opts.slowMs ?? SLOW_WALLET_MS)
  }
  const relay: RelayIO = {
    post: (c, sgn) => {
      onCosigner = true
      if (timer) clearTimeout(timer)
      return io.post(c, sgn)
    },
    onRelay: (id) => io.onRelay(id),
    waitForSignature: async (id) => {
      const sig = await io.waitForSignature(id)
      // back to wallet A (its envelope approval, when it pays the fee)
      onCosigner = false
      arm()
      return sig
    },
  }
  arm()
  let txId: string
  try {
    txId = await fcl.mutate({
      cadence: SWAP_CADENCE,
      args: (arg: typeof fcl.arg, t: typeof fcl.t) => [
        arg(plan.a.source, t.Address),
        arg(plan.a.ctl, t.UInt64),
        arg(plan.a.ids, t.Array(t.UInt64)),
        arg(plan.b.source, t.Address),
        arg(plan.b.ctl, t.UInt64),
        arg(plan.b.ids, t.Array(t.UInt64)),
      ],
      // order matters: prepare(a, b) — wallet A first, the relayed wallet B second
      authorizations: [fcl.currentUser.authorization, relayedAuthorizer(plan.b.signer, relay)] as any,
      limit: SWAP_GAS_LIMIT,
    })
  } catch (e) {
    // "Load failed" alone names no request; say which one died (or was blocked)
    throw new Error(errorText(e) + trace.describe())
  } finally {
    if (timer) clearTimeout(timer)
    trace.stop()
  }
  let lastReadError = ""
  for (let attempt = 1; attempt <= SEAL_READ_ATTEMPTS; attempt++) {
    let sealed: { errorMessage?: string; statusCode?: number }
    try {
      await whenVisible()
      sealed = (await fcl.tx(txId).onceSealed()) as { errorMessage?: string; statusCode?: number }
    } catch (e) {
      // FCL rejects onceSealed with a TransactionError when the transaction EXECUTED and reverted
      if (isExecutionError(e)) throw new Error(`Transaction ${txId} failed: ${errorText(e)}`)
      lastReadError = errorText(e)
      continue
    }
    if (sealed?.errorMessage || (sealed?.statusCode ?? 0) !== 0) {
      throw new Error(`Transaction ${txId} failed: ${sealed?.errorMessage || `status ${sealed?.statusCode}`}`)
    }
    return { txId }
  }
  throw new SealUnconfirmedError(txId, lastReadError)
}

/** The composite signature a wallet returns, in either shape FCL services use. */
export function readComposite(out: any, fallbackKeyId: unknown): RelayedSignature {
  const c = out?.data && !out?.signature ? out.data : out
  const signature = sansPrefix(c?.signature ?? c?.sig ?? "")
  const keyId = Number(c?.keyId ?? fallbackKeyId)
  if (!/^[0-9a-f]{128}$/.test(signature)) throw new Error("The wallet returned no signature.")
  if (!Number.isInteger(keyId) || keyId < 0) throw new Error("The wallet's signature carries no key index.")
  return { signature, keyId }
}

/** Co-signer: wallet B must be connected. Signs the relayed signable as an authorizer. */
export async function coSign(signable: any, cosigner: string): Promise<RelayedSignature> {
  initFcl()
  if (signable?.cadence !== SWAP_CADENCE) throw new Error("This request is not the swap-test transaction; refusing to sign.")
  const want = sansPrefix(cosigner)
  const user = (await fcl.currentUser.snapshot()) as { addr?: string | null }
  if (sansPrefix(user?.addr ?? "") !== want) {
    throw new Error(`Connect side B's wallet (0x${want}) first; this session is connected to ${user?.addr ?? "nothing"}.`)
  }
  const role = { proposer: false, authorizer: true, payer: false, param: false }
  const base: any = await (fcl.currentUser.authorization as any)({ kind: "ACCOUNT", tempId: "CURRENT_USER", role })
  let accounts: any[] = [base]
  if (typeof base?.resolve === "function") {
    const { resolve, ...rest } = base
    const pre = {
      f_type: "PreSignable",
      f_vsn: "1.0.1",
      roles: role,
      cadence: signable.cadence,
      args: signable.args,
      data: {},
      interaction: signable.interaction,
      voucher: signable.voucher,
    }
    const resolved = await resolve({ ...rest, role }, pre)
    accounts = (Array.isArray(resolved) ? resolved : [resolved]).flat()
  }
  const mine =
    accounts.find((a) => sansPrefix(a?.addr) === want && a?.role?.authorizer) ?? accounts.find((a) => sansPrefix(a?.addr) === want)
  if (!mine || typeof mine.signingFunction !== "function") throw new Error("The wallet offered no way to sign as side B.")
  const out = await mine.signingFunction({ ...signable, addr: want, keyId: mine.keyId, roles: role })
  return readComposite(out, mine.keyId)
}
