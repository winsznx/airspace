// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice BinaryMarketsModule market registry + trader-facing redemption.
/// @dev Signatures transcribed from `@somnia-chain/markets-sdk@0.28.1`
///      `binaryModuleReadAbi` / `binaryModuleWriteAbi` and verified live against
///      0x3ecC694Cef705358864a646142ac17A90E29e388 on Shannon (chainId 50312).
interface IBinaryMarketsModule {
    /// @dev The 14-field value-type MarketRecord. Field order is ABI-critical.
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

    function marketNonce(bytes32 marketId) external view returns (uint64);

    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount) external;
}

/// @notice The per-window BinaryPool. Recycled across markets; `marketNonce`
///         is the reuse generation that disambiguates successive markets.
interface IBinaryPool {
    /// @dev v2 placement entry. The generic `placeOrder` reverts `UseBinaryPlacement`
    ///      on a binary pool. `kind`: 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO.
    ///      `price` is ALWAYS the YES-side price. Escrow is pulled from msg.sender.
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

    function marketNonce() external view returns (uint64);
    function finalized() external view returns (bool);
    function marketExpiryNs() external view returns (uint64);
    function outcomeToken() external view returns (address);
    function collateralToken() external view returns (address);

    struct OrderBookParams {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    function getOrderBookParameters() external view returns (OrderBookParams memory);

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

    function getBinaryPoolParams() external view returns (BinaryPoolInfo memory);
}

/// @notice Per-market lifecycle view. Carries no asset or series identity.
interface IBinaryMarket {
    function isResolved() external view returns (bool);
    function isVoided() external view returns (bool);
    function expiry() external view returns (uint64);
    function pool() external view returns (address);
}

/// @notice A factory-minted MarketCreator instance. `seriesById` is the ONLY
///         on-chain surface that names an asset.
interface IMarketCreator {
    function seriesById(uint32 seriesId)
        external
        view
        returns (address collateral, string memory asset, uint64 numericDecimals, uint64 intervalSec, uint64 settlementWindow);

    function latestExpiryBySeriesId(uint32 seriesId) external view returns (uint64 expiry);
    function venueId() external view returns (bytes32);
}

/// @notice The shared ERC-6909 outcome-token singleton.
interface IOutcomeToken6909 {
    function balanceOf(address owner, uint256 id) external view returns (uint256);
    function isOperator(address owner, address spender) external view returns (bool);
    function setOperator(address spender, bool approved) external returns (bool);
    function transfer(address receiver, uint256 id, uint256 amount) external returns (bool);
}

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}
