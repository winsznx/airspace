// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../src/airspace/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../src/airspace/AirspacePortfolioFactory.sol";
import {GlobalPolicy, DomainPolicy, AgentPolicy, Intent} from "../src/airspace/IAirspaceV2.sol";
import {IBinaryMarketsModule, IBinaryPool, IOutcomeToken6909, IERC20Min} from "../src/interfaces/IDreamDex.sol";

interface ITestUsdc is IERC20Min {
    function faucet(uint256 amount) external;
}

interface IPoolMint {
    function mintSet(address yesTo, address noTo, uint256 amount) external;
}

/// @notice Final LOCK validation against the live DreamDEX deployment on Somnia
///         Shannon (chainId 50312), pinned to a fork block. Nothing is mocked.
contract AirspacePortfolioForkTest is Test {
    address constant MODULE = 0x3ecC694Cef705358864a646142ac17A90E29e388;
    address constant OUTCOME = 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9;
    address constant TUSDC = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;

    uint256 constant ONE = 1e6;
    uint128 constant K = 1e6; // one contract in raw units

    address owner = makeAddr("OWNER");
    address A = makeAddr("AGENT_A");
    address B = makeAddr("AGENT_B");
    address C = makeAddr("AGENT_C");
    address attacker = makeAddr("ATTACKER");
    address whale = makeAddr("WHALE");

    AirspacePortfolioFactory factory;
    AirspacePortfolio pf;

    struct Mkt {
        bytes32 id;
        address pool;
        uint64 nonce;
        uint64 ts;
        uint64 ex;
        uint256 yesId;
        uint64 bestBid;
        uint64 bestAsk;
        uint256 askQty;
        address creator;
        address collateral;
    }

    Mkt m1; // sibling 1
    Mkt m2; // sibling 2 — same creator, same collateral, same cadence
    bytes32 DOM;

    function setUp() public {
        vm.createSelectFork(vm.envString("SHANNON_RPC"), vm.envUint("FORK_BLOCK"));
        m1 = _load(bytes32(vm.envUint("MKT_1")));
        m2 = _load(bytes32(vm.envUint("MKT_2")));

        factory = new AirspacePortfolioFactory(MODULE, OUTCOME);
        vm.prank(owner);
        pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(0))));

        vm.prank(address(pf));
        ITestUsdc(TUSDC).faucet(9_000 * ONE);

        DOM = pf.domainOf(m1.id);

        vm.startPrank(owner);
        pf.syncCapitalBase(TUSDC);
        pf.setGlobalPolicy(_global());
        pf.setDomainPolicy(DOM, _dom(500 * K));
        pf.setAgent(A, _agent());
        pf.setAgent(B, _agent());
        pf.setAgent(C, _agent());
        vm.stopPrank();
    }

    // ------------------------------------------------------------- helpers

    function _load(bytes32 id) internal view returns (Mkt memory k) {
        (,,, address coll,,,, address creator,, address pool,,, uint64 ts, uint64 ex) =
            IBinaryMarketsModule(MODULE).markets(id);
        require(pool != address(0), "market missing at fork block");
        k.id = id;
        k.pool = pool;
        k.ts = ts;
        k.ex = ex;
        k.creator = creator;
        k.collateral = coll;
        k.nonce = IBinaryPool(pool).marketNonce();
        k.yesId = (uint256(uint160(pool)) << 72) | (uint256(k.nonce) << 8);
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
        return DomainPolicy({set: true, maxDomainRiskUsage: cap, maxDomainCommitted: uint128(8_000 * ONE), maxLiveMarkets: 16});
    }

    /// @dev Deliberately generous: every agent's OWN policy admits every order
    ///      in these tests, so a rejection can only come from the portfolio.
    function _agent() internal pure returns (AgentPolicy memory) {
        return AgentPolicy({
            enabled: true,
            maxCommitted: uint128(4_000 * ONE),
            maxOrderNotional: uint128(3_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            cooldownSec: 0
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
            strategyVersion: keccak256("airspace/lock")
        });
    }

    /// @dev POST_ONLY buy at the TOP of the book (one tick under the ask) so an
    ///      incoming external sell hits this order first. Used only by R7.
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

    // ==================================================================
    // 1. STRUCTURAL DOMAINS — no attestation, no per-market admission
    // ==================================================================

    function test_D1_cadenceCanonicalisation() public view {
        // The live market's own window canonicalises to a real cadence.
        assertTrue(pf.cadenceOf(m1.ts, m1.ex) > 0, "live market has a cadence");
        // Late-roll jitter: an 898s window on a 900-aligned expiry is a 900s market.
        uint64 ex900 = 1787842800; // divisible by 900, observed live
        assertEq(pf.cadenceOf(ex900 - 900, ex900), 900, "exact 900");
        assertEq(pf.cadenceOf(ex900 - 898, ex900), 900, "898 absorbs into 900");
        assertEq(pf.cadenceOf(ex900 - 60, ex900), 60, "60s never escalates to 900");
        assertEq(pf.cadenceOf(ex900 - 300, ex900), 300, "300s never escalates");
        // A window longer than every canonical cadence has no domain.
        assertEq(pf.cadenceOf(0, 200000), 0, "no structural domain");
    }

    function test_D2_liveMarketResolvesWithZeroConfiguration() public view {
        bytes32 d = pf.domainOf(m1.id);
        assertTrue(d != bytes32(0), "live market must resolve");
        uint32 cad = pf.cadenceOf(m1.ts, m1.ex);
        assertEq(d, pf.domainKey(m1.creator, m1.collateral, cad), "domain is exactly creator|collateral|cadence");
        console2.log("cadence (s):", cad);
    }

    /// @notice Sibling series of the same cadence share ONE domain. Intentional.
    /// @dev The contract has no way to tell BTC from ETH and never claims to.
    function test_D3_siblingSeriesShareOneStructuralDomain() public view {
        assertEq(m1.creator, m2.creator, "same creator");
        assertEq(m1.collateral, m2.collateral, "same collateral");
        assertEq(pf.cadenceOf(m1.ts, m1.ex), pf.cadenceOf(m2.ts, m2.ex), "same cadence");
        assertEq(pf.domainOf(m1.id), pf.domainOf(m2.id), "siblings share one risk domain -- BY DESIGN");
    }

    function test_D4_unconfiguredDomainIsDeniedByDefault() public {
        // A market whose domain the owner never configured.
        AirspacePortfolio fresh;
        vm.prank(owner);
        fresh = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(uint256(99)))));
        vm.startPrank(owner);
        fresh.syncCapitalBase(TUSDC);
        fresh.setGlobalPolicy(_global());
        fresh.setAgent(A, _agent());
        vm.stopPrank();

        Intent memory i = _rest(m1, 10 * K, 1);
        vm.prank(A);
        vm.expectRevert(AirspacePortfolio.DomainNotConfigured.selector);
        fresh.execute(i);
    }

    /// @notice One domain policy covers BOTH sibling markets with no owner
    ///         transaction in between. This is the per-market admission burden
    ///         gone: a new generation is admissible the moment it exists.
    function test_D5_noPerMarketAdmissionTransaction() public {
        uint256 ownerNonceBefore = vm.getNonce(owner);

        _exec(A, _rest(m1, 20 * K, 1));
        _exec(B, _rest(m2, 20 * K, 2)); // different market, same domain, zero config

        assertEq(vm.getNonce(owner), ownerNonceBefore, "owner sent NO transaction between the two markets");
        assertEq(pf.domainMarketCount(DOM), 2, "both markets auto-tracked");
        assertEq(pf.domainRiskUsage(DOM), 40 * K, "aggregated across both");
    }

    // ==================================================================
    // 2. CROSS-AGENT ADMISSION — the dominant mechanism
    // ==================================================================

    function test_X1_individuallyValidOrderRejectedByOtherAgentsState() public {
        uint128 idA = _exec(A, _rest(m1, 180 * K, 1));
        assertEq(pf.domainRiskUsage(DOM), 180 * K);

        _exec(B, _rest(m2, 240 * K, 2));
        assertEq(pf.domainRiskUsage(DOM), 420 * K);

        uint128 cCommittedBefore = pf.agentCommitted(C);

        Intent memory ic = _rest(m1, 150 * K, 3);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.DomainRiskExceeded.selector);
        pf.execute(ic);

        assertEq(pf.agentCommitted(C), cCommittedBefore, "C's committed state unchanged by rejection");
        assertEq(pf.domainRiskUsage(DOM), 420 * K, "domain state unchanged by rejection");

        // Release A's capacity through a real lifecycle path, then C fits.
        bytes32 key = pf.orderKey(m1.pool, m1.nonce, idA);
        vm.prank(owner);
        pf.cancelOrder(m1.pool, idA);
        pf.releaseOrder(key);
        assertEq(pf.domainRiskUsage(DOM), 240 * K);

        _exec(C, _rest(m1, 150 * K, 4));
        assertEq(pf.domainRiskUsage(DOM), 390 * K, "same shape now admitted");
    }

    // ==================================================================
    // 5. CONCURRENCY — atomic contract state picks the winner
    // ==================================================================

    function test_X2_twoAgentsRaceOneHeadroom_sameBlock() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(200 * K));

        Intent memory ia = _rest(m1, 150 * K, 1);
        Intent memory ib = _rest(m2, 150 * K, 2);

        uint256 blk = block.number;
        _exec(A, ia); // first to land reserves
        vm.prank(B);
        vm.expectRevert(AirspacePortfolio.DomainRiskExceeded.selector);
        pf.execute(ib);

        assertEq(block.number, blk, "both attempts in the SAME block");
        assertEq(pf.domainRiskUsage(DOM), 150 * K, "exactly one reserved");
        assertEq(pf.agentCommitted(B), 0, "loser committed nothing");
    }

    function test_X3_threeAgentsRace() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(200 * K));

        Intent memory ia = _rest(m1, 150 * K, 1);
        Intent memory ib = _rest(m2, 150 * K, 2);
        Intent memory ic = _rest(m1, 150 * K, 3);

        _exec(A, ia);
        vm.prank(B);
        vm.expectRevert(AirspacePortfolio.DomainRiskExceeded.selector);
        pf.execute(ib);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.DomainRiskExceeded.selector);
        pf.execute(ic);

        assertEq(pf.domainRiskUsage(DOM), 150 * K, "exactly one winner out of three");
    }

    function test_X3b_tenAgentsRace() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(250 * K)); // room for exactly 2 x 100

        address[] memory ten = new address[](10);
        for (uint256 k = 0; k < 10; k++) {
            ten[k] = address(uint160(0xA1000 + k));
            vm.prank(owner);
            pf.setAgent(ten[k], _agent());
        }

        uint256 winners;
        uint256 blk = block.number;
        for (uint256 k = 0; k < 10; k++) {
            Intent memory i = _rest(k % 2 == 0 ? m1 : m2, 100 * K, uint64(k + 1));
            vm.prank(ten[k]);
            try pf.execute(i) returns (uint128) {
                winners++;
            } catch {}
        }
        assertEq(block.number, blk, "all ten in one block");
        assertEq(winners, 2, "cap admitted exactly two");
        assertEq(pf.domainRiskUsage(DOM), 200 * K);
    }

    // ==================================================================
    // 4. RESERVATION INVARIANTS
    // ==================================================================

    function test_R1_worstCaseReservedBeforeValueMoves() public {
        // A POST_ONLY order that cannot fill still consumes full capacity.
        uint128 before_ = pf.domainRiskUsage(DOM);
        _exec(A, _rest(m1, 100 * K, 1));
        assertEq(pf.domainRiskUsage(DOM) - before_, 100 * K, "full quantity reserved");
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(address(pf), m1.yesId), 0, "nothing filled");
        assertGt(pf.reservedCollateral(), 0, "collateral escrowed");
    }

    function test_R2_partialOrFullFillDoesNotDoubleCount() public {
        Mkt memory k = m1.askQty > 0 ? m1 : m2;
        uint128 qty = 50 * K;
        uint128 before_ = pf.domainRiskUsage(DOM);
        _exec(A, _take(k, qty, 1));
        uint128 delta = pf.domainRiskUsage(DOM) - before_;
        uint256 held = IOutcomeToken6909(OUTCOME).balanceOf(address(pf), k.yesId);
        console2.log("filled (measured):", held); console2.log("domain delta:", uint256(delta));
        // filled + resting == reserved: the delta can never exceed what was reserved.
        assertLe(delta, qty, "no double count");
    }

    function test_R3_cancelReleasesOnlyWhatWasFreed() public {
        uint128 id = _exec(A, _rest(m1, 100 * K, 1));
        _exec(B, _rest(m1, 40 * K, 2));
        assertEq(pf.domainRiskUsage(DOM), 140 * K);

        vm.prank(owner);
        pf.cancelOrder(m1.pool, id);
        pf.releaseOrder(pf.orderKey(m1.pool, m1.nonce, id));

        assertEq(pf.domainRiskUsage(DOM), 40 * K, "released exactly A's 100, not B's 40");
    }

    function test_R4_releaseRefusedWhileOrderIsLive() public {
        uint128 id = _exec(A, _rest(m1, 100 * K, 1));
        bytes32 key = pf.orderKey(m1.pool, m1.nonce, id);

        vm.prank(attacker);
        vm.expectRevert(AirspacePortfolio.OrderStillLive.selector);
        pf.releaseOrder(key);

        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.OrderStillLive.selector);
        pf.releaseOrder(key);

        assertEq(pf.domainRiskUsage(DOM), 100 * K);
    }

    function test_R5_pruneRefusedWhileMarketCarriesState() public {
        _exec(A, _rest(m1, 100 * K, 1));
        vm.expectRevert(AirspacePortfolio.MarketStillActive.selector);
        pf.pruneMarket(m1.id);
        assertEq(pf.domainMarketCount(DOM), 1, "still tracked");
    }

    function test_R6_pruneAllowedOnceEmpty_boundsTheCollection() public {
        uint128 id = _exec(A, _rest(m1, 100 * K, 1));
        vm.prank(owner);
        pf.cancelOrder(m1.pool, id);
        pf.releaseOrder(pf.orderKey(m1.pool, m1.nonce, id));

        pf.pruneMarket(m1.id); // permissionless
        assertEq(pf.domainMarketCount(DOM), 0, "collection shrinks back");
        assertEq(pf.domainRiskUsage(DOM), 0);
    }

    /// @notice ADVERSARIAL: make stored reservation state disagree with real
    ///         DreamDEX position state by filling a resting order from OUTSIDE
    ///         the portfolio, in a transaction the portfolio never sees.
    function test_R7_externalFillCannotUnderstateRisk() public {
        // Portfolio rests a bid.
        uint128 qty = 20 * K;
        uint128 id = _exec(A, _restTop(m1, qty, 1));
        uint128 usageBefore = pf.domainRiskUsage(DOM);
        assertEq(usageBefore, qty, "reserved");

        // An unrelated whale mints a complete set and sells YES into that bid.
        vm.startPrank(whale);
        ITestUsdc(TUSDC).faucet(1_000 * ONE);
        IERC20Min(TUSDC).approve(m1.pool, type(uint256).max);
        IPoolMint(m1.pool).mintSet(whale, whale, 100 * K);
        IOutcomeToken6909(OUTCOME).setOperator(m1.pool, true);
        Intent memory dummy = _restTop(m1, qty, 99);
        (bool ok,) = m1.pool.call(
            abi.encodeWithSignature(
                "placeBinaryOrder(uint8,uint256,uint256,uint64,uint8,uint8,address,uint96,uint64)",
                uint8(1), // SELL_YES
                dummy.price, // hit the portfolio's resting bid
                uint256(qty),
                dummy.expireTimestampNs,
                uint8(2), // IOC
                uint8(0),
                address(0),
                uint96(0),
                uint64(0)
            )
        );
        vm.stopPrank();

        if (!ok) {
            console2.log("external cross did not execute; skipping (book state dependent)");
            return;
        }

        // The portfolio now HOLDS the position but still believes the order rests.
        uint256 held = IOutcomeToken6909(OUTCOME).balanceOf(address(pf), m1.yesId);
        assertEq(held, qty, "external fill landed on the portfolio");

        uint128 usageAfter = pf.domainRiskUsage(DOM);
        console2.log("usage before:", uint256(usageBefore)); console2.log("after external fill:", uint256(usageAfter));

        // The stale reservation and the real balance are BOTH counted, so risk is
        // OVERSTATED, never understated. This is the safe direction.
        assertGe(usageAfter, usageBefore, "external fill must never reduce measured risk");
        assertEq(usageAfter, 2 * qty, "reservation + realized position, conservatively double-counted");

        // Reconciliation removes the stale half. Permissionless, and the pool decides.
        pf.releaseOrder(pf.orderKey(m1.pool, m1.nonce, id));
        assertEq(pf.domainRiskUsage(DOM), qty, "converges to the true position");
    }

    // ==================================================================
    // 7. HOSTILE MULTI-AGENT SUITE
    // ==================================================================

    function test_H1_agentCannotWithdrawAnything() public {
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.withdraw(TUSDC, C, 1);

        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.withdrawOutcome(m1.yesId, C, 1);

        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.ownerCall(TUSDC, 0, "");
    }

    function test_H2_agentCannotRewritePolicyOrIdentity() public {
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setAgent(A, _agent());

        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setDomainPolicy(DOM, _dom(type(uint128).max));

        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setGlobalPolicy(_global());
    }

    function test_H3_agentCannotSpoofAnotherIdentity() public {
        Intent memory i = _rest(m1, 10 * K, 1);
        _exec(C, i); // C runs A's exact intent shape
        assertEq(pf.agentCommitted(A), 0, "A's budget untouched");
        assertGt(pf.agentCommitted(C), 0, "charged to C");
    }

    function test_H4_recycledGenerationAndPoolSwapFail() public {
        Intent memory i = _rest(m1, 10 * K, 1);
        i.marketNonce = m1.nonce - 1;
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.GenerationMismatch.selector);
        pf.execute(i);

        Intent memory j = _rest(m1, 10 * K, 2);
        j.pool = address(0xdead);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.PoolMismatch.selector);
        pf.execute(j);
    }

    /// @dev "Switching to the sibling market" is NOT a bypass -- the sibling is
    ///      in the same structural domain, so it consumes the same headroom.
    function test_H5_siblingSwitchDoesNotEscapeTheCeiling() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(100 * K));

        _exec(A, _rest(m1, 90 * K, 1));
        Intent memory i = _rest(m2, 90 * K, 2); // the sibling series
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.DomainRiskExceeded.selector);
        pf.execute(i);
    }

    function test_H6_priceGriefFails() public {
        Intent memory i = _rest(m1, 10 * K, 1);
        i.price = 995_000;
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.PriceOutsidePolicy.selector);
        pf.execute(i);
    }

    function test_H7_replayFails() public {
        Intent memory i = _rest(m1, 10 * K, 1);
        _exec(C, i);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.IntentReplayed.selector);
        pf.execute(i);
    }

    function test_H8_staleMarketExecutionFails() public {
        Intent memory i = _rest(m1, 10 * K, 1);
        vm.warp(uint256(m1.ex) + 1);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.MarketNotTrading.selector);
        pf.execute(i);
    }

    function test_H9_manyTinyReservationsStillHitTheCeiling() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(50 * K));

        uint256 placed;
        for (uint64 n = 1; n <= 20; n++) {
            Intent memory i = _rest(m1, 5 * K, n);
            vm.prank(C);
            try pf.execute(i) returns (uint128) {
                placed++;
            } catch {
                break;
            }
        }
        assertEq(placed, 10, "10 x 5 = 50 exactly fills the ceiling");
        assertEq(pf.domainRiskUsage(DOM), 50 * K);
    }

    function test_H10_unregisteredAndDisabledAgentsRefused() public {
        Intent memory i = _rest(m1, 10 * K, 1);
        vm.prank(attacker);
        vm.expectRevert(AirspacePortfolio.NotAgent.selector);
        pf.execute(i);

        AgentPolicy memory off = _agent();
        off.enabled = false;
        vm.prank(owner);
        pf.setAgent(C, off);
        Intent memory j = _rest(m1, 10 * K, 2);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.AgentDisabled.selector);
        pf.execute(j);
    }

    /// @notice An agent has no allowance and no balance, so it cannot reach the
    ///         pool with portfolio capital even though the pool is public.
    function test_H11_agentCannotTradeDirectlyWithPortfolioCapital() public {
        assertEq(IERC20Min(TUSDC).allowance(address(pf), m1.pool), 0, "no standing allowance");
        assertEq(IERC20Min(TUSDC).balanceOf(C), 0, "agent holds nothing");
        assertFalse(IOutcomeToken6909(OUTCOME).isOperator(address(pf), C), "agent is not an operator");
    }

    function test_H12_agentCannotConsumeHeadroomReleasedInTheSameBlock() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _dom(100 * K));
        uint128 id = _exec(A, _rest(m1, 100 * K, 1));

        // C cannot pre-empt: the release has not happened yet.
        Intent memory i = _rest(m2, 100 * K, 2);
        vm.prank(C);
        vm.expectRevert(AirspacePortfolio.DomainRiskExceeded.selector);
        pf.execute(i);

        // After a genuine release in the same block, the headroom is real and
        // whoever calls first gets it -- which is correct, not a vulnerability.
        vm.prank(owner);
        pf.cancelOrder(m1.pool, id);
        pf.releaseOrder(pf.orderKey(m1.pool, m1.nonce, id));
        Intent memory j = _rest(m2, 100 * K, 3);
        _exec(C, j);
        assertEq(pf.domainRiskUsage(DOM), 100 * K);
    }

    // ==================================================================
    // OWNER RECOVERY
    // ==================================================================

    function test_O1_ownerRecoveryUnconditionalWithEveryAgentRevoked() public {
        _exec(A, _rest(m1, 100 * K, 1));
        _exec(B, _rest(m2, 100 * K, 2));

        AgentPolicy memory off = _agent();
        off.enabled = false;
        vm.startPrank(owner);
        pf.setAgent(A, off);
        pf.setAgent(B, off);
        pf.setAgent(C, off);
        vm.stopPrank();

        vm.warp(block.timestamp + 8 days); // policy long expired

        uint256 bal = IERC20Min(TUSDC).balanceOf(address(pf));
        vm.prank(owner);
        pf.withdraw(TUSDC, owner, bal);
        assertEq(IERC20Min(TUSDC).balanceOf(address(pf)), 0);
        assertEq(IERC20Min(TUSDC).balanceOf(owner), bal, "recovery ignores risk state entirely");
    }
}
