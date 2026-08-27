// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IBinaryMarketsModule,
    IBinaryPool,
    IBinaryMarket,
    IMarketCreator,
    IOutcomeToken6909,
    IERC20Min
} from "./interfaces/IDreamDex.sol";

/// @title FlightAccount
/// @notice A per-user, contract-owned execution account for DreamDEX Event Contracts.
///
/// The account is the trader of record: it calls `BinaryPool.placeBinaryOrder`
/// as `msg.sender`, so collateral escrow is pulled from the account, fills settle
/// to the account, and ERC-6909 outcome tokens are credited to the account. The
/// agent key never holds, and can never move, user capital.
///
/// Why this shape and not a delegation: `placeBinaryOrderFor` on a BinaryPool
/// reverts `OnlyApprovedContracts()` for every EOA caller, including a caller
/// acting for itself (verified live on Shannon). There is no user-grantable
/// operator path for binary pools -- the OperatorPermissionsRegistry that backs
/// spot/perp session keys is not wired into BinaryPool at all. Custody-by-account
/// is therefore the only structural boundary available on this venue.
contract FlightAccount {
    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------
    error AlreadyInitialized();
    error NotOwner();
    error NotAgent();
    error PolicyExpired();
    error NoPolicy();
    error IntentReplayed();
    error CooldownActive();
    error MarketNotBound();
    error UnknownMarket();
    error PoolMismatch();
    error GenerationMismatch();
    error MarketNotTrading();
    error InsufficientHeadroom();
    error CadenceMismatch();
    error AssetMismatch();
    error CollateralMismatch();
    error CreatorMismatch();
    error PriceOutsidePolicy();
    error OrderNotionalExceeded();
    error ExposureExceeded();
    error OffTickGrid();
    error OffLotGrid();
    error BelowMinQuantity();
    error OrderExpiryInvalid();
    error BadKind();
    error PlacementFailed();
    error ZeroAddress();
    error TransferFailed();

    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    /// @notice How tightly the policy pins the tradable market.
    /// @dev EXACT is the only mode with no residual ambiguity. SERIES cannot
    ///      distinguish sibling series that share a creator and cadence
    ///      (e.g. BTC-900s vs ETH-900s) -- see AUTHORITY_MODEL.md.
    enum BindMode {
        EXACT,
        SERIES
    }

    struct Policy {
        BindMode mode;
        bytes32 marketId; // EXACT mode: the one admissible market
        address marketCreator; // SERIES mode: expected MarketCreator instance
        uint32 seriesId; // SERIES mode: expected series
        bytes32 assetHash; // keccak256(bytes(asset)) read from chain
        address collateral; // expected collateral token
        uint64 intervalSec; // expected cadence (expiry - tradingStart)
        uint128 maxOrderNotional; // per-order collateral-equivalent cap, raw units
        uint128 maxExposure; // aggregate collateral-equivalent cap, raw units
        uint64 maxBuyPrice; // buys must be <= this (YES-scale price units)
        uint64 minSellPrice; // sells must be >= this
        uint64 minHeadroomSec; // required remaining window at execution
        uint64 cooldownSec; // minimum gap between accepted intents
        uint64 policyExpiry; // policy validity deadline
    }

    struct Intent {
        bytes32 marketId;
        address pool;
        uint64 marketNonce; // expected pool reuse generation
        uint8 kind; // 0 BUY_YES, 1 SELL_YES, 2 BUY_NO, 3 SELL_NO
        uint256 price; // YES-side price, raw units
        uint256 quantity; // raw units
        uint64 expireTimestampNs;
        uint8 orderType;
        uint64 nonce; // replay protection
        bytes32 strategyVersion; // opaque provenance tag
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------
    address public owner;
    address public agent;
    IBinaryMarketsModule public module;
    IOutcomeToken6909 public outcomeToken;

    Policy internal _policy;
    bytes32 public policyHash;
    uint64 public policyEpoch;

    /// @notice Collateral-equivalent notional committed under the CURRENT policy epoch.
    /// @dev Monotonic within an epoch; reset when the owner sets a new policy.
    ///      This is a max-loss bound for a single bound market, not a mark-to-market.
    uint128 public deployedNotional;

    uint64 public lastTradeAt;
    mapping(uint64 => bool) public intentNonceUsed;

    // ---------------------------------------------------------------------
    // Events -- the on-chain half of the execution receipt
    // ---------------------------------------------------------------------
    event Initialized(address indexed owner, address indexed agent, address module);
    event AgentChanged(address indexed previousAgent, address indexed newAgent);
    event PolicySet(bytes32 indexed policyHash, uint64 indexed epoch);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OutcomeWithdrawn(uint256 indexed id, address indexed to, uint256 amount);

    event IntentExecuted(
        bytes32 indexed intentHash,
        bytes32 indexed marketId,
        bytes32 indexed policyHash,
        address pool,
        uint64 marketNonce,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint128 notional,
        uint128 deployedNotionalAfter,
        uint128 orderId,
        bytes32 strategyVersion,
        bytes32 preTradeStateHash
    );

    // ---------------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------------
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    // ---------------------------------------------------------------------
    // Init (clone pattern -- no constructor state)
    // ---------------------------------------------------------------------
    function initialize(address owner_, address agent_, address module_, address outcomeToken_) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || module_ == address(0) || outcomeToken_ == address(0)) revert ZeroAddress();
        owner = owner_;
        agent = agent_;
        module = IBinaryMarketsModule(module_);
        outcomeToken = IOutcomeToken6909(outcomeToken_);
        emit Initialized(owner_, agent_, module_);
    }

    // ---------------------------------------------------------------------
    // Owner surface -- unconditional, never gated on agent state
    // ---------------------------------------------------------------------

    function setAgent(address newAgent) external onlyOwner {
        emit AgentChanged(agent, newAgent);
        agent = newAgent;
    }

    /// @notice Install a policy. Resets the exposure counter (new epoch).
    function setPolicy(Policy calldata p) external onlyOwner {
        _policy = p;
        policyHash = hashPolicy(p);
        policyEpoch += 1;
        deployedNotional = 0;
        emit PolicySet(policyHash, policyEpoch);
    }

    /// @notice Withdraw collateral (or any ERC-20) to an owner-chosen address.
    /// @dev Unconditional: no policy check, no agent check, no market state check.
    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
        emit Withdrawn(token, to, amount);
    }

    /// @notice Withdraw ERC-6909 outcome tokens.
    function withdrawOutcome(uint256 id, address to, uint256 amount) external onlyOwner {
        outcomeToken.transfer(to, id, amount);
        emit OutcomeWithdrawn(id, to, amount);
    }

    /// @notice Cancel a resting order. Owner-only by design: cancellation frees
    ///         escrow back to the account and is part of capital recovery.
    function cancelOrder(address pool, uint128 orderId) external onlyOwner {
        IBinaryPool(pool).cancelOrder(orderId);
    }

    /// @notice Redeem winning outcome tokens through the module.
    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)
        external
        onlyOwner
    {
        if (!outcomeToken.isOperator(address(this), address(module))) {
            outcomeToken.setOperator(address(module), true);
        }
        module.redeem(operatorId, venueId, marketId, outcomeIdx, amount);
    }

    /// @notice Unconditional owner recovery hatch.
    /// @dev The owner already owns every asset the account holds, so an
    ///      owner-only arbitrary call adds no privilege -- it guarantees that
    ///      recovery never depends on this contract having anticipated a
    ///      protocol upgrade. The agent can never reach it.
    function ownerCall(address target, uint256 value, bytes calldata data)
        external
        onlyOwner
        returns (bytes memory)
    {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    // ---------------------------------------------------------------------
    // Agent surface -- the enforced execution boundary
    // ---------------------------------------------------------------------

    /// @notice Execute one intent against a DreamDEX Event Contract, subject to policy.
    /// @dev The agent chooses WHAT to trade. This function decides whether user
    ///      capital is allowed to move. Every gate reads authoritative on-chain
    ///      state, never indexer data and never agent-supplied claims.
    function execute(Intent calldata i) external onlyAgent returns (uint128 orderId) {
        Policy memory p = _policy;
        if (p.policyExpiry == 0) revert NoPolicy();
        if (block.timestamp > p.policyExpiry) revert PolicyExpired();

        // --- replay + rate limit -------------------------------------------
        if (intentNonceUsed[i.nonce]) revert IntentReplayed();
        intentNonceUsed[i.nonce] = true;
        if (lastTradeAt != 0 && block.timestamp < uint256(lastTradeAt) + p.cooldownSec) revert CooldownActive();

        // --- market identity ------------------------------------------------
        _checkMarketBinding(p, i);

        // Snapshot BEFORE any state moves, so the receipt commits to the
        // position the order was decided against.
        bytes32 preState = _preTradeStateHash(i);

        // --- authoritative market state + policy limits ---------------------
        uint128 notional = _checkStateAndLimits(p, i);

        // --- place ----------------------------------------------------------
        lastTradeAt = uint64(block.timestamp);
        orderId = _place(i, notional);

        _emitReceipt(i, notional, orderId, preState);
    }

    /// @dev Split out purely to keep `execute` under the stack limit.
    function _emitReceipt(Intent calldata i, uint128 notional, uint128 orderId, bytes32 preState) internal {
        emit IntentExecuted(
            hashIntent(i),
            i.marketId,
            policyHash,
            i.pool,
            i.marketNonce,
            i.kind,
            i.price,
            i.quantity,
            notional,
            deployedNotional,
            orderId,
            i.strategyVersion,
            preState
        );
    }

    // ---------------------------------------------------------------------
    // Internal gates
    // ---------------------------------------------------------------------

    function _checkMarketBinding(Policy memory p, Intent calldata i) internal view {
        if (p.mode == BindMode.EXACT) {
            if (i.marketId != p.marketId) revert MarketNotBound();
        }

        (,,, address collateral,,,, address creator,, address pool,,,,) = module.markets(i.marketId);
        if (pool == address(0)) revert UnknownMarket();
        if (collateral != p.collateral) revert CollateralMismatch();

        if (p.mode == BindMode.SERIES) {
            if (creator != p.marketCreator) revert CreatorMismatch();
            (address sCollateral, string memory asset,, uint64 sInterval,) =
                IMarketCreator(p.marketCreator).seriesById(p.seriesId);
            if (sCollateral != p.collateral) revert CollateralMismatch();
            if (keccak256(bytes(asset)) != p.assetHash) revert AssetMismatch();
            if (sInterval != p.intervalSec) revert CadenceMismatch();
        }
    }

    function _checkStateAndLimits(Policy memory p, Intent calldata i) internal returns (uint128 notional) {
        (,,,,,,,, address market, address pool, uint256 yesId, uint256 noId, uint64 tradingStart, uint64 expiry) =
            module.markets(i.marketId);

        // The agent supplies the pool it wants to hit. It must be THE pool the
        // module registry binds to this market -- not merely a pool that exists.
        if (pool != i.pool) revert PoolMismatch();

        // Recycled-pool defence. Outcome ids encode
        //   id = (uint160(pool) << 72) | (nonce << 8) | idx
        // so a pool serving a LATER market has the same address but a different
        // generation. Requiring the registry's ids to match the ids derived from
        // (pool, intent.marketNonce) AND the pool's live marketNonce pins the
        // exact generation the agent claimed.
        uint64 liveNonce = IBinaryPool(pool).marketNonce();
        if (liveNonce != i.marketNonce) revert GenerationMismatch();
        if (yesId != _outcomeId(pool, i.marketNonce, 0) || noId != _outcomeId(pool, i.marketNonce, 1)) {
            revert GenerationMismatch();
        }

        // Authoritative Trading. Indexer status lags by seconds and is not used.
        if (IBinaryPool(pool).finalized()) revert MarketNotTrading();
        if (IBinaryMarket(market).isResolved() || IBinaryMarket(market).isVoided()) revert MarketNotTrading();
        if (block.timestamp < tradingStart || block.timestamp >= expiry) revert MarketNotTrading();

        // Window headroom.
        if (expiry - block.timestamp < p.minHeadroomSec) revert InsufficientHeadroom();

        // Cadence, cross-checked against the market record itself.
        if (expiry - tradingStart != p.intervalSec) revert CadenceMismatch();

        // Price bounds.
        if (i.kind > 3) revert BadKind();
        bool isBuy = (i.kind == 0 || i.kind == 2);
        if (isBuy) {
            if (i.price > p.maxBuyPrice) revert PriceOutsidePolicy();
        } else {
            if (i.price < p.minSellPrice) revert PriceOutsidePolicy();
        }

        // Grid conformance -- read from the pool, not assumed.
        IBinaryPool.OrderBookParams memory g = IBinaryPool(pool).getOrderBookParameters();
        if (g.tickSize != 0 && i.price % g.tickSize != 0) revert OffTickGrid();
        if (g.lotSize != 0 && i.quantity % g.lotSize != 0) revert OffLotGrid();
        if (i.quantity < g.minQuantity) revert BelowMinQuantity();

        // Order expiry must be set and must not exceed the market's own cap.
        uint64 cap = IBinaryPool(pool).marketExpiryNs();
        if (i.expireTimestampNs == 0 || i.expireTimestampNs > cap) revert OrderExpiryInvalid();

        // Notional. Collateral-equivalent value of the order, matching the pool's
        // own ceil-rounded escrow computation.
        uint256 oneCollateral = IBinaryPool(pool).getBinaryPoolParams().oneCollateral;
        uint256 unit = isBuy ? _buyUnitCost(i.kind, i.price, oneCollateral) : i.price;
        uint256 n = (unit * i.quantity + oneCollateral - 1) / oneCollateral;
        if (n > type(uint128).max) revert OrderNotionalExceeded();
        notional = uint128(n);
        if (notional > p.maxOrderNotional) revert OrderNotionalExceeded();

        // Aggregate exposure. Only buys commit fresh collateral.
        if (isBuy) {
            uint128 after_ = deployedNotional + notional;
            if (after_ > p.maxExposure) revert ExposureExceeded();
            deployedNotional = after_;
        }
    }

    /// @dev BUY_YES escrows `price`; BUY_NO escrows `oneCollateral - price`,
    ///      because the book quotes a single YES probability and NO = 1 - YES.
    function _buyUnitCost(uint8 kind, uint256 price, uint256 oneCollateral) internal pure returns (uint256) {
        return kind == 0 ? price : oneCollateral - price;
    }

    function _place(Intent calldata i, uint128 notional) internal returns (uint128 orderId) {
        bool isBuy = (i.kind == 0 || i.kind == 2);

        if (isBuy) {
            // Approve exactly this order's escrow, nothing more.
            IERC20Min c = IERC20Min(IBinaryPool(i.pool).collateralToken());
            c.approve(i.pool, 0);
            c.approve(i.pool, notional);
        } else {
            // Sells escrow outcome tokens; the pool must be an ERC-6909 operator.
            if (!outcomeToken.isOperator(address(this), i.pool)) {
                outcomeToken.setOperator(i.pool, true);
            }
        }

        (bool ok, uint128 id) = IBinaryPool(i.pool).placeBinaryOrder(
            i.kind, i.price, i.quantity, i.expireTimestampNs, i.orderType, 0, address(0), 0, uint64(i.nonce)
        );
        if (!ok) revert PlacementFailed();
        orderId = id;

        if (isBuy) {
            IERC20Min(IBinaryPool(i.pool).collateralToken()).approve(i.pool, 0);
        }
    }

    // ---------------------------------------------------------------------
    // Views / hashing -- the receipt's verifiable fields
    // ---------------------------------------------------------------------

    function policy() external view returns (Policy memory) {
        return _policy;
    }

    function hashPolicy(Policy memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function hashIntent(Intent calldata i) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, i));
    }

    /// @dev A commitment to the account's pre-trade position, so a receipt can be
    ///      checked against state that existed before the order landed.
    function _preTradeStateHash(Intent calldata i) internal view returns (bytes32) {
        (,,,,,,,,, address pool, uint256 yesId, uint256 noId,,) = module.markets(i.marketId);
        return keccak256(
            abi.encode(
                address(this),
                policyHash,
                policyEpoch,
                deployedNotional,
                IERC20Min(IBinaryPool(pool).collateralToken()).balanceOf(address(this)),
                outcomeToken.balanceOf(address(this), yesId),
                outcomeToken.balanceOf(address(this), noId)
            )
        );
    }

    function preTradeStateHash(Intent calldata i) external view returns (bytes32) {
        return _preTradeStateHash(i);
    }

    function _outcomeId(address pool, uint64 nonce, uint8 idx) internal pure returns (uint256) {
        return (uint256(uint160(pool)) << 72) | (uint256(nonce) << 8) | uint256(idx);
    }

    function outcomeIdFor(address pool, uint64 nonce, uint8 idx) external pure returns (uint256) {
        return _outcomeId(pool, nonce, idx);
    }

    receive() external payable {}
}
