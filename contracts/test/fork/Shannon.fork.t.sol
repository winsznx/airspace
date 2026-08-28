// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../../src/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../../src/AirspacePortfolioFactory.sol";
import {GlobalPolicy, DomainPolicy, AgentPolicy, Intent, Refusal, AdmissionView, Gate} from
    "../../src/interfaces/IAirspace.sol";
import {IBinaryMarketsModule, IBinaryPool, IOutcomeToken6909, IERC20Minimal} from "../../src/interfaces/IDreamDex.sol";

interface ITestUsdc is IERC20Minimal {
    function faucet(uint256 amount) external;
}

interface IPoolExtra {
    function mintSet(address yesTo, address noTo, uint256 amount) external;
    function getBookLevels(bool isBid, uint64 n) external view returns (uint256[2][] memory);
}

/// @notice Production contracts against the REAL DreamDEX deployment on Somnia
///         Shannon (chainId 50312), pinned to a fork block. Nothing is mocked.
///
/// These carry forward the strongest archived adversarial proofs and add the
/// structural-domain proofs the production design introduced.
contract ShannonForkTest is Test {
    address constant MODULE = 0x3ecC694Cef705358864a646142ac17A90E29e388;
    address constant OUTCOME = 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9;
    address constant TUSDC = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;

    uint256 constant ONE = 1e6;
    uint128 constant K = 1e6;

    address owner = makeAddr("OWNER");
    address A = makeAddr("AGENT_A");
    address B = makeAddr("AGENT_B");
    address C = makeAddr("AGENT_C");
    address attacker = makeAddr("ATTACKER");
    address whale = makeAddr("WHALE");

    AirspacePortfolioFactory factory;
    AirspacePortfolio pf;
    bytes32 DOM;

    struct Mkt {
        bytes32 id;
        address pool;
        uint64 nonce;
        uint64 ts;
        uint64 ex;
        uint256 yesId;
        uint64 bestBid;
        uint64 bestAsk;
        address creator;
        address collateral;
    }

    Mkt m1;
    Mkt m2;

    function setUp() public {
        vm.createSelectFork(vm.envString("SHANNON_RPC"), vm.envUint("FORK_BLOCK"));
        m1 = _load(bytes32(vm.envUint("MKT_1")));
        m2 = _load(bytes32(vm.envUint("MKT_2")));

        factory = new AirspacePortfolioFactory(MODULE, OUTCOME, TUSDC);
        vm.prank(owner);
        pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(0))));

        // Fund the portfolio from the testnet faucet, then credit it.
        vm.prank(address(pf));
        ITestUsdc(TUSDC).faucet(9_000 * ONE);
        // Hoisted: an external call inside the argument list would consume the prank.
        uint128 funded = uint128(IERC20Minimal(TUSDC).balanceOf(address(pf)));
        vm.prank(owner);
        pf.setCapitalBase(funded);

        DOM = pf.domainOf(m1.id);

        vm.startPrank(owner);
        pf.setGlobalPolicy(_global());
        pf.setDomainPolicy(DOM, _dom(500 * K));
        pf.setAgent(A, _agent());
        pf.setAgent(B, _agent());
        pf.setAgent(C, _agent());
        vm.stopPrank();
    }

    // ------------------------------------------------------------- helpers

    function _load(bytes32 id) internal view returns (Mkt memory k) {
        (,,, address coll,,,, address cr,, address pool,,, uint64 ts, uint64 ex) =
            IBinaryMarketsModule(MODULE).markets(id);
        require(pool != address(0), "market missing at fork block");
        k.id = id;
        k.pool = pool;
        k.ts = ts;
        k.ex = ex;
        k.creator = cr;
        k.collateral = coll;
        k.nonce = IBinaryPool(pool).marketNonce();
        k.yesId = (uint256(uint160(pool)) << 72) | (uint256(k.nonce) << 8);
        (k.bestBid,) = _best(pool, true);
        (k.bestAsk,) = _best(pool, false);
    }

    function _best(address pool, bool isBid) internal view returns (uint64 px, uint256 qty) {
        (bool ok, bytes memory ret) =
            pool.staticcall(abi.encodeWithSignature("getBookLevels(bool,uint64)", isBid, uint64(1)));
        require(ok, "book read failed");
        uint256[2][] memory lv = abi.decode(ret, (uint256[2][]));
        if (lv.length == 0) return (0, 0);
        return (uint64(lv[0][0]), lv[0][1]);
    }

    function _global() internal view returns (GlobalPolicy memory) {
        return GlobalPolicy({
            maxCommittedCapital: uint128(8_000 * ONE),
            maxReservedCollateral: uint128(8_000 * ONE),
            maxSingleOrderNotional: uint128(3_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            minHeadroomSec: 30,
            policyExpiry: uint64(block.timestamp + 7 days)
        });
    }

    function _dom(uint128 cap) internal pure returns (DomainPolicy memory) {
        return DomainPolicy({
            configured: true,
            maxDomainRiskUsage: cap,
            maxDomainCommitted: 0,
            maxLiveMarkets: 0
        });
    }

    function _agent() internal pure returns (AgentPolicy memory) {
        return AgentPolicy({
            enabled: true,
            maxCommitted: uint128(4_000 * ONE),
            maxOrderNotional: uint128(3_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            cooldownSec: 0,
            strategyId: bytes32("fork")
        });
    }

    /// @dev POST_ONLY buy far below the touch: a pure reservation that cannot fill.
    function _rest(Mkt memory k, uint128 qty, uint64 nonce) internal view returns (Intent memory) {
        uint64 px = k.bestBid > 40_000 ? k.bestBid - 40_000 : 10_000;
        px = (px / 1000) * 1000;
        if (px < 1000) px = 1000;
        return Intent({
            marketId: k.id,
            pool: k.pool,
            marketNonce: k.nonce,
            kind: 0,
            price: px,
            quantity: qty,
            expireTimestampNs: IBinaryPool(k.pool).marketExpiryNs(),
            orderType: 3,
            nonce: nonce,
            strategyVersion: bytes32("fork/v1")
        });
    }

    /// @dev POST_ONLY at the top of the book, so an incoming sell hits it first.
    function _restTop(Mkt memory k, uint128 qty, uint64 nonce) internal view returns (Intent memory) {
        Intent memory i = _rest(k, qty, nonce);
        uint64 px = k.bestAsk > 1000 ? k.bestAsk - 1000 : 1000;
        i.price = (px / 1000) * 1000;
        return i;
    }

    function _take(Mkt memory k, uint128 qty, uint64 nonce) internal view returns (Intent memory) {
        Intent memory i = _rest(k, qty, nonce);
        i.price = k.bestAsk;
        i.orderType = 2; // IOC
        return i;
    }

    function _exec(address who, Intent memory i) internal returns (uint128) {
        vm.prank(who);
        return pf.execute(i);
    }

    function _expect(address who, Intent memory i, Refusal code) internal {
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(AirspacePortfolio.Refused.selector, code));
        pf.execute(i);
    }

    // =================================================================
    // STRUCTURAL DOMAINS against real markets
    // =================================================================

    function test_F1_domainDerivesFromLiveRegistryWithZeroConfig() public view {
        bytes32 d = pf.domainOf(m1.id);
        assertTrue(d != bytes32(0), "live market resolves");
        uint32 cad = uint32(m1.ex - m1.ts);
        assertEq(d, pf.domainKey(m1.creator, m1.collateral, cad), "creator|collateral|cadence");
        console2.log("live cadence (s):", cad);
    }

    /// @notice Sibling series of one cadence share ONE domain. Intentional: the
    ///         contract cannot tell BTC from ETH and never claims to.
    function test_F2_siblingSeriesShareOneDomain() public view {
        assertEq(m1.creator, m2.creator);
        assertEq(m1.collateral, m2.collateral);
        assertEq(pf.domainOf(m1.id), pf.domainOf(m2.id), "siblings share a domain BY DESIGN");
    }

    /// @notice One domain policy covers two different markets with two different
    ///         pools and generations — with no owner transaction in between.
    function test_F3_noPerMarketAdmission() public {
        uint256 ownerNonce = vm.getNonce(owner);
        _exec(A, _rest(m1, 20 * K, 1));
        _exec(B, _rest(m2, 20 * K, 1));
        assertEq(vm.getNonce(owner), ownerNonce, "owner sent NO transaction between markets");
        assertEq(pf.domainMarketCount(DOM), 2, "both auto-tracked");
        assertEq(pf.domainRiskUsage(DOM), 40 * K);
    }

    // =================================================================
    // THE DOMINANT MECHANISM, live
    // =================================================================

    function test_F4_crossAgentRefusalOnRealMarkets() public {
        _exec(A, _rest(m1, 180 * K, 1));
        assertEq(pf.domainRiskUsage(DOM), 180 * K);
        _exec(B, _rest(m2, 240 * K, 1));
        assertEq(pf.domainRiskUsage(DOM), 420 * K);

        Intent memory ic = _rest(m1, 150 * K, 1);
        AdmissionView memory v = pf.previewIntent(C, ic);
        assertEq(uint8(v.refusal), uint8(Refusal.DOMAIN_RISK_EXCEEDED));
        assertEq(v.domainUsageBefore, 420 * K);
        assertEq(v.domainUsageAfter, 570 * K);
        assertEq(v.domainCeiling, 500 * K);
        assertTrue(Gate.has(v.gates, Gate.GENERATION) && Gate.has(v.gates, Gate.MARKET_TRADING));
        assertFalse(Gate.has(v.gates, Gate.DOMAIN_CAPACITY));

        _expect(C, ic, Refusal.DOMAIN_RISK_EXCEEDED);
        assertEq(pf.agentCommitted(C), 0, "C committed nothing");
        assertEq(pf.domainRiskUsage(DOM), 420 * K, "state unchanged by the refusal");
    }

    function test_F5_releaseThenReadmitLive() public {
        uint128 idA = _exec(A, _rest(m1, 180 * K, 1));
        _exec(B, _rest(m2, 240 * K, 1));
        _expect(C, _rest(m1, 150 * K, 1), Refusal.DOMAIN_RISK_EXCEEDED);

        vm.prank(owner);
        pf.cancelOrder(m1.pool, idA);
        pf.releaseOrder(keccak256(abi.encode(m1.pool, m1.nonce, idA)));
        assertEq(pf.domainRiskUsage(DOM), 240 * K);

        _exec(C, _rest(m1, 150 * K, 1));
        assertEq(pf.domainRiskUsage(DOM), 390 * K, "identical shape now admitted");
    }

    // =================================================================
    // REAL EXECUTION AND RECONCILIATION
    // =================================================================

    function test_F6_takerFillsRealBookAndPositionBelongsToPortfolio() public {
        (uint64 ask, uint256 qty) = _best(m1.pool, false);
        if (ask == 0 || qty == 0) {
            console2.log("no resting ask at this fork block; skipping");
            return;
        }
        uint128 want = uint128(qty > 50 * K ? 50 * K : qty);
        want = (want / 1000) * 1000;

        uint256 collBefore = IERC20Minimal(TUSDC).balanceOf(address(pf));
        _exec(A, _take(m1, want, 1));

        uint256 held = IOutcomeToken6909(OUTCOME).balanceOf(address(pf), m1.yesId);
        console2.log("filled:", held);
        assertGt(held, 0, "the portfolio crossed the real book");
        assertLt(IERC20Minimal(TUSDC).balanceOf(address(pf)), collBefore, "collateral was spent");
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(A, m1.yesId), 0, "agent holds nothing");
        assertEq(IERC20Minimal(TUSDC).balanceOf(A), 0, "agent holds no collateral");
    }

    /// @notice ADVERSARIAL: an external party fills the portfolio's resting order
    ///         in a transaction the portfolio never sees.
    function test_F7_externalFillNeverUnderstatesRisk() public {
        uint128 qty = 20 * K;
        uint128 id = _exec(A, _restTop(m1, qty, 1));
        uint128 before_ = pf.domainRiskUsage(DOM);
        assertEq(before_, qty);

        vm.startPrank(whale);
        ITestUsdc(TUSDC).faucet(1_000 * ONE);
        IERC20Minimal(TUSDC).approve(m1.pool, type(uint256).max);
        IPoolExtra(m1.pool).mintSet(whale, whale, 100 * K);
        IOutcomeToken6909(OUTCOME).setOperator(m1.pool, true);
        Intent memory shape = _restTop(m1, qty, 99);
        (bool ok,) = m1.pool.call(
            abi.encodeWithSignature(
                "placeBinaryOrder(uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)",
                uint8(1), shape.price, uint256(qty), shape.expireTimestampNs, uint8(2), uint8(0), address(0),
                uint96(0), uint64(0)
            )
        );
        vm.stopPrank();
        if (!ok) {
            console2.log("external cross did not execute at this block; skipping");
            return;
        }

        uint128 after_ = pf.domainRiskUsage(DOM);
        console2.log("usage before:", before_);
        console2.log("usage after :", after_);
        assertGe(after_, before_, "an external fill must never reduce measured risk");
        assertEq(after_, 2 * qty, "reservation + realized, conservatively double counted");

        pf.releaseOrder(keccak256(abi.encode(m1.pool, m1.nonce, id)));
        assertEq(pf.domainRiskUsage(DOM), qty, "converges to the true position");
    }

    // =================================================================
    // HOSTILE AGENTS against real state
    // =================================================================

    function test_F8_hostileAgentSuite() public {
        // sibling switch does not escape a saturated ceiling
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(100 * K));
        _exec(A, _rest(m1, 90 * K, 1));
        _expect(C, _rest(m2, 90 * K, 1), Refusal.DOMAIN_RISK_EXCEEDED);
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(500 * K));

        Intent memory i;
        i = _rest(m1, 10 * K, 1);
        i.pool = address(0xdead);
        _expect(C, i, Refusal.POOL_MISMATCH);

        i = _rest(m1, 10 * K, 1);
        i.marketNonce = m1.nonce - 1;
        _expect(C, i, Refusal.MARKET_GENERATION_MISMATCH);

        i = _rest(m1, 10 * K, 1);
        i.price = 995_000;
        _expect(C, i, Refusal.PRICE_OUTSIDE_POLICY);

        i = _rest(m1, 10 * K, 1);
        i.price += 1; // off the 1000 tick grid
        _expect(C, i, Refusal.OFF_TICK_GRID);

        _expect(attacker, _rest(m1, 10 * K, 1), Refusal.NOT_AGENT);

        // replay
        Intent memory used = _rest(m1, 10 * K, 5);
        _exec(C, used);
        _expect(C, used, Refusal.INTENT_REPLAYED);

        // direct asset access
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.withdraw(TUSDC, C, 1);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.ownerCall(TUSDC, 0, "");

        // no standing allowance and no operator grant for an agent
        assertEq(IERC20Minimal(TUSDC).allowance(address(pf), m1.pool), 0, "no standing allowance");
        assertFalse(IOutcomeToken6909(OUTCOME).isOperator(address(pf), C), "agent is not an operator");
    }

    function test_F9_rivalCannotReleaseALiveReservation() public {
        uint128 id = _exec(A, _rest(m1, 50 * K, 1));
        bytes32 key = keccak256(abi.encode(m1.pool, m1.nonce, id));
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.OrderStillLive.selector);
        pf.releaseOrder(key);
        vm.prank(attacker);
        vm.expectRevert(AirspacePortfolio.OrderStillLive.selector);
        pf.releaseOrder(key);
        assertEq(pf.domainRiskUsage(DOM), 50 * K);
    }

    function test_F10_ownerRecoveryUnconditional() public {
        _exec(A, _rest(m1, 100 * K, 1));
        _exec(B, _rest(m2, 100 * K, 1));

        vm.startPrank(owner);
        pf.revokeAgent(A);
        pf.revokeAgent(B);
        pf.revokeAgent(C);
        vm.stopPrank();
        vm.warp(block.timestamp + 8 days); // policy long expired

        uint256 bal = IERC20Minimal(TUSDC).balanceOf(address(pf));
        vm.prank(owner);
        pf.withdraw(TUSDC, owner, bal);
        assertEq(IERC20Minimal(TUSDC).balanceOf(address(pf)), 0);
        assertEq(IERC20Minimal(TUSDC).balanceOf(owner), bal, "recovery ignores all risk state");
    }
}
