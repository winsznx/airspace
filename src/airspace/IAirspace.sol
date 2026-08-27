// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice The one IOrderBook view AIRSPACE needs beyond placement: it reverts
///         `IncorrectOrder()` for an id the pool has no ACTIVE order for
///         (unknown, filled, cancelled, or reduced away). That revert is what
///         makes reservation release provable rather than asserted.
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

/// @notice A market's risk-bucket admission record, owner-attested but
///         structurally cross-checked against the module registry.
struct AdmittedMarket {
    bool admitted;
    bytes32 bucket; // owner-declared risk bucket (e.g. keccak("BTC"))
    address creator; // pinned at admission from module.markets()
    address collateral; // pinned at admission
    uint64 intervalSec; // pinned at admission (expiry - tradingStart)
    uint64 marketNonce; // pool generation pinned at admission
    address pool; // pinned at admission
}

/// @notice Portfolio-wide ceilings. Apply to the sum across every agent.
struct GlobalPolicy {
    uint128 maxCommittedCollateral; // total collateral out of free balance
    uint128 maxRestingReservation; // total collateral escrowed in resting orders
    uint128 maxSingleOrderNotional; // hard ceiling regardless of agent policy
    uint64 maxBuyPrice;
    uint64 minSellPrice;
    uint32 maxLivePositions; // distinct markets carrying non-zero exposure
    uint64 minHeadroomSec;
    uint64 policyExpiry;
}

/// @notice Per-risk-bucket ceilings. This is where cross-agent enforcement bites.
struct BucketPolicy {
    uint128 maxGrossDirectional; // sum of |netYes - netNo| across the bucket's markets
    uint128 maxCommitted; // collateral committed to the bucket
}

/// @notice A single agent's own envelope. Strictly narrower than global.
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
