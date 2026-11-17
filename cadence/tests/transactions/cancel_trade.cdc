// transactions/cancel_trade.cdc
import "RPCTradeEscrow"

transaction(tradeId: UInt64, reason: String) {
    prepare(signer: &Account) {
        RPCTradeEscrow.cancelTrade(
            tradeId: tradeId,
            cancelledBy: signer.address,
            reason: reason
        )
    }
}
