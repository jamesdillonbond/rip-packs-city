// transactions/reclaim_expired.cdc
import "RPCTradeEscrow"

transaction(tradeId: UInt64) {
    prepare(signer: &Account) {}
    execute {
        RPCTradeEscrow.reclaimExpired(tradeId: tradeId)
    }
}
