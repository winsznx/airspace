// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AirspaceBase} from "../AirspaceBase.t.sol";
import {CollateralOracle} from "../reference/CollateralOracle.sol";
import {Intent, Refusal, AdmissionView} from "../../src/interfaces/IAirspace.sol";
import {MockPool} from "../mocks/MockDreamDex.sol";

/// @notice Independent validation of the capital side.
///
/// The v1 failure was directional, and the tempting conclusion is that the
/// collateral accounting is fine because it was not implicated. That reasoning
/// is exactly what let the directional bug live: v1's ceiling invariant checked
/// `domainRiskUsage <= CEILING`, the number under test against itself, and an
/// understatement made it pass. So this file checks capital the same way the fix
/// checks exposure — against a reference that was written separately, and
/// against the portfolio's own measured ERC-20 balance rather than its
/// accumulators.
///
/// Three things are proven here:
///   1. A BUY escrows EXACTLY what admission reserved. Not less, not more.
///   2. A SELL escrows no collateral at all.
///   3. `reservedCollateral` equals the sum of live per-order reservations, so
///      the accumulator and the records cannot drift apart silently.
contract CollateralAccountingTest is AirspaceBase {
    function setUp() public {
        _setUpAirspace(1_000_000 * K);
    }

    function _mk(bytes32 id, MockPool p, uint8 kind, uint256 price, uint128 qty, address who)
        internal
        returns (Intent memory i)
    {
        i = _intent(id, p, qty, _nextNonce(who));
        i.kind = kind;
        i.price = price;
    }

    // =================================================================
    // 1. WHAT ADMISSION RESERVES IS WHAT THE VENUE TAKES
    // =================================================================

    /// @notice The reservation quoted at admission is the collateral that
    ///         actually leaves, measured on the token, for every buy kind.
    function test_buyEscrowsExactlyWhatWasReserved() public {
        pool1.setFillBps(0);
        uint256[4] memory prices = [uint256(20_000), 100_000, 500_000, 970_000];

        for (uint256 k; k < prices.length; ++k) {
            for (uint8 kind = 0; kind < 3; kind += 2) {
                Intent memory i = _mk(mkt1, pool1, kind, prices[k], 37 * K, agentA);

                AdmissionView memory v = pf.previewIntent(agentA, i);
                assertEq(uint8(v.refusal), uint8(Refusal.NONE), "probe must be admissible");

                uint256 independent = CollateralOracle.reserve(kind, prices[k], 37 * K, ONE);
                assertEq(v.reserveRequired, independent, "production and reference disagree on the reservation");

                uint256 before = tok.balanceOf(address(pf));
                vm.prank(agentA);
                pf.execute(i);
                uint256 moved = before - tok.balanceOf(address(pf));

                assertEq(moved, independent, "the venue took a different amount than admission reserved");
            }
        }
    }

    /// @notice A SELL moves outcome tokens, never collateral.
    function test_sellEscrowsNoCollateral() public {
        // Acquire something to sell.
        pool1.setFillBps(10_000);
        // Built before the prank: constructing an intent reads `marketNonce`
        // from the pool, and that external call would consume the prank.
        Intent memory buy = _mk(mkt1, pool1, 0, 100_000, 200 * K, agentA);
        vm.prank(agentA);
        pf.execute(buy);
        pool1.setFillBps(0);

        uint256 beforeColl = tok.balanceOf(address(pf));
        uint128 reservedBefore = pf.reservedCollateral();
        uint128 agentBefore = pf.agentCommitted(agentA);

        Intent memory sell = _mk(mkt1, pool1, 1, 100_000, 150 * K, agentA);
        vm.prank(agentA);
        pf.execute(sell);

        assertEq(tok.balanceOf(address(pf)), beforeColl, "a sell must not move collateral");
        assertEq(pf.reservedCollateral(), reservedBefore, "a sell must not consume reserved collateral");
        assertEq(pf.agentCommitted(agentA), agentBefore, "a sell must not raise committed capital");
    }

    /// @notice The two implementations agree on every input in range.
    function testFuzz_reservationMatchesTheReference(uint8 kindSeed, uint32 priceSeed, uint64 qty) public {
        uint8 kind = uint8(bound(kindSeed, 0, 3));
        uint256 price = bound(priceSeed, 10, 990) * 1000;
        uint128 q = uint128(bound(qty, 1, 40_000)) * 1000;

        pool1.setFillBps(0);
        Intent memory i = _mk(mkt1, pool1, kind, price, q, agentA);
        AdmissionView memory v = pf.previewIntent(agentA, i);

        assertEq(
            uint256(v.reserveRequired),
            CollateralOracle.reserve(kind, price, q, ONE),
            "closed-form reservation diverged from the reference"
        );
    }

    /// @notice Rounding goes UP, always. A portfolio that rounds down is a
    ///         portfolio that is short by a unit at the moment of transfer.
    function testFuzz_reservationNeverRoundsDown(uint32 priceSeed, uint64 qty) public {
        uint256 price = bound(priceSeed, 10, 990) * 1000;
        uint128 q = uint128(bound(qty, 1, 40_000)) * 1000;

        pool1.setFillBps(0);
        AdmissionView memory v = pf.previewIntent(agentA, _mk(mkt1, pool1, 0, price, q, agentA));

        // The exact cost, unrounded, scaled up to avoid fractions.
        assertGe(uint256(v.reserveRequired) * ONE, price * uint256(q), "reserved less than the order costs");
        // And never more than one unit over, so the conservatism is bounded.
        assertLt((uint256(v.reserveRequired) - 1) * ONE, price * uint256(q), "over-reserved by more than rounding");
    }

    // =================================================================
    // 2. THE ACCUMULATOR AGAINST THE RECORDS
    // =================================================================

    /// @notice `reservedCollateral` is a running total. It must equal the sum of
    ///         what the individual order records say is still locked, or one of
    ///         the two is lying and admission is reading the wrong one.
    function test_reservedCollateralEqualsTheSumOfLiveOrders() public {
        pool1.setFillBps(0);
        pool2.setFillBps(0);

        bytes32[] memory keys = new bytes32[](4);
        keys[0] = _place(agentA, mkt1, pool1, 0, 100_000, 90 * K);
        keys[1] = _place(agentB, mkt1, pool1, 2, 250_000, 40 * K);
        keys[2] = _place(agentC, mkt2, pool2, 0, 700_000, 30 * K);
        keys[3] = _place(agentA, mkt2, pool2, 2, 330_000, 70 * K);

        _assertAccumulatorMatchesRecords(keys);

        // Cancel one at the venue and reconcile it. The accumulator has to fall
        // by exactly that record's reservation, not by a recomputed guess.
        (,,,,,,, uint128 released) = pf.orderRec(keys[1]);
        uint128 accBefore = pf.reservedCollateral();
        vm.prank(address(pf));
        pool1.cancelOrder(2);
        pf.releaseOrder(keys[1]);
        assertEq(pf.reservedCollateral(), accBefore - released, "release moved the accumulator by the wrong amount");

        _assertAccumulatorMatchesRecords(keys);
    }

    /// @notice A PARTIAL release scales the reservation proportionally. This is
    ///         the one place the capital books round, so it is checked rather
    ///         than assumed.
    function test_partialReleaseScalesTheReservationDownward() public {
        pool1.setFillBps(0);
        bytes32 key = _place(agentA, mkt1, pool1, 0, 333_000, 100 * K);

        (,,,,,,, uint128 full) = pf.orderRec(key);
        pool1.externalFill(1, 40 * K);
        pf.releaseOrder(key);
        (,,,,,,, uint128 rest) = pf.orderRec(key);

        // 60% of the order still rests, so at most 60% of the escrow may still
        // be counted. Rounding is allowed to leave LESS than the exact share —
        // it may not leave more, which would keep charging for capital already
        // spent and eventually strand it.
        assertLe(uint256(rest) * 100, uint256(full) * 60, "kept more reserved than is still resting");
        assertGe(uint256(rest) * 100, uint256(full) * 60 - 100, "dropped materially more than the filled share");
        assertEq(pf.reservedCollateral(), rest, "accumulator and record disagree after a partial release");
    }

    // =================================================================
    // 3. WHERE THE MEASURED MODEL IS IMPRECISE, STATED PLAINLY
    // =================================================================

    /// @notice `committedCapital` is `capitalBase - freeCollateral`, so incoming
    ///         collateral that is not new funding reads as capital freed.
    ///
    /// A profitable sell pays the portfolio, raising free collateral above the
    /// capital base and pinning measured committed capital at zero while orders
    /// are still open. That understates the committed-capital BUDGET, which is a
    /// policy allowance, and it cannot understate solvency: every buy is gated
    /// on `freeCollateral() >= reserveRequired`, read from the token itself, so
    /// the portfolio can never authorise collateral it does not hold.
    ///
    /// This is a known imprecision, not a silent one. The fix is for the owner
    /// to call `setCapitalBase` after realising profit, which is what that
    /// function is for.
    function test_sellProceedsUnderstateCommittedCapitalNotSolvency() public {
        pool1.setFillBps(10_000);
        Intent memory buy = _mk(mkt1, pool1, 0, 100_000, 500 * K, agentA);
        vm.prank(agentA);
        pf.execute(buy);

        // Sell the position back at a much better price. Proceeds exceed cost.
        Intent memory sell = _mk(mkt1, pool1, 1, 900_000, 500 * K, agentA);
        vm.prank(agentA);
        pf.execute(sell);

        uint256 free = pf.freeCollateral();
        assertGt(free, pf.capitalBase(), "the fixture did not actually realise a profit");
        assertEq(pf.committedCapital(), 0, "measured committed capital floors at zero once free exceeds base");

        // Solvency is unaffected: a buy larger than the portfolio holds is still
        // refused, because that gate reads the token balance, not the base.
        pool1.setFillBps(0);
        Intent memory tooBig = _mk(mkt1, pool1, 0, 990_000, uint128(free / 990_000 * K + 1000 * K), agentA);
        AdmissionView memory v = pf.previewIntent(agentA, tooBig);
        assertTrue(v.refusal != Refusal.NONE, "admitted a buy larger than the collateral on hand");

        // And the owner's correction restores the measure.
        vm.prank(owner);
        pf.setCapitalBase(uint128(free));
        assertEq(pf.committedCapital(), 0);
        assertEq(pf.capitalBase(), free, "base realigned to what the portfolio actually holds");
    }

    /// @notice An agent has no path to the money. Not to withdraw it, not to
    ///         redirect it, not to raise its own allowance.
    function test_noAgentPathToCapital() public {
        uint256 held = tok.balanceOf(address(pf));

        vm.startPrank(agentA);
        vm.expectRevert();
        pf.withdraw(address(tok), agentA, held);
        vm.expectRevert();
        pf.withdrawOutcome(0, agentA, 1);
        vm.expectRevert();
        pf.setCapitalBase(type(uint128).max);
        vm.expectRevert();
        pf.setAgent(agentA, _agentPolicy());
        vm.expectRevert();
        pf.ownerCall(address(tok), 0, abi.encodeWithSignature("transfer(address,uint256)", agentA, held));
        vm.stopPrank();

        assertEq(tok.balanceOf(address(pf)), held, "portfolio balance moved");
    }

    // -----------------------------------------------------------------

    function _place(address who, bytes32 id, MockPool p, uint8 kind, uint256 price, uint128 qty)
        internal
        returns (bytes32 key)
    {
        Intent memory i = _mk(id, p, kind, price, qty, who);
        vm.prank(who);
        uint128 orderId = pf.execute(i);
        return keccak256(abi.encode(address(p), p.marketNonce(), orderId));
    }

    function _assertAccumulatorMatchesRecords(bytes32[] memory keys) internal view {
        uint256 sum;
        for (uint256 k; k < keys.length; ++k) {
            (,,,,,,, uint128 coll) = pf.orderRec(keys[k]);
            sum += coll;
        }
        assertEq(uint256(pf.reservedCollateral()), sum, "reservedCollateral drifted from the order records");
    }
}
