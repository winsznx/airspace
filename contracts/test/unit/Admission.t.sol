// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AirspaceBase} from "../AirspaceBase.t.sol";
import {AirspacePortfolio} from "../../src/AirspacePortfolio.sol";
import {AgentPolicy, DomainPolicy, GlobalPolicy, Intent, Refusal, AdmissionView, Gate} from
    "../../src/interfaces/IAirspace.sol";
import {console2} from "forge-std/Test.sol";
import {MockPool} from "../mocks/MockDreamDex.sol";

/// @notice The dominant mechanism, and the gates around it.
contract AdmissionTest is AirspaceBase {
    function setUp() public {
        _setUpAirspace(500 * K);
    }

    // =================================================================
    // THE DOMINANT MECHANISM
    // =================================================================

    /// @notice An individually valid order refused solely because of other
    ///         agents' portfolio state. This is the product.
    function test_crossAgentRefusal() public {
        _exec(agentA, mkt1, pool1, 180 * K);
        assertEq(pf.domainRiskUsage(DOM), 180 * K, "A alone");

        _exec(agentB, mkt2, pool2, 240 * K);
        assertEq(pf.domainRiskUsage(DOM), 420 * K, "A + B");

        uint128 cCommittedBefore = pf.agentCommitted(agentC);

        // C's own policy admits this order with an order of magnitude to spare.
        Intent memory ic = _intent(mkt1, pool1, 150 * K, 1);
        AdmissionView memory v = pf.previewIntent(agentC, ic);
        assertEq(uint8(v.refusal), uint8(Refusal.DOMAIN_RISK_EXCEEDED));
        assertEq(v.domainUsageBefore, 420 * K);
        assertEq(v.domainUsageAfter, 570 * K);
        assertEq(v.domainCeiling, 500 * K);

        // Every earlier gate passed. Only the portfolio gate failed.
        assertTrue(Gate.has(v.gates, Gate.AGENT_POLICY), "agent policy PASS");
        assertTrue(Gate.has(v.gates, Gate.GENERATION), "generation PASS");
        assertTrue(Gate.has(v.gates, Gate.MARKET_TRADING), "trading PASS");
        assertTrue(Gate.has(v.gates, Gate.PRICE), "price PASS");
        assertTrue(Gate.has(v.gates, Gate.HEADROOM), "headroom PASS");
        assertTrue(Gate.has(v.gates, Gate.GRID), "grid PASS");
        assertFalse(Gate.has(v.gates, Gate.DOMAIN_CAPACITY), "portfolio domain FAIL");

        _expectRefusal(agentC, ic, Refusal.DOMAIN_RISK_EXCEEDED);

        // A rejected intent consumes nothing.
        assertEq(pf.agentCommitted(agentC), cCommittedBefore, "C committed unchanged");
        assertEq(pf.domainRiskUsage(DOM), 420 * K, "domain unchanged");
        assertEq(pf.agentNonce(agentC), 0, "nonce not consumed by a refusal");
    }

    /// @notice `previewIntent` and `execute` are the same code path, so the UI's
    ///         gate display can never disagree with the enforced decision.
    function test_previewMatchesExecutionForEveryRefusal() public {
        _exec(agentA, mkt1, pool1, 480 * K);

        Intent memory tooBig = _intent(mkt1, pool1, 100 * K, 1);
        assertEq(uint8(pf.previewIntent(agentC, tooBig).refusal), uint8(Refusal.DOMAIN_RISK_EXCEEDED));
        _expectRefusal(agentC, tooBig, Refusal.DOMAIN_RISK_EXCEEDED);

        Intent memory offGrid = _intent(mkt1, pool1, 10 * K, 1);
        offGrid.price = 100_001;
        assertEq(uint8(pf.previewIntent(agentC, offGrid).refusal), uint8(Refusal.OFF_TICK_GRID));
        _expectRefusal(agentC, offGrid, Refusal.OFF_TICK_GRID);

        Intent memory badGen = _intent(mkt1, pool1, 10 * K, 1);
        badGen.marketNonce = 99;
        assertEq(uint8(pf.previewIntent(agentC, badGen).refusal), uint8(Refusal.MARKET_GENERATION_MISMATCH));
        _expectRefusal(agentC, badGen, Refusal.MARKET_GENERATION_MISMATCH);

        Intent memory ok = _intent(mkt2, pool2, 10 * K, 1);
        assertEq(uint8(pf.previewIntent(agentC, ok).refusal), uint8(Refusal.NONE));
        vm.prank(agentC);
        pf.execute(ok);
    }

    /// @notice Capacity released through a real lifecycle path re-admits the
    ///         identical order.
    function test_releaseThenReadmit() public {
        uint128 idA = _exec(agentA, mkt1, pool1, 180 * K);
        _exec(agentB, mkt2, pool2, 240 * K);

        Intent memory ic = _intent(mkt1, pool1, 150 * K, 1);
        _expectRefusal(agentC, ic, Refusal.DOMAIN_RISK_EXCEEDED);

        vm.prank(owner);
        pf.cancelOrder(address(pool1), idA);
        pf.releaseOrder(keccak256(abi.encode(address(pool1), pool1.marketNonce(), idA)));
        assertEq(pf.domainRiskUsage(DOM), 240 * K, "A released");

        vm.prank(agentC);
        pf.execute(ic);
        assertEq(pf.domainRiskUsage(DOM), 390 * K, "same shape now admitted");
    }

    // =================================================================
    // CONCURRENCY
    // =================================================================

    function test_twoAgentsRaceSameBlock() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _domainPolicy(200 * K));

        uint256 blk = block.number;
        _exec(agentA, mkt1, pool1, 150 * K);
        _expectRefusal(agentB, _intent(mkt2, pool2, 150 * K, 1), Refusal.DOMAIN_RISK_EXCEEDED);

        assertEq(block.number, blk, "same block");
        assertEq(pf.domainRiskUsage(DOM), 150 * K, "exactly one winner");
        assertEq(pf.agentCommitted(agentB), 0, "loser committed nothing");
    }

    function test_tenAgentsRace() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _domainPolicy(250 * K));

        address[] memory ten = new address[](10);
        for (uint256 k; k < 10; ++k) {
            ten[k] = address(uint160(0xA1000 + k));
            vm.prank(owner);
            pf.setAgent(ten[k], _agentPolicy());
        }

        uint256 winners;
        uint256 blk = block.number;
        for (uint256 k; k < 10; ++k) {
            Intent memory i = _intent(k % 2 == 0 ? mkt1 : mkt2, k % 2 == 0 ? pool1 : pool2, 100 * K, 1);
            vm.prank(ten[k]);
            try pf.execute(i) returns (uint128) {
                ++winners;
            } catch {}
        }
        assertEq(block.number, blk, "all in one block");
        assertEq(winners, 2, "cap admitted exactly two");
        assertEq(pf.domainRiskUsage(DOM), 200 * K);
    }

    // =================================================================
    // RESERVATION LIFECYCLE
    // =================================================================

    function test_unfilledOrderStillConsumesCapacity() public {
        pool1.setFillBps(0); // nothing fills
        _exec(agentA, mkt1, pool1, 100 * K);

        assertEq(pf.domainRiskUsage(DOM), 100 * K, "reserved before any fill");
        uint256 yesId = (uint256(uint160(address(pool1))) << 72) | (uint256(pool1.marketNonce()) << 8);
        assertEq(oc.balanceOf(address(pf), yesId), 0, "nothing filled");
        assertGt(pf.reservedCollateral(), 0, "collateral escrowed");
    }

    function test_partialFillDoesNotDoubleCount() public {
        pool1.setFillBps(5000); // half fills, half rests
        _exec(agentA, mkt1, pool1, 100 * K);

        // filled + resting == reserved, so the domain moved by exactly what was
        // admitted -- never more.
        assertEq(pf.domainRiskUsage(DOM), 100 * K, "no double count");
    }

    function test_fullFillLeavesNoResidualReservation() public {
        pool1.setFillBps(10000);
        _exec(agentA, mkt1, pool1, 100 * K);

        assertEq(pf.domainRiskUsage(DOM), 100 * K, "position carries the exposure");
        assertEq(pf.reservedCollateral(), 0, "no escrow retained");
    }

    /// @notice ADVERSARIAL: a fill AIRSPACE never saw must not understate risk.
    function test_externalFillOverstatesNeverUnderstates() public {
        pool1.setFillBps(0);
        uint128 id = _exec(agentA, mkt1, pool1, 20 * K);
        uint128 before_ = pf.domainRiskUsage(DOM);
        assertEq(before_, 20 * K);

        // An outside counterparty consumes the resting order.
        pool1.externalFill(id, 20 * K);

        uint128 after_ = pf.domainRiskUsage(DOM);
        assertEq(after_, 40 * K, "reservation + realized position, conservatively double counted");
        assertGe(after_, before_, "an external fill must never reduce measured risk");

        // Reconciliation removes the stale half, converging to the truth.
        pf.releaseOrder(keccak256(abi.encode(address(pool1), pool1.marketNonce(), id)));
        assertEq(pf.domainRiskUsage(DOM), 20 * K, "converges");
    }

    function test_releaseRefusedWhileOrderIsLive() public {
        pool1.setFillBps(0);
        uint128 id = _exec(agentA, mkt1, pool1, 100 * K);
        bytes32 key = keccak256(abi.encode(address(pool1), pool1.marketNonce(), id));

        vm.prank(attacker);
        vm.expectRevert(AirspacePortfolio.OrderStillLive.selector);
        pf.releaseOrder(key);

        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.OrderStillLive.selector);
        pf.releaseOrder(key);

        assertEq(pf.domainRiskUsage(DOM), 100 * K);
    }

    function test_settledMarketCarriesNoDirectionalRisk() public {
        pool1.setFillBps(10000);
        _exec(agentA, mkt1, pool1, 100 * K);
        assertEq(pf.domainRiskUsage(DOM), 100 * K);

        (,,,,,,,, address market,,,,,) = mod.markets(mkt1);
        (bool ok,) = market.call(abi.encodeWithSignature("resolve()"));
        assertTrue(ok);

        pf.releaseSettled(mkt1);
        assertEq(pf.domainRiskUsage(DOM), 0, "a fixed claim is not a bet");
    }

    function test_pruneBoundsTheCollection() public {
        pool1.setFillBps(0);
        uint128 id = _exec(agentA, mkt1, pool1, 100 * K);
        assertEq(pf.domainMarketCount(DOM), 1);

        vm.expectRevert(AirspacePortfolio.MarketStillActive.selector);
        pf.pruneMarket(mkt1);

        vm.prank(owner);
        pf.cancelOrder(address(pool1), id);
        pf.releaseOrder(keccak256(abi.encode(address(pool1), pool1.marketNonce(), id)));
        pf.pruneMarket(mkt1);

        assertEq(pf.domainMarketCount(DOM), 0, "collection shrinks back");
        assertEq(pf.domainRiskUsage(DOM), 0);
    }

    // =================================================================
    // COMPROMISED AGENTS
    // =================================================================

    function test_agentCannotMoveCapital() public {
        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.withdraw(address(tok), agentC, 1);

        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.withdrawOutcome(0, agentC, 1);

        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.ownerCall(address(tok), 0, "");
    }

    function test_agentCannotRewritePolicy() public {
        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setAgent(agentA, _agentPolicy());

        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setDomainPolicy(DOM, _domainPolicy(type(uint128).max));

        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setGlobalPolicy(_globalPolicy());

        vm.prank(agentC);
        vm.expectRevert(AirspacePortfolio.NotOwner.selector);
        pf.setCapitalBase(type(uint128).max);
    }

    function test_replayRefused() public {
        Intent memory i = _intent(mkt1, pool1, 10 * K, 7);
        vm.prank(agentA);
        pf.execute(i);
        _expectRefusal(agentA, i, Refusal.INTENT_REPLAYED);

        // And an older nonce cannot be reused either.
        Intent memory older = _intent(mkt1, pool1, 10 * K, 3);
        _expectRefusal(agentA, older, Refusal.INTENT_REPLAYED);
    }

    function test_unregisteredAndDisabledRefused() public {
        _expectRefusal(attacker, _intent(mkt1, pool1, 10 * K, 1), Refusal.NOT_AGENT);

        vm.prank(owner);
        pf.revokeAgent(agentC);
        _expectRefusal(agentC, _intent(mkt1, pool1, 10 * K, 1), Refusal.AGENT_DISABLED);
    }

    function test_agentCannotSpoofAnother() public {
        Intent memory i = _intent(mkt1, pool1, 10 * K, 1);
        vm.prank(agentC);
        pf.execute(i); // C runs A's exact intent shape
        assertEq(pf.agentCommitted(agentA), 0, "A's budget untouched");
        assertGt(pf.agentCommitted(agentC), 0, "charged to C");
    }

    function test_poolSubstitutionRefused() public {
        Intent memory i = _intent(mkt1, pool1, 10 * K, 1);
        i.pool = address(pool2);
        _expectRefusal(agentC, i, Refusal.POOL_MISMATCH);
    }

    function test_recycledGenerationRefused() public {
        pool1.setFillBps(0);
        _exec(agentA, mkt1, pool1, 10 * K);
        pool1.roll(); // the pool now serves a later market

        Intent memory i = _intent(mkt1, pool1, 10 * K, 1);
        i.marketNonce = pool1.marketNonce();
        _expectRefusal(agentC, i, Refusal.MARKET_GENERATION_MISMATCH);
    }

    function test_priceGriefRefused() public {
        Intent memory i = _intent(mkt1, pool1, 10 * K, 1);
        i.price = 995_000;
        _expectRefusal(agentC, i, Refusal.PRICE_OUTSIDE_POLICY);
    }

    function test_staleMarketRefused() public {
        (,,,,,,,,,,,,, uint64 expiry) = mod.markets(mkt1);
        Intent memory i = _intent(mkt1, pool1, 10 * K, 1);
        vm.warp(uint256(expiry) + 1);
        _expectRefusal(agentC, i, Refusal.MARKET_NOT_TRADING);
    }

    function test_unconfiguredDomainRefused() public {
        (bytes32 other, MockPool p) = _newMarket(99, 900); // a 15m market, unconfigured
        Intent memory i = _intent(other, p, 10 * K, 1);
        _expectRefusal(agentC, i, Refusal.DOMAIN_NOT_CONFIGURED);
    }

    function test_manyTinyReservationsStillHitTheCeiling() public {
        vm.prank(owner);
        pf.setDomainPolicy(DOM, _domainPolicy(50 * K));
        pool1.setFillBps(0);

        uint256 placed;
        for (uint64 n = 1; n <= 20; ++n) {
            Intent memory i = _intent(mkt1, pool1, 5 * K, n);
            vm.prank(agentC);
            try pf.execute(i) returns (uint128) {
                ++placed;
            } catch {
                break;
            }
        }
        assertEq(placed, 10, "10 x 5 exactly fills the ceiling");
        assertEq(pf.domainRiskUsage(DOM), 50 * K);
    }

    function test_agentBudgetIsSeparateFromPortfolioBudget() public {
        AgentPolicy memory tight = _agentPolicy();
        tight.maxCommitted = uint128(1 * ONE);
        vm.prank(owner);
        pf.setAgent(agentC, tight);

        _expectRefusal(agentC, _intent(mkt1, pool1, 100 * K, 1), Refusal.AGENT_COMMITTED_EXCEEDED);
    }

    // =================================================================
    // OWNER RECOVERY
    // =================================================================

    function test_ownerRecoveryIsUnconditional() public {
        pool1.setFillBps(0);
        _exec(agentA, mkt1, pool1, 100 * K);
        _exec(agentB, mkt2, pool2, 100 * K);

        vm.startPrank(owner);
        pf.revokeAgent(agentA);
        pf.revokeAgent(agentB);
        pf.revokeAgent(agentC);
        vm.stopPrank();

        vm.warp(block.timestamp + 4000 days); // policy long expired

        uint256 bal = tok.balanceOf(address(pf));
        assertGt(bal, 0);
        vm.prank(owner);
        pf.withdraw(address(tok), owner, bal);
        assertEq(tok.balanceOf(address(pf)), 0, "recovery ignores risk state entirely");
    }

    function test_recoveryWorksWithDomainSaturated() public {
        _exec(agentA, mkt1, pool1, 500 * K);
        assertEq(pf.domainRiskUsage(DOM), 500 * K);

        uint256 bal = tok.balanceOf(address(pf));
        vm.prank(owner);
        pf.withdraw(address(tok), owner, bal);
        assertEq(tok.balanceOf(address(pf)), 0);
    }
}
