// tests/cadence/stubs/DapperUtilityCoin.cdc
//
// TYPE-SHAPE MIRROR, NOT BEHAVIORAL MIRROR.
// For Cadence type-checker resolution only — never deploy this anywhere.
//
// The production contract at mainnet 0xead892083b3e2c6c is closed-source
// (Dapper Wallet's internal stablecoin) and is not legitimately
// installable via `flow dependencies install`. This stub exposes only
// the surface area that lib/cadence/purchase-moment.ts references:
//   - The DUC contract conforms to FungibleToken so that DUC.Vault
//     inherits the FungibleToken.Withdraw entitlement.
//   - DUC.Vault conforms to FungibleToken.Vault so that production code
//     compiles against `auth(FungibleToken.Withdraw) &DapperUtilityCoin.Vault`.
//   - withdraw() returns @{FungibleToken.Vault}; production force-casts
//     the result to @DapperUtilityCoin.Vault, which is permitted because
//     this stub only ever creates DUC.Vault instances.
//   - createEmptyVault(vaultType:) for FungibleToken interface compliance.
//
// The /storage/dapperUtilityCoinVault path is referenced by the production
// transaction; the path itself is just a Cadence path literal and does not
// require any contract-side declaration.
//
// Behavioral fidelity (real DUC permission gates, Dapper co-signer logic,
// real merchant routing) is intentionally absent. Type-checking only.

import "FungibleToken"

access(all) contract DapperUtilityCoin: FungibleToken {

    access(all) var totalSupply: UFix64

    access(all) resource Vault: FungibleToken.Vault {

        access(all) var balance: UFix64

        init(balance: UFix64) {
            self.balance = balance
        }

        access(contract) fun burnCallback() {
            self.balance = 0.0
        }

        access(all) view fun getSupportedVaultTypes(): {Type: Bool} {
            return { self.getType(): true }
        }

        access(all) view fun isSupportedVaultType(type: Type): Bool {
            return type == self.getType()
        }

        access(all) view fun isAvailableToWithdraw(amount: UFix64): Bool {
            return amount <= self.balance
        }

        access(FungibleToken.Withdraw) fun withdraw(amount: UFix64): @{FungibleToken.Vault} {
            self.balance = self.balance - amount
            return <- create Vault(balance: amount)
        }

        access(all) fun deposit(from: @{FungibleToken.Vault}) {
            let other <- from as! @DapperUtilityCoin.Vault
            self.balance = self.balance + other.balance
            destroy other
        }

        access(all) view fun getViews(): [Type] { return [] }
        access(all) fun resolveView(_ view: Type): AnyStruct? { return nil }

        access(all) fun createEmptyVault(): @{FungibleToken.Vault} {
            return <- create Vault(balance: 0.0)
        }
    }

    access(all) fun createEmptyVault(vaultType: Type): @{FungibleToken.Vault} {
        return <- create Vault(balance: 0.0)
    }

    access(all) view fun getContractViews(resourceType: Type?): [Type] { return [] }
    access(all) fun resolveContractView(resourceType: Type?, viewType: Type): AnyStruct? { return nil }

    init() {
        self.totalSupply = 0.0
    }
}
