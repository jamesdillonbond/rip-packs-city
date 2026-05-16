// transactions/admin_set_paused.cdc
//
// Pause or unpause the escrow contract. Only the contract account can
// run this (it's the only account where the Admin resource is stored).
//
// Requires the AdminOp entitlement on the borrow ref; signer is the
// contract account.

import "RPCTradeEscrow"

transaction(paused: Bool) {
    prepare(signer: auth(BorrowValue) &Account) {
        let admin = signer.storage.borrow<auth(RPCTradeEscrow.AdminOp) &RPCTradeEscrow.Admin>(
            from: RPCTradeEscrow.AdminStoragePath
        ) ?? panic("Admin resource not found at AdminStoragePath")
        admin.setPaused(paused)
    }
}
