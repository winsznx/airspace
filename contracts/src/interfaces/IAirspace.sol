// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title AIRSPACE types and admission result codes
/// @notice One capital pool. Many trading agents. One shared risk envelope.

/// @notice Portfolio-wide ceilings. Apply to the sum across every agent.
struct GlobalPolicy {
    uint128 maxCommittedCapital; // collateral no longer free
    uint128 maxReservedCollateral; // collateral escrowed behind resting orders
    uint128 maxSingleOrderNotional; // hard ceiling regardless of agent policy
    uint64 maxBuyPrice; // YES-scale price units
    uint64 minSellPrice;
    uint64 minHeadroomSec; // required remaining window at execution
    uint64 policyExpiry; // 0 disables the portfolio entirely
}

/// @notice Ceilings for one STRUCTURAL RISK DOMAIN.
/// @dev A domain is `keccak256(creator, collateral, canonicalCadence)`, every
///      field read from the DreamDEX module registry during execution. It is a
///      CADENCE domain, not an asset: sibling series of the same cadence from the
///      same creator share one domain by design, and the contract never claims to
///      distinguish BTC from ETH. See PRD 9 and STRUCTURAL_DOMAINS.md.
struct DomainPolicy {
    bool configured; // distinguishes "unset" (deny) from "zero limit"
    uint128 maxDomainRiskUsage; // sum of |marketDirectionalExposure| in the domain
    uint128 maxDomainCommitted; // 0 disables this sub-limit
    uint32 maxLiveMarkets; // 0 disables this sub-limit
}

/// @notice One agent's own envelope. Always narrower than or equal to the portfolio's.
struct AgentPolicy {
    bool enabled;
    uint128 maxCommitted; // this agent's share of committed capital
    uint128 maxOrderNotional;
    uint64 maxBuyPrice;
    uint64 minSellPrice;
    uint64 cooldownSec;
    bytes32 strategyId; // informational provenance, OFFCHAIN_WITNESS
}

/// @notice An agent's proposed order.
struct Intent {
    bytes32 marketId;
    address pool;
    uint64 marketNonce;
    uint8 kind; // 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO
    uint256 price; // YES-side price, raw collateral units
    uint256 quantity; // contract units
    uint64 expireTimestampNs;
    uint8 orderType; // 0 LIMIT, 1 FOK, 2 IOC, 3 POST_ONLY
    uint64 nonce; // strictly increasing per agent
    bytes32 strategyVersion; // informational provenance, OFFCHAIN_WITNESS
}

/// @notice Every way admission can be refused.
/// @dev Mirrors the PRD 28 error model. `execute` reverts with `Refused(code)`;
///      `previewIntent` returns the same code without reverting, so the UI's
///      per-gate display and the enforced decision come from ONE code path and
///      cannot drift apart.
enum Refusal {
    NONE,
    NOT_AGENT,
    AGENT_DISABLED,
    POLICY_EXPIRED,
    INTENT_REPLAYED,
    COOLDOWN_ACTIVE,
    MARKET_NOT_FOUND,
    POOL_MISMATCH,
    MARKET_GENERATION_MISMATCH,
    MARKET_NOT_TRADING,
    INSUFFICIENT_HEADROOM,
    DOMAIN_UNSUPPORTED,
    DOMAIN_NOT_CONFIGURED,
    BAD_ORDER_KIND,
    PRICE_OUTSIDE_POLICY,
    OFF_TICK_GRID,
    OFF_LOT_GRID,
    BELOW_MIN_QUANTITY,
    ORDER_EXPIRY_INVALID,
    AGENT_ORDER_NOTIONAL_EXCEEDED,
    GLOBAL_ORDER_NOTIONAL_EXCEEDED,
    AGENT_COMMITTED_EXCEEDED,
    DOMAIN_RISK_EXCEEDED,
    DOMAIN_COMMITTED_EXCEEDED,
    GLOBAL_COMMITTED_EXCEEDED,
    GLOBAL_RESERVED_EXCEEDED,
    MAX_LIVE_MARKETS_EXCEEDED,
    DOMAIN_MARKETS_FULL,
    INSUFFICIENT_COLLATERAL
}

/// @notice The full result of evaluating an intent, gate by gate.
/// @dev Returned by `previewIntent` so the product can show exactly which
///      condition blocked execution, with the arithmetic behind it. This is the
///      structure behind the central UI moment:
///
///        Agent policy       PASS
///        Market generation  PASS
///        Price ceiling      PASS
///        Market headroom    PASS
///        Portfolio domain   FAIL      420 + 150 > 500
struct Evaluation {
    // NOTE: memory-only. `previewIntent` returns the slimmer `AdmissionView`;
    // ABI-encoding a struct this wide is the single largest bytecode cost.
    Refusal refusal; // NONE => admissible right now
    bytes32 domain; // structural risk domain, 0 when underivable
    uint32 cadenceSec; // canonical cadence, 0 when underivable
    address pool;
    address market;
    uint64 marketNonce;
    uint64 tradingStart;
    uint64 expiry;
    uint256 yesId;
    uint256 oneCollateral;
    uint128 reserveRequired; // collateral-equivalent this order would escrow
    // --- the numbers behind the decision -------------------------------
    int128 marketDirectionalBefore;
    int128 marketDirectionalAfter;
    uint128 domainUsageBefore;
    uint128 domainUsageAfter;
    uint128 domainCeiling;
    uint128 committedBefore;
    uint128 committedAfter;
    uint128 globalCommittedCeiling;
    uint128 agentCommittedBefore;
    uint128 agentCommittedAfter;
    uint128 agentCommittedCeiling;
    /// @dev Individual gate outcomes as a bitmask (see `Gate`). Packed rather
    ///      than eleven bools because the ABI encoding for a wide struct is the
    ///      single largest contributor to this contract's bytecode size, and a
    ///      mask is what the UI wants anyway.
    uint32 gates;
}

/// @notice The externally returned admission decision.
/// @dev Deliberately narrower than `Evaluation`: it carries the decision and the
///      arithmetic behind it, which is everything the product's gate view needs.
///      Contextual fields (market address, outcome ids, collateral scale) are
///      read separately, so the wide struct never crosses the ABI boundary.
struct AdmissionView {
    Refusal refusal;
    uint32 gates;
    bytes32 domain;
    uint32 cadenceSec;
    address pool;
    uint64 expiry;
    uint128 reserveRequired;
    int128 marketDirectionalBefore;
    int128 marketDirectionalAfter;
    uint128 domainUsageBefore;
    uint128 domainUsageAfter;
    uint128 domainCeiling;
    uint128 committedAfter;
    uint128 globalCommittedCeiling;
    uint128 agentCommittedAfter;
    uint128 agentCommittedCeiling;
}

/// @notice Bit positions in `Evaluation.gates`.
library Gate {
    uint32 internal constant AGENT_REGISTERED = 1 << 0;
    uint32 internal constant AGENT_POLICY = 1 << 1;
    uint32 internal constant MARKET_RESOLVED = 1 << 2;
    uint32 internal constant MARKET_TRADING = 1 << 3;
    uint32 internal constant GENERATION = 1 << 4;
    uint32 internal constant GRID = 1 << 5;
    uint32 internal constant PRICE = 1 << 6;
    uint32 internal constant HEADROOM = 1 << 7;
    uint32 internal constant DOMAIN_CONFIGURED = 1 << 8;
    uint32 internal constant DOMAIN_CAPACITY = 1 << 9;
    uint32 internal constant GLOBAL_CAPACITY = 1 << 10;

    function has(uint32 mask, uint32 bit) internal pure returns (bool) {
        return mask & bit != 0;
    }
}
