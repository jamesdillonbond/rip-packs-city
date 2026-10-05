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

/** How long a wallet prompt may sit unanswered before the console says where to look. */
export const SLOW_WALLET_MS = 20_000

export type WalletChannel = "phone" | "extension" | "popup" | "unknown"

/**
 * WHERE the connected wallet will ask for approval, from FCL's authz service
 * method. Over WalletConnect (a QR-code connection) the request goes to the
 * Flow Wallet app on the PHONE, so a desktop page just waits with nothing on
 * screen (Trevor, test2, 2026-10-04: "It's not doing anything now").
 */
export function channelOf(services: unknown): WalletChannel {
  const list = Array.isArray(services) ? (services as Array<{ type?: unknown; method?: unknown }>) : []
  const authz = list.find((s) => s?.type === "authz") ?? list.find((s) => s?.type === "authn")
  const m = String(authz?.method ?? "")
  if (m === "WC/RPC") return "phone"
  if (m === "EXT/RPC") return "extension"
  if (m === "POP/RPC" || m === "TAB/RPC" || m === "HTTP/POST" || m === "IFRAME/RPC") return "popup"
  return "unknown"
}

export async function walletChannel(): Promise<WalletChannel> {
  try {
    const user = (await fcl.currentUser.snapshot()) as { services?: unknown }
    return channelOf(user?.services)
  } catch {
    return "unknown"
  }
}

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

export interface WalletTraceExtra {
  /** FCL message types seen on the page while waiting ("FCL:VIEW:READY", …). */
  seen?: string[]
  /** What FCL or the wallet LOGGED (console.error/warn) without rejecting. */
  logged?: string[]
}

/** Where to look, said once a prompt has gone unanswered for SLOW_WALLET_MS. */
export function slowWalletHint(channel: WalletChannel, waitingOn: string[], blocked: string[], extra: WalletTraceExtra = {}): string {
  const seen = extra.seen ?? []
  const logged = extra.logged ?? []
  const where =
    channel === "extension" && seen.length === 0
      ? "The Flow Wallet extension has not answered this page at all. Click its toolbar icon and unlock it if asked; if no request is waiting there, reload the extension (chrome://extensions → Flow Wallet → reload), reload this page, and try again."
      : channel === "phone"
      ? "Open the Flow Wallet app on your phone: you connected by QR code, so the approval is waiting there."
      : channel === "extension"
        ? "Click the Flow Wallet extension icon in your browser toolbar: its approval window may be behind this one."
        : channel === "popup"
          ? "Your browser may have blocked the wallet's popup: look for a blocked-popup icon in the address bar and allow it."
          : "Check your Flow Wallet (the phone app, or the browser extension icon) for an approval request."
  return (
    where +
    (waitingOn.length ? ` Still waiting on: ${waitingOn.join(", ")}.` : "") +
    (blocked.length ? ` Blocked by the page's security policy: ${blocked.join(", ")}.` : "") +
    (seen.length ? ` Wallet messages seen: ${seen.join(", ")}.` : "") +
    (logged.length ? ` Logged: ${logged.join(" | ")}` : "")
  )
}

/**
 * Asks the connected wallet to sign one delivery batch, then waits for the
 * transaction to SEAL. Throws if the wallet declines or the transaction
 * reverts — a batch is only reported sent when the chain says it executed.
 * A failure to READ the seal of a submitted transaction is a SealUnconfirmedError.
 */
export async function sendDeliveryBatch(batch: DeliveryBatch, opts: { onSlow?: (hint: string) => void; slowMs?: number } = {}): Promise<SentBatch> {
  initFcl()
  const trace = startNetworkTrace()
  // the timer starts FIRST: whatever stalls after this point, the admin still hears where to look
  let channel: WalletChannel = "unknown"
  const slow = opts.onSlow
    ? setTimeout(
        () => opts.onSlow?.(slowWalletHint(channel, trace.waitingOn(), trace.blocked(), { seen: trace.seen(), logged: trace.logged() })),
        opts.slowMs ?? SLOW_WALLET_MS,
      )
    : null
  let txId: string
  try {
    channel = await within(walletChannel(), 1_500, "unknown")
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
    if (slow) clearTimeout(slow)
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
export interface NetworkTrace {
  describe: () => string
  stop: () => void
  waitingOn: () => string[]
  blocked: () => string[]
  seen: () => string[]
  logged: () => string[]
}

const MAX_LOGGED = 3

export function startNetworkTrace(): NetworkTrace {
  if (typeof window === "undefined" || typeof window.fetch !== "function") {
    return { describe: () => "", stop: () => undefined, waitingOn: () => [], blocked: () => [], seen: () => [], logged: () => [] }
  }
  // FCL talks to an extension or popup by window messages; which ones arrived says how far it got
  const seenTypes = new Set<string>()
  const onMessage = (ev: Event) => {
    const t = (ev as MessageEvent).data?.type
    if (typeof t === "string" && t.startsWith("FCL:")) seenTypes.add(t)
  }
  // FCL reports some failures only to the console and keeps waiting; keep the first few
  const loggedLines: string[] = []
  const realError = console.error
  const realWarn = console.warn
  const capture = (real: (...a: unknown[]) => void) =>
    function (this: unknown, ...a: unknown[]) {
      if (loggedLines.length < MAX_LOGGED) {
        loggedLines.push(
          a
            .map((x) => (x instanceof Error ? x.message : typeof x === "string" ? x : (() => { try { return JSON.stringify(x) } catch { return String(x) } })()))
            .join(" ")
            .replace(/\s+/g, " ")
            .slice(0, 200),
        )
      }
      real.apply(console, a)
    }
  const tracedError = capture(realError)
  const tracedWarn = capture(realWarn)
  console.error = tracedError
  console.warn = tracedWarn
  const canListen = typeof window.addEventListener === "function"
  if (canListen) window.addEventListener("message", onMessage)
  const failed: string[] = []
  const blocked: string[] = []
  // requests sent and not yet answered: what a silent wait is actually waiting on
  const inflight = new Map<number, string>()
  let seq = 0
  const realFetch = window.fetch
  const traced: typeof fetch = async (input, init) => {
    const label = `${(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()} ${requestLabel(input)}`
    const id = ++seq
    inflight.set(id, label)
    try {
      return await realFetch.call(window, input, init)
    } catch (e) {
      failed.push(label)
      throw e
    } finally {
      inflight.delete(id)
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
    waitingOn: () => [...new Set(inflight.values())],
    blocked: () => [...new Set(blocked)],
    seen: () => [...seenTypes],
    logged: () => [...loggedLines],
    stop: () => {
      if (window.fetch === traced) window.fetch = realFetch
      if (console.error === tracedError) console.error = realError
      if (console.warn === tracedWarn) console.warn = realWarn
      if (canListen) window.removeEventListener("message", onMessage)
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
