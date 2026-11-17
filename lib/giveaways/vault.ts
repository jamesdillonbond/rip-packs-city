// lib/giveaways/vault.ts
//
// INSTANT delivery from the giveaway vault (Trevor, 2026-11-08: "Is there a way
// for the moments to instantly flow to the pack openers upon opening the pack?"
// → "Do what makes sense and proceed with it all the way through"). Server-only.
//
// The vault is a plain Flow account, separate from every other RPC key, that
// holds only the pools of drops their sponsor chose to FUND. Its key lives in
// three env vars; without all three — or without RPC_GIVEAWAY_INSTANT_DELIVERY=1,
// the kill switch — nothing here signs, and every drop keeps the sponsor-signed
// "Deliver all" path exactly as before.
//
// Configured in Vercel Production 2026-11-08 (PT): the vault is 0x38300125d58f76d1, key
// index 0 (secp256k1/SHA2-256, verified on chain); the key itself is a Sensitive env var.
//
//   GIVEAWAY_VAULT_ADDR         0x… of the vault (a plain account: no Hybrid Custody, no linking)
//   GIVEAWAY_VAULT_PRIVATE_KEY  its ECDSA_secp256k1 key (hex) — Vercel "sensitive"
//   GIVEAWAY_VAULT_KEY_INDEX    the key's index on the account
//   RPC_GIVEAWAY_INSTANT_DELIVERY=1   the switch; unset it to stop every vault send at once
//
// What the vault is ever asked to sign (lib/giveaways/vault-cadence.ts):
//   * its one-time Top Shot collection setup;
//   * DELIVER_OWN_BATCH_CADENCE moving Moments to recipients the DATABASE chose
//     (reserve_giveaway_vault_send): a claim's recorded recipient, or a Moment's
//     own funded_from once its drop has closed unclaimed. No request names a
//     recipient. Every batch is simulated against live mainnet state first, and a
//     Moment the vault no longer holds cannot be sent twice — the withdraw fails.

import type { SupabaseClient } from "@supabase/supabase-js"
import * as fcl from "@onflow/fcl"
import * as t from "@onflow/types"
import { buildKeyAuthz, configureFcl } from "@/lib/breaks/server-authz"
import { DELIVER_GAS_LIMIT, DELIVER_OWN_BATCH_CADENCE, DELIVER_OWN_SIMULATION_SCRIPT, MAX_DELIVERY_BATCH } from "@/lib/giveaways/deliver-cadence"
import { VAULT_SETUP_CADENCE, VAULT_SETUP_SIMULATION_SCRIPT, VAULT_STATUS_SCRIPT } from "@/lib/giveaways/vault-cadence"
import { addr, arrayOf, runFlowScript, u64, type CdcValue } from "@/lib/giveaways/flow-script"
import { readTopShotHoldings, type Holding } from "@/lib/giveaways/topshot-holdings"
import { chunk } from "@/lib/giveaways/deliver"
import { getPool, GiveawayError, verifyDeliveries, type DropRow } from "@/lib/giveaways/store"

const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/
const SEAL_TIMEOUT_MS = 45_000

export interface VaultConfig {
  addr: string
  pk: string
  keyIndex: number
}

/** The vault's key from env, or null when any part is missing or malformed. Never logs the key. */
export function vaultConfig(env: NodeJS.ProcessEnv = process.env): VaultConfig | null {
  const a = (env.GIVEAWAY_VAULT_ADDR ?? "").trim().toLowerCase()
  const pk = (env.GIVEAWAY_VAULT_PRIVATE_KEY ?? "").trim().replace(/^0x/, "")
  const idx = Number.parseInt(env.GIVEAWAY_VAULT_KEY_INDEX ?? "", 10)
  if (!FLOW_ADDRESS.test(a) || !/^[0-9a-f]{64}$/i.test(pk) || !Number.isInteger(idx) || idx < 0) return null
  return { addr: a, pk, keyIndex: idx }
}

/** The vault address only — safe to show the admin. */
export function vaultAddress(env: NodeJS.ProcessEnv = process.env): string | null {
  return vaultConfig(env)?.addr ?? null
}

/** Instant delivery runs only with a complete key AND the switch on. */
export function instantDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return vaultConfig(env) != null && env.RPC_GIVEAWAY_INSTANT_DELIVERY === "1"
}

export interface VaultStatus {
  configured: boolean
  enabled: boolean
  address: string | null
  /** null = no Top Shot collection yet (run setup). */
  topshot_held: number | null
  flow_balance: string | null
  storage_used: number | null
  storage_capacity: number | null
}

function strings(v: CdcValue): string[] {
  if (v?.type !== "Array" || !Array.isArray(v.value)) throw new GiveawayError("The vault status read returned an unexpected shape.", 502, "flow_shape")
  return (v.value as CdcValue[]).map((x) => String(x.value))
}

export async function vaultStatus(run: typeof runFlowScript = runFlowScript, env: NodeJS.ProcessEnv = process.env): Promise<VaultStatus> {
  const cfg = vaultConfig(env)
  const base = { configured: cfg != null, enabled: instantDeliveryEnabled(env), address: cfg?.addr ?? null }
  if (!cfg) return { ...base, topshot_held: null, flow_balance: null, storage_used: null, storage_capacity: null }
  const [held, balance, used, capacity] = strings(await run(VAULT_STATUS_SCRIPT, [addr(cfg.addr)]))
  return {
    ...base,
    topshot_held: held === "-1" ? null : Number(held),
    flow_balance: balance,
    storage_used: Number(used),
    storage_capacity: Number(capacity),
  }
}

type Submit = (cadence: string, args: (arg: typeof fcl.arg, types: typeof t) => unknown[], cfg: VaultConfig) => Promise<string>

/** Sign and submit as the vault; resolves to the tx id once SEALED without an error, else throws (the message is Flow's). */
export const submitAsVault: Submit = async (cadence, args, cfg) => {
  configureFcl()
  const authz = buildKeyAuthz(cfg)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txId: string = await (fcl.mutate as any)({
    cadence,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    args: (arg: any) => args(arg, t),
    proposer: authz,
    payer: authz,
    authorizations: [authz],
    limit: DELIVER_GAS_LIMIT,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sealed: any = await Promise.race([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fcl.tx(txId) as any).onceSealed(),
    new Promise((_, reject) => setTimeout(() => reject(new VaultSealUnknownError(txId)), SEAL_TIMEOUT_MS)),
  ])
  if (sealed?.errorMessage) throw new Error(`tx ${txId}: ${String(sealed.errorMessage).slice(0, 300)}`)
  return txId
}

/** Submitted, but its seal was not read in time: it MAY have executed. Never "not sent". */
export class VaultSealUnknownError extends Error {
  constructor(readonly txId: string) {
    super(`tx ${txId} submitted; its seal was not read in time (it may still land — Verify reads the chain)`)
    this.name = "VaultSealUnknownError"
  }
}

export interface VaultDeps {
  run?: typeof runFlowScript
  submit?: Submit
  read?: (address: string, ids: string[]) => Promise<Record<string, Holding>>
  env?: NodeJS.ProcessEnv
}

function requireEnabled(env: NodeJS.ProcessEnv): VaultConfig {
  const cfg = vaultConfig(env)
  if (!cfg) throw new GiveawayError("The giveaway vault is not configured (GIVEAWAY_VAULT_ADDR / _PRIVATE_KEY / _KEY_INDEX).", 409, "vault_unconfigured")
  if (env.RPC_GIVEAWAY_INSTANT_DELIVERY !== "1") {
    throw new GiveawayError("Instant delivery is switched off (RPC_GIVEAWAY_INSTANT_DELIVERY is not 1).", 409, "vault_disabled")
  }
  return cfg
}

/** One-time: give the vault a Top Shot collection (simulated first). Returns the tx id, or null when it already has one. */
export async function setUpVault(deps: VaultDeps = {}): Promise<string | null> {
  const env = deps.env ?? process.env
  const run = deps.run ?? runFlowScript
  const cfg = requireEnabled(env)
  const status = await vaultStatus(run, env)
  if (status.topshot_held != null) return null
  const sim = await run(VAULT_SETUP_SIMULATION_SCRIPT, [addr(cfg.addr)])
  if (sim?.value !== true) throw new GiveawayError("The simulated vault setup did not produce a Top Shot collection; nothing was sent.", 409, "simulation_failed")
  return (deps.submit ?? submitAsVault)(VAULT_SETUP_CADENCE, () => [], cfg)
}

/**
 * After the sponsor's wallet has moved the pool into the vault: read the chain,
 * and only if the vault holds EVERY undelivered pool Moment (unlocked), record
 * the drop as funded. A partial funding records nothing and says what's missing.
 */
export async function confirmFunding(db: SupabaseClient, drop: DropRow, deps: VaultDeps = {}): Promise<{ moved: number }> {
  const env = deps.env ?? process.env
  const cfg = requireEnabled(env)
  if (drop.status !== "sealed" && drop.status !== "open") {
    throw new GiveawayError(`Only a sealed or open drop can be funded (this one is ${drop.status}).`, 409, "wrong_status")
  }
  const pool = (await getPool(db, drop.id)).filter((m) => m.delivered_at == null)
  if (pool.length === 0) throw new GiveawayError("Every Moment in this drop is already delivered.", 409, "nothing_to_fund")
  const holdings = await (deps.read ?? readTopShotHoldings)(cfg.addr, pool.map((m) => m.moment_id))
  const missing = pool.filter((m) => !holdings[m.moment_id]?.held).map((m) => m.moment_id)
  const locked = pool.filter((m) => holdings[m.moment_id]?.held && holdings[m.moment_id]?.locked !== false).map((m) => m.moment_id)
  if (missing.length) throw new GiveawayError(`The vault doesn't hold ${missing.length} pool Moment(s) yet: ${missing.join(", ")}`, 409, "vault_incomplete")
  if (locked.length) throw new GiveawayError(`Locked in the vault (can't be sent): ${locked.join(", ")}`, 409, "vault_locked")
  const { data, error } = await db.rpc("mark_giveaway_vault_funded", { p_drop_id: drop.id, p_vault: cfg.addr })
  if (error) {
    if (error.code === "22023") throw new GiveawayError(error.message, 409, "refused")
    throw error
  }
  return { moved: Number(data ?? 0) }
}

export interface VaultSendReport {
  reserved: number
  sent: number
  tx_ids: string[]
  /** Batches whose seal was not read in time: they may have landed. */
  unknown: string[]
  failed: { moment_ids: string[]; error: string }[]
}

async function recordAttempt(db: SupabaseClient, dropId: string, ids: string[], patch: { delivery_tx_id?: string | null; delivery_error?: string | null }): Promise<void> {
  const { error } = await db.from("giveaway_pack_moments").update(patch).eq("drop_id", dropId).in("moment_id", ids)
  // the chain is the record of delivery; a failed note is reported, never a reason to resend
  if (error) console.log(`[giveaway-vault] attempt note failed drop=${dropId}: ${error.message}`)
}

/**
 * Send from the vault whatever reserve_giveaway_vault_send hands out: a claimed
 * pack's Moments (packNo, or every claimed pack when null), or — `returnUnclaimed`
 * on a CLOSED drop — the unclaimed Moments back to where each was funded from.
 * Then Verify reads the chain and stamps what arrived.
 */
export async function sendFromVault(
  db: SupabaseClient,
  drop: DropRow,
  opts: { packNo?: number | null; returnUnclaimed?: boolean } = {},
  deps: VaultDeps = {},
): Promise<VaultSendReport> {
  const env = deps.env ?? process.env
  const run = deps.run ?? runFlowScript
  const submit = deps.submit ?? submitAsVault
  const cfg = requireEnabled(env)
  if (drop.vault_address !== cfg.addr) {
    throw new GiveawayError("This drop's pool is not in the configured vault.", 409, "not_funded")
  }
  const { data, error } = await db.rpc("reserve_giveaway_vault_send", {
    p_drop_id: drop.id,
    p_pack_no: opts.packNo ?? null,
    p_return: opts.returnUnclaimed === true,
  })
  if (error) {
    if (error.code === "22023") throw new GiveawayError(error.message, 409, "refused")
    throw error
  }
  const rows = ((data ?? []) as { moment_id: string; recipient: string }[]).filter((r) => FLOW_ADDRESS.test(r.recipient))
  const report: VaultSendReport = { reserved: rows.length, sent: 0, tx_ids: [], unknown: [], failed: [] }
  for (const part of chunk(rows, MAX_DELIVERY_BATCH)) {
    const ids = part.map((r) => r.moment_id)
    const recipients = part.map((r) => r.recipient)
    try {
      const sim = await run(DELIVER_OWN_SIMULATION_SCRIPT, [addr(cfg.addr), arrayOf(ids.map(u64)), arrayOf(recipients.map(addr))])
      const ok = sim?.type === "Array" && Array.isArray(sim.value) && (sim.value as CdcValue[]).length === ids.length && (sim.value as CdcValue[]).every((x) => x.value === true)
      if (!ok) throw new Error("the simulated transfer did not land every Moment; nothing was sent")
      const txId = await submit(
        DELIVER_OWN_BATCH_CADENCE,
        (arg, types) => [arg(ids, types.Array(types.UInt64)), arg(recipients, types.Array(types.Address))],
        cfg,
      )
      report.sent += ids.length
      report.tx_ids.push(txId)
      await recordAttempt(db, drop.id, ids, { delivery_tx_id: txId, delivery_error: null })
    } catch (e) {
      if (e instanceof VaultSealUnknownError) {
        report.unknown.push(e.txId)
        await recordAttempt(db, drop.id, ids, { delivery_tx_id: e.txId, delivery_error: "seal not read in time; Verify reads the chain" })
      } else {
        const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500)
        report.failed.push({ moment_ids: ids, error: msg })
        await recordAttempt(db, drop.id, ids, { delivery_error: msg })
      }
    }
  }
  // 2026-11-13 (review): on `reserved`, not `sent` — a return whose seal was not read in time (unknown) skipped
  // this, and a later retry fails simulation (the vault no longer holds it), so `source_wallet` pointed at the vault
  // forever. markReturned reads the chain itself, so running it on an unconfirmed send is safe.
  if (opts.returnUnclaimed && report.reserved > 0) await markReturned(db, drop, deps)
  if (report.reserved > 0 && !opts.returnUnclaimed) {
    // stamp what arrived (and leave the rest for the lock window to retry)
    await verifyDeliveries(db, drop).catch((e) => console.log(`[giveaway-vault] verify after send failed: ${e instanceof Error ? e.message : String(e)}`))
  }
  return report
}

/** A returned Moment is the sponsor's again: point its source back at where it came from. */
export async function markReturned(db: SupabaseClient, drop: DropRow, deps: VaultDeps = {}): Promise<{ returned: number }> {
  const pool = (await getPool(db, drop.id)).filter((m) => m.source_wallet === drop.vault_address && m.funded_from && m.delivered_at == null)
  if (pool.length === 0) return { returned: 0 }
  const read = deps.read ?? readTopShotHoldings
  const byOrigin = new Map<string, string[]>()
  for (const m of pool) byOrigin.set(m.funded_from as string, [...(byOrigin.get(m.funded_from as string) ?? []), m.moment_id])
  let returned = 0
  for (const [origin, ids] of byOrigin) {
    const h = await read(origin, ids)
    const home = ids.filter((id) => h[id]?.held)
    if (home.length === 0) continue
    const { error } = await db
      .from("giveaway_pack_moments")
      .update({ source_wallet: origin, delivery_error: null })
      .eq("drop_id", drop.id)
      .in("moment_id", home)
    if (error) throw error
    returned += home.length
  }
  return { returned }
}
