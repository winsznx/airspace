// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one IOrderBook view the portfolio needs beyond placement. It
///         reverts `IncorrectOrder()` for any id the pool has no ACTIVE order
///         for -- unknown, filled, cancelled, or reduced away. That revert is
///         identical for a filled and a cancelled order, which is precisely why
///         live position state is read from ERC-6909 balances and never from a
///         running counter.
interface IOrderBookView {
    struct Order {
        uint128 orderId;
        bool isBid;
        address owner;
        uint64 userData;
        uint256 price;
        uint256 fullQuantity;
        uint256 quantityRemaining;
        uint64 expireTimestampNs;
    }

    function getOrder(uint128 orderId) external view returns (Order memory);
}

/// @notice Portfolio-wide ceilings, applying to the sum across every agent.
struct GlobalPolicy {
    uint128 maxCommittedCapital; // collateral no longer free
    uint128 maxReservedCollateral; // collateral escrowed behind resting orders
    uint128 maxSingleOrderNotional;
    uint64 maxBuyPrice;
    uint64 minSellPrice;
    uint64 minHeadroomSec;
    uint64 policyExpiry;
}

/// @notice Ceilings for one STRUCTURAL RISK DOMAIN.
/// @dev A domain is `keccak256(creator, collateral, cadenceSec)` -- every field
///      read from authoritative on-chain state during execution. It is a cadence
///      domain, not an asset. It does NOT distinguish BTC from ETH; sibling
///      series of the same cadence from the same creator share one domain, by
///      design. See STRUCTURAL_DOMAINS.md.
struct DomainPolicy {
    bool set; // distinguishes "unset" (deny) from "zero limit"
    uint128 maxDomainRiskUsage; // Σ |marketDirectionalExposure| over the domain
    uint128 maxDomainCommitted; // committed capital attributable to the domain
    uint32 maxLiveMarkets; // markets in the domain carrying non-zero state
}

/// @notice One agent's own envelope. Strictly narrower than the portfolio's.
struct AgentPolicy {
    bool enabled;
    uint128 maxCommitted;
    uint128 maxOrderNotional;
    uint64 maxBuyPrice;
    uint64 minSellPrice;
    uint64 cooldownSec;
}

struct Intent {
    bytes32 marketId;
    address pool;
    uint64 marketNonce;
    uint8 kind; // 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO
    uint256 price; // YES-side price, raw units
    uint256 quantity;
    uint64 expireTimestampNs;
    uint8 orderType; // 0 LIMIT, 1 FOK, 2 IOC, 3 POST_ONLY
    uint64 nonce;
    bytes32 strategyVersion;
}
