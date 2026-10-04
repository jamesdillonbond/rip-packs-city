// lib/giveaways/admin-wallet.ts
//
// The giveaway ADMIN's wallet actions: connect their own Flow Wallet (a Hybrid
// Custody parent of their Dapper account) and sign delivery batches. RPC never
// holds a key or a moment (Trevor, 2026-09-29). Connecting goes through
// lib/giveaways/flow-wallet-connect.ts, the one module that opens a wallet
// picker; only app/admin/giveaways/AdminGiveawaysClient.tsx imports this file
// (pinned by __tests__/no-client-wallet-connect.test.ts).

import * as fcl from "@onflow/fcl"
import { initFcl } from "@/lib/chains/flow/flow"
import { DELIVER_BATCH_CADENCE, DELIVER_GAS_LIMIT, DELIVER_OWN_BATCH_CADENCE } from "@/lib/giveaways/deliver-cadence"
import type { DeliveryBatch } from "@/lib/giveaways/deliver"
import { errorText } from "@/lib/giveaways/view-format"

export {
  DISCOVERY_AUTHN_ENDPOINT,
  WALLETCONNECT_PROJECT_ID,
  connectFlowWallet as connectAdminWallet,
  disconnectFlowWallet as disconnectAdminWallet,
  prepareWalletConnect,
} from "@/lib/giveaways/flow-wallet-connect"

export interface SentBatch {
  txId: string
}

/**
 * The transaction reached the network (it has an id) but its seal could not be
 * READ — e.g. iPhone Safari killed the status connection while the admin was in
 * the Flow Wallet app. It may well have executed: the console must say "check
 * Verify", never "NOT sent", or the admin re-sends a delivery that already went.
 */
export class SealUnconfirmedError extends Error {
  readonly txId: string
  constructor(txId: string, cause: string) {
    super(`Transaction ${txId} was submitted, but its result could not be read (${cause}). Do NOT send again: tap Verify deliveries.`)
    this.name = "SealUnconfirmedError"
    this.txId = txId
  }
}

const SEAL_READ_ATTEMPTS = 3

/**
 * Asks the connected wallet to sign one delivery batch, then waits for the
 * transaction to SEAL. Throws if the wallet declines or the transaction
 * reverts — a batch is only reported sent when the chain says it executed.
 * A failure to READ the seal of a submitted transaction is a SealUnconfirmedError.
 */
export async function sendDeliveryBatch(batch: DeliveryBatch): Promise<SentBatch> {
  initFcl()
  const trace = startNetworkTrace()
  let txId: string
  try {
    // "own": the connected Flow Wallet's own moments; "linked": a child account's, via Hybrid Custody
    txId = await fcl.mutate({
      cadence: batch.kind === "own" ? DELIVER_OWN_BATCH_CADENCE : DELIVER_BATCH_CADENCE,
      args: (arg: typeof fcl.arg, t: typeof fcl.t) =>
        batch.kind === "own"
          ? [arg(batch.momentIDs, t.Array(t.UInt64)), arg(batch.recipients, t.Array(t.Address))]
          : [
              arg(batch.source, t.Address),
              arg(batch.providerControllerID as string, t.UInt64),
              arg(batch.momentIDs, t.Array(t.UInt64)),
              arg(batch.recipients, t.Array(t.Address)),
            ],
      // proposer, payer and the single authorizer all default to the connected
      // wallet (fcl.currentUser) — the admin signs and pays the network fee.
      limit: DELIVER_GAS_LIMIT,
    })
  } catch (e) {
    // "Load failed" alone names no request; say which one died (or was blocked)
    throw new Error(errorText(e) + trace.describe())
  } finally {
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

function isExecutionError(e: unknown): boolean {
  const o = e as { type?: unknown; message?: unknown } | null
  return !!o && typeof o === "object" && (typeof o.type === "string" || /\[Error Code: \d+\]/.test(String(o.message ?? "")))
}

/** Resolves at once when the page is visible, else when the admin switches back to it. */
function whenVisible(): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden") return Promise.resolve()
  return new Promise((resolve) => {
    const on = () => {
      if (document.visibilityState === "hidden") return
      document.removeEventListener("visibilitychange", on)
      resolve()
    }
    document.addEventListener("visibilitychange", on)
  })
}

/**
 * Records, while a batch is being signed, every fetch that failed and every
 * request the page's Content-Security-Policy blocked — Safari reports both as a
 * bare "Load failed". Browser only; a no-op elsewhere.
 */
export function startNetworkTrace(): { describe: () => string; stop: () => void } {
  if (typeof window === "undefined" || typeof window.fetch !== "function") return { describe: () => "", stop: () => undefined }
  const failed: string[] = []
  const blocked: string[] = []
  const realFetch = window.fetch
  const traced: typeof fetch = async (input, init) => {
    try {
      return await realFetch.call(window, input, init)
    } catch (e) {
      failed.push(`${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${requestLabel(input)}`)
      throw e
    }
  }
  const onViolation = (ev: Event) => {
    const v = ev as SecurityPolicyViolationEvent
    blocked.push(`${v.blockedURI || "(unknown)"} by ${v.effectiveDirective || v.violatedDirective}`)
  }
  let wentHidden = document.visibilityState === "hidden"
  const onVisibility = () => {
    if (document.visibilityState === "hidden") wentHidden = true
  }
  window.fetch = traced
  document.addEventListener("securitypolicyviolation", onViolation)
  document.addEventListener("visibilitychange", onVisibility)
  return {
    describe: () =>
      (failed.length ? ` · request failed: ${[...new Set(failed)].join(", ")}` : "") +
      (blocked.length ? ` · blocked by the page's security policy: ${[...new Set(blocked)].join(", ")}` : "") +
      (wentHidden && (failed.length || blocked.length) ? " · the page was in the background meanwhile (iOS can cut its connections)" : ""),
    stop: () => {
      if (window.fetch === traced) window.fetch = realFetch
      document.removeEventListener("securitypolicyviolation", onViolation)
      document.removeEventListener("visibilitychange", onVisibility)
    },
  }
}

function requestLabel(input: RequestInfo | URL): string {
  try {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
    return u.host + u.pathname
  } catch {
    return "(unparseable url)"
  }
}
