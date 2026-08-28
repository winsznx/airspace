// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    IBinaryMarketsModule,
    IBinaryPool,
    IBinaryMarket,
    IOrderBookView,
    IOutcomeToken6909,
    IERC20Minimal
} from "./interfaces/IDreamDex.sol";
import {
    GlobalPolicy,
    DomainPolicy,
    AgentPolicy,
    Intent,
    Refusal,
    Evaluation,
    AdmissionView,
    Gate
} from "./interfaces/IAirspace.sol";
import {Cadence} from "./libraries/Cadence.sol";

/// @title AirspacePortfolio
/// @author AIRSPACE
/// @notice One capital pool. Many trading agents. One shared risk envelope.
///
/// Several independently controlled DreamDEX Event Contract agents share one
/// capital base. Every proposed order must pass BOTH its local agent policy AND
/// atomic portfolio-wide admission. An individually legal order is refused when
/// reservations or positions created by OTHER agents have already consumed the
/// portfolio's risk capacity.
///
/// ---------------------------------------------------------------------------
/// Four properties carry the safety argument. Each was established by hostile
/// validation, not by design preference; see `engineering/` for the evidence.
///
/// 1. ONE CONTRACT HOLDS ALL CAPITAL. Aggregate admission must be atomic and
///    unbypassable. Reserve-then-place happens in a single call, so admission
///    and the value transfer it authorises cannot be separated, and two agents
///    racing the same headroom are serialised by the EVM with no off-chain lock.
///    Custody here is forced rather than chosen: `placeBinaryOrderFor` reverts
///    `OnlyApprovedContracts()` for every EOA caller, so DreamDEX Event
///    Contracts expose no user-grantable session-key path at all.
///
/// 2. RISK DOMAINS ARE STRUCTURAL, NOT SEMANTIC. A domain is
///    `keccak256(creator, collateral, canonicalCadence)`, every field read from
///    the module registry during execution. No indexer, no owner-supplied "BTC"
///    string, no event-log attestation, no relayer, no per-market admission.
///    This contract CANNOT distinguish BTC from ETH and never claims to:
///    sibling series of one cadence share a domain deliberately.
///
/// 3. LIVE POSITION STATE IS READ, NOT ACCUMULATED. `getOrder` reverts
///    identically for a filled and a cancelled order, so a running exposure
///    counter cannot stay correct once fills land in transactions this contract
///    never executes. Realized positions come from the ERC-6909 singleton;
///    storage holds only unfilled reservations, which this contract created.
///
/// 4. UNCERTAINTY OVERSTATES, NEVER UNDERSTATES. Where exact risk is not
///    provable the portfolio retains capacity. Recorded usage may exceed true
///    economic exposure; it must never fall below the maximum commitment still
///    reachable from admitted state.
/// ---------------------------------------------------------------------------
contract AirspacePortfolio {
    using Cadence for uint64;

    string public constant VERSION = "1.0.0";

    // ----------------------------------------------------------------- errors
    error AlreadyInitialized();
    error NotOwner();
    error ZeroAddress();
    error TransferFailed();
    error Reentrancy();
    /// @notice Admission refused. `code` names the exact gate that failed.
    error Refused(Refusal code);
    error PlacementFailed();
    error OrderStillLive();
    error NothingToRelease();
    error MarketNotSettled();
    error MarketStillActive();
    error NotTracked();

    // -------------------------------------------------------------- constants

    /// @dev Bounds domain iteration and therefore worst-case admission gas.
    ///      Reaching the cap fails closed (`DOMAIN_MARKETS_FULL`); pruning is
    ///      permissionless, so a keeper restores capacity without privilege.
    uint32 public constant MAX_MARKETS_PER_DOMAIN = 48;

    /// @dev Transient-storage slot for the reentrancy lock (EIP-1153).
    ///      Literal because inline assembly only accepts direct number constants;
    ///      value is keccak256("airspace.reentrancy.lock").
    uint256 private constant _LOCK = 0xf138d38dc9e601898747f91857868a6836c47c0bd9741577069d51e5ca094508;

    // ------------------------------------------------------------------ types

    /// @notice Unfilled reservations plus the structural facts captured when this
    ///         portfolio first touched the market. Realized positions are NOT
    ///         mirrored here; they are read from the outcome token.
    struct MarketState {
        address pool; // pinned at first touch, re-verified every execution
        uint64 marketNonce; // the generation this portfolio traded
        bytes32 domain;
        uint128 yesLong; // open BUY_YES quantity
        uint128 yesShort; // open SELL_YES quantity
        uint128 noLong; // open BUY_NO quantity
        uint128 noShort; // open SELL_NO quantity
        bool tracked;
        bool settled; // terminal on-chain: a fixed claim, not a bet
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
    }

    // ---------------------------------------------------------------- storage
    address public owner;
    IBinaryMarketsModule public module;
    IOutcomeToken6909 public outcomeToken;
    address public collateralToken;
    address public factory;

    /// @notice Auto-generated tuple getter; cheaper than returning a memory struct.
    GlobalPolicy public globalPolicy;
    bytes32 public globalPolicyHash;
    uint64 public policyEpoch;

    mapping(address => AgentPolicy) public agentPolicy;
    mapping(address => bytes32) public agentPolicyHash;
    mapping(address => uint128) public agentCommitted;
    mapping(address => uint64) public agentLastTradeAt;
    /// @notice Strictly-increasing per-agent nonce watermark.
    /// @dev Replay protection in ONE storage slot per agent rather than one per
    ///      intent, which is what keeps storage bounded by agent count instead of
    ///      by history (PRD 19.3). A reverted intent does not consume its nonce.
    mapping(address => uint64) public agentNonce;

    mapping(bytes32 => DomainPolicy) public domainPolicy;
    mapping(bytes32 => bytes32[]) internal _domainMarkets;
    mapping(bytes32 => uint256) internal _marketSlot; // marketId => 1-based index
    mapping(bytes32 => MarketState) public marketState;

    mapping(bytes32 => OrderRec) public orderRec;

    /// @notice Collateral placed under management.
    /// @dev `committedCapital` is DERIVED as `capitalBase - freeCollateral`, which
    ///      is exact and self-healing: escrow leaving for a resting order,
    ///      collateral spent on a fill, a cancel returning escrow and a redemption
    ///      returning collateral all move the token balance, so all four are
    ///      reflected with no bookkeeping and no fill/cancel ambiguity.
    uint128 public capitalBase;

    /// @notice Collateral escrowed behind orders believed to still be resting.
    /// @dev Tracked, not measured. May OVERSTATE after a maker fill this contract
    ///      never saw, until `releaseOrder` runs. Never understates.
    uint128 public reservedCollateral;

    // ----------------------------------------------------------------- events
    event Initialized(address indexed owner, address module, address outcomeToken, string version);
    event GlobalPolicySet(bytes32 indexed policyHash, uint64 indexed epoch, GlobalPolicy policy);
    event DomainPolicySet(bytes32 indexed domain, DomainPolicy policy);
    event AgentSet(address indexed agent, bytes32 indexed policyHash, bool enabled, AgentPolicy policy);
    event AgentRevoked(address indexed agent);
    event Funded(address indexed from, uint256 amount, uint128 capitalBaseAfter);
    event CapitalBaseSet(uint128 capitalBase);
    event MarketTracked(bytes32 indexed marketId, bytes32 indexed domain, address pool, uint64 marketNonce);
    event MarketPruned(bytes32 indexed marketId, bytes32 indexed domain);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OutcomeWithdrawn(uint256 indexed id, address indexed to, uint256 amount);
    event Redeemed(bytes32 indexed marketId, uint8 outcomeIdx, uint256 amount);

    /// @notice An intent was admitted and an order was submitted to DreamDEX.
    event IntentAdmitted(
        bytes32 indexed intentHash,
        bytes32 indexed marketId,
        address indexed agent,
        bytes32 domain,
        address pool,
        uint64 marketNonce,
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint128 orderId,
        bytes32 strategyVersion
    );

    /// @notice The reconciliation half of the receipt. Measured or exactly derived.
    event IntentReconciled(
        bytes32 indexed intentHash,
        uint128 reserveRequired,
        uint128 filledQty, // MEASURED: ERC-6909 balance delta
        uint128 filledCost, // DERIVED: collateral delta minus resting escrow
        uint128 restingQty, // MEASURED: the pool's own quantityRemaining
        int128 directionalBefore,
        int128 directionalAfter,
        uint128 domainUsageBefore,
        uint128 domainUsageAfter,
        uint128 committedAfter
    );

    /// @notice An intent was refused. Emitted only by the on-chain refusal path.
    event IntentRefused(bytes32 indexed intentHash, address indexed agent, bytes32 indexed marketId, Refusal code);

    event ReservationReleased(
        bytes32 indexed orderKey, bytes32 indexed marketId, uint128 qtyReleased, uint128 collateralReleased
    );
    event SettledExposureReleased(bytes32 indexed marketId, int128 directionalCleared);

    // -------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev EIP-1153 transient lock. `execute` calls out to the DreamDEX pool;
    ///      the pool is registry-derived rather than agent-supplied, but a
    ///      reentrant path would let one intent observe half-written reservation
    ///      state, so it is closed explicitly.
    modifier nonReentrant() {
        assembly ("memory-safe") {
            if tload(_LOCK) {
                mstore(0x00, 0xab143c06) // Reentrancy()
                revert(0x1c, 0x04)
            }
            tstore(_LOCK, 1)
        }
        _;
        assembly ("memory-safe") {
            tstore(_LOCK, 0)
        }
    }

    // ------------------------------------------------------------------- init
    function initialize(address owner_, address module_, address outcomeToken_, address collateral_) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (owner_ == address(0) || module_ == address(0) || outcomeToken_ == address(0)) revert ZeroAddress();
        owner = owner_;
        factory = msg.sender;
        module = IBinaryMarketsModule(module_);
        outcomeToken = IOutcomeToken6909(outcomeToken_);
        collateralToken = collateral_;
        emit Initialized(owner_, module_, outcomeToken_, VERSION);
    }

    // =====================================================================
    // STRUCTURAL DOMAIN DERIVATION — no attestation anywhere
    // =====================================================================

    function domainKey(address creator, address collateral, uint32 cadenceSec) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, collateral, cadenceSec));
    }

    /// @notice The structural risk domain a market belongs to, or 0 if none.
    /// @dev Derived entirely from the module registry at call time. A market
    ///      created one second ago resolves correctly with zero configuration.
    function domainOf(bytes32 marketId) public view returns (bytes32) {
        (,,, address collateral,,,, address creator,, address pool,,, uint64 ts, uint64 ex) = module.markets(marketId);
        if (pool == address(0)) return bytes32(0);
        uint32 cad = Cadence.canonical(ts, ex);
        if (cad == 0) return bytes32(0);
        return domainKey(creator, collateral, cad);
    }

    // =====================================================================
    // MEASUREMENT — read from the chain, never from an accumulator
    // =====================================================================

    function freeCollateral() public view returns (uint128) {
        if (collateralToken == address(0)) return 0;
        return uint128(IERC20Minimal(collateralToken).balanceOf(address(this)));
    }

    /// @notice Collateral no longer free: escrowed behind resting orders, or spent
    ///         acquiring positions. Measured, not accumulated.
    function committedCapital() public view returns (uint128) {
        uint128 free = freeCollateral();
        return capitalBase > free ? capitalBase - free : 0;
    }

    /// @notice Net outcome exposure of ONE market, in contract units.
    /// @dev `netYes - netNo`, each leg being the realized ERC-6909 balance plus
    ///      open buy reservations minus open sell reservations. Within one market
    ///      a matched YES+NO pair is a complete set — worth exactly one collateral
    ///      unit at settlement regardless of outcome — so it carries zero
    ///      directional exposure and correctly nets to zero. A settled market
    ///      returns 0: its position is a fixed claim, not a bet.
    function marketDirectionalExposure(bytes32 marketId) public view returns (int128) {
        MarketState storage m = marketState[marketId];
        if (!m.tracked || m.settled) return 0;
        return _directional(m);
    }

    function _directional(MarketState storage m) internal view returns (int128) {
        uint256 yesId = _outcomeId(m.pool, m.marketNonce, 0);
        int256 yes = int256(outcomeToken.balanceOf(address(this), yesId)) + int256(uint256(m.yesLong))
            - int256(uint256(m.yesShort));
        int256 no = int256(outcomeToken.balanceOf(address(this), yesId + 1)) + int256(uint256(m.noLong))
            - int256(uint256(m.noShort));
        return int128(yes - no);
    }

    /// @notice Domain risk usage: the sum of ABSOLUTE directional exposure over
    ///         the domain's tracked markets.
    /// @dev Gross, never netted across markets. Two markets in one cadence domain
    ///      are different questions resolving at different times against different
    ///      reference prices — and the domain does not even establish that they
    ///      share an underlying. Netting would understate; summing absolutes can
    ///      only overstate, which is the safe direction.
    function domainRiskUsage(bytes32 domain) public view returns (uint128 usage) {
        bytes32[] storage ids = _domainMarkets[domain];
        uint256 n = ids.length;
        for (uint256 k; k < n; ++k) {
            usage += _abs(marketDirectionalExposure(ids[k]));
        }
    }

    function liveMarkets(bytes32 domain) public view returns (uint32 n) {
        bytes32[] storage ids = _domainMarkets[domain];
        uint256 len = ids.length;
        for (uint256 k; k < len; ++k) {
            if (marketDirectionalExposure(ids[k]) != 0) ++n;
        }
    }

    // =====================================================================
    // OWNER SURFACE — unconditional, never gated on agent or market state
    // =====================================================================

    function setGlobalPolicy(GlobalPolicy calldata p) external onlyOwner {
        globalPolicy = p;
        globalPolicyHash = keccak256(abi.encode(p));
        unchecked {
            policyEpoch += 1;
        }
        emit GlobalPolicySet(globalPolicyHash, policyEpoch, p);
    }

    /// @notice Configure a STRUCTURAL domain. This is the only admission step and
    ///         it is per-domain, not per-market: one call covers every market that
    ///         series will ever roll, forever.
    function setDomainPolicy(bytes32 domain, DomainPolicy calldata p) external onlyOwner {
        domainPolicy[domain] = p;
        emit DomainPolicySet(domain, p);
    }

    function setAgent(address agent, AgentPolicy calldata p) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        agentPolicy[agent] = p;
        agentPolicyHash[agent] = keccak256(abi.encode(p));
        emit AgentSet(agent, agentPolicyHash[agent], p.enabled, p);
    }

    /// @notice Revoke an agent immediately. Its committed attribution is retained
    ///         so historical accounting stays honest.
    function revokeAgent(address agent) external onlyOwner {
        agentPolicy[agent].enabled = false;
        agentPolicyHash[agent] = keccak256(abi.encode(agentPolicy[agent]));
        emit AgentRevoked(agent);
    }

    /// @notice Deposit collateral and credit it to the portfolio's capital base.
    /// @dev Permissionless: adding capital can only help the owner. This is the
    ///      supported deposit path — a raw ERC-20 transfer into the portfolio is
    ///      spendable but uncredited until `setCapitalBase` reconciles it.
    function fund(uint256 amount) external {
        address t = collateralToken;
        if (t == address(0)) revert ZeroAddress();
        (bool ok, bytes memory ret) =
            t.call(abi.encodeWithSignature("transferFrom(address,address,uint256)", msg.sender, address(this), amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        capitalBase += uint128(amount);
        emit Funded(msg.sender, amount, capitalBase);
    }

    /// @notice Reconcile the capital base, e.g. after a raw transfer in.
    /// @dev Owner-only and deliberately explicit rather than automatic: raising
    ///      `capitalBase` raises measured `committedCapital`, so it must be a
    ///      considered act, not a side effect of somebody sending tokens.
    function setCapitalBase(uint128 newBase) external onlyOwner {
        capitalBase = newBase;
        emit CapitalBaseSet(newBase);
    }

    function withdraw(address token, address to, uint256 amount) external onlyOwner {
        if (!IERC20Minimal(token).transfer(to, amount)) revert TransferFailed();
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
        emit Redeemed(marketId, outcomeIdx, amount);
    }

    /// @notice Unconditional owner recovery hatch. Unreachable by any agent.
    /// @dev Grants the owner no privilege they do not already hold — they own every
    ///      asset here — so that recovery never depends on this contract having
    ///      anticipated a protocol upgrade.
    function ownerCall(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call{value: value}(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
        return ret;
    }

    // =====================================================================
    // EVALUATION — the single source of admission truth
    // =====================================================================

    /// @notice Evaluate an intent without changing state or reverting.
    /// @dev `execute` runs this exact function and reverts on a non-NONE refusal,
    ///      so the product's gate-by-gate display and the enforced decision come
    ///      from one code path and cannot drift apart.
    function previewIntent(address agent, Intent calldata i) external view returns (AdmissionView memory v) {
        Evaluation memory e = _evaluate(agent, i);
        v = AdmissionView({
            refusal: e.refusal,
            gates: e.gates,
            domain: e.domain,
            cadenceSec: e.cadenceSec,
            pool: e.pool,
            expiry: e.expiry,
            reserveRequired: e.reserveRequired,
            marketDirectionalBefore: e.marketDirectionalBefore,
            marketDirectionalAfter: e.marketDirectionalAfter,
            domainUsageBefore: e.domainUsageBefore,
            domainUsageAfter: e.domainUsageAfter,
            domainCeiling: e.domainCeiling,
            committedAfter: e.committedAfter,
            globalCommittedCeiling: e.globalCommittedCeiling,
            agentCommittedAfter: e.agentCommittedAfter,
            agentCommittedCeiling: e.agentCommittedCeiling
        });
    }

    function _evaluate(address agent, Intent calldata i) internal view returns (Evaluation memory e) {
        AgentPolicy storage ap = agentPolicy[agent];
        GlobalPolicy storage gp = globalPolicy;

        // ---- agent identity and local policy ------------------------------
        if (agentPolicyHash[agent] != bytes32(0)) e.gates |= Gate.AGENT_REGISTERED;
        if (e.gates & Gate.AGENT_REGISTERED == 0) return _refuse(e, Refusal.NOT_AGENT);
        if (!ap.enabled) return _refuse(e, Refusal.AGENT_DISABLED);
        if (gp.policyExpiry == 0 || block.timestamp > gp.policyExpiry) return _refuse(e, Refusal.POLICY_EXPIRED);
        if (i.nonce <= agentNonce[agent]) return _refuse(e, Refusal.INTENT_REPLAYED);
        uint64 last = agentLastTradeAt[agent];
        if (last != 0 && block.timestamp < uint256(last) + ap.cooldownSec) return _refuse(e, Refusal.COOLDOWN_ACTIVE);
        e.gates |= Gate.AGENT_POLICY;

        // ---- authoritative market resolution ------------------------------
        address creator;
        address collateral;
        {
            (,,, address coll,,,, address cr, address mk, address pl,,, uint64 ts, uint64 ex) =
                module.markets(i.marketId);
            if (pl == address(0)) return _refuse(e, Refusal.MARKET_NOT_FOUND);
            e.pool = pl;
            e.market = mk;
            e.tradingStart = ts;
            e.expiry = ex;
            creator = cr;
            collateral = coll;
        }
        e.gates |= Gate.MARKET_RESOLVED;
        if (e.pool != i.pool) return _refuse(e, Refusal.POOL_MISMATCH);

        // ---- structural domain, derived here, from the registry, every time -
        e.cadenceSec = Cadence.canonical(e.tradingStart, e.expiry);
        if (e.cadenceSec == 0) return _refuse(e, Refusal.DOMAIN_UNSUPPORTED);
        e.domain = domainKey(creator, collateral, e.cadenceSec);
        DomainPolicy storage dp = domainPolicy[e.domain];
        if (dp.configured) e.gates |= Gate.DOMAIN_CONFIGURED;
        if (!dp.configured) return _refuse(e, Refusal.DOMAIN_NOT_CONFIGURED);

        // ---- generation binding -------------------------------------------
        e.marketNonce = i.marketNonce;
        e.yesId = _outcomeId(e.pool, i.marketNonce, 0);
        {
            MarketState storage prior = marketState[i.marketId];
            if (
                prior.tracked
                    && (prior.pool != e.pool || prior.marketNonce != i.marketNonce || prior.domain != e.domain)
            ) return _refuse(e, Refusal.MARKET_GENERATION_MISMATCH);
        }
        if (IBinaryPool(e.pool).marketNonce() != i.marketNonce) {
            return _refuse(e, Refusal.MARKET_GENERATION_MISMATCH);
        }
        e.gates |= Gate.GENERATION;

        // ---- authoritative Trading state (chain only, never the indexer) ---
        if (IBinaryPool(e.pool).finalized()) return _refuse(e, Refusal.MARKET_NOT_TRADING);
        if (IBinaryMarket(e.market).isResolved() || IBinaryMarket(e.market).isVoided()) {
            return _refuse(e, Refusal.MARKET_NOT_TRADING);
        }
        if (block.timestamp < e.tradingStart || block.timestamp >= e.expiry) {
            return _refuse(e, Refusal.MARKET_NOT_TRADING);
        }
        e.gates |= Gate.MARKET_TRADING;
        if (e.expiry - block.timestamp < gp.minHeadroomSec) return _refuse(e, Refusal.INSUFFICIENT_HEADROOM);
        e.gates |= Gate.HEADROOM;

        // ---- order shape ---------------------------------------------------
        if (i.kind > 3) return _refuse(e, Refusal.BAD_ORDER_KIND);
        bool isBuy = (i.kind == 0 || i.kind == 2);
        if (isBuy) {
            if (i.price > ap.maxBuyPrice || i.price > gp.maxBuyPrice) return _refuse(e, Refusal.PRICE_OUTSIDE_POLICY);
        } else {
            if (i.price < ap.minSellPrice || i.price < gp.minSellPrice) {
                return _refuse(e, Refusal.PRICE_OUTSIDE_POLICY);
            }
        }
        e.gates |= Gate.PRICE;

        {
            IBinaryPool.OrderBookParams memory g = IBinaryPool(e.pool).getOrderBookParameters();
            if (g.tickSize != 0 && i.price % g.tickSize != 0) return _refuse(e, Refusal.OFF_TICK_GRID);
            if (g.lotSize != 0 && i.quantity % g.lotSize != 0) return _refuse(e, Refusal.OFF_LOT_GRID);
            if (i.quantity < g.minQuantity) return _refuse(e, Refusal.BELOW_MIN_QUANTITY);
        }
        if (i.expireTimestampNs == 0 || i.expireTimestampNs > IBinaryPool(e.pool).marketExpiryNs()) {
            return _refuse(e, Refusal.ORDER_EXPIRY_INVALID);
        }
        e.gates |= Gate.GRID;

        // ---- worst-case reservation ---------------------------------------
        e.oneCollateral = IBinaryPool(e.pool).getBinaryPoolParams().oneCollateral;
        e.reserveRequired = _reserveFor(i.kind, i.price, i.quantity, e.oneCollateral);
        if (e.reserveRequired > ap.maxOrderNotional) return _refuse(e, Refusal.AGENT_ORDER_NOTIONAL_EXCEEDED);
        if (e.reserveRequired > gp.maxSingleOrderNotional) return _refuse(e, Refusal.GLOBAL_ORDER_NOTIONAL_EXCEEDED);

        // ---- THE CROSS-AGENT ADMISSION CHECK -------------------------------
        _projectCapacity(e, i, agent, dp, gp, isBuy);
        return e;
    }

    /// @dev Splits out purely to keep `_evaluate` under the stack limit.
    function _projectCapacity(
        Evaluation memory e,
        Intent calldata i,
        address agent,
        DomainPolicy storage dp,
        GlobalPolicy storage gp,
        bool isBuy
    ) internal view {
        MarketState storage m = marketState[i.marketId];

        e.marketDirectionalBefore = marketDirectionalExposure(i.marketId);
        e.domainUsageBefore = domainRiskUsage(e.domain);
        e.domainCeiling = dp.maxDomainRiskUsage;

        // Project the FULL potential exposure, as though the order fills
        // completely. A resting order that has not filled still carries the risk
        // it will create when it does, so it occupies the ceiling from admission.
        int128 q = int128(uint128(i.quantity));
        int128 dYes;
        int128 dNo;
        if (i.kind == 0) dYes = q;
        else if (i.kind == 1) dYes = -q;
        else if (i.kind == 2) dNo = q;
        else dNo = -q;
        e.marketDirectionalAfter = e.marketDirectionalBefore + dYes - dNo;

        // A market with no live state yet is not in the domain set, so its
        // contribution is added rather than swapped.
        uint128 before_ = m.tracked ? _abs(e.marketDirectionalBefore) : 0;
        e.domainUsageAfter = e.domainUsageBefore - before_ + _abs(e.marketDirectionalAfter);

        if (e.domainUsageAfter > e.domainCeiling) {
            e.refusal = Refusal.DOMAIN_RISK_EXCEEDED;
            return;
        }
        e.gates |= Gate.DOMAIN_CAPACITY;

        if (!m.tracked && _domainMarkets[e.domain].length >= MAX_MARKETS_PER_DOMAIN) {
            e.refusal = Refusal.DOMAIN_MARKETS_FULL;
            return;
        }

        e.committedBefore = committedCapital();
        e.agentCommittedBefore = agentCommitted[agent];
        e.globalCommittedCeiling = gp.maxCommittedCapital;
        e.agentCommittedCeiling = agentPolicy[agent].maxCommitted;
        e.committedAfter = e.committedBefore;
        e.agentCommittedAfter = e.agentCommittedBefore;

        if (isBuy) {
            if (freeCollateral() < e.reserveRequired) {
                e.refusal = Refusal.INSUFFICIENT_COLLATERAL;
                return;
            }
            e.agentCommittedAfter = e.agentCommittedBefore + e.reserveRequired;
            e.committedAfter = e.committedBefore + e.reserveRequired;

            if (e.agentCommittedAfter > e.agentCommittedCeiling) {
                e.refusal = Refusal.AGENT_COMMITTED_EXCEEDED;
                return;
            }
            if (e.committedAfter > e.globalCommittedCeiling) {
                e.refusal = Refusal.GLOBAL_COMMITTED_EXCEEDED;
                return;
            }
            if (dp.maxDomainCommitted != 0 && e.committedAfter > dp.maxDomainCommitted) {
                e.refusal = Refusal.DOMAIN_COMMITTED_EXCEEDED;
                return;
            }
            if (uint256(reservedCollateral) + e.reserveRequired > gp.maxReservedCollateral) {
                e.refusal = Refusal.GLOBAL_RESERVED_EXCEEDED;
                return;
            }
        }
        e.gates |= Gate.GLOBAL_CAPACITY;

        if (dp.maxLiveMarkets != 0) {
            uint32 live = liveMarkets(e.domain);
            if (!m.tracked || e.marketDirectionalBefore == 0) {
                if (e.marketDirectionalAfter != 0) live += 1;
            }
            if (live > dp.maxLiveMarkets) {
                e.refusal = Refusal.MAX_LIVE_MARKETS_EXCEEDED;
                return;
            }
        }
    }

    function _refuse(Evaluation memory e, Refusal r) internal pure returns (Evaluation memory) {
        e.refusal = r;
        return e;
    }

    /// @dev A BUY escrows collateral. A SELL escrows outcome tokens; its
    ///      collateral-equivalent is used only for notional ceilings and is never
    ///      added to committed capital.
    function _reserveFor(uint8 kind, uint256 price, uint256 quantity, uint256 one) internal pure returns (uint128) {
        uint256 unit = (kind == 0 || kind == 1) ? price : one - price;
        return uint128((unit * quantity + one - 1) / one);
    }

    // =====================================================================
    // EXECUTION
    // =====================================================================

    /// @notice Propose an order. The portfolio decides whether capital moves.
    /// @dev Reservation and placement happen in ONE call, so aggregate admission
    ///      and the value transfer it authorises cannot be separated. Two agents
    ///      competing for the same headroom are serialised by the EVM: the first
    ///      to land reserves, the second re-reads the updated state and is refused.
    ///      No off-chain mutex is required or used.
    function execute(Intent calldata i) external nonReentrant returns (uint128 orderId) {
        Evaluation memory e = _evaluate(msg.sender, i);
        bytes32 ih = _intentHash(msg.sender, i);
        if (e.refusal != Refusal.NONE) {
            emit IntentRefused(ih, msg.sender, i.marketId, e.refusal);
            revert Refused(e.refusal);
        }

        agentNonce[msg.sender] = i.nonce;
        agentLastTradeAt[msg.sender] = uint64(block.timestamp);

        _commitReservation(msg.sender, i, e);
        ExecCtx memory c;
        (orderId, c) = _place(i, e);

        emit IntentAdmitted(
            ih,
            i.marketId,
            msg.sender,
            e.domain,
            e.pool,
            i.marketNonce,
            i.kind,
            i.price,
            i.quantity,
            orderId,
            i.strategyVersion
        );

        _reconcile(msg.sender, i, e, c, ih, orderId);
    }

    function _commitReservation(address agent, Intent calldata i, Evaluation memory e) internal {
        MarketState storage m = marketState[i.marketId];

        if (!m.tracked) {
            m.pool = e.pool;
            m.marketNonce = i.marketNonce;
            m.domain = e.domain;
            m.tracked = true;
            _domainMarkets[e.domain].push(i.marketId);
            _marketSlot[i.marketId] = _domainMarkets[e.domain].length;
            emit MarketTracked(i.marketId, e.domain, e.pool, i.marketNonce);
        }

        uint128 q = uint128(i.quantity);
        if (i.kind == 0) m.yesLong += q;
        else if (i.kind == 1) m.yesShort += q;
        else if (i.kind == 2) m.noLong += q;
        else m.noShort += q;

        if (i.kind == 0 || i.kind == 2) {
            agentCommitted[agent] = e.agentCommittedAfter;
            reservedCollateral += e.reserveRequired;
        }
    }

    /// @dev Balances captured immediately before placement, so the fill can be
    ///      MEASURED as a delta rather than inferred from anything the pool says.
    struct ExecCtx {
        uint128 yesBefore;
        uint128 noBefore;
        uint128 freeBefore;
    }

    function _place(Intent calldata i, Evaluation memory e) internal returns (uint128 orderId, ExecCtx memory c) {
        c.yesBefore = uint128(outcomeToken.balanceOf(address(this), e.yesId));
        c.noBefore = uint128(outcomeToken.balanceOf(address(this), e.yesId + 1));
        c.freeBefore = freeCollateral();

        bool isBuy = (i.kind == 0 || i.kind == 2);
        if (isBuy) {
            // Exact per-order allowance, cleared immediately after placement, so
            // no standing allowance survives the call.
            IERC20Minimal(collateralToken).approve(i.pool, 0);
            IERC20Minimal(collateralToken).approve(i.pool, e.reserveRequired);
        } else {
            _authorizeOutcomeEscrow(i.pool);
        }

        bool ok;
        (ok, orderId) = IBinaryPool(i.pool)
            .placeBinaryOrder(i.kind, i.price, i.quantity, i.expireTimestampNs, i.orderType, 0, address(0), 0, i.nonce);
        if (!ok) revert PlacementFailed();

        if (isBuy) IERC20Minimal(collateralToken).approve(i.pool, 0);
    }

    /// @dev A SELL escrows outcome tokens. The ERC-6909 operator model exposes no
    ///      per-id form for the pool's escrow path, so the grant is pool-wide, made
    ///      lazily on first sell, and only to a pool the module registry binds to a
    ///      configured market. Residual risk is documented in SECURITY.md.
    function _authorizeOutcomeEscrow(address pool) internal {
        if (!outcomeToken.isOperator(address(this), pool)) {
            outcomeToken.setOperator(pool, true);
        }
    }

    function _reconcile(
        address agent,
        Intent calldata i,
        Evaluation memory e,
        ExecCtx memory c,
        bytes32 ih,
        uint128 orderId
    ) internal {
        MarketState storage m = marketState[i.marketId];
        bool isBuy = (i.kind == 0 || i.kind == 2);
        bool isYes = (i.kind == 0 || i.kind == 1);

        // MEASURED: the outcome-token delta IS the filled quantity.
        uint128 filled;
        {
            uint128 after_ = uint128(outcomeToken.balanceOf(address(this), isYes ? e.yesId : e.yesId + 1));
            uint128 before_ = isYes ? c.yesBefore : c.noBefore;
            filled = isBuy ? (after_ - before_) : (before_ - after_);
        }

        // MEASURED: the BOOK decides what rests. An IOC remainder is cancelled and
        // a limit remainder rests, and only `getOrder` can tell them apart.
        uint128 resting = _liveRemaining(i.pool, orderId);
        uint128 gone = uint128(i.quantity) - resting;

        // Drop the reservation to what is genuinely still open. The realized part
        // needs no bookkeeping: it is now visible in the token balance.
        if (i.kind == 0) m.yesLong -= gone;
        else if (i.kind == 1) m.yesShort -= gone;
        else if (i.kind == 2) m.noLong -= gone;
        else m.noShort -= gone;

        uint128 filledCost;
        uint128 restingEscrow;
        if (isBuy) {
            uint128 freeAfter = freeCollateral();
            uint128 collOut = c.freeBefore > freeAfter ? c.freeBefore - freeAfter : 0;
            restingEscrow = resting == 0 ? 0 : _reserveFor(i.kind, i.price, resting, e.oneCollateral);
            // Collateral out = fill cost + escrow still locked behind the resting
            // remainder. The remainder escrows at OUR limit price, which we know,
            // so the fill cost is exactly derivable. No fill price is ever guessed.
            filledCost = collOut > restingEscrow ? collOut - restingEscrow : 0;

            // Reserved but unspent collateral comes straight back: a taker is
            // charged the resting price, not its own limit.
            uint128 unspent = e.reserveRequired > collOut ? e.reserveRequired - collOut : 0;
            if (unspent != 0) agentCommitted[agent] -= unspent;
            reservedCollateral -= (e.reserveRequired - restingEscrow);
        }

        if (resting != 0) {
            orderRec[_orderKey(i.pool, i.marketNonce, orderId)] = OrderRec({
                agent: agent,
                marketId: i.marketId,
                pool: i.pool,
                marketNonce: i.marketNonce,
                orderId: orderId,
                kind: i.kind,
                qtyOpen: resting,
                collReserved: restingEscrow
            });
        }

        emit IntentReconciled(
            ih,
            e.reserveRequired,
            filled,
            filledCost,
            resting,
            e.marketDirectionalBefore,
            marketDirectionalExposure(i.marketId),
            e.domainUsageBefore,
            domainRiskUsage(e.domain),
            committedCapital()
        );
    }

    function _liveRemaining(address pool, uint128 orderId) internal view returns (uint128) {
        try IOrderBookView(pool).getOrder(orderId) returns (IOrderBookView.Order memory o) {
            return uint128(o.quantityRemaining);
        } catch {
            return 0;
        }
    }

    // =====================================================================
    // LIFECYCLE — permissionless, but the CHAIN decides
    // =====================================================================

    /// @notice Drop a reservation to whatever the pool still holds open.
    /// @dev Permissionless because it is not discretionary: the pool supplies the
    ///      number and the caller supplies none. It can only move the books toward
    ///      on-chain truth. Whether the order filled or was cancelled is irrelevant
    ///      — if it filled, the position is already visible in the token balance
    ///      and directional exposure is unchanged; if it was cancelled, the
    ///      exposure genuinely disappears. A recycled pool means that market is
    ///      over, so the whole reservation is released.
    function releaseOrder(bytes32 key) external nonReentrant {
        OrderRec storage o = orderRec[key];
        if (o.qtyOpen == 0) revert NothingToRelease();

        uint128 stillOpen = IBinaryPool(o.pool).marketNonce() != o.marketNonce ? 0 : _liveRemaining(o.pool, o.orderId);
        if (stillOpen >= o.qtyOpen) revert OrderStillLive();

        uint128 released = o.qtyOpen - stillOpen;
        uint128 coll = o.collReserved == 0 ? 0 : uint128((uint256(o.collReserved) * released) / o.qtyOpen);

        MarketState storage m = marketState[o.marketId];
        uint8 kind = o.kind;
        if (kind == 0) m.yesLong -= released;
        else if (kind == 1) m.yesShort -= released;
        else if (kind == 2) m.noLong -= released;
        else m.noShort -= released;

        o.qtyOpen -= released;
        o.collReserved -= coll;
        reservedCollateral = reservedCollateral > coll ? reservedCollateral - coll : 0;

        bytes32 marketId = o.marketId;
        if (o.qtyOpen == 0) delete orderRec[key]; // bound storage; refunds gas

        emit ReservationReleased(key, marketId, released, coll);
    }

    /// @notice Mark a market terminal once the chain says so.
    /// @dev A resolved or voided market's position is a fixed claim, not a bet, so
    ///      it stops being directional risk. Permissionless and provable; it cannot
    ///      be called early.
    function releaseSettled(bytes32 marketId) external {
        (,,,,,,,, address market,,,,,) = module.markets(marketId);
        if (market == address(0)) revert NotTracked();
        if (!IBinaryMarket(market).isResolved() && !IBinaryMarket(market).isVoided()) revert MarketNotSettled();

        MarketState storage m = marketState[marketId];
        if (!m.tracked || m.settled) revert NothingToRelease();

        int128 dir = _directional(m);
        m.yesLong = 0;
        m.yesShort = 0;
        m.noLong = 0;
        m.noShort = 0;
        m.settled = true;

        emit SettledExposureReleased(marketId, dir);
    }

    /// @notice Drop a market from its domain's iteration set.
    /// @dev Permissionless and provable. Only a market that contributes nothing may
    ///      be pruned: settled, or carrying no reservations and no balance. Pruning
    ///      anything else would remove live exposure from the domain total and
    ///      understate risk, so it is refused. This is what keeps the per-domain
    ///      collection bounded under continuously rolling markets.
    function pruneMarket(bytes32 marketId) external {
        MarketState storage m = marketState[marketId];
        if (!m.tracked) revert NotTracked();

        bool noReservations = m.yesLong == 0 && m.yesShort == 0 && m.noLong == 0 && m.noShort == 0;
        if (!noReservations) revert MarketStillActive();
        if (!m.settled) {
            uint256 yesId = _outcomeId(m.pool, m.marketNonce, 0);
            if (
                outcomeToken.balanceOf(address(this), yesId) != 0
                    || outcomeToken.balanceOf(address(this), yesId + 1) != 0
            ) revert MarketStillActive();
        }

        bytes32 domain = m.domain;
        bytes32[] storage list = _domainMarkets[domain];
        uint256 slot = _marketSlot[marketId];
        if (slot == 0) revert NotTracked();

        uint256 lastIdx = list.length;
        if (slot != lastIdx) {
            bytes32 moved = list[lastIdx - 1];
            list[slot - 1] = moved;
            _marketSlot[moved] = slot;
        }
        list.pop();
        _marketSlot[marketId] = 0;
        m.tracked = false;

        emit MarketPruned(marketId, domain);
    }

    // =====================================================================
    // Views
    // =====================================================================

    function domainMarkets(bytes32 d) external view returns (bytes32[] memory) {
        return _domainMarkets[d];
    }

    function domainMarketCount(bytes32 d) external view returns (uint256) {
        return _domainMarkets[d].length;
    }

    // =====================================================================
    // Internals
    // =====================================================================

    function _intentHash(address agent, Intent calldata i) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), block.chainid, agent, i));
    }

    /// @dev Order ids are per-pool and pools are recycled, so an id alone is not a
    ///      key. Binding the generation prevents a stale id colliding with a live
    ///      order at the same address.
    function _orderKey(address pool, uint64 nonce, uint128 orderId) internal pure returns (bytes32) {
        return keccak256(abi.encode(pool, nonce, orderId));
    }

    /// @dev `id = (uint160(pool) << 72) | (nonce << 8) | idx` — the DreamDEX
    ///      ERC-6909 encoding. Successive markets on one recycled pool therefore
    ///      occupy disjoint id ranges.
    function _outcomeId(address pool, uint64 nonce, uint8 idx) internal pure returns (uint256) {
        return (uint256(uint160(pool)) << 72) | (uint256(nonce) << 8) | uint256(idx);
    }

    function _abs(int128 x) internal pure returns (uint128) {
        return x >= 0 ? uint128(x) : uint128(-x);
    }

    receive() external payable {}
}
