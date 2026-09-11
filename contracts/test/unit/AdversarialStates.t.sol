// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AirspaceBase} from "../AirspaceBase.t.sol";
import {ExposureOracle} from "../reference/ExposureOracle.sol";
import {Intent, Refusal} from "../../src/interfaces/IAirspace.sol";
import {MockPool, MockMarket} from "../mocks/MockDreamDex.sol";
import {console2} from "forge-std/Test.sol";

/// @notice Every adversarial state the v1 failure showed we had to reach, pinned
///         as a named deterministic scenario.
///
/// Fuzzing is kept, but it is not where these belong. v1's suite fuzzed 8,192
/// calls a run and could reach none of this: its handler hard-coded one order
/// kind, and its fixture put every market's trading window two days in the
/// future so nothing was ever admitted at all. A suite that cannot reach the bug
/// produces confidence without evidence.
///
/// Each test below asserts the critical property against the independent oracle:
///
///     AIRSPACE_ACCOUNTED_WORST_CASE >= INDEPENDENT_REFERENCE_WORST_CASE
///
/// Understatement by one raw unit fails.
contract AdversarialStatesTest is AirspaceBase {
    function setUp() public {
        _setUpAirspace(100_000 * K);
    }

    // -----------------------------------------------------------------
    // helpers
    // -----------------------------------------------------------------

    function _order(address who, bytes32 id, MockPool p, uint8 kind, uint256 price, uint128 qty)
        internal
        returns (uint128 orderId)
    {
        Intent memory i = _intent(id, p, qty, _nextNonce(who));
        i.kind = kind;
        i.price = price;
        vm.prank(who);
        return pf.execute(i);
    }

    function _oracleFor(bytes32 id, MockPool p) internal view returns (uint256) {
        (,,, uint128 yL, uint128 yS, uint128 nL, uint128 nS,,) = pf.marketState(id);
        uint256 yesId = (uint256(uint160(address(p))) << 72) | (uint256(p.marketNonce()) << 8);
        return ExposureOracle.worstCase(
            ExposureOracle.Market({
                balYes: oc.balanceOf(address(pf), yesId),
                balNo: oc.balanceOf(address(pf), yesId + 1),
                buyYes: yL,
                sellYes: yS,
                buyNo: nL,
                sellNo: nS
            })
        );
    }

    /// @dev The property, asserted wherever a scenario leaves the books.
    function _assertNeverUnderstates(bytes32 id, MockPool p, string memory where) internal view {
        uint256 accounted = pf.marketWorstCaseExposure(id);
        uint256 independent = _oracleFor(id, p);
        assertGe(accounted, independent, where);
    }

    /// @dev Acquire a real position by buying and letting it fill. Never minted:
    ///      fabricated inventory would fabricate exposure the contract never
    ///      admitted, and any conclusion drawn from it would be an artefact.
    function _acquire(address who, bytes32 id, MockPool p, uint8 buyKind, uint128 qty) internal {
        p.setFillBps(10_000);
        _order(who, id, p, buyKind, 100_000, qty);
        p.setFillBps(0);
    }

    // =================================================================
    // OPPOSING RESERVATIONS — the shape that broke v1
    // =================================================================

    function test_buyYesAndBuyNoRestingTogether() public {
        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 120 * K);
        _order(agentB, mkt1, pool1, 2, 100_000, 90 * K);

        (,,, uint128 yL,, uint128 nL,,,) = pf.marketState(mkt1);
        assertEq(yL, 120 * K, "BUY_YES resting");
        assertEq(nL, 90 * K, "BUY_NO resting at the same time");

        // v1 reported |120 - 90| = 30. Either can fill alone, so it is 120.
        assertEq(pf.marketWorstCaseExposure(mkt1), 120 * K, "worst case is the larger leg, not the difference");
        _assertNeverUnderstates(mkt1, pool1, "opposing buys");
    }

    function test_buyYesAndSellYes() public {
        _acquire(agentA, mkt1, pool1, 0, 200 * K);
        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 80 * K); // BUY_YES resting
        _order(agentB, mkt1, pool1, 1, 100_000, 50 * K); // SELL_YES resting

        _assertNeverUnderstates(mkt1, pool1, "buy yes + sell yes");
    }

    function test_buyNoAndSellNo() public {
        _acquire(agentA, mkt1, pool1, 2, 200 * K);
        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 2, 100_000, 80 * K);
        _order(agentB, mkt1, pool1, 3, 100_000, 50 * K);

        _assertNeverUnderstates(mkt1, pool1, "buy no + sell no");
    }

    // =================================================================
    // REALIZED POSITION PLUS AN OPPOSING PENDING ORDER
    // =================================================================

    function test_realizedYesPlusPendingBuyNo() public {
        _acquire(agentA, mkt1, pool1, 0, 300 * K);
        pool1.setFillBps(0);
        _order(agentB, mkt1, pool1, 2, 100_000, 200 * K);

        _assertNeverUnderstates(mkt1, pool1, "realized yes + pending buy no");
        // Holding 300 YES, worst case is still 300: the pending BUY_NO only
        // reduces exposure if it fills, and it may not.
        assertEq(pf.marketWorstCaseExposure(mkt1), 300 * K);
    }

    function test_realizedNoPlusPendingBuyYes() public {
        _acquire(agentA, mkt1, pool1, 2, 300 * K);
        pool1.setFillBps(0);
        _order(agentB, mkt1, pool1, 0, 100_000, 200 * K);

        _assertNeverUnderstates(mkt1, pool1, "realized no + pending buy yes");
        assertEq(pf.marketWorstCaseExposure(mkt1), 300 * K);
    }

    /// @notice A held complete set carries no directional risk. One-sided
    ///         pending order on top is exposed by exactly that order.
    function test_completeSetPlusOneSidedPending() public {
        _acquire(agentA, mkt1, pool1, 0, 250 * K);
        _acquire(agentA, mkt1, pool1, 2, 250 * K);
        assertEq(pf.marketWorstCaseExposure(mkt1), 0, "a complete set is not directional");

        pool1.setFillBps(0);
        _order(agentB, mkt1, pool1, 0, 100_000, 60 * K);
        assertEq(pf.marketWorstCaseExposure(mkt1), 60 * K, "exposed by the pending leg alone");
        _assertNeverUnderstates(mkt1, pool1, "complete set + one-sided pending");
    }

    // =================================================================
    // PARTIAL FILLS, EXTERNAL FILLS, CANCELLATION
    // =================================================================

    function test_partialFillOfOnlyOneOpposingReservation() public {
        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 200 * K);
        _order(agentB, mkt1, pool1, 2, 100_000, 200 * K);

        // Half of the BUY_YES fills; the BUY_NO is untouched.
        pool1.externalFill(1, 100 * K);

        _assertNeverUnderstates(mkt1, pool1, "partial fill of one leg only");
    }

    function test_externalCounterpartyFillsARestingOrder() public {
        pool1.setFillBps(0);
        uint128 oid = _order(agentA, mkt1, pool1, 0, 100_000, 150 * K);

        uint256 before = pf.marketWorstCaseExposure(mkt1);
        assertEq(before, 150 * K);

        // A transaction AIRSPACE never initiates, and cannot observe as it
        // happens: no callback, no hook, nothing to react to.
        pool1.externalFill(oid, 150 * K);

        // THE ONE PLACE THIS SYSTEM DELIBERATELY OVERSTATES.
        //
        // The tokens have arrived, so they are in the realized balance. The
        // reservation is still on the books, because nothing has yet proven to
        // the contract that the order is gone — `getOrder` reverts identically
        // for filled and cancelled orders, so the fill is indistinguishable from
        // a cancel until someone calls `releaseOrder`. Between the fill and that
        // call, the same 150 contracts are counted twice.
        //
        // 300 against a true 150. That direction is the safe one and it is the
        // direction the design chose on purpose: the alternative is to guess the
        // order is gone, and a wrong guess understates. It costs admission
        // headroom until reconciliation, never safety.
        assertEq(pf.marketWorstCaseExposure(mkt1), 2 * before, "counted twice until reconciled");
        _assertNeverUnderstates(mkt1, pool1, "after an external fill");

        // Reconciliation is permissionless and takes one call, and it converges
        // on the true figure rather than merely near it.
        bytes32 key = keccak256(abi.encode(address(pool1), pool1.marketNonce(), oid));
        pf.releaseOrder(key);
        assertEq(pf.marketWorstCaseExposure(mkt1), before, "exactly the realized position, once reconciled");
        _assertNeverUnderstates(mkt1, pool1, "after reconciliation");
    }

    /// @notice The same overstatement on a PARTIAL fill resolves proportionally:
    ///         release drops the reservation to what the pool still holds open,
    ///         not to zero.
    function test_partialFillReconcilesToTheRemainder() public {
        pool1.setFillBps(0);
        uint128 oid = _order(agentA, mkt1, pool1, 0, 100_000, 200 * K);
        pool1.externalFill(oid, 60 * K);

        // 60 realized + 200 still reserved.
        assertEq(pf.marketWorstCaseExposure(mkt1), 260 * K, "overstated by the 60 that filled");

        bytes32 key = keccak256(abi.encode(address(pool1), pool1.marketNonce(), oid));
        pf.releaseOrder(key);

        // 60 realized + 140 still genuinely resting.
        assertEq(pf.marketWorstCaseExposure(mkt1), 200 * K, "the remainder is still live and still charged");
        _assertNeverUnderstates(mkt1, pool1, "after a partial reconciliation");
    }

    function test_cancelOneSideWhileTheOppositeStaysLive() public {
        pool1.setFillBps(0);
        uint128 yesOrder = _order(agentA, mkt1, pool1, 0, 100_000, 140 * K);
        _order(agentB, mkt1, pool1, 2, 100_000, 90 * K);

        vm.prank(address(pf));
        pool1.cancelOrder(yesOrder);
        // The contract still charges it until a release proves it gone: safe.
        _assertNeverUnderstates(mkt1, pool1, "one side cancelled at the venue");

        bytes32 key = keccak256(abi.encode(address(pool1), pool1.marketNonce(), yesOrder));
        pf.releaseOrder(key);
        _assertNeverUnderstates(mkt1, pool1, "after releasing the cancelled side");

        (,,, uint128 yL,, uint128 nL,,,) = pf.marketState(mkt1);
        assertEq(yL, 0, "cancelled leg released");
        assertEq(nL, 90 * K, "the opposite leg is untouched");
    }

    /// @notice A cancelled SELL returns its escrowed tokens, which INCREASES
    ///         realized exposure. The accounting has to have been carrying that
    ///         possibility all along.
    function test_cancelledSellReturnsEscrowAndRaisesExposure() public {
        _acquire(agentA, mkt1, pool1, 0, 200 * K);
        pool1.setFillBps(0);
        uint128 sell = _order(agentA, mkt1, pool1, 1, 100_000, 200 * K);

        // The tokens are at the venue, so the realized balance is zero — but the
        // portfolio is still charged the full 200, because a cancel brings them
        // straight back.
        uint256 charged = pf.marketWorstCaseExposure(mkt1);
        assertEq(charged, 200 * K, "a resting sell is charged, not forgiven");
        _assertNeverUnderstates(mkt1, pool1, "with a resting sell");

        vm.prank(address(pf));
        pool1.cancelOrder(sell);
        bytes32 key = keccak256(abi.encode(address(pool1), pool1.marketNonce(), sell));
        pf.releaseOrder(key);

        // 200 YES are back on the books. The charge carried while the ask rested
        // already covered exactly this, which is the property that matters: the
        // escrow's return was never a surprise to the accounting.
        assertEq(pf.marketWorstCaseExposure(mkt1), 200 * K, "the escrow returned to a realized position");
        assertGe(charged, pf.marketWorstCaseExposure(mkt1), "the resting charge already covered the return");
        _assertNeverUnderstates(mkt1, pool1, "after the escrow returned");
    }

    // =================================================================
    // MULTIPLE AGENTS, MULTIPLE MARKETS, ONE DOMAIN
    // =================================================================

    function test_multipleAgentsSupplyOpposingOrders() public {
        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 100 * K);
        _order(agentB, mkt1, pool1, 2, 100_000, 100 * K);
        _order(agentC, mkt1, pool1, 0, 100_000, 50 * K);

        // A netting model sees 150 - 100 = 50. Independently, the YES side can
        // reach 150 on its own.
        assertEq(pf.marketWorstCaseExposure(mkt1), 150 * K);
        _assertNeverUnderstates(mkt1, pool1, "three agents, opposing sides");
    }

    function test_severalMarketsInOneDomainAggregateGross() public {
        pool1.setFillBps(0);
        pool2.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 120 * K);
        _order(agentB, mkt2, pool2, 2, 100_000, 90 * K);

        assertEq(pf.marketWorstCaseExposure(mkt1), 120 * K);
        assertEq(pf.marketWorstCaseExposure(mkt2), 90 * K);
        // Long one market and short another must NOT offset: they are different
        // questions resolving at different times, and nothing establishes a
        // payoff equivalence between them.
        assertEq(pf.domainRiskUsage(DOM), 210 * K, "domain aggregates gross");
    }

    // =================================================================
    // ADMISSION
    // =================================================================

    /// @notice The whole point: an admission may never leave the domain over.
    function test_admissionNeverLeavesTheDomainOverItsCeiling() public {
        // Tighten to make the boundary reachable in a few orders.
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _domainPolicy(300 * K));

        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 200 * K);
        assertLe(pf.domainRiskUsage(DOM), 300 * K);

        // 200 + 150 on the same side would reach 350.
        Intent memory over = _intent(mkt1, pool1, 150 * K, _nextNonce(agentB));
        assertEq(uint8(pf.previewIntent(agentB, over).refusal), uint8(Refusal.DOMAIN_RISK_EXCEEDED));
        _expectRefusal(agentB, over, Refusal.DOMAIN_RISK_EXCEEDED);

        // And an OPPOSING order is not a way around it. v1 would have admitted
        // this, because it would have netted the two to 50.
        Intent memory opposing = _intent(mkt1, pool1, 150 * K, _nextNonce(agentB));
        opposing.kind = 2;
        assertEq(uint8(pf.previewIntent(agentB, opposing).refusal), uint8(Refusal.NONE), "opposing leg fits at 200");
        vm.prank(agentB);
        pf.execute(opposing);
        assertEq(pf.marketWorstCaseExposure(mkt1), 200 * K, "still bounded by the larger side");
        assertLe(pf.domainRiskUsage(DOM), 300 * K, "admission respected the ceiling");
        _assertNeverUnderstates(mkt1, pool1, "after an opposing admission");
    }

    /// @notice Concurrent admissions in one block cannot both consume the same
    ///         headroom: the second sees the first's effect.
    function test_concurrentAdmissionsRaceForTheSameHeadroom() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _domainPolicy(250 * K));
        pool1.setFillBps(0);

        _order(agentA, mkt1, pool1, 0, 100_000, 200 * K);

        // Same block, no time passes. The second agent must be refused.
        Intent memory second = _intent(mkt1, pool1, 100 * K, _nextNonce(agentB));
        _expectRefusal(agentB, second, Refusal.DOMAIN_RISK_EXCEEDED);
        assertEq(pf.marketWorstCaseExposure(mkt1), 200 * K, "the refusal changed nothing");
    }

    // =================================================================
    // GENERATION RECYCLING
    // =================================================================

    /// @notice A recycled pool must not let a stale generation's exposure be
    ///         mistaken for the new one's, in either direction.
    function test_generationRecyclingIsBoundBothWays() public {
        pool1.setFillBps(0);
        _order(agentA, mkt1, pool1, 0, 100_000, 150 * K);
        assertEq(pf.marketWorstCaseExposure(mkt1), 150 * K);

        uint64 gen = pool1.marketNonce();
        pool1.roll();

        // The market's tracked exposure is pinned to the generation it traded,
        // so it keeps reading the old outcome ids rather than silently
        // re-pointing at whatever the pool is running now.
        assertEq(pf.marketWorstCaseExposure(mkt1), 150 * K, "still charged for the generation it traded");
        _assertNeverUnderstates(mkt1, pool1, "after the pool rolled");

        // And an intent naming the stale generation is refused outright.
        Intent memory stale = _intent(mkt1, pool1, 10 * K, _nextNonce(agentB));
        stale.marketNonce = gen;
        _expectRefusal(agentB, stale, Refusal.MARKET_GENERATION_MISMATCH);

        // As is one naming the NEW generation, because this marketId is already
        // bound to the old one. A new generation needs a new marketId.
        Intent memory fresh = _intent(mkt1, pool1, 10 * K, _nextNonce(agentB));
        _expectRefusal(agentB, fresh, Refusal.MARKET_GENERATION_MISMATCH);

        // The reservation is released against the recycled pool, and the market
        // then prunes out of the domain rather than accumulating forever.
        bytes32 key = keccak256(abi.encode(address(pool1), gen, uint128(1)));
        pf.releaseOrder(key);
        assertEq(pf.marketWorstCaseExposure(mkt1), 0, "released once the generation is gone");
        pf.pruneMarket(mkt1);
        assertEq(pf.domainRiskUsage(DOM), 0);
    }
}
