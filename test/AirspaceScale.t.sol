// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../src/airspace/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../src/airspace/AirspacePortfolioFactory.sol";
import {GlobalPolicy, DomainPolicy, AgentPolicy, Intent} from "../src/airspace/IAirspaceV2.sol";
import {MockERC20, MockOutcome6909, MockModule, MockPool, MockMarket} from "./mocks/Mocks.sol";

/// @notice Deterministic scaling benchmark: 100 portfolios, 1,000 agents,
///         10,000 intents, and continuously rolling market generations.
///
/// Mocked DreamDEX surface ON PURPOSE. Correctness is proven against the real
/// deployment in AirspacePortfolio.fork.t.sol; 10,000 forked intents would
/// measure RPC latency, not contract cost. Every mock signature mirrors the real
/// contract. Results are labelled MODELLED where they are not live measurements.
contract AirspaceScaleTest is Test {
    uint256 constant ONE = 1e6;
    uint128 constant K = 1e6;

    MockERC20 tok;
    MockOutcome6909 oc;
    MockModule mod;
    AirspacePortfolioFactory factory;

    address owner = makeAddr("OWNER");
    address creator = makeAddr("CREATOR");

    function setUp() public {
        vm.warp(1_800_000_000); // a clean, cadence-aligned base
        tok = new MockERC20();
        oc = new MockOutcome6909();
        mod = new MockModule();
        factory = new AirspacePortfolioFactory(address(mod), address(oc));
    }

    function _mkMarket(uint256 seed, uint64 cadence, uint64 expiry) internal returns (bytes32 id, address pool) {
        MockPool p = new MockPool(address(tok));
        MockMarket m = new MockMarket(address(p));
        id = keccak256(abi.encode(seed, expiry));
        mod.set(id, address(tok), creator, address(m), address(p), expiry - cadence, expiry);
        pool = address(p);
    }

    function _global() internal view returns (GlobalPolicy memory) {
        return GlobalPolicy({
            maxCommittedCapital: type(uint128).max / 2,
            maxReservedCollateral: type(uint128).max / 2,
            maxSingleOrderNotional: type(uint128).max / 2,
            maxBuyPrice: 1_000_000,
            minSellPrice: 0,
            minHeadroomSec: 0,
            policyExpiry: uint64(block.timestamp + 3650 days)
        });
    }

    function _agent() internal pure returns (AgentPolicy memory) {
        return AgentPolicy({
            enabled: true,
            maxCommitted: type(uint128).max / 2,
            maxOrderNotional: type(uint128).max / 2,
            maxBuyPrice: 1_000_000,
            minSellPrice: 0,
            cooldownSec: 0
        });
    }

    function _intent(bytes32 id, address pool, uint128 qty, uint64 nonce) internal pure returns (Intent memory) {
        return Intent({
            marketId: id,
            pool: pool,
            marketNonce: 1,
            kind: 0,
            price: 10_000,
            quantity: qty,
            expireTimestampNs: 1,
            orderType: 3,
            nonce: nonce,
            strategyVersion: bytes32(0)
        });
    }

    // ==================================================================
    // S1 — 100 portfolios
    // ==================================================================

    function test_S1_hundredPortfolios() public {
        uint256 g0 = gasleft();
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(owner);
            factory.createPortfolio(owner, bytes32(i));
        }
        uint256 used = g0 - gasleft();
        console2.log("100 portfolios, total gas:", used);
        console2.log("per portfolio:", used / 100);
        // Portfolios share no storage: cost is flat, not superlinear.
        assertLt(used / 100, 200_000, "clone deploy stays cheap");
    }

    // ==================================================================
    // S2 — 1,000 agents across 100 portfolios
    // ==================================================================

    function test_S2_thousandAgents() public {
        address[] memory pfs = new address[](100);
        for (uint256 i = 0; i < 100; i++) {
            vm.prank(owner);
            pfs[i] = factory.createPortfolio(owner, bytes32(i));
        }
        uint256 g0 = gasleft();
        for (uint256 i = 0; i < 100; i++) {
            AirspacePortfolio pf = AirspacePortfolio(payable(pfs[i]));
            vm.startPrank(owner);
            for (uint256 j = 0; j < 10; j++) {
                pf.setAgent(address(uint160(0x10000 + i * 10 + j)), _agent());
            }
            vm.stopPrank();
        }
        uint256 used = g0 - gasleft();
        console2.log("1000 agent registrations, total gas:", used);
        console2.log("per agent:", used / 1000);
        assertEq(AirspacePortfolio(payable(pfs[0])).agentCount(), 10);
    }

    // ==================================================================
    // S3 — 10,000 intents
    // ==================================================================

    function test_S3_tenThousandIntents() public {
        vm.prank(owner);
        AirspacePortfolio pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(uint256(1)))));
        tok.mint(address(pf), 1e18);

        uint64 ex = uint64((block.timestamp / 3600 + 1) * 3600); // next 1h boundary
        (bytes32 id, address pool) = _mkMarket(1, 3600, ex);
        bytes32 dom = pf.domainOf(id);

        vm.startPrank(owner);
        pf.syncCapitalBase(address(tok));
        pf.setGlobalPolicy(_global());
        pf.setDomainPolicy(
            dom, DomainPolicy({set: true, maxDomainRiskUsage: type(uint128).max / 2, maxDomainCommitted: 0, maxLiveMarkets: 0})
        );
        for (uint256 j = 0; j < 10; j++) pf.setAgent(address(uint160(0x20000 + j)), _agent());
        vm.stopPrank();

        uint256 g0 = gasleft();
        uint64 n = 1;
        for (uint256 k = 0; k < 10_000; k++) {
            address ag = address(uint160(0x20000 + (k % 10)));
            vm.prank(ag);
            pf.execute(_intent(id, pool, 1 * K, n++));
        }
        uint256 used = g0 - gasleft();
        console2.log("10000 intents, total gas:", used);
        console2.log("per intent:", used / 10_000);
        console2.log("domain markets tracked:", pf.domainMarketCount(dom));

        // ONE market, so the domain collection never grew: per-intent cost is flat.
        assertEq(pf.domainMarketCount(dom), 1, "collection did not grow with intent count");
        assertEq(pf.domainRiskUsage(dom), 10_000 * K);
    }

    // ==================================================================
    // S4 — rolling generations: does any collection grow without bound?
    // ==================================================================

    function test_S4_rollingGenerationsStayBounded() public {
        vm.prank(owner);
        AirspacePortfolio pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(uint256(2)))));
        tok.mint(address(pf), 1e18);

        uint64 base = uint64((block.timestamp / 60 + 1) * 60);
        (bytes32 id0,) = _mkMarket(0, 60, base);
        bytes32 dom = pf.domainOf(id0);

        vm.startPrank(owner);
        pf.syncCapitalBase(address(tok));
        pf.setGlobalPolicy(_global());
        pf.setDomainPolicy(
            dom, DomainPolicy({set: true, maxDomainRiskUsage: type(uint128).max / 2, maxDomainCommitted: 0, maxLiveMarkets: 0})
        );
        pf.setAgent(address(uint160(0x30001)), _agent());
        vm.stopPrank();

        // 500 consecutive 60-second generations, the venue's fastest cadence.
        uint256 maxSeen;
        uint64 n = 1;
        for (uint256 gen = 1; gen <= 500; gen++) {
            uint64 expiry = base + uint64(gen * 60);
            vm.warp(expiry - 30); // inside this generation's window
            (bytes32 id, address pool) = _mkMarket(gen, 60, expiry);
            assertEq(pf.domainOf(id), dom, "every new generation lands in the SAME domain, with no config");

            vm.prank(address(uint160(0x30001)));
            uint128 oid = pf.execute(_intent(id, pool, 1 * K, n++));

            uint256 cLive = pf.domainMarketCount(dom);
            if (cLive > maxSeen) maxSeen = cLive;

            // Lifecycle: cancel, release, prune -- all permissionless.
            vm.prank(owner);
            pf.cancelOrder(pool, oid);
            pf.releaseOrder(pf.orderKey(pool, 1, oid));
            pf.pruneMarket(id);
        }

        console2.log("generations processed:", uint256(500));
        console2.log("peak domain collection size:", maxSeen);
        console2.log("final domain collection size:", pf.domainMarketCount(dom));
        assertEq(maxSeen, 1, "collection never exceeded one live market at any point");
        assertEq(pf.domainMarketCount(dom), 0, "fully drained");
        assertEq(pf.domainRiskUsage(dom), 0);
    }

    /// @notice Without pruning the collection is capped, not unbounded: the cap
    ///         is what bounds worst-case gas, and hitting it fails closed.
    function test_S5_collectionIsCappedNotUnbounded() public {
        vm.prank(owner);
        AirspacePortfolio pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(uint256(3)))));
        tok.mint(address(pf), 1e18);

        uint64 base5 = uint64((block.timestamp / 60 + 1) * 60);
        (bytes32 id0,) = _mkMarket(0, 60, base5);
        bytes32 dom = pf.domainOf(id0);

        vm.startPrank(owner);
        pf.syncCapitalBase(address(tok));
        pf.setGlobalPolicy(_global());
        pf.setDomainPolicy(
            dom, DomainPolicy({set: true, maxDomainRiskUsage: type(uint128).max / 2, maxDomainCommitted: 0, maxLiveMarkets: 0})
        );
        pf.setAgent(address(uint160(0x40001)), _agent());
        vm.stopPrank();

        uint32 cap = pf.MAX_MARKETS_PER_DOMAIN();
        uint64 n = 1;
        uint256 admitted;
        for (uint256 gen = 1; gen <= cap + 5; gen++) {
            uint64 ex5 = base5 + uint64(gen * 60);
            vm.warp(ex5 - 30);
            (bytes32 id, address pool) = _mkMarket(gen, 60, ex5);
            vm.prank(address(uint160(0x40001)));
            try pf.execute(_intent(id, pool, 1 * K, n++)) returns (uint128) {
                admitted++;
            } catch {
                break;
            }
        }
        assertEq(admitted, cap, "capped at MAX_MARKETS_PER_DOMAIN, fails closed");
        console2.log("cap:", uint256(cap)); console2.log("admitted:", admitted);

        // Gas of the worst-case full-domain read.
        uint256 g0 = gasleft();
        uint128 usage = pf.domainRiskUsage(dom);
        uint256 used = g0 - gasleft();
        console2.log("domainRiskUsage over a FULL domain, gas:", used);
        console2.log("usage:", usage);
    }
}
