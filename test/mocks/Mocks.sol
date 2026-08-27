// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Deterministic stand-ins for the DreamDEX surface AirspacePortfolio
///         touches. Used ONLY for the scaling benchmark, where 10,000 intents
///         against a forked RPC would be dominated by network latency rather
///         than contract cost. Correctness is proven on the real fork
///         (test/AirspacePortfolio.fork.t.sol); these measure gas and storage
///         growth. Every signature mirrors the real contracts exactly.

contract MockERC20 {
    string public name = "mock";
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
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

contract MockOutcome6909 {
    mapping(address => mapping(uint256 => uint256)) public balanceOf;
    mapping(address => mapping(address => bool)) public isOperator;

    function setOperator(address s, bool ok) external returns (bool) {
        isOperator[msg.sender][s] = ok;
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
}

contract MockMarket {
    bool public isResolved;
    bool public isVoided;
    address public pool;

    constructor(address p) {
        pool = p;
    }

    function resolve() external {
        isResolved = true;
    }
}

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

    uint64 public marketNonce = 1;
    bool public finalized;
    uint64 public marketExpiryNs = type(uint64).max;
    address public collateralToken;
    MockERC20 internal token;
    uint128 internal nextId = 1;
    mapping(uint128 => Order) internal orders;

    constructor(address t) {
        token = MockERC20(t);
        collateralToken = t;
    }

    function roll() external {
        marketNonce += 1;
    }

    function getOrderBookParameters() external pure returns (OB memory) {
        return OB(1000, 1000, 1000);
    }

    function getBinaryPoolParams() external view returns (Info memory i) {
        i.oneCollateral = 1e6;
        i.marketNonce = marketNonce;
        i.collateralToken = collateralToken;
    }

    /// @dev Everything rests: the worst case for reservation accounting, and the
    ///      case that keeps the domain collection populated.
    function placeBinaryOrder(
        uint8,
        uint256 price,
        uint256 quantity,
        uint64,
        uint8,
        uint8,
        address,
        uint96,
        uint64
    ) external returns (bool, uint128) {
        uint256 escrow = (price * quantity + 1e6 - 1) / 1e6;
        token.transferFrom(msg.sender, address(this), escrow);
        uint128 id = nextId++;
        orders[id] = Order(id, true, msg.sender, 0, price, quantity, quantity, 0);
        return (true, id);
    }

    function getOrder(uint128 id) external view returns (Order memory) {
        Order memory o = orders[id];
        require(o.quantityRemaining > 0, "IncorrectOrder");
        return o;
    }

    function cancelOrder(uint128 id) external {
        Order memory o = orders[id];
        uint256 escrow = (o.price * o.quantityRemaining + 1e6 - 1) / 1e6;
        delete orders[id];
        token.transfer(o.owner, escrow);
    }
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
        uint256 yesId = (uint256(uint160(r.pool)) << 72) | (uint256(1) << 8);
        return (0, 2, 0, r.collateral, 0, bytes32(0), address(0), r.creator, r.market, r.pool, yesId, yesId + 1, r.tradingStart, r.expiry);
    }

    function redeem(uint32, bytes32, bytes32, uint8, uint256) external {}
}
