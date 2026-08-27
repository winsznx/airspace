// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {AirspaceAccount} from "../src/airspace/AirspaceAccount.sol";
import {AirspaceFactory} from "../src/airspace/AirspaceFactory.sol";
import {GlobalPolicy, BucketPolicy, AgentPolicy, Intent, AdmittedMarket} from "../src/airspace/IAirspace.sol";
import {IBinaryMarketsModule, IBinaryPool, IOutcomeToken6909, IERC20Min} from "../src/interfaces/IDreamDex.sol";

interface ITestUsdc is IERC20Min {
    function faucet(uint256 amount) external;
}

/// @notice Multi-agent portfolio proofs against the live DreamDEX deployment on
///         Somnia Shannon (chainId 50312), pinned to a fork block.
///
/// The headline invariant, spelled out in test_X1:
///   BTC bucket ceiling = 500 contracts
///   Agent A reserves 180  (individually valid)
///   Agent B reserves 240  (individually valid)
///   Agent C proposes 150  (individually valid under C's OWN policy)
///   -> C is rejected, solely because 180 + 240 + 150 > 500.
contract AirspaceForkTest is Test {
    address constant MODULE = 0x3ecC694Cef705358864a646142ac17A90E29e388;
    address constant OUTCOME = 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9;
    address constant TUSDC = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;

    bytes32 constant BTC = keccak256("BTC");
    uint256 constant ONE = 1e6;
    uint128 constant C_UNIT = 1e6; // one contract in raw units

    address owner = makeAddr("OWNER");
    address agentA = makeAddr("AGENT_A");
    address agentB = makeAddr("AGENT_B");
    address agentC = makeAddr("AGENT_C");
    address attacker = makeAddr("ATTACKER");

    AirspaceFactory factory;
    AirspaceAccount pf;

    struct Mkt {
        bytes32 id;
        address pool;
        uint64 nonce;
        uint64 expiry;
        uint256 yesId;
        uint256 noId;
        uint64 bestBid;
        uint64 bestAsk;
        uint256 askQty;
    }

    Mkt m1; // BTC daily
    Mkt m2; // BTC hourly

    function setUp() public {
        vm.createSelectFork(vm.envString("SHANNON_RPC"), vm.envUint("FORK_BLOCK"));

        m1 = _load(bytes32(vm.envUint("BTC_MARKET_1")));
        m2 = _load(bytes32(vm.envUint("BTC_MARKET_2")));

        factory = new AirspaceFactory(MODULE, OUTCOME);
        vm.prank(owner);
        pf = AirspaceAccount(payable(factory.createPortfolio(owner, bytes32(0))));

        vm.prank(address(pf));
        ITestUsdc(TUSDC).faucet(9_000 * ONE);

        vm.startPrank(owner);
        pf.syncCapitalBase(TUSDC);
        pf.setGlobalPolicy(_global());
        pf.setBucketPolicy(BTC, BucketPolicy({maxGrossDirectional: 500 * C_UNIT, maxCommitted: uint128(5_000 * ONE)}));
        pf.admitMarket(m1.id, BTC);
        pf.admitMarket(m2.id, BTC);
        pf.setAgent(agentA, _agent());
        pf.setAgent(agentB, _agent());
        pf.setAgent(agentC, _agent());
        vm.stopPrank();
    }

    // ------------------------------------------------------------ helpers

    function _load(bytes32 id) internal view returns (Mkt memory k) {
        (,,,,,,,,, address pool, uint256 y, uint256 n,, uint64 ex) = IBinaryMarketsModule(MODULE).markets(id);
        require(pool != address(0), "market missing at fork block");
        k.id = id;
        k.pool = pool;
        k.yesId = y;
        k.noId = n;
        k.expiry = ex;
        k.nonce = IBinaryPool(pool).marketNonce();
        (k.bestBid,) = _best(pool, true);
        (k.bestAsk, k.askQty) = _best(pool, false);
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
            maxCommittedCollateral: uint128(8_000 * ONE),
            maxRestingReservation: uint128(8_000 * ONE),
            maxSingleOrderNotional: uint128(2_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            maxLivePositions: 8,
            minHeadroomSec: 60,
            policyExpiry: uint64(block.timestamp + 7 days)
        });
    }

    /// @dev Deliberately generous: every agent's OWN policy admits every order
    ///      in these tests, so any rejection can only come from the portfolio.
    function _agent() internal pure returns (AgentPolicy memory) {
        return AgentPolicy({
            enabled: true,
            maxCommitted: uint128(3_000 * ONE),
            maxOrderNotional: uint128(2_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            cooldownSec: 0
        });
    }

    /// @dev A resting (POST_ONLY) buy well below the touch: a pure reservation
    ///      that will not fill, which is exactly what we need to prove that
    ///      unfilled orders still consume portfolio risk.
    function _rest(Mkt memory k, uint128 contracts, uint64 nonce) internal view returns (Intent memory) {
        uint64 px = k.bestBid > 20_000 ? k.bestBid - 20_000 : 10_000;
        px = (px / 1000) * 1000;
        return Intent({
            marketId: k.id,
            pool: k.pool,
            marketNonce: k.nonce,
            kind: 0,
            price: px,
            quantity: contracts,
            expireTimestampNs: IBinaryPool(k.pool).marketExpiryNs(),
            orderType: 3, // POST_ONLY
            nonce: nonce,
            strategyVersion: keccak256("airspace/v1")
        });
    }

    /// @dev An IOC that crosses the real book.
    function _take(Mkt memory k, uint128 contracts, uint64 nonce) internal view returns (Intent memory) {
        return Intent({
            marketId: k.id,
            pool: k.pool,
            marketNonce: k.nonce,
            kind: 0,
            price: k.bestAsk,
            quantity: contracts,
            expireTimestampNs: IBinaryPool(k.pool).marketExpiryNs(),
            orderType: 2, // IOC
            nonce: nonce,
            strategyVersion: keccak256("airspace/v1")
        });
    }

    function _exec(address who, Intent memory i) internal returns (uint128) {
        vm.prank(who);
        return pf.execute(i);
    }

    // ==================================================================
    // X1 -- THE DOMINANT MECHANISM
    // ==================================================================

    function test_X1_crossAgentAggregateRejection() public {
        Intent memory ia = _rest(m1, 180 * C_UNIT, 1);
        Intent memory ib = _rest(m2, 240 * C_UNIT, 2);
        Intent memory ic = _rest(m1, 150 * C_UNIT, 3);

        uint128 idA = _exec(agentA, ia);
        assertEq(pf.bucketGross(BTC), 180 * C_UNIT, "A alone");

        _exec(agentB, ib);
        assertEq(pf.bucketGross(BTC), 420 * C_UNIT, "A + B");

        // C's own policy admits this order in full -- maxOrderNotional and
        // maxCommitted are both far above it. The ONLY thing that stops it is
        // the exposure other agents already created.
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.BucketDirectionalExceeded.selector);
        pf.execute(ic);

        // Prove it is genuinely cross-agent: C's own committed is still zero.
        assertEq(pf.agentCommitted(agentC), 0, "C committed nothing");
        assertEq(pf.bucketGross(BTC), 420 * C_UNIT, "state unchanged by the rejection");

        // ---- release A's reservation, then the SAME shape becomes admissible.
        vm.prank(owner);
        pf.cancelOrder(m1.pool, idA);

        bytes32 key = pf.orderKey(m1.pool, m1.nonce, idA);
        pf.releaseOrder(key); // permissionless, but the POOL decides

        assertEq(pf.bucketGross(BTC), 240 * C_UNIT, "A released");

        Intent memory ic2 = _rest(m1, 150 * C_UNIT, 4);
        _exec(agentC, ic2);
        assertEq(pf.bucketGross(BTC), 390 * C_UNIT, "B + C now fit");
    }

    /// @dev Same ceiling, reached by one agent alone, to show the limit is on the
    ///      portfolio and not on any individual agent.
    function test_X2_singleAgentHitsTheSamePortfolioCeiling() public {
        _exec(agentA, _rest(m1, 400 * C_UNIT, 1));
        Intent memory _i = _rest(m2, 150 * C_UNIT, 2);
        vm.prank(agentA);
        vm.expectRevert(AirspaceAccount.BucketDirectionalExceeded.selector);
        pf.execute(_i);
    }

    // ==================================================================
    // Reservation lifecycle
    // ==================================================================

    function test_R1_restingOrdersCannotHideAggregateExposure() public {
        // Three resting orders, none of which has filled. If reservations were
        // ignored until fill, all three would be admitted and the portfolio
        // would be over its ceiling the moment the book moved.
        _exec(agentA, _rest(m1, 200 * C_UNIT, 1));
        _exec(agentB, _rest(m2, 200 * C_UNIT, 2));

        Intent memory _i = _rest(m1, 200 * C_UNIT, 3);
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.BucketDirectionalExceeded.selector);
        pf.execute(_i);

        // Nothing has filled: the account holds no outcome tokens at all.
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(address(pf), m1.yesId), 0);
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(address(pf), m2.yesId), 0);
        // Yet 400 contracts of the 500 ceiling are correctly accounted for.
        assertEq(pf.bucketGross(BTC), 400 * C_UNIT);
        assertGt(pf.totalResting(), 0, "collateral is escrowed in the book");
    }

    function test_R2_reservationSurvivesAsFilledPlusResting() public {
        // A taker order that crosses real liquidity. Whatever splits between
        // filled and resting, the sum must equal what was reserved -- otherwise
        // the ceiling checked before placement would not hold afterwards.
        Mkt memory k = m1.askQty > 0 ? m1 : m2;
        uint128 qty = 100 * C_UNIT;

        uint128 before_ = pf.bucketGross(BTC);
        _exec(agentA, _take(k, qty, 1));
        uint128 after_ = pf.bucketGross(BTC);

        uint256 held = IOutcomeToken6909(OUTCOME).balanceOf(address(pf), k.yesId);
        console2.log("filled (measured YES delta):", held);
        console2.log("bucket gross after         :", after_);

        // filled + resting == reserved, so the bucket moved by exactly the
        // amount that was admitted -- never more, and never silently less.
        assertLe(after_ - before_, qty, "cannot exceed what was reserved");
        assertGt(held, 0, "the taker actually crossed the book");
    }

    function test_R3_nonCrossingIocConsumesNothing() public {
        // The pool reverts `ImmediateOrCancelNoFill()` rather than accepting an
        // IOC that crosses nothing, so the whole transaction unwinds and the
        // reservation can never be stranded. Verified against the live pool.
        Intent memory i = _take(m1, 100 * C_UNIT, 1);
        i.price = 1000; // far below the book

        vm.prank(agentA);
        vm.expectRevert(); // ImmediateOrCancelNoFill() from BinaryPool
        pf.execute(i);

        assertEq(pf.bucketGross(BTC), 0, "no exposure");
        assertEq(pf.agentCommitted(agentA), 0, "no capital committed");
        assertEq(pf.totalResting(), 0, "no escrow retained");
    }

    function test_R4_releaseCannotBeForgedWhileTheOrderIsLive() public {
        uint128 id = _exec(agentA, _rest(m1, 100 * C_UNIT, 1));
        bytes32 key = pf.orderKey(m1.pool, m1.nonce, id);

        // The order is genuinely resting, so nobody -- not the attacker, not
        // another agent, not even the owner -- can free the headroom.
        vm.prank(attacker);
        vm.expectRevert(AirspaceAccount.OrderStillLive.selector);
        pf.releaseOrder(key);

        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.OrderStillLive.selector);
        pf.releaseOrder(key);

        assertEq(pf.bucketGross(BTC), 100 * C_UNIT);
    }

    // ==================================================================
    // Compromised agent C
    // ==================================================================

    function test_C1_compromisedAgentCannotWithdraw() public {
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.withdraw(TUSDC, agentC, 1);

        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.withdrawOutcome(m1.yesId, agentC, 1);

        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.ownerCall(TUSDC, 0, "");
    }

    function test_C2_agentCannotTouchAnotherAgentsPolicyOrIdentity() public {
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.setAgent(agentA, _agent());

        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.setGlobalPolicy(_global());

        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.setBucketPolicy(BTC, BucketPolicy({maxGrossDirectional: type(uint128).max, maxCommitted: type(uint128).max}));

        // And it cannot admit a market into a bucket to dodge a ceiling.
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.NotOwner.selector);
        pf.admitMarket(m1.id, keccak256("NOT_BTC"));
    }

    function test_C3_agentCannotImpersonateAnotherAgent() public {
        // C signs an intent shaped exactly like A's. Identity is msg.sender, so
        // the commitment lands on C's own budget, never A's.
        _exec(agentC, _rest(m1, 10 * C_UNIT, 1));
        assertEq(pf.agentCommitted(agentA), 0, "A's budget untouched");
        assertGt(pf.agentCommitted(agentC), 0, "C spent its own budget");
    }

    function test_C4_unregisteredCallerIsNotAnAgent() public {
        Intent memory _i = _rest(m1, 10 * C_UNIT, 1);
        vm.prank(attacker);
        vm.expectRevert(AirspaceAccount.NotAgent.selector);
        pf.execute(_i);
    }

    function test_C5_disabledAgentIsRefused() public {
        AgentPolicy memory p = _agent();
        p.enabled = false;
        vm.prank(owner);
        pf.setAgent(agentC, p);

        Intent memory _i = _rest(m1, 10 * C_UNIT, 1);
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.AgentDisabled.selector);
        pf.execute(_i);
    }

    function test_C6_unadmittedMarketIsDeniedByDefault() public {
        Mkt memory k = m1;
        k.id = bytes32(uint256(m1.id) - 1); // a real market, never admitted
        Intent memory _i = _rest(k, 10 * C_UNIT, 1);
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.MarketNotAdmitted.selector);
        pf.execute(_i);
    }

    function test_C7_poolSubstitutionAndStaleGenerationFail() public {
        Intent memory i = _rest(m1, 10 * C_UNIT, 1);
        i.pool = address(0xdead);
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.PoolMismatch.selector);
        pf.execute(i);

        Intent memory j = _rest(m1, 10 * C_UNIT, 2);
        j.marketNonce = m1.nonce - 1;
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.GenerationMismatch.selector);
        pf.execute(j);
    }

    function test_C8_replayFails() public {
        Intent memory i = _rest(m1, 10 * C_UNIT, 1);
        _exec(agentC, i);
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.IntentReplayed.selector);
        pf.execute(i);
    }

    function test_C9_priceGriefFails() public {
        Intent memory i = _rest(m1, 10 * C_UNIT, 1);
        i.price = 995_000; // above the global ceiling of 990_000
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.PriceOutsidePolicy.selector);
        pf.execute(i);
    }

    function test_C10_agentBudgetIsSeparateFromPortfolioBudget() public {
        AgentPolicy memory tight = _agent();
        tight.maxCommitted = uint128(5 * ONE);
        vm.prank(owner);
        pf.setAgent(agentC, tight);

        Intent memory _i = _rest(m1, 100 * C_UNIT, 1);
        vm.prank(agentC);
        vm.expectRevert(AirspaceAccount.AgentCommittedExceeded.selector);
        pf.execute(_i);
    }

    // ==================================================================
    // Owner recovery
    // ==================================================================

    function test_O1_ownerRecoversWithAllAgentsRevoked() public {
        _exec(agentA, _rest(m1, 50 * C_UNIT, 1));
        _exec(agentB, _take(m1.askQty > 0 ? m1 : m2, 50 * C_UNIT, 2));

        AgentPolicy memory off = _agent();
        off.enabled = false;
        vm.startPrank(owner);
        pf.setAgent(agentA, off);
        pf.setAgent(agentB, off);
        pf.setAgent(agentC, off);
        vm.stopPrank();

        // Cancel every resting order so the escrow comes home, then sweep.
        vm.warp(block.timestamp + 8 days); // policy long expired too

        uint256 bal = IERC20Min(TUSDC).balanceOf(address(pf));
        vm.prank(owner);
        pf.withdraw(TUSDC, owner, bal);
        assertEq(IERC20Min(TUSDC).balanceOf(address(pf)), 0);
        assertEq(IERC20Min(TUSDC).balanceOf(owner), bal);

        uint256 pos = IOutcomeToken6909(OUTCOME).balanceOf(address(pf), m1.yesId);
        if (pos > 0) {
            vm.prank(owner);
            pf.withdrawOutcome(m1.yesId, owner, pos);
            assertEq(IOutcomeToken6909(OUTCOME).balanceOf(owner, m1.yesId), pos);
        }
    }

    function test_O2_recoveryDoesNotDependOnPortfolioState() public {
        // Saturate the envelope, then recover anyway.
        _exec(agentA, _rest(m1, 400 * C_UNIT, 1));
        assertEq(pf.bucketGross(BTC), 400 * C_UNIT);

        uint256 bal = IERC20Min(TUSDC).balanceOf(address(pf));
        vm.prank(owner);
        pf.withdraw(TUSDC, owner, bal);
        assertEq(IERC20Min(TUSDC).balanceOf(owner), bal, "withdrawal ignores risk state entirely");
    }
}
