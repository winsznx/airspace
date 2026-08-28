// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../src/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../src/AirspacePortfolioFactory.sol";
import {GlobalPolicy, DomainPolicy, AgentPolicy, Intent, Refusal, AdmissionView, Gate} from
    "../src/interfaces/IAirspace.sol";
import {MockERC20, MockOutcome6909, MockModule, MockPool, MockMarket} from "./mocks/MockDreamDex.sol";

/// @notice Shared fixture: a funded portfolio, three independent agents and a
///         configured structural domain, all against the mock DreamDEX surface.
abstract contract AirspaceBase is Test {
    uint128 internal constant K = 1e6; // one contract in raw units
    uint256 internal constant ONE = 1e6; // one collateral unit

    MockERC20 internal tok;
    MockOutcome6909 internal oc;
    MockModule internal mod;
    AirspacePortfolioFactory internal factory;
    AirspacePortfolio internal pf;

    address internal owner = makeAddr("OWNER");
    address internal agentA = makeAddr("AGENT_A");
    address internal agentB = makeAddr("AGENT_B");
    address internal agentC = makeAddr("AGENT_C");
    address internal attacker = makeAddr("ATTACKER");
    address internal creator = makeAddr("CREATOR");

    bytes32 internal DOM;
    bytes32 internal mkt1;
    bytes32 internal mkt2;
    MockPool internal pool1;
    MockPool internal pool2;

    uint64 internal constant CADENCE = 3600;

    function _setUpAirspace(uint128 domainCeiling) internal {
        vm.warp(1_800_000_000);
        tok = new MockERC20();
        oc = new MockOutcome6909();
        mod = new MockModule();
        factory = new AirspacePortfolioFactory(address(new AirspacePortfolio()), address(mod), address(oc), address(tok));

        vm.prank(owner);
        pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(0))));

        (mkt1, pool1) = _newMarket(1, CADENCE);
        (mkt2, pool2) = _newMarket(2, CADENCE);
        DOM = pf.domainOf(mkt1);

        tok.mint(owner, 1_000_000 * ONE);
        vm.startPrank(owner);
        tok.approve(address(pf), type(uint256).max);
        pf.fund(100_000 * ONE);
        pf.setGlobalPolicy(_globalPolicy());
        pf.setDomainPolicy(DOM, _domainPolicy(domainCeiling));
        pf.setAgent(agentA, _agentPolicy());
        pf.setAgent(agentB, _agentPolicy());
        pf.setAgent(agentC, _agentPolicy());
        vm.stopPrank();
    }

    function _newMarket(uint256 seed, uint64 cadence) internal returns (bytes32 id, MockPool p) {
        uint64 expiry = uint64((block.timestamp / cadence + 1) * cadence);
        MockMarket m = new MockMarket();
        p = new MockPool(address(tok), address(oc), address(m));
        id = keccak256(abi.encode("market", seed, expiry));
        mod.set(id, address(tok), creator, address(m), address(p), expiry - cadence, expiry);
    }

    function _globalPolicy() internal view returns (GlobalPolicy memory) {
        return GlobalPolicy({
            maxCommittedCapital: uint128(90_000 * ONE),
            maxReservedCollateral: uint128(90_000 * ONE),
            maxSingleOrderNotional: uint128(50_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            minHeadroomSec: 30,
            policyExpiry: uint64(block.timestamp + 3650 days)
        });
    }

    function _domainPolicy(uint128 ceiling) internal pure returns (DomainPolicy memory) {
        return DomainPolicy({
            configured: true,
            maxDomainRiskUsage: ceiling,
            maxDomainCommitted: 0,
            maxLiveMarkets: 0
        });
    }

    /// @dev Deliberately generous: every agent's OWN policy admits every order in
    ///      these tests, so a refusal can only come from the portfolio.
    function _agentPolicy() internal pure returns (AgentPolicy memory) {
        return AgentPolicy({
            enabled: true,
            maxCommitted: uint128(80_000 * ONE),
            maxOrderNotional: uint128(50_000 * ONE),
            maxBuyPrice: 990_000,
            minSellPrice: 10_000,
            cooldownSec: 0,
            strategyId: bytes32("test")
        });
    }

    uint64 internal _nonceA = 1;
    uint64 internal _nonceB = 1;
    uint64 internal _nonceC = 1;

    function _nextNonce(address who) internal returns (uint64) {
        if (who == agentA) return _nonceA++;
        if (who == agentB) return _nonceB++;
        if (who == agentC) return _nonceC++;
        return 1;
    }

    function _intent(bytes32 marketId, MockPool p, uint128 contracts, uint64 nonce)
        internal
        view
        returns (Intent memory)
    {
        return Intent({
            marketId: marketId,
            pool: address(p),
            marketNonce: p.marketNonce(),
            kind: 0, // BUY_YES
            price: 100_000, // 0.10, on the 1000 tick grid
            quantity: contracts,
            expireTimestampNs: 1,
            orderType: 3, // POST_ONLY
            nonce: nonce,
            strategyVersion: bytes32("v1")
        });
    }

    function _exec(address who, bytes32 marketId, MockPool p, uint128 contracts) internal returns (uint128) {
        Intent memory i = _intent(marketId, p, contracts, _nextNonce(who));
        vm.prank(who);
        return pf.execute(i);
    }

    function _expectRefusal(address who, Intent memory i, Refusal code) internal {
        vm.prank(who);
        vm.expectRevert(abi.encodeWithSelector(AirspacePortfolio.Refused.selector, code));
        pf.execute(i);
    }
}
