// lib/storage-fix/cadence.ts
//
// The ONLY transactions the admin storage-fix console (/admin/storage-fix) may ask a
// wallet to sign, plus the read-only script its check runs (Trevor, 2026-11-05: "have this
// all be internal, with this actual tool and sign in being behind admin page").
//
// Why a Dapper wallet needs its own transaction: a Dapper account has NO public
// /public/flowTokenReceiver, so an ordinary FLOW transfer has nowhere to land and a
// storage-capped account (error 1103, "storage limit check failed") cannot be topped up
// by a normal send. The only way in is Dapper's PrivateReceiverForwarder, and
// DapperStorageRent.fundedRefillV2 is the public door to it. Read on mainnet 2026-11-05
// (rest-mainnet `?expand=contracts`):
//   * DapperStorageRent @ 0xa08e88e23f332538 — fundedRefillV2(address, tokens) forwards the
//     ENTIRE vault passed in through PrivateReceiverForwarder.Sender and returns an EMPTY
//     vault, so the whole `amount` is spent (nothing comes back).
//   * PrivateReceiverForwarder @ 0x18eb4ee6b3c026d2 — sendPrivateTokens panics
//     "Could not borrow reference to private forwarder" when the recipient has no forwarder
//     at /public/privateForwardingPublic, i.e. is not a Dapper wallet. Trevor's two failed
//     refills (0x22e074e394d4df20, Jun 24 2025; 0xaa40b06e5c62d145, Apr 28 2026) were exactly
//     that. Those accounts take the PLAIN transfer below instead.
//
// DAPPER_REFILL_CADENCE is VERBATIM the transaction Trevor signed through run.flowty.io for
// every refill he ever sent (8 sealed, Apr–Sep 2025; text read back from his transaction
// 4d22f6d1… on 2026-11-05). run.flowty.io no longer answers (2026-11-05), which is why this
// console exists. Do not "tidy" it: pinned by __tests__/storage-fix-cadence.test.ts.

export const DAPPER_STORAGE_RENT_ADDRESS = "0xa08e88e23f332538"
export const PRIVATE_FORWARDER_ADDRESS = "0x18eb4ee6b3c026d2"
export const PRIVATE_FORWARDER_PUBLIC_PATH = "/public/privateForwardingPublic"

// The statements each transaction runs, shared VERBATIM with its simulation below, so the
// simulation is evidence about the exact text the wallet signs (the swap test's rule).
export const DAPPER_REFILL_BODY = `        let vaultRef = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)
          ?? panic("vault not found")

        let returned <- DapperStorageRent.fundedRefillV2(address: receiver, tokens: <-vaultRef!.withdraw(amount: amount) as! @FlowToken.Vault)
        vaultRef.deposit(from: <-returned)`

export const DAPPER_REFILL_CADENCE = `import DapperStorageRent from 0xa08e88e23f332538
import FlowToken from 0x1654653399040a61
import FungibleToken from 0xf233dcee88fe0abe

transaction(receiver: Address, amount: UFix64) {
    prepare(signer: auth(BorrowValue) &Account) {
${DAPPER_REFILL_BODY}
    }
}`

export const PLAIN_SEND_WITHDRAW = `        let vaultRef = signer.storage.borrow<auth(FungibleToken.Withdraw) &FlowToken.Vault>(from: /storage/flowTokenVault)
            ?? panic("The signer has no FLOW vault at /storage/flowTokenVault")`
export const PLAIN_SEND_DEPOSIT = `        let receiverRef = getAccount(receiver).capabilities.borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver)
            ?? panic("The receiver has no FLOW receiver at /public/flowTokenReceiver")`

// A plain FLOW transfer into the recipient's default receiver, for an account that HAS one
// (anything that is not a Dapper wallet). Panics, reverting everything, when the receiver
// is missing — it never sends FLOW anywhere but `receiver`'s own vault.
export const PLAIN_SEND_CADENCE = `import FungibleToken from 0xf233dcee88fe0abe
import FlowToken from 0x1654653399040a61

transaction(receiver: Address, amount: UFix64) {
    let sentVault: @{FungibleToken.Vault}

    prepare(signer: auth(BorrowValue) &Account) {
${PLAIN_SEND_WITHDRAW}
        self.sentVault <- vaultRef.withdraw(amount: amount)
    }

    execute {
${PLAIN_SEND_DEPOSIT}
        receiverRef.deposit(from: <-self.sentVault)
    }
}`

// ── Simulations: the same statements as a read-only SCRIPT ───────────────────
// A script may borrow any account's storage through getAuthAccount and NEVER commits, so
// running the fix with the operator's own address as `signer` proves, on mainnet state,
// that the exact statements execute and how much capacity the receiver gains — before
// the wallet opens. Measured 2026-11-05: the Dapper refill of 0.02 FLOW took Andrew's
// 0x9124… from 6,100,000 to 8,100,000 bytes; each text reverts on the OTHER kind of account.
const simulation = (imports: string, body: string) => `${imports}

access(all) fun main(signerAddr: Address, receiver: Address, amount: UFix64): [UInt64] {
    let signer = getAuthAccount<auth(BorrowValue) &Account>(signerAddr)
    let before = getAccount(receiver).storage.capacity
${body}
    return [before, getAccount(receiver).storage.capacity]
}`

export const DAPPER_REFILL_SIMULATION = simulation(
  `import DapperStorageRent from 0xa08e88e23f332538
import FlowToken from 0x1654653399040a61
import FungibleToken from 0xf233dcee88fe0abe`,
  DAPPER_REFILL_BODY,
)

export const PLAIN_SEND_SIMULATION = simulation(
  `import FungibleToken from 0xf233dcee88fe0abe
import FlowToken from 0x1654653399040a61`,
  `${PLAIN_SEND_WITHDRAW}
        let sentVault <- vaultRef.withdraw(amount: amount)
${PLAIN_SEND_DEPOSIT}
        receiverRef.deposit(from: <-sentVault)`,
)

/** Both transactions are tiny; this bounds a wrong text, it is not a cost estimate. */
export const STORAGE_FIX_GAS_LIMIT = 999

/** The two texts a wallet may be asked to sign here, and nothing else. */
export const STORAGE_FIX_CADENCES: readonly string[] = [DAPPER_REFILL_CADENCE, PLAIN_SEND_CADENCE]

// Read-only: the account's storage state, which way FLOW can reach it, and the network's
// live storage price. Run at a block height by lib/storage-fix/check.ts.
export const STORAGE_STATE_SCRIPT = `import PrivateReceiverForwarder from 0x18eb4ee6b3c026d2
import FungibleToken from 0xf233dcee88fe0abe
import FlowStorageFees from 0xe467b9dd11fa00df

access(all) fun main(a: Address): [AnyStruct] {
    let acct = getAccount(a)
    let balance = acct.capabilities.borrow<&{FungibleToken.Balance}>(/public/flowTokenBalance)
    return [
        acct.storage.used,
        acct.storage.capacity,
        balance?.balance,
        acct.capabilities.borrow<&PrivateReceiverForwarder.Forwarder>(PrivateReceiverForwarder.PrivateReceiverPublicPath) != nil,
        acct.capabilities.borrow<&{FungibleToken.Receiver}>(/public/flowTokenReceiver) != nil,
        FlowStorageFees.storageMegaBytesPerReservedFLOW
    ]
}`

// Read-only, for the history search: just the capacity, cheapest to run at many heights.
export const STORAGE_CAPACITY_SCRIPT = `access(all) fun main(a: Address): UInt64 {
    return getAccount(a).storage.capacity
}`
