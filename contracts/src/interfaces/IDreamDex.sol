// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title DreamDEX Event Contract interfaces used by AIRSPACE
/// @notice Only the surface AIRSPACE actually calls is declared here. Signatures
///         were transcribed from `@somnia-chain/markets-sdk@0.28.1` and verified
///         live against the Shannon deployment during hostile validation; see
///         `engineering/00-flightpath-feasibility/SPIKE_FINDINGS.md`.
/// @dev Deliberately NOT a full port of the SDK surface. Every function here is
///      reachable from production code.

/// @notice BinaryMarketsModule — the market registry and trader-facing redemption.
interface IBinaryMarketsModule {
    /// @dev The 14-field value-type MarketRecord. Field order is ABI-critical:
    ///      collateral is field 3, creator 7, market 8, pool 9, tradingStart 12,
    ///      expiry 13. Verified against the deployed proxy.
    function markets(bytes32 marketId)
        external
        view
        returns (
            uint256 oracleQuestionId,
            uint8 outcomeSlotCount,
            uint8 voidPolicy,
            address collateral,
            uint32 originOperatorId,
            bytes32 originVenueId,
            address oracleAdapter,
            address creator,
            address market,
            address pool,
            uint256 yesId,
            uint256 noId,
            uint64 tradingStart,
            uint64 expiry
        );

    /// @notice Redeem winning outcome tokens. The module pulls the CALLER's
    ///         tokens, so the portfolio must hold them and have granted the
    ///         module ERC-6909 operator status.
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external;
}

/// @notice The per-window BinaryPool. Recycled across markets; `marketNonce` is
///         the reuse generation that disambiguates successive markets.
interface IBinaryPool {
    struct OrderBookParams {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    struct BinaryPoolInfo {
        address collateralToken;
        address market;
        address outcomeToken;
        uint256 yesId;
        uint256 noId;
        uint256 oneCollateral;
        uint256 setBacking;
        address feeRecipient;
        uint256 makerFeeBpsTimes1k;
        uint256 takerFeeBpsTimes1k;
        uint256 maxBuilderFeeBpsTimes1k;
        uint256 settlementFeeBpsTimes1k;
        address settlement;
        uint64 marketNonce;
        bool finalized;
    }

    /// @dev v2 placement entry. The generic `placeOrder` reverts
    ///      `UseBinaryPlacement` on a binary pool. `kind`: 0 BUY_YES, 1 SELL_YES,
    ///      2 BUY_NO, 3 SELL_NO. `price` is ALWAYS the YES-side price. Escrow is
    ///      pulled from msg.sender, which is why the portfolio is the trader of
    ///      record. Returns `(success, orderId)` — readable by a contract caller.
    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64 expireTimestampNs,
        uint8 orderType,
        uint8 selfMatchingOption,
        address builder,
        uint96 builderFeeBpsTimes1k,
        uint64 userData
    ) external payable returns (bool success, uint128 id);

    function cancelOrder(uint128 orderId) external;

    /// @notice Permissionless keeper drain: cleans expired orders and returns
    ///         locked escrow to each order's owner. Anyone may call it, which is
    ///         what lets an AIRSPACE keeper restore liveness without privilege.
    function cancelExpiredOrders(uint128[] calldata orderIds) external;

    function marketNonce() external view returns (uint64);
    function finalized() external view returns (bool);
    function marketExpiryNs() external view returns (uint64);
    function collateralToken() external view returns (address);
    function outcomeToken() external view returns (address);
    function getOrderBookParameters() external view returns (OrderBookParams memory);
    function getBinaryPoolParams() external view returns (BinaryPoolInfo memory);
}

/// @notice The one IOrderBook view AIRSPACE needs beyond placement.
/// @dev It reverts `IncorrectOrder()` for any id the pool has no ACTIVE order
///      for. That revert is IDENTICAL for a filled and a cancelled order, which
///      is exactly why realized position state is read from ERC-6909 balances
///      and never from a running counter. See PRD 14.4.
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

/// @notice Per-market lifecycle view. Carries no asset or series identity.
interface IBinaryMarket {
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
}

/// @notice The shared ERC-6909 outcome-token singleton.
interface IOutcomeToken6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function allowance(address owner, address spender, uint256 id) external view returns (uint256);
    function isOperator(address owner, address spender) external view returns (bool);
    function approve(address spender, uint256 id, uint256 amount) external returns (bool);
    function setOperator(address spender, bool approved) external returns (bool);
    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool);
}

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}
