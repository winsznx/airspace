// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AirspaceBase} from "../AirspaceBase.t.sol";
import {AirspacePortfolio} from "../../src/AirspacePortfolio.sol";
import {Intent, Refusal} from "../../src/interfaces/IAirspace.sol";
import {console2} from "forge-std/Test.sol";
import {MockMarket, MockPool} from "../mocks/MockDreamDex.sol";

/// @notice What happens as a domain fills up.
///
/// `_evaluate` walks a domain's tracked markets to aggregate exposure, so its
/// cost grows with the number of live markets. That is the one place in this
/// design where gas is unbounded in principle, and `MAX_MARKETS_PER_DOMAIN`
/// exists to bound it in practice. These tests measure the growth rather than
/// assuming it, and prove the cap is enforced rather than documented.
contract ScaleTest is AirspaceBase {
    uint32 constant CAP = 48;

    function setUp() public {
        _setUpAirspace(1_000_000 * K);
    }

    /// @notice Fill a domain to the cap and record what evaluation costs.
    ///
    /// The numbers are printed rather than asserted against a magic constant:
    /// pinning gas invites a test that fails on every compiler bump. What IS
    /// asserted is the shape — cost grows roughly linearly in tracked markets,
    /// and a full domain still evaluates.
    function test_evaluationCostGrowsLinearlyWithTrackedMarkets() public {
        uint256 gasAtOne;
        uint256 gasAtCap;

        for (uint256 n = 0; n < CAP; n++) {
            (bytes32 id, MockPool p) = _newMarket(1000 + n, CADENCE);
            _exec(agentA, id, p, 10 * K);

            if (n == 0 || n == CAP - 1) {
                (bytes32 probeId, MockPool probe) = _newMarket(9000 + n, CADENCE);
                Intent memory i = _intent(probeId, probe, 10 * K, 1);
                uint256 before = gasleft();
                pf.previewIntent(agentB, i);
                uint256 used = before - gasleft();
                if (n == 0) gasAtOne = used;
                else gasAtCap = used;
            }
        }

        console2.log("previewIntent gas with 1 tracked market :", gasAtOne);
        console2.log("previewIntent gas with 47 tracked markets:", gasAtCap);
        console2.log("per-market marginal gas                 :", (gasAtCap - gasAtOne) / 46);

        assertGt(gasAtCap, gasAtOne, "cost must grow with tracked markets");
        // Linear, not quadratic: 47 markets must not cost more than ~60x one.
        assertLt(gasAtCap, gasAtOne * 60, "evaluation cost is superlinear in tracked markets");
    }

    /// @notice The cap is enforced, and it refuses rather than reverting opaquely.
    function test_domainRefusesBeyondTheMarketCap() public {
        for (uint256 n = 0; n < CAP; n++) {
            (bytes32 id, MockPool p) = _newMarket(2000 + n, CADENCE);
            _exec(agentA, id, p, 1 * K);
        }
        assertEq(pf.domainMarketCount(DOM), CAP, "domain is full");

        (bytes32 extra, MockPool extraPool) = _newMarket(2999, CADENCE);
        Intent memory i = _intent(extra, extraPool, 1 * K, 1);
        assertEq(uint8(pf.previewIntent(agentB, i).refusal), uint8(Refusal.DOMAIN_MARKETS_FULL));
        _expectRefusal(agentB, i, Refusal.DOMAIN_MARKETS_FULL);
    }

    /// @notice A full domain still admits into markets it already tracks.
    ///
    /// The cap bounds how many markets a domain aggregates, not how much may be
    /// traded. Conflating the two would strand an owner's capital the moment a
    /// domain filled up.
    function test_fullDomainStillTradesItsExistingMarkets() public {
        bytes32 first;
        MockPool firstPool;
        for (uint256 n = 0; n < CAP; n++) {
            (bytes32 id, MockPool p) = _newMarket(3000 + n, CADENCE);
            _exec(agentA, id, p, 1 * K);
            if (n == 0) (first, firstPool) = (id, p);
        }
        assertEq(pf.domainMarketCount(DOM), CAP, "domain is full");

        uint128 before = pf.domainRiskUsage(DOM);
        _exec(agentB, first, firstPool, 5 * K);
        assertEq(pf.domainRiskUsage(DOM), before + 5 * K, "a tracked market still accepts orders");
    }

    /// @notice Pruning a settled market makes room again, permissionlessly.
    function test_pruningReclaimsDomainCapacity() public {
        bytes32 first;
        for (uint256 n = 0; n < CAP; n++) {
            (bytes32 id, MockPool p) = _newMarket(4000 + n, CADENCE);
            _exec(agentA, id, p, 1 * K);
            if (n == 0) first = id;
        }
        assertEq(pf.domainMarketCount(DOM), CAP);

        // Settle the market at the venue, then release and prune. Both of those
        // are permissionless: a full domain must not need the owner to unblock it.
        (,,,,,,,, address mkt,,,,,) = mod.markets(first);
        MockMarket(mkt).resolve();
        vm.warp(block.timestamp + CADENCE * 2);
        vm.prank(address(0xBEEF));
        pf.releaseSettled(first);
        vm.prank(address(0xBEEF));
        pf.pruneMarket(first);

        assertEq(pf.domainMarketCount(DOM), CAP - 1, "pruning freed a slot");

        (bytes32 fresh, MockPool freshPool) = _newMarket(4999, CADENCE);
        Intent memory i = _intent(fresh, freshPool, 1 * K, 1);
        assertEq(uint8(pf.previewIntent(agentB, i).refusal), uint8(Refusal.NONE), "the freed slot is usable");
    }

    /// @notice Many agents on one portfolio cost nothing extra to evaluate.
    ///
    /// Agent state is a single mapping slot per agent, never a list, so a
    /// portfolio with a thousand agents evaluates an intent as cheaply as one
    /// with three. This is why `_agentList` was removed rather than kept.
    function test_agentCountDoesNotAffectEvaluationCost() public {
        (bytes32 id, MockPool p) = _newMarket(5000, CADENCE);
        Intent memory i = _intent(id, p, 10 * K, 1);

        // Warm every slot the evaluation touches. Without this the first call
        // measures cold-storage access, not agent count.
        pf.previewIntent(agentA, i);

        uint256 before = gasleft();
        pf.previewIntent(agentA, i);
        uint256 withThreeAgents = before - gasleft();

        vm.startPrank(owner);
        for (uint256 n = 0; n < 250; n++) {
            pf.setAgent(address(uint160(0x10000 + n)), _agentPolicy());
        }
        vm.stopPrank();

        pf.previewIntent(agentA, i);
        before = gasleft();
        pf.previewIntent(agentA, i);
        uint256 withManyAgents = before - gasleft();

        console2.log("previewIntent gas with 3 agents  :", withThreeAgents);
        console2.log("previewIntent gas with 253 agents:", withManyAgents);

        // Identical work, so allow only warm/cold storage noise.
        assertApproxEqRel(withManyAgents, withThreeAgents, 0.02e18, "agent count must not change evaluation cost");
    }
}
