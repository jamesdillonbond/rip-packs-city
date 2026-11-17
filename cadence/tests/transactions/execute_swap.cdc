// transactions/execute_swap.cdc
import "RPCTradeEscrow"

transaction(tradeId: UInt64) {
    prepare(signer: &Account) {}
    execute {
        RPCTradeEscrow.executeSwap(tradeId: tradeId)
    }
}
