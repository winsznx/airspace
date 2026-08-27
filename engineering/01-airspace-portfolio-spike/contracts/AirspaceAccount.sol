// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    IBinaryMarketsModule, IBinaryPool, IBinaryMarket, IOutcomeToken6909, IERC20Min
} from "../../shared/interfaces/IDreamDex.sol";
import {
    IOrderBookView, AdmittedMarket, GlobalPolicy, BucketPolicy, AgentPolicy, Intent
} from "./IAirspace.sol";

/// @title AirspaceAccount
/// @notice One capital base. Many agents. One risk envelope.
///
/// A portfolio-level execution and risk control plane for several independent,
/// heterogeneous DreamDEX Event Contract agents sharing one pool of collateral.
///
/// The load-bearing property is not that an agent is individually constrained --
/// that is table stakes. It is that an order satisfying its own agent's policy in
/// full is still rejected when its effect, combined with positions, reservations
/// and resting orders created by OTHER agents, would breach a portfolio ceiling.
///
/// Two design decisions carry the safety argument:
///
/// 1. ONE CONTRACT HOLDS ALL CAPITAL. Aggregate enforcement has to be atomic and
///    unbypassable. If capital sat in per-agent child accounts, each child would
///    have to volunteer to consult a coordinator, and a child that did not would
///    spend shared capital outside the envelope. Here there is no second place
///    capital can live, so the aggregate check is a storage read in the same
///    transaction that moves the money.
///
/// 2. EXPOSURE IS MEASURED, NOT ACCUMULATED. Realized positions are read from the
///    ERC-6909 outcome singleton at check time; only unfilled reservations are
///    tracked in storage. A running total would have to answer "did that dead
///    order fill or was it cancelled?" -- a question the pool cannot answer after
///    the fact, since `getOrder` reverts identically for both. Reading the
///    balance makes the question disappear: if it filled, the balance already
///    moved; if it was cancelled, it did not. The accounting cannot drift away
///    from the chain because the chain is where it is read from.
contract AirspaceAccount {
    // ---------------------------------------------------------------- errors
    error AlreadyInitialized();
    error NotOwner();
    error NotAgent();
    error AgentDisabled();
    error PolicyExpired();
    error IntentReplayed();
    error CooldownActive();
    error MarketNotAdmitted();
    error UnknownMarket();
    error PoolMismatch();
    error GenerationMismatch();
    error CreatorMismatch();
    error CollateralMismatch();
    error CadenceMismatch();
    error MarketNotTrading();
    error InsufficientHeadroom();
    error PriceOutsidePolicy();
    error OffTickGrid();
    error OffLotGrid();
    error BelowMinQuantity();
    error OrderExpiryInvalid();
    error BadKind();
    error PlacementFailed();
    error TransferFailed();
    error ZeroAddress();
    error BucketFull();

    // --- portfolio ceilings. These are the point of the product. ------------
    error AgentCommittedExceeded();
    error OrderNotionalExceeded();
    error GlobalCommittedExceeded();
    error GlobalRestingExceeded();
    error MaxLivePositionsExceeded();
    error BucketCommittedExceeded();
    /// @notice An individually-valid order would push the risk bucket's
    ///         cross-agent gross directional exposure over its ceiling.
    error BucketDirectionalExceeded();

    error OrderStillLive();
    error NothingToRelease();
    error MarketNotSettled();

    uint256 internal constant MAX_MARKETS_PER_BUCKET = 32;

    // ---------------------------------------------------------------- types

    /// @notice Unfilled reservations only. Realized positions are read from the
    ///         outcome token, never mirrored here.
    struct MarketRes {
        uint128 yesLong; // open BUY_YES quantity
        uint128 yesShort; // open SELL_YES quantity
        uint128 noLong; // open BUY_NO quantity
        uint128 noShort; // open SELL_NO quantity
        bool settledReleased;
    }

    struct OrderRec {
        address agent;
        bytes32 marketId;
        address pool;
        uint64 marketNonce;
        uint128 orderId;
        uint8 kind;
        uint128 qtyOpen;
        uint128 collReserved;
        bool open;
    }

    // -------------------------------------------------------------- storage
    address public owner;
    IBinaryMarketsModule public module;
    IOutcomeToken6909 public outcomeToken;

    GlobalPolicy internal _global;
    bytes32 public globalPolicyHash;
    uint64 public policyEpoch;

    mapping(address => AgentPolicy) internal _agentPolicy;
    mapping(address => bytes32) public agentPolicyHash;
    mapping(address => uint128) public agentCommitted; // agent's share of committed capital
    mapping(address => uint64) public agentLastTradeAt;
    address[] public agents;

    mapping(bytes32 => AdmittedMarket) internal _admitted;
    mapping(bytes32 => BucketPolicy) internal _bucketPolicy;
    mapping(bytes32 => bytes32[]) internal _bucketMarkets; // bucket => admitted marketIds
    mapping(bytes32 => MarketRes) internal _res;

    mapping(bytes32 => OrderRec) internal _orders;
    mapping(bytes32 => bool) public intentUsed;

    /// @notice Collateral the owner has declared as this portfolio's capital.
    /// @dev Committed capital is derived as `capitalBase - freeBalance`, which is
    ///      exact and self-healing: escrow that leaves the wallet for a resting
    ///      order, collateral spent on a fill, and collateral returned by a
    ///      cancel or a redemption are all reflected automatically.
    uint128 public capitalBase;
    address public collateralToken;

    uint128 public totalResting; // sum of open-order escrow (tracked)

    // --------------------------------------------------------------- events
    event Initialized(address indexed owner, address module);
    event GlobalPolicySet(bytes32 indexed policyHash, uint64 indexed epoch);
    event BucketPolicySet(bytes32 indexed bucket, uint128 maxGrossDirectional, uint128 maxCommitted);
    event AgentSet(address indexed agent, bytes32 indexed policyHash, bool enabled);
    event MarketAdmitted(bytes32 indexed marketId, bytes32 indexed bucket, address pool, uint64 marketNonce);
    event MarketRevoked(bytes32 indexed marketId);
    event CapitalBaseSynced(uint128 capitalBase);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OutcomeWithdrawn(uint256 indexed id, address indexed to, uint256 amount);

    event IntentExecuted(
        bytes32 indexed intentHash,
        bytes32 indexed marketId,
        address indexed agent,
        bytes32 bucket,
        bytes32 globalPolicyHash_,
        bytes32 agentPolicyHash_,
        address pool,
        uint64 marketNonce,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint128 orderId,
        bytes32 strategyVersion
    );

    /// @dev The reconciliation half of the receipt. Split from IntentExecuted
    ///      only because the two together exceed one log's field budget.
    event IntentReconciled(
        bytes32 indexed intentHash,
        uint128 reservedDelta, // collateral escrow this order reserved
        uint128 filledQty, // MEASURED: outcome-token balance delta
        uint128 filledCost, // DERIVED: collateral delta minus resting escrow
        uint128 restingQty, // MEASURED: pool's own quantityRemaining
        int128 directionalBefore,
        int128 directionalAfter,
        uint128 bucketGrossBefore,
        uint128 bucketGrossAfter,
        uint128 committedAfter
    );

    event ReservationReleased(
        bytes32 indexed orderKey, bytes32 indexed marketId, uint128 qtyReleased, uint128 collateralReleased
    );
    event SettledExposureReleased(bytes32 indexed marketId, int128 directionalCleared);

    // ------------------------------------------------------------ modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ----------------------------------------------------------------- init
    function initialize(address owner_, address module_, address outcomeToken_) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || module_ == address(0) || outcomeToken_ == address(0)) revert ZeroAddress();
        owner = owner_;
        module = IBinaryMarketsModule(module_);
        outcomeToken = IOutcomeToken6909(outcomeToken_);
        emit Initialized(owner_, module_);
    }

    // ================================================================
    // OWNER SURFACE -- unconditional, never gated on agent or market state
    // ================================================================

    function setGlobalPolicy(GlobalPolicy calldata p) external onlyOwner {
        _global = p;
        globalPolicyHash = keccak256(abi.encode(p));
        policyEpoch += 1;
        emit GlobalPolicySet(globalPolicyHash, policyEpoch);
    }

    function setBucketPolicy(bytes32 bucket, BucketPolicy calldata p) external onlyOwner {
        _bucketPolicy[bucket] = p;
        emit BucketPolicySet(bucket, p.maxGrossDirectional, p.maxCommitted);
    }

    function setAgent(address agent, AgentPolicy calldata p) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (agentPolicyHash[agent] == 0) agents.push(agent);
        _agentPolicy[agent] = p;
        agentPolicyHash[agent] = keccak256(abi.encode(p));
        emit AgentSet(agent, agentPolicyHash[agent], p.enabled);
    }

    /// @notice Declare the portfolio's capital base from the current free balance.
    /// @dev Call after funding. Committed capital is measured against this.
    function syncCapitalBase(address token) external onlyOwner {
        collateralToken = token;
        capitalBase = uint128(IERC20Min(token).balanceOf(address(this)));
        emit CapitalBaseSynced(capitalBase);
    }

    /// @notice Admit a market into a risk bucket.
    /// @dev The bucket label is OWNER-ATTESTED. No on-chain view maps a marketId
    ///      to its underlying asset -- see RISK_IDENTITY.md for the full search
    ///      and why this is sound against the actual adversary (a compromised
    ///      agent, not the owner). Everything structural is pinned here from the
    ///      module registry and re-verified at execution, so a wrong or stale
    ///      attestation can never redirect capital to a different market.
    ///      Default is deny: an unadmitted market cannot be traded at all.
    function admitMarket(bytes32 marketId, bytes32 bucket) external onlyOwner {
        (,,, address collateral,,,, address creator,, address pool,,, uint64 tradingStart, uint64 expiry) =
            module.markets(marketId);
        if (pool == address(0)) revert UnknownMarket();

        if (!_admitted[marketId].admitted) {
            if (_bucketMarkets[bucket].length >= MAX_MARKETS_PER_BUCKET) revert BucketFull();
            _bucketMarkets[bucket].push(marketId);
        }

        _admitted[marketId] = AdmittedMarket({
            admitted: true,
            bucket: bucket,
            creator: creator,
            collateral: collateral,
            intervalSec: expiry - tradingStart,
            marketNonce: IBinaryPool(pool).marketNonce(),
            pool: pool
        });
        emit MarketAdmitted(marketId, bucket, pool, _admitted[marketId].marketNonce);
    }

    function revokeMarket(bytes32 marketId) external onlyOwner {
        _admitted[marketId].admitted = false;
        emit MarketRevoked(marketId);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (!IERC20Min(token).transfer(to, amount)) revert TransferFailed();
        if (token == collateralToken) {
            capitalBase = capitalBase > uint128(amount) ? capitalBase - uint128(amount) : 0;
        }
        emit Withdrawn(token, to, amount);
    }

    function withdrawOutcome(uint256 id, address to, uint256 amount) external onlyOwner {
        outcomeToken.transfer(to, id, amount);
        emit OutcomeWithdrawn(id, to, amount);
    }

    function cancelOrder(address pool, uint128 orderId) external onlyOwner {
        IBinaryPool(pool).cancelOrder(orderId);
    }

    function redeem(uint32 operatorId, bytes32 venueId, bytes32 marketId, uint8 outcomeIdx, uint256 amount)
        external
        onlyOwner
    {
        if (!outcomeToken.isOperator(address(this), address(module))) {
            outcomeToken.setOperator(address(module), true);
        }
        module.redeem(operatorId, venueId, marketId, outcomeIdx, amount);
    }

    /// @notice Unconditional owner recovery hatch. Unreachable by any agent.
    function ownerCall(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    // ================================================================
    // MEASUREMENT -- read from the chain, never from an accumulator
    // ================================================================

    /// @notice Directional risk for one market, in contract units.
    /// @dev `netYes - netNo`, where each leg is the realized ERC-6909 balance
    ///      plus open buy reservations minus open sell reservations. A matched
    ///      YES+NO pair is a complete set and carries no outcome risk, so it
    ///      correctly nets to zero.
    function directionalOf(bytes32 marketId) public view returns (int128) {
        AdmittedMarket memory am = _admitted[marketId];
        if (am.pool == address(0)) return 0;
        MarketRes memory r = _res[marketId];

        uint256 yesId = _outcomeId(am.pool, am.marketNonce, 0);
        uint256 noId = yesId + 1;

        int256 yes = int256(outcomeToken.balanceOf(address(this), yesId)) + int256(uint256(r.yesLong))
            - int256(uint256(r.yesShort));
        int256 no =
            int256(outcomeToken.balanceOf(address(this), noId)) + int256(uint256(r.noLong)) - int256(uint256(r.noShort));
        return int128(yes - no);
    }

    /// @notice Gross directional exposure of a risk bucket: the sum of the
    ///         absolute directional exposure of each admitted market in it.
    /// @dev Gross, not netted across markets. Being long BTC in the 15-minute
    ///      window and short BTC in the daily window is NOT risk-free -- they
    ///      resolve at different times against different prices -- so netting
    ///      them would understate risk. Summing absolutes never understates.
    function bucketGross(bytes32 bucket) public view returns (uint128 gross) {
        bytes32[] memory ids = _bucketMarkets[bucket];
        for (uint256 i = 0; i < ids.length; i++) {
            if (!_admitted[ids[i]].admitted) continue;
            gross += _abs(directionalOf(ids[i]));
        }
    }

    /// @notice Collateral that is not sitting free: escrowed in resting orders,
    ///         or spent acquiring positions.
    function committedCollateral() public view returns (uint128) {
        if (collateralToken == address(0)) return 0;
        uint128 free = uint128(IERC20Min(collateralToken).balanceOf(address(this)));
        return capitalBase > free ? capitalBase - free : 0;
    }

    function livePositions(bytes32 bucket) public view returns (uint32 n) {
        bytes32[] memory ids = _bucketMarkets[bucket];
        for (uint256 i = 0; i < ids.length; i++) {
            if (directionalOf(ids[i]) != 0) n++;
        }
    }

    // ================================================================
    // AGENT SURFACE
    // ================================================================

    struct Ctx {
        bytes32 bucket;
        address market;
        uint256 yesId;
        uint256 noId;
        uint256 oneCollateral;
        address collateral;
        bool isBuy;
        bool isYes;
        uint128 reserve;
        int128 dirBefore;
        uint128 grossBefore;
        uint128 collBefore;
        uint128 yesBefore;
        uint128 noBefore;
    }

    /// @notice Propose an order. The portfolio decides whether capital moves.
    function execute(Intent calldata i) external returns (uint128 orderId) {
        if (agentPolicyHash[msg.sender] == 0) revert NotAgent();
        AgentPolicy memory ap = _agentPolicy[msg.sender];
        if (!ap.enabled) revert AgentDisabled();

        GlobalPolicy memory gp = _global;
        if (gp.policyExpiry == 0 || block.timestamp > gp.policyExpiry) revert PolicyExpired();

        bytes32 ih = keccak256(abi.encode(address(this), block.chainid, msg.sender, i));
        if (intentUsed[ih]) revert IntentReplayed();
        intentUsed[ih] = true;

        uint64 last = agentLastTradeAt[msg.sender];
        if (last != 0 && block.timestamp < uint256(last) + ap.cooldownSec) revert CooldownActive();

        Ctx memory c = _validate(i, ap, gp);
        _reserve(i, c, gp);

        agentLastTradeAt[msg.sender] = uint64(block.timestamp);
        orderId = _place(i, c);
        _reconcile(i, c, ih, orderId);

        emit IntentExecuted(
            ih,
            i.marketId,
            msg.sender,
            c.bucket,
            globalPolicyHash,
            agentPolicyHash[msg.sender],
            i.pool,
            i.marketNonce,
            i.kind,
            i.price,
            i.quantity,
            orderId,
            i.strategyVersion
        );
    }

    // ------------------------------------------------------------ validation
    function _validate(Intent calldata i, AgentPolicy memory ap, GlobalPolicy memory gp)
        internal
        view
        returns (Ctx memory c)
    {
        AdmittedMarket memory am = _admitted[i.marketId];
        if (!am.admitted) revert MarketNotAdmitted();
        c.bucket = am.bucket;

        (,,, address collateral,,,, address creator, address market, address pool,,, uint64 ts, uint64 ex) =
            module.markets(i.marketId);
        if (pool == address(0)) revert UnknownMarket();
        if (pool != i.pool || pool != am.pool) revert PoolMismatch();
        if (creator != am.creator) revert CreatorMismatch();
        if (collateral != am.collateral) revert CollateralMismatch();
        if (ex - ts != am.intervalSec) revert CadenceMismatch();

        c.market = market;
        c.collateral = collateral;
        c.yesId = _outcomeId(pool, i.marketNonce, 0);
        c.noId = c.yesId + 1;

        if (IBinaryPool(pool).marketNonce() != i.marketNonce || i.marketNonce != am.marketNonce) {
            revert GenerationMismatch();
        }

        if (IBinaryPool(pool).finalized()) revert MarketNotTrading();
        if (IBinaryMarket(market).isResolved() || IBinaryMarket(market).isVoided()) revert MarketNotTrading();
        if (block.timestamp < ts || block.timestamp >= ex) revert MarketNotTrading();
        if (ex - block.timestamp < gp.minHeadroomSec) revert InsufficientHeadroom();

        if (i.kind > 3) revert BadKind();
        c.isBuy = (i.kind == 0 || i.kind == 2);
        c.isYes = (i.kind == 0 || i.kind == 1);

        if (c.isBuy) {
            if (i.price > ap.maxBuyPrice || i.price > gp.maxBuyPrice) revert PriceOutsidePolicy();
        } else {
            if (i.price < ap.minSellPrice || i.price < gp.minSellPrice) revert PriceOutsidePolicy();
        }

        IBinaryPool.OrderBookParams memory g = IBinaryPool(pool).getOrderBookParameters();
        if (g.tickSize != 0 && i.price % g.tickSize != 0) revert OffTickGrid();
        if (g.lotSize != 0 && i.quantity % g.lotSize != 0) revert OffLotGrid();
        if (i.quantity < g.minQuantity) revert BelowMinQuantity();

        uint64 cap = IBinaryPool(pool).marketExpiryNs();
        if (i.expireTimestampNs == 0 || i.expireTimestampNs > cap) revert OrderExpiryInvalid();

        c.oneCollateral = IBinaryPool(pool).getBinaryPoolParams().oneCollateral;
        c.reserve = _reserveFor(i.kind, i.price, i.quantity, c.oneCollateral);
        if (c.reserve > ap.maxOrderNotional || c.reserve > gp.maxSingleOrderNotional) revert OrderNotionalExceeded();
    }

    /// @dev A BUY escrows collateral. A SELL escrows outcome tokens; its
    ///      collateral-equivalent is the proceeds it forgoes, used only for the
    ///      notional ceiling, never added to committed capital.
    function _reserveFor(uint8 kind, uint256 price, uint256 quantity, uint256 one) internal pure returns (uint128) {
        uint256 unit = (kind == 0 || kind == 1) ? price : one - price;
        return uint128((unit * quantity + one - 1) / one);
    }

    // ------------------------------------- THE CROSS-AGENT ENFORCEMENT POINT
    function _reserve(Intent calldata i, Ctx memory c, GlobalPolicy memory gp) internal {
        c.dirBefore = directionalOf(i.marketId);
        c.grossBefore = bucketGross(c.bucket);

        // Reserve the FULL potential exposure before any capital moves. A
        // resting order that has not filled still carries the risk it will
        // create when it does, so it occupies the ceiling from this moment.
        MarketRes storage r = _res[i.marketId];
        uint128 q = uint128(i.quantity);
        if (i.kind == 0) r.yesLong += q;
        else if (i.kind == 1) r.yesShort += q;
        else if (i.kind == 2) r.noLong += q;
        else r.noShort += q;

        BucketPolicy memory bp = _bucketPolicy[c.bucket];
        uint128 grossAfter = c.grossBefore - _abs(c.dirBefore) + _abs(directionalOf(i.marketId));
        if (bp.maxGrossDirectional != 0 && grossAfter > bp.maxGrossDirectional) revert BucketDirectionalExceeded();

        if (c.isBuy) {
            // Committed capital ladders: agent -> bucket -> portfolio.
            uint128 newAgent = agentCommitted[msg.sender] + c.reserve;
            if (newAgent > _agentPolicy[msg.sender].maxCommitted) revert AgentCommittedExceeded();

            uint128 projected = committedCollateral() + c.reserve;
            if (projected > gp.maxCommittedCollateral) revert GlobalCommittedExceeded();
            if (bp.maxCommitted != 0 && projected > bp.maxCommitted) revert BucketCommittedExceeded();

            uint128 newResting = totalResting + c.reserve;
            if (newResting > gp.maxRestingReservation) revert GlobalRestingExceeded();

            agentCommitted[msg.sender] = newAgent;
            totalResting = newResting;
        }

        if (gp.maxLivePositions != 0 && livePositions(c.bucket) > gp.maxLivePositions) {
            revert MaxLivePositionsExceeded();
        }
    }

    // ---------------------------------------------------------- placement
    function _place(Intent calldata i, Ctx memory c) internal returns (uint128 orderId) {
        c.collBefore = uint128(IERC20Min(c.collateral).balanceOf(address(this)));
        c.yesBefore = uint128(outcomeToken.balanceOf(address(this), c.yesId));
        c.noBefore = uint128(outcomeToken.balanceOf(address(this), c.noId));

        if (c.isBuy) {
            IERC20Min(c.collateral).approve(i.pool, 0);
            IERC20Min(c.collateral).approve(i.pool, c.reserve);
        } else if (!outcomeToken.isOperator(address(this), i.pool)) {
            outcomeToken.setOperator(i.pool, true);
        }

        bool ok;
        (ok, orderId) = IBinaryPool(i.pool).placeBinaryOrder(
            i.kind, i.price, i.quantity, i.expireTimestampNs, i.orderType, 0, address(0), 0, uint64(i.nonce)
        );
        if (!ok) revert PlacementFailed();

        if (c.isBuy) IERC20Min(c.collateral).approve(i.pool, 0);
    }

    // ------------------------------------------------------- reconciliation
    function _reconcile(Intent calldata i, Ctx memory c, bytes32 ih, uint128 orderId) internal {
        // MEASURED: the outcome-token delta IS the filled quantity.
        uint128 filled;
        {
            uint128 yesAfter = uint128(outcomeToken.balanceOf(address(this), c.yesId));
            uint128 noAfter = uint128(outcomeToken.balanceOf(address(this), c.noId));
            filled = c.isYes
                ? (c.isBuy ? yesAfter - c.yesBefore : c.yesBefore - yesAfter)
                : (c.isBuy ? noAfter - c.noBefore : c.noBefore - noAfter);
        }

        // MEASURED: the BOOK decides what rests. An IOC remainder is cancelled,
        // a limit remainder rests, and only `getOrder` knows which.
        uint128 resting = _liveRemaining(i.pool, orderId);
        uint128 q = uint128(i.quantity);
        uint128 gone = q - resting; // filled or cancelled -- no longer a reservation

        // Drop the reservation down to what is actually still open. The realized
        // part needs no bookkeeping: it is now visible in the token balance.
        MarketRes storage r = _res[i.marketId];
        if (i.kind == 0) r.yesLong -= gone;
        else if (i.kind == 1) r.yesShort -= gone;
        else if (i.kind == 2) r.noLong -= gone;
        else r.noShort -= gone;

        uint128 collAfter = uint128(IERC20Min(c.collateral).balanceOf(address(this)));
        uint128 collOut = c.collBefore > collAfter ? c.collBefore - collAfter : 0;
        uint128 restingEscrow = resting == 0 ? 0 : _reserveFor(i.kind, i.price, resting, c.oneCollateral);
        // Collateral out = fill cost + escrow still locked behind the remainder.
        // The remainder escrows at OUR limit price, so the fill cost is exactly
        // derivable. We never guess a fill price.
        uint128 filledCost = collOut > restingEscrow ? collOut - restingEscrow : 0;

        if (c.isBuy) {
            uint128 unspent = c.reserve > collOut ? c.reserve - collOut : 0;
            if (unspent > 0) agentCommitted[msg.sender] -= unspent;
            totalResting -= (c.reserve - restingEscrow);
        }

        if (resting > 0) {
            _orders[_orderKey(i.pool, i.marketNonce, orderId)] = OrderRec({
                agent: msg.sender,
                marketId: i.marketId,
                pool: i.pool,
                marketNonce: i.marketNonce,
                orderId: orderId,
                kind: i.kind,
                qtyOpen: resting,
                collReserved: restingEscrow,
                open: true
            });
        }

        emit IntentReconciled(
            ih,
            c.reserve,
            filled,
            filledCost,
            resting,
            c.dirBefore,
            directionalOf(i.marketId),
            c.grossBefore,
            bucketGross(c.bucket),
            committedCollateral()
        );
    }

    /// @dev 0 when the pool has no ACTIVE order for this id -- it reverts
    ///      `IncorrectOrder()` for filled, cancelled, reduced or unknown ids.
    function _liveRemaining(address pool, uint128 orderId) internal view returns (uint128) {
        try IOrderBookView(pool).getOrder(orderId) returns (IOrderBookView.Order memory o) {
            return uint128(o.quantityRemaining);
        } catch {
            return 0;
        }
    }

    // ================================================================
    // RESERVATION RELEASE -- permissionless, but the POOL decides
    // ================================================================

    /// @notice Drop a reservation to whatever the pool still holds open.
    /// @dev Permissionless on purpose: it can only move the books toward
    ///      on-chain truth, and the pool -- not the caller -- supplies the
    ///      number. An agent cannot use it to free headroom for itself, because
    ///      the order has to actually be gone first. Whether it filled or was
    ///      cancelled does not matter here: if it filled, the position is
    ///      already visible in the token balance and directional exposure is
    ///      unchanged; if it was cancelled, the exposure genuinely disappears.
    function releaseOrder(bytes32 key) external {
        OrderRec storage o = _orders[key];
        if (!o.open) revert NothingToRelease();

        uint128 stillOpen = IBinaryPool(o.pool).marketNonce() != o.marketNonce
            ? 0 // pool recycled: that market is over
            : _liveRemaining(o.pool, o.orderId);

        if (stillOpen >= o.qtyOpen) revert OrderStillLive();

        uint128 released = o.qtyOpen - stillOpen;
        uint128 coll = o.collReserved == 0 ? 0 : uint128((uint256(o.collReserved) * released) / o.qtyOpen);

        MarketRes storage r = _res[o.marketId];
        if (o.kind == 0) r.yesLong -= released;
        else if (o.kind == 1) r.yesShort -= released;
        else if (o.kind == 2) r.noLong -= released;
        else r.noShort -= released;

        o.qtyOpen -= released;
        o.collReserved -= coll;
        if (o.qtyOpen == 0) o.open = false;
        totalResting = totalResting > coll ? totalResting - coll : 0;

        emit ReservationReleased(key, o.marketId, released, coll);
    }

    /// @notice Clear a settled market's exposure once it is terminal on-chain.
    /// @dev Permissionless and provable. Positions become claimable collateral,
    ///      so they stop being directional risk. Redemption is a separate
    ///      owner action; this only frees the risk envelope.
    function releaseSettled(bytes32 marketId) external {
        (,,,,,,,, address market,,,,,) = module.markets(marketId);
        if (market == address(0)) revert UnknownMarket();
        if (!IBinaryMarket(market).isResolved() && !IBinaryMarket(market).isVoided()) revert MarketNotSettled();

        MarketRes storage r = _res[marketId];
        if (r.settledReleased) revert NothingToRelease();

        int128 dir = directionalOf(marketId);
        r.yesLong = 0;
        r.yesShort = 0;
        r.noLong = 0;
        r.noShort = 0;
        r.settledReleased = true;
        _admitted[marketId].admitted = false; // drops out of bucketGross

        emit SettledExposureReleased(marketId, dir);
    }

    // ================================================================
    // Views
    // ================================================================

    function globalPolicy() external view returns (GlobalPolicy memory) {
        return _global;
    }

    function bucketPolicy(bytes32 b) external view returns (BucketPolicy memory) {
        return _bucketPolicy[b];
    }

    function bucketMarkets(bytes32 b) external view returns (bytes32[] memory) {
        return _bucketMarkets[b];
    }

    function reservations(bytes32 m) external view returns (MarketRes memory) {
        return _res[m];
    }

    function admittedMarket(bytes32 m) external view returns (AdmittedMarket memory) {
        return _admitted[m];
    }

    function agentPolicy(address a) external view returns (AgentPolicy memory) {
        return _agentPolicy[a];
    }

    function orderRec(bytes32 k) external view returns (OrderRec memory) {
        return _orders[k];
    }

    function agentCount() external view returns (uint256) {
        return agents.length;
    }

    function orderKey(address pool, uint64 nonce, uint128 orderId) external pure returns (bytes32) {
        return _orderKey(pool, nonce, orderId);
    }

    function hashIntent(address agent, Intent calldata i) external view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, agent, i));
    }

    function outcomeIdFor(address pool, uint64 nonce, uint8 idx) external pure returns (uint256) {
        return _outcomeId(pool, nonce, idx);
    }

    // ================================================================
    // Internals
    // ================================================================

    /// @dev Order ids are per-pool and pools are recycled, so an id alone is not
    ///      a key. Binding the generation prevents a stale id from colliding
    ///      with a live order on the same address.
    function _orderKey(address pool, uint64 nonce, uint128 orderId) internal pure returns (bytes32) {
        return keccak256(abi.encode(pool, nonce, orderId));
    }

    function _outcomeId(address pool, uint64 nonce, uint8 idx) internal pure returns (uint256) {
        return (uint256(uint160(pool)) << 72) | (uint256(nonce) << 8) | uint256(idx);
    }

    function _abs(int128 x) internal pure returns (uint128) {
        return x >= 0 ? uint128(x) : uint128(-x);
    }

    receive() external payable {}
}
