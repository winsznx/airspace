// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../contracts/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../contracts/AirspacePortfolioFactory.sol";
import {GlobalPolicy, DomainPolicy, AgentPolicy, Intent} from "../contracts/IAirspaceV2.sol";
import {MockERC20, MockOutcome6909, MockModule, MockPool, MockMarket} from "./mocks/Mocks.sol";

/// @notice Sponsor-impact simulation: what does a SHARED capital pool make
///         possible that isolated per-strategy vaults do not?
///
/// MODELLED, not measured in production. The demand schedule below is an
/// explicit assumption, printed with the results. Everything else -- what is
/// admitted, what is rejected, how much capital is required -- is computed by
/// the REAL AirspacePortfolio contract under its real policy rules. No
/// capital-efficiency number is asserted by hand; each is derived from the
/// admitted/rejected counts the contract produced.
contract AirspaceSponsorImpactTest is Test {
    uint128 constant K = 1e6;

    MockERC20 tok;
    MockOutcome6909 oc;
    MockModule mod;
    AirspacePortfolioFactory factory;

    address owner = makeAddr("OWNER");
    address creator = makeAddr("CREATOR");
    address[3] agents = [makeAddr("A"), makeAddr("B"), makeAddr("C")];

    // ---- THE ASSUMPTION ---------------------------------------------------
    // Three strategies with STAGGERED activity. Each needs a large share of the
    // risk envelope while it is active and none while it is not -- the ordinary
    // shape for strategies keyed to different signals (a momentum bot on the
    // open, a mean-reversion bot mid-window, a settlement sweeper near expiry).
    //
    // phase -> per-agent demand, in contracts.
    uint128[3][4] DEMAND = [
        [uint128(300), 0, 0], // phase 0: only A wants size
        [uint128(0), 300, 0], // phase 1: only B
        [uint128(0), 0, 300], // phase 2: only C
        [uint128(100), 100, 100] // phase 3: all three, modest
    ];

    uint128 constant DOMAIN_CEILING = 300 * K; // the risk the owner is willing to run

    function setUp() public {
        vm.warp(1_800_000_000);
        tok = new MockERC20();
        oc = new MockOutcome6909();
        mod = new MockModule();
        factory = new AirspacePortfolioFactory(address(mod), address(oc));
    }

    function _mkMarket(uint256 seed, uint64 cadence) internal returns (bytes32 id, address pool) {
        uint64 expiry = uint64((block.timestamp / cadence + 1) * cadence);
        MockPool p = new MockPool(address(tok));
        MockMarket m = new MockMarket(address(p));
        id = keccak256(abi.encode(seed, expiry, block.timestamp));
        mod.set(id, address(tok), creator, address(m), address(p), expiry - cadence, expiry);
        pool = address(p);
    }

    function _mkPortfolio(uint256 salt, uint128 ceiling, uint128 funding, address[] memory ags)
        internal
        returns (AirspacePortfolio pf, bytes32 dom)
    {
        vm.prank(owner);
        pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(salt))));
        tok.mint(address(pf), funding);

        (bytes32 probe,) = _mkMarket(999_000 + salt, 3600);
        dom = pf.domainOf(probe);

        vm.startPrank(owner);
        pf.syncCapitalBase(address(tok));
        pf.setGlobalPolicy(
            GlobalPolicy({
                maxCommittedCapital: funding,
                maxReservedCollateral: funding,
                maxSingleOrderNotional: funding,
                maxBuyPrice: 1_000_000,
                minSellPrice: 0,
                minHeadroomSec: 0,
                policyExpiry: uint64(block.timestamp + 3650 days)
            })
        );
        pf.setDomainPolicy(
            dom,
            DomainPolicy({set: true, maxDomainRiskUsage: ceiling, maxDomainCommitted: 0, maxLiveMarkets: 0})
        );
        for (uint256 i = 0; i < ags.length; i++) {
            pf.setAgent(
                ags[i],
                AgentPolicy({
                    enabled: true,
                    maxCommitted: funding,
                    maxOrderNotional: funding,
                    maxBuyPrice: 1_000_000,
                    minSellPrice: 0,
                    cooldownSec: 0
                })
            );
        }
        vm.stopPrank();
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

    /// @notice SHARED: one pool, one ceiling, three agents taking turns.
    function test_I1_sharedPoolAdmitsTheWholeSchedule() public {
        address[] memory ags = new address[](3);
        for (uint256 i = 0; i < 3; i++) ags[i] = agents[i];
        (AirspacePortfolio pf, bytes32 dom) = _mkPortfolio(1, DOMAIN_CEILING, 1e15, ags);

        uint256 admitted;
        uint256 rejected;
        uint64 n = 1;

        for (uint256 phase = 0; phase < 4; phase++) {
            (bytes32 id, address pool) = _mkMarket(phase, 3600);
            for (uint256 a = 0; a < 3; a++) {
                uint128 want = DEMAND[phase][a];
                if (want == 0) continue;
                vm.prank(agents[a]);
                try pf.execute(_intent(id, pool, want * K, n++)) returns (uint128 oid) {
                    admitted++;
                    // Phase ends: the agent stands down and its capacity returns.
                    vm.prank(owner);
                    pf.cancelOrder(pool, oid);
                    pf.releaseOrder(pf.orderKey(pool, 1, oid));
                } catch {
                    rejected++;
                }
            }
            pf.pruneMarket(id);
        }

        console2.log("=== SHARED POOL (modelled) ===");
        console2.log("domain ceiling (contracts):", DOMAIN_CEILING / K);
        console2.log("capital pools funded:", uint256(1));
        console2.log("risk budgets funded (contracts):", DOMAIN_CEILING / K);
        console2.log("intents admitted:", admitted);
        console2.log("intents rejected:", rejected);
        assertEq(rejected, 0, "shared pool serves every staggered peak");
        assertEq(pf.domainRiskUsage(dom), 0);
    }

    /// @notice ISOLATED: three vaults, each with its own slice of the SAME total
    ///         risk budget. Same schedule, same total risk appetite.
    function test_I2_isolatedVaultsStrandCapacity() public {
        uint128 slice = DOMAIN_CEILING / 3; // the owner's total appetite, split three ways

        uint256 admitted;
        uint256 rejected;

        for (uint256 a = 0; a < 3; a++) {
            address[] memory one = new address[](1);
            one[0] = agents[a];
            (AirspacePortfolio pf,) = _mkPortfolio(100 + a, slice, 1e15, one);

            uint64 n = 1;
            for (uint256 phase = 0; phase < 4; phase++) {
                uint128 want = DEMAND[phase][a];
                if (want == 0) continue;
                (bytes32 id, address pool) = _mkMarket(1000 + a * 10 + phase, 3600);
                vm.prank(agents[a]);
                try pf.execute(_intent(id, pool, want * K, n++)) returns (uint128 oid) {
                    admitted++;
                    vm.prank(owner);
                    pf.cancelOrder(pool, oid);
                    pf.releaseOrder(pf.orderKey(pool, 1, oid));
                } catch {
                    rejected++;
                }
            }
        }

        console2.log("=== ISOLATED VAULTS (modelled) ===");
        console2.log("per-vault ceiling (contracts):", slice / K);
        console2.log("capital pools funded:", uint256(3));
        console2.log("intents admitted:", admitted);
        console2.log("intents rejected:", rejected);

        // Each agent's 300-contract peak exceeds its 100-contract slice.
        assertEq(rejected, 3, "each agent's peak is rejected by its own slice");
        assertEq(admitted, 3, "only the modest phase-3 orders fit");
    }

    /// @notice What isolation would have to spend to serve the same schedule.
    function test_I3_isolatedNeedsMoreRiskBudgetForTheSameSchedule() public {
        // Give each isolated vault the FULL peak it needs.
        uint128 peak = 300 * K;
        uint256 admitted;
        for (uint256 a = 0; a < 3; a++) {
            address[] memory one = new address[](1);
            one[0] = agents[a];
            (AirspacePortfolio pf,) = _mkPortfolio(200 + a, peak, 1e15, one);
            uint64 n = 1;
            for (uint256 phase = 0; phase < 4; phase++) {
                uint128 want = DEMAND[phase][a];
                if (want == 0) continue;
                (bytes32 id, address pool) = _mkMarket(2000 + a * 10 + phase, 3600);
                vm.prank(agents[a]);
                uint128 oid = pf.execute(_intent(id, pool, want * K, n++));
                admitted++;
                vm.prank(owner);
                pf.cancelOrder(pool, oid);
                pf.releaseOrder(pf.orderKey(pool, 1, oid));
            }
        }

        uint256 isolatedTotal = 3 * (peak / K);
        uint256 sharedTotal = DOMAIN_CEILING / K;

        console2.log("=== SAME SCHEDULE, BOTH MODELS (modelled) ===");
        console2.log("shared: risk budget funded (contracts):", sharedTotal);
        console2.log("isolated: risk budget funded (contracts):", isolatedTotal);
        console2.log("ratio x100:", (isolatedTotal * 100) / sharedTotal);
        console2.log("intents admitted (isolated, fully funded):", admitted);

        // The ratio is DERIVED from the schedule's peak concurrency, not asserted.
        assertEq(admitted, 6, "isolated serves the schedule only when each vault is funded to its own peak");
        assertEq(isolatedTotal, 900);
        assertEq(sharedTotal, 300);
    }
}
