// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Deterministic stand-ins for the DreamDEX surface AirspacePortfolio
///         touches. Used for unit/invariant/fuzz coverage where 10,000 operations
///         against a forked RPC would measure network latency rather than
///         contract behaviour. Protocol-specific correctness is proven separately
///         by the fork suite against the real deployment.
///
/// @dev Every signature mirrors the real contract exactly. The mock pool is
///      deliberately richer than a stub: it supports partial fills, resting
///      remainders, cancellation and external fills, because those are the
///      transitions the reservation invariants depend on.

contract MockERC20 {
    string public name = "Mock USD";
    string public symbol = "mUSD";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        if (f != msg.sender) allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

contract MockOutcome6909 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isOperator;
    mapping(address => mapping(address => mapping(uint256 => uint256))) public allowance;

    function setOperator(address s, bool ok) external returns (bool) {
        isOperator[msg.sender][s] = ok;
        return true;
    }

    function approve(address s, uint256 id, uint256 a) external returns (bool) {
        allowance[msg.sender][s][id] = a;
        return true;
    }

    function transfer(address to, uint256 id, uint256 a) external returns (bool) {
        balanceOf[msg.sender][id] -= a;
        balanceOf[to][id] += a;
        return true;
    }

    function mint(address to, uint256 id, uint256 a) external {
        balanceOf[to][id] += a;
    }

    function burn(address from, uint256 id, uint256 a) external {
        balanceOf[from][id] -= a;
    }
}

contract MockMarket {
    bool public isResolved;
    bool public isVoided;

    function resolve() external {
        isResolved = true;
    }

    function void() external {
        isVoided = true;
    }
}

/// @notice A binary pool with a controllable fill ratio.
contract MockPool {
    struct OB {
        uint256 tickSize;
        uint256 minQuantity;
        uint256 lotSize;
    }

    struct Info {
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

    error IncorrectOrder();

    uint64 public marketNonce = 1;
    bool public finalized;
    uint64 public marketExpiryNs = type(uint64).max;
    address public collateralToken;
    address public outcomeToken;
    address public market;
    uint256 public oneCollateral = 1e6;

    /// @notice Basis points of each incoming order that fills immediately.
    uint16 public fillBps; // 0 = everything rests, 10000 = everything fills
    uint128 internal _nextId = 1;
    mapping(uint128 => Order) internal _orders;
    /// @dev Which outcome each order is on, 0 = YES, 1 = NO. Needed on both
    ///      sides: a cancelled SELL returns that outcome's escrow, and a
    ///      cancelled BUY must be refunded at the price IT paid, which for a
    ///      BUY_NO is `one - price` rather than `price`.
    mapping(uint128 => uint8) internal _side;

    MockERC20 internal token;
    MockOutcome6909 internal oc;

    constructor(address t, address o, address m) {
        token = MockERC20(t);
        oc = MockOutcome6909(o);
        collateralToken = t;
        outcomeToken = o;
        market = m;
    }

    function setFillBps(uint16 b) external {
        fillBps = b;
    }

    function roll() external {
        marketNonce += 1;
    }

    function setFinalized(bool f) external {
        finalized = f;
    }

    function getOrderBookParameters() external pure returns (OB memory) {
        return OB(1000, 1000, 1000);
    }

    function getBinaryPoolParams() external view returns (Info memory i) {
        i.oneCollateral = oneCollateral;
        i.marketNonce = marketNonce;
        i.collateralToken = collateralToken;
        i.market = market;
        i.outcomeToken = outcomeToken;
    }

    function _outcomeId(uint8 idx) internal view returns (uint256) {
        return (uint256(uint160(address(this))) << 72) | (uint256(marketNonce) << 8) | uint256(idx);
    }

    function placeBinaryOrder(
        uint8 kind,
        uint256 price,
        uint256 quantity,
        uint64,
        uint8,
        uint8,
        address,
        uint96,
        uint64
    ) external returns (bool, uint128) {
        bool isBuy = (kind == 0 || kind == 2);
        bool isYes = (kind == 0 || kind == 1);
        uint256 unit = isYes ? price : oneCollateral - price;

        uint256 filled = (quantity * fillBps) / 10000;
        filled = (filled / 1000) * 1000; // keep on the lot grid
        uint256 resting = quantity - filled;

        if (isBuy) {
            // Escrow the WHOLE order, exactly as the real pool does.
            uint256 escrow = (unit * quantity + oneCollateral - 1) / oneCollateral;
            token.transferFrom(msg.sender, address(this), escrow);
            if (filled != 0) oc.mint(msg.sender, _outcomeId(isYes ? 0 : 1), filled);
        } else {
            // A SELL escrows OUTCOME TOKENS at PLACEMENT, not at fill.
            //
            // Verified against four live Shannon pools (scripts/escrow-probe.mjs):
            // each pool's outcome balance equalled its resting ask depth
            // exactly. The whole
            // quantity leaves the seller now; the resting remainder comes back
            // only if the order is cancelled or expires. Modelling this as a
            // burn-on-fill — which this mock did while v1 was live — hides the
            // entire sell-side of the accounting from every test.
            oc.burn(msg.sender, _outcomeId(isYes ? 0 : 1), quantity);
            if (filled != 0) token.mint(msg.sender, (unit * filled) / oneCollateral);
        }

        _side[_nextId] = isYes ? 0 : 1;
        uint128 id = _nextId++;
        if (resting != 0) {
            _orders[id] = Order(id, isBuy, msg.sender, 0, price, quantity, resting, 0);
        }
        return (true, id);
    }

    /// @dev Reverts `IncorrectOrder()` for filled, cancelled or unknown ids —
    ///      identically, which is the ambiguity the portfolio is designed around.
    function getOrder(uint128 id) external view returns (Order memory) {
        Order memory o = _orders[id];
        if (o.quantityRemaining == 0) revert IncorrectOrder();
        return o;
    }

    function cancelOrder(uint128 id) external {
        Order memory o = _orders[id];
        if (o.quantityRemaining == 0) revert IncorrectOrder();
        uint8 idx = _side[id];
        delete _orders[id];
        delete _side[id];
        if (o.isBid) {
            // Refund at the price this side actually paid.
            uint256 unit = idx == 0 ? o.price : oneCollateral - o.price;
            token.transfer(o.owner, (unit * o.quantityRemaining + oneCollateral - 1) / oneCollateral);
        } else {
            // The unsold remainder of the escrow comes back to the seller.
            oc.mint(o.owner, _outcomeId(idx), o.quantityRemaining);
        }
    }

    /// @notice A fill AIRSPACE did not initiate: the resting order is consumed by
    ///         an incoming counterparty in another transaction entirely.
    /// @dev A filled BUY delivers outcome tokens. A filled SELL delivers nothing
    ///      — those tokens left at placement — it delivers collateral.
    function externalFill(uint128 id, uint256 qty) external {
        Order storage o = _orders[id];
        require(o.quantityRemaining >= qty, "too much");
        uint8 idx = _side[id];
        uint256 unit = idx == 0 ? o.price : oneCollateral - o.price;
        o.quantityRemaining -= qty;
        if (o.isBid) oc.mint(o.owner, _outcomeId(idx), qty);
        else token.mint(o.owner, (unit * qty) / oneCollateral);
        if (o.quantityRemaining == 0) {
            delete _orders[id];
            delete _side[id];
        }
    }

    function cancelExpiredOrders(uint128[] calldata) external {}
}

contract MockModule {
    struct Rec {
        address collateral;
        address creator;
        address market;
        address pool;
        uint64 tradingStart;
        uint64 expiry;
    }

    mapping(bytes32 => Rec) public recs;

    function set(bytes32 id, address collateral, address creator, address market, address pool, uint64 ts, uint64 ex)
        external
    {
        recs[id] = Rec(collateral, creator, market, pool, ts, ex);
    }

    function markets(bytes32 id)
        external
        view
        returns (
            uint256,
            uint8,
            uint8,
            address,
            uint32,
            bytes32,
            address,
            address,
            address,
            address,
            uint256,
            uint256,
            uint64,
            uint64
        )
    {
        Rec memory r = recs[id];
        uint256 nonce = r.pool == address(0) ? 0 : MockPool(r.pool).marketNonce();
        uint256 yesId = (uint256(uint160(r.pool)) << 72) | (nonce << 8);
        return (
            0,
            2,
            0,
            r.collateral,
            0,
            bytes32(0),
            address(0),
            r.creator,
            r.market,
            r.pool,
            yesId,
            yesId + 1,
            r.tradingStart,
            r.expiry
        );
    }

    function redeem(uint32, bytes32, bytes32, uint8, uint256) external {}
}
