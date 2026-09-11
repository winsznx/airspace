// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ExposureOracle} from "../reference/ExposureOracle.sol";

/// @notice Regression for the v1 safety failure, and the model that replaces it.
///
/// v1 computed a single netted figure:
///
///     (balYES + yesLong - yesShort) - (balNO + noLong - noShort)
///
/// which prices exactly one outcome — every resting order filling at once. That
/// is the most NETTED assumption available, not the most conservative one, and
/// it let a pending BUY_YES cancel a pending BUY_NO even though either can fill
/// without the other.
///
/// The state below is not hypothetical. It is market #48588 of the live campaign
/// portfolio at Shannon block 473455000, read off chain:
///
///     balYES 70   balNO 620   yesLong 1090   noLong 620
///     v1 reported            80
///     true worst case     1,170
///     domain ceiling        500
///
/// Full decomposition in engineering/03-superseded-unsafe-v1/.
contract ReservationNettingTest is Test {
    using ExposureOracle for ExposureOracle.Market;

    /// @dev v1's formula, reproduced verbatim so the regression tests the real
    ///      thing rather than a description of it.
    function _v1(uint256 balYes, uint256 balNo, uint256 yesLong, uint256 yesShort, uint256 noLong, uint256 noShort)
        internal
        pure
        returns (uint256)
    {
        int256 yes = int256(balYes) + int256(yesLong) - int256(yesShort);
        int256 no = int256(balNo) + int256(noLong) - int256(noShort);
        int256 d = yes - no;
        return d < 0 ? uint256(-d) : uint256(d);
    }

    /// @dev The replacement, as the production contract computes it.
    function _v2(uint256 balYes, uint256 balNo, uint256 yesLong, uint256 yesShort, uint256 noLong, uint256 noShort)
        internal
        pure
        returns (uint256)
    {
        int256 b = int256(balYes) - int256(balNo);
        int256 up = b + int256(yesLong) + int256(yesShort);
        int256 dn = b - int256(noLong) - int256(noShort);
        uint256 a = up < 0 ? uint256(-up) : uint256(up);
        uint256 c = dn < 0 ? uint256(-dn) : uint256(dn);
        return a > c ? a : c;
    }

    function _oracle(uint256 balYes, uint256 balNo, uint256 yesLong, uint256 yesShort, uint256 noLong, uint256 noShort)
        internal
        pure
        returns (uint256)
    {
        return ExposureOracle.worstCase(
            ExposureOracle.Market({
                balYes: balYes, balNo: balNo, buyYes: yesLong, sellYes: yesShort, buyNo: noLong, sellNo: noShort
            })
        );
    }

    uint256 constant K = 1e6;

    // =================================================================
    // THE HISTORICAL FAILURE
    // =================================================================

    /// @notice The exact on-chain state that broke v1.
    function test_historicalState_v1Understates() public pure {
        uint256 reported = _v1(70 * K, 620 * K, 1090 * K, 0, 620 * K, 0);
        uint256 truth = _oracle(70 * K, 620 * K, 1090 * K, 0, 620 * K, 0);

        assertEq(reported, 80 * K, "v1 reported 80, as recorded on chain");
        assertEq(truth, 1170 * K, "independent worst case is 1,170");

        // The failure, stated as an assertion: v1 understated by 1,090.
        assertLt(reported, truth, "v1 understated maximum commitment");
        assertEq(truth - reported, 1090 * K, "understatement of 1,090 contracts");
    }

    /// @notice The replacement reproduces the independent figure exactly.
    function test_historicalState_v2Matches() public pure {
        assertEq(_v2(70 * K, 620 * K, 1090 * K, 0, 620 * K, 0), 1170 * K, "v2 must report 1,170");
    }

    /// @notice And it would have refused, where v1 admitted.
    function test_historicalState_v2WouldHaveRefused() public pure {
        uint256 ceiling = 500 * K;
        assertLe(_v1(70 * K, 620 * K, 1090 * K, 0, 620 * K, 0), ceiling, "v1 saw room and admitted");
        assertGt(_v2(70 * K, 620 * K, 1090 * K, 0, 620 * K, 0), ceiling, "v2 refuses");
    }

    // =================================================================
    // THE SHAPE OF THE DEFECT
    // =================================================================

    /// @notice Two opposing resting buys, nothing held. v1 saw zero risk.
    function test_opposingBuysDoNotNet() public pure {
        assertEq(_v1(0, 0, 100 * K, 0, 100 * K, 0), 0, "v1 netted them to nothing");
        assertEq(_oracle(0, 0, 100 * K, 0, 100 * K, 0), 100 * K, "either can fill alone");
        assertEq(_v2(0, 0, 100 * K, 0, 100 * K, 0), 100 * K, "v2 agrees with the oracle");
    }

    /// @notice Opposing REALIZED balances SHOULD net: a held complete set pays
    ///         one unit either way, so it carries no directional risk. The fix
    ///         must not over-correct into treating that as exposure.
    function test_realizedCompleteSetStillNets() public pure {
        assertEq(_oracle(500 * K, 500 * K, 0, 0, 0, 0), 0, "a complete set is not directional");
        assertEq(_v2(500 * K, 500 * K, 0, 0, 0, 0), 0, "v2 must agree");
    }

    /// @notice A complete set plus a one-sided pending order is exposed by
    ///         exactly that order.
    function test_completeSetPlusOneSidedPending() public pure {
        assertEq(_v2(500 * K, 500 * K, 90 * K, 0, 0, 0), 90 * K);
        assertEq(_oracle(500 * K, 500 * K, 90 * K, 0, 0, 0), 90 * K);
    }

    // =================================================================
    // EVERY ORDER KIND, AND EVERY OPPOSING PAIR
    // =================================================================

    function test_eachKindAlone() public pure {
        // From flat. A sell's tokens are already escrowed, so the balance shown
        // is post-escrow and the exposure is the token coming BACK on cancel.
        assertEq(_v2(0, 0, 100 * K, 0, 0, 0), 100 * K, "BUY_YES");
        assertEq(_v2(0, 0, 0, 100 * K, 0, 0), 100 * K, "SELL_YES: escrow returns on cancel");
        assertEq(_v2(0, 0, 0, 0, 100 * K, 0), 100 * K, "BUY_NO");
        assertEq(_v2(0, 0, 0, 0, 0, 100 * K), 100 * K, "SELL_NO: escrow returns on cancel");
    }

    function test_buyYesPlusSellYes() public pure {
        uint256 v = _v2(0, 0, 100 * K, 60 * K, 0, 0);
        assertEq(v, _oracle(0, 0, 100 * K, 60 * K, 0, 0));
        // Both push the same way: the buy fills AND the sell's escrow returns.
        assertEq(v, 160 * K);
    }

    function test_buyNoPlusSellNo() public pure {
        uint256 v = _v2(0, 0, 0, 0, 100 * K, 60 * K);
        assertEq(v, _oracle(0, 0, 0, 0, 100 * K, 60 * K));
        assertEq(v, 160 * K);
    }

    function test_realizedYesPlusPendingBuyNo() public pure {
        // Long 400 YES with a resting BUY_NO 300: worst is the buy filling.
        assertEq(_v2(400 * K, 0, 0, 0, 300 * K, 0), 400 * K, "the long side still dominates");
        assertEq(_oracle(400 * K, 0, 0, 0, 300 * K, 0), 400 * K);
    }

    function test_realizedNoPlusPendingBuyYes() public pure {
        assertEq(_v2(0, 400 * K, 300 * K, 0, 0, 0), 400 * K);
        assertEq(_oracle(0, 400 * K, 300 * K, 0, 0, 0), 400 * K);
    }

    // =================================================================
    // THE PROPERTY, OVER EVERYTHING REACHABLE
    // =================================================================

    /// @notice AIRSPACE_ACCOUNTED >= INDEPENDENT_REFERENCE, always.
    ///
    /// Understatement by a single raw unit fails. Overstatement is allowed and
    /// is separately measured below.
    function testFuzz_neverUnderstatesTheOracle(
        uint96 balYes,
        uint96 balNo,
        uint96 buyYes,
        uint96 sellYes,
        uint96 buyNo,
        uint96 sellNo
    ) public pure {
        uint256 accounted = _v2(balYes, balNo, buyYes, sellYes, buyNo, sellNo);
        uint256 expected = _oracle(balYes, balNo, buyYes, sellYes, buyNo, sellNo);
        assertGe(accounted, expected, "AIRSPACE understated the independent worst case");
    }

    /// @notice On this model the two agree exactly — the bound is tight, so the
    ///         conservatism costs nothing. If that ever stops holding, the
    ///         overstatement is what this test will surface.
    function testFuzz_boundIsTightNotMerelySafe(
        uint96 balYes,
        uint96 balNo,
        uint96 buyYes,
        uint96 sellYes,
        uint96 buyNo,
        uint96 sellNo
    ) public pure {
        assertEq(
            _v2(balYes, balNo, buyYes, sellYes, buyNo, sellNo),
            _oracle(balYes, balNo, buyYes, sellYes, buyNo, sellNo),
            "closed form should equal exhaustive enumeration"
        );
    }

    /// @notice v1 fails the same property, which is what makes it a regression.
    function testFuzz_v1DoesNotHoldTheProperty(uint96 a, uint96 b) public pure {
        // Any two opposing resting buys are a counterexample.
        vm.assume(a > 0 && b > 0);
        uint256 accounted = _v1(0, 0, a, 0, b, 0);
        uint256 expected = _oracle(0, 0, a, 0, b, 0);
        // v1 reports |a - b|; the truth is max(a, b).
        assertLt(accounted, expected, "v1 must understate here, by construction");
    }

    // =================================================================
    // DOMAIN AGGREGATION
    // =================================================================

    /// @notice Markets in one domain are summed gross, never netted.
    function test_domainDoesNotNetAcrossMarkets() public pure {
        ExposureOracle.Market[] memory ms = new ExposureOracle.Market[](2);
        // Long one market, short another by the same size.
        ms[0] = ExposureOracle.Market(300 * K, 0, 0, 0, 0, 0);
        ms[1] = ExposureOracle.Market(0, 300 * K, 0, 0, 0, 0);
        assertEq(ExposureOracle.domainWorstCase(ms), 600 * K, "gross, not netted to zero");
    }
}
