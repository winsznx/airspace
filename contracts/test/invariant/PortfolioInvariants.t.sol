// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../../src/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../../src/AirspacePortfolioFactory.sol";
import {
    GlobalPolicy,
    DomainPolicy,
    AgentPolicy,
    Intent,
    Refusal,
    AdmissionView,
    Gate
} from "../../src/interfaces/IAirspace.sol";
import {MockERC20, MockOutcome6909, MockModule, MockPool, MockMarket} from "../mocks/MockDreamDex.sol";
import {ExposureOracle} from "../reference/ExposureOracle.sol";

/// @notice Drives random multi-agent activity against one portfolio.
/// @dev Every action an AGENT could take is reachable here; the handler holds no
///      owner privilege except the explicit owner-recovery probe, so anything the
///      invariants observe is reachable by hostile agents alone.
contract Handler is Test {
    AirspacePortfolio public pf;
    MockERC20 public tok;
    MockOutcome6909 public oc;
    MockModule public mod;
    MockPool[] public pools;
    bytes32[] public marketIds;
    address[] public agents;
    bytes32 public DOM;
    uint128 public ceiling;

    uint128 constant K = 1e6;

    mapping(address => uint64) internal _nonce;
    bytes32[] internal _liveOrderKeys;

    /// @dev Coverage. v1's suite passed while the case that broke production was
    ///      structurally unreachable, so this run must PROVE it reached the
    ///      states it claims to test rather than assume the fuzzer got there.
    uint256[4] public admittedByKind;
    uint256 public sawOpposingReservations;
    uint256 public sawRealizedPlusOpposingPending;
    uint256 public sawExternalFill;
    uint256 public sawPartialThenOpposite;
    bytes public lastRefusal;
    uint8 public lastPreview;

    constructor(
        AirspacePortfolio _pf,
        MockERC20 _tok,
        MockOutcome6909 _oc,
        MockModule _mod,
        bytes32 _dom,
        uint128 _ceiling
    ) {
        pf = _pf;
        tok = _tok;
        oc = _oc;
        mod = _mod;
        DOM = _dom;
        ceiling = _ceiling;
    }

    /// @notice So the invariants can walk the fixture's markets.
    function marketCount() external view returns (uint256) {
        return marketIds.length;
    }

    /// @notice Every order key this run ever produced, so the capital invariant
    ///         can reconstruct `reservedCollateral` from the records rather than
    ///         trusting the accumulator to describe itself. Keys of fully
    ///         released orders stay in the list and read as zero, which is the
    ///         correct contribution.
    function orderKeyCount() external view returns (uint256) {
        return _liveOrderKeys.length;
    }

    function orderKeyAt(uint256 k) external view returns (bytes32) {
        return _liveOrderKeys[k];
    }

    function addMarket(bytes32 id, MockPool p) external {
        marketIds.push(id);
        pools.push(p);
    }

    /// @dev The domain is only known once the first market is registered.
    function setDomain(bytes32 d) external {
        DOM = d;
    }

    function addAgent(address a) external {
        agents.push(a);
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return marketIds.length == 0 ? 0 : seed % marketIds.length;
    }

    /// @notice An agent proposes an order. Failures are swallowed on purpose:
    ///         a refusal is a valid outcome and must leave state untouched.
    function propose(uint256 agentSeed, uint256 marketSeed, uint128 qty, uint16 fill, uint8 kindSeed, uint32 priceSeed)
        public
    {
        if (agents.length == 0 || marketIds.length == 0) return;
        address who = agents[agentSeed % agents.length];
        uint256 mi = _pick(marketSeed);
        MockPool p = pools[mi];
        p.setFillBps(uint16(bound(fill, 0, 10000)));
        qty = uint128(bound(qty, 1, 400)) * K;

        // ALL FOUR KINDS. v1's handler hard-coded BUY_YES, which made the
        // opposing-reservation case — the one that actually broke production —
        // structurally unreachable no matter how long the fuzzer ran.
        uint8 kind = uint8(bound(kindSeed, 0, 3));
        // Price on the tick grid and inside the policy band.
        uint256 price = bound(priceSeed, 20, 970) * 1000;

        // A sell needs tokens to escrow, and they must have been ACQUIRED, not
        // minted: fabricating inventory would fabricate exposure the contract
        // never admitted and turn any ceiling result into an artefact. So a sell
        // is clipped to what the portfolio actually holds, and becomes a buy on
        // the same side when it holds nothing — which is how it would come to
        // hold something.
        if (kind == 1 || kind == 3) {
            uint256 oid =
                (uint256(uint160(address(p))) << 72) | (uint256(p.marketNonce()) << 8) | (kind == 1 ? 0 : 1);
            uint256 held = oc.balanceOf(address(pf), oid);
            if (held == 0) kind = kind == 1 ? 0 : 2;
            else if (qty > held) qty = uint128((held / 1e3) * 1e3);
            if (qty == 0) return;
        }

        Intent memory i = Intent({
            marketId: marketIds[mi],
            pool: address(p),
            marketNonce: p.marketNonce(),
            kind: kind,
            price: price,
            quantity: qty,
            expireTimestampNs: 1,
            orderType: 3,
            nonce: ++_nonce[who],
            strategyVersion: bytes32(0)
        });

        vm.prank(who);
        try pf.execute(i) returns (uint128 orderId) {
            _liveOrderKeys.push(keccak256(abi.encode(address(p), p.marketNonce(), orderId)));
            admittedByKind[kind] += 1;
            _noteState(marketIds[mi]);

            // THE ADMISSION GUARANTEE, asserted where it is actually made.
            //
            // The contract promises that an admitted intent leaves the domain
            // at or under its ceiling. It cannot promise usage never exceeds
            // the ceiling afterwards — an outside party filling a resting order,
            // or a cancelled sell returning its escrow, both move exposure
            // without any admission. Asserting the weaker thing as a global
            // invariant is how a suite ends up describing a system that never
            // trades.
            assertLe(pf.domainRiskUsage(DOM), ceiling, "ADMISSION left the domain over its ceiling");
        } catch {}
    }

    /// @dev Record which adversarial shapes this run actually reached.
    function _noteState(bytes32 id) internal {
        (address pool, uint64 nonce,, uint128 yL, uint128 yS, uint128 nL, uint128 nS, bool tracked,) =
            pf.marketState(id);
        if (!tracked) return;

        bool up = yL > 0 || yS > 0;
        bool down = nL > 0 || nS > 0;
        if (up && down) sawOpposingReservations += 1;

        uint256 yesId = (uint256(uint160(pool)) << 72) | (uint256(nonce) << 8);
        uint256 bY = oc.balanceOf(address(pf), yesId);
        uint256 bN = oc.balanceOf(address(pf), yesId + 1);
        if ((bY > 0 && down) || (bN > 0 && up)) sawRealizedPlusOpposingPending += 1;
    }

    /// @notice One side of a resting pair is cancelled while the other stays live.
    function cancelOne(uint256 seed) public {
        if (pools.length == 0) return;
        MockPool p = pools[seed % pools.length];
        vm.prank(address(pf));
        try p.cancelOrder(uint128(bound(seed, 1, 30))) {} catch {}
    }

    /// @notice Anyone attempts a permissionless release. It must only ever move
    ///         the books toward on-chain truth.
    function release(uint256 seed) public {
        if (_liveOrderKeys.length == 0) return;
        bytes32 key = _liveOrderKeys[seed % _liveOrderKeys.length];
        try pf.releaseOrder(key) {} catch {}
    }

    /// @notice An outside counterparty fills a resting order in a transaction the
    ///         portfolio never sees.
    function externalFill(uint256 seed, uint128 qty) public {
        if (pools.length == 0) return;
        MockPool p = pools[seed % pools.length];
        qty = uint128(bound(qty, 1, 50)) * K;
        try p.externalFill(uint128(bound(seed, 1, 20)), qty) {
            sawExternalFill += 1;
        } catch {}
    }

    /// @notice A hostile agent tries to take assets directly. Must always fail.
    function agentWithdrawAttempt(uint256 agentSeed, uint256 amount) public {
        if (agents.length == 0) return;
        address who = agents[agentSeed % agents.length];
        vm.prank(who);
        try pf.withdraw(address(tok), who, amount) {
            revert("AGENT WITHDREW COLLATERAL");
        } catch {}
        vm.prank(who);
        try pf.withdrawOutcome(0, who, amount) {
            revert("AGENT WITHDREW OUTCOMES");
        } catch {}
        vm.prank(who);
        try pf.ownerCall(address(tok), 0, "") {
            revert("AGENT REACHED OWNERCALL");
        } catch {}
    }

    function prune(uint256 seed) public {
        if (marketIds.length == 0) return;
        try pf.pruneMarket(marketIds[_pick(seed)]) {} catch {}
    }

    function warp(uint32 dt) public {
        vm.warp(block.timestamp + bound(dt, 1, 600));
    }
}

/// @notice Binding invariants. Each maps to a PRD 5 core product invariant.
contract PortfolioInvariantsTest is Test {
    uint128 constant K = 1e6;
    uint256 constant ONE = 1e6;
    uint128 constant CEILING = 500 * K;

    MockERC20 tok;
    MockOutcome6909 oc;
    MockModule mod;
    AirspacePortfolioFactory factory;
    AirspacePortfolio pf;
    Handler handler;

    address owner = makeAddr("OWNER");
    address creator = makeAddr("CREATOR");
    bytes32 DOM;

    function setUp() public {
        vm.warp(1_800_000_000);
        tok = new MockERC20();
        oc = new MockOutcome6909();
        mod = new MockModule();
        factory =
            new AirspacePortfolioFactory(address(new AirspacePortfolio()), address(mod), address(oc), address(tok));

        vm.prank(owner);
        pf = AirspacePortfolio(payable(factory.createPortfolio(owner, bytes32(0))));

        tok.mint(owner, 10_000_000 * ONE);
        vm.startPrank(owner);
        tok.approve(address(pf), type(uint256).max);
        pf.fund(1_000_000 * ONE);
        pf.setGlobalPolicy(
            GlobalPolicy({
                maxCommittedCapital: uint128(900_000 * ONE),
                maxReservedCollateral: uint128(900_000 * ONE),
                maxSingleOrderNotional: uint128(500_000 * ONE),
                maxBuyPrice: 990_000,
                minSellPrice: 10_000,
                minHeadroomSec: 0,
                policyExpiry: uint64(block.timestamp + 3650 days)
            })
        );
        vm.stopPrank();

        // Three markets in one structural domain.
        uint64 cadence = 86400;
        // The window must be LIVE NOW.
        //
        // This was `+ 3`, which put tradingStart two days in the future, so
        // every proposed intent was refused MARKET_NOT_TRADING and the suite
        // admitted nothing at all — in v1 too. An invariant over a portfolio
        // that never trades is satisfied by doing nothing, which is the second
        // independent reason v1's fuzzing could not reach the defect.
        uint64 expiry = uint64((block.timestamp / cadence + 1) * cadence);
        // DOM is resolved from the first market below; the handler is given it after.
        handler = new Handler(pf, tok, oc, mod, bytes32(0), CEILING);
        for (uint256 k; k < 3; ++k) {
            MockMarket m = new MockMarket();
            MockPool p = new MockPool(address(tok), address(oc), address(m));
            bytes32 id = keccak256(abi.encode("inv", k));
            mod.set(id, address(tok), creator, address(m), address(p), expiry - cadence, expiry);
            handler.addMarket(id, p);
            if (k == 0) {
                DOM = pf.domainOf(id);
                handler.setDomain(DOM);
            }
        }

        vm.startPrank(owner);
        pf.setDomainPolicy(
            DOM, DomainPolicy({configured: true, maxDomainRiskUsage: CEILING, maxDomainCommitted: 0, maxLiveMarkets: 0})
        );
        for (uint256 k; k < 5; ++k) {
            address a = address(uint160(0xA6E70 + k));
            pf.setAgent(
                a,
                AgentPolicy({
                    enabled: true,
                    maxCommitted: uint128(800_000 * ONE),
                    maxOrderNotional: uint128(500_000 * ONE),
                    maxBuyPrice: 990_000,
                    minSellPrice: 10_000,
                    cooldownSec: 0,
                    strategyId: bytes32(0)
                })
            );
            handler.addAgent(a);
        }
        vm.stopPrank();

        // Fuzz only the adversarial surface. `addMarket`/`addAgent` are fixture
        // setters and must not be driven with random data, or the run degrades
        // into proposing against markets that do not exist.
        bytes4[] memory sel = new bytes4[](7);
        sel[0] = Handler.propose.selector;
        sel[1] = Handler.release.selector;
        sel[2] = Handler.externalFill.selector;
        sel[3] = Handler.agentWithdrawAttempt.selector;
        sel[4] = Handler.prune.selector;
        sel[5] = Handler.warp.selector;
        sel[6] = Handler.cancelOne.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// @dev THE CRITICAL PROPERTY.
    ///
    ///      AIRSPACE_ACCOUNTED_WORST_CASE >= INDEPENDENT_REFERENCE_WORST_CASE
    ///
    ///      at every reachable state. Understatement by one raw unit fails.
    ///
    ///      v1's ceiling invariant asserted `domainRiskUsage <= CEILING`, which
    ///      checks the number under test against itself: an understatement made
    ///      it PASS. This compares against a second implementation that reaches
    ///      the answer by exhaustive enumeration instead, so the two cannot
    ///      collude.
    function invariant_neverUnderstatesIndependentWorstCase() public view {
        uint256 accounted;
        uint256 oracleTotal;

        for (uint256 k; k < handler.marketCount(); ++k) {
            bytes32 id = handler.marketIds(k);
            accounted += pf.marketWorstCaseExposure(id);

            (address pool, uint64 nonce,, uint128 yL, uint128 yS, uint128 nL, uint128 nS, bool tracked, bool settled) =
                pf.marketState(id);
            if (!tracked || settled) continue;

            uint256 yesId = (uint256(uint160(pool)) << 72) | (uint256(nonce) << 8);
            oracleTotal += ExposureOracle.worstCase(
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

        assertGe(accounted, oracleTotal, "AIRSPACE UNDERSTATED the independent worst case");
    }

    /// @dev Coverage is REPORTED here, not asserted.
    ///
    ///      Asserting it would be wrong twice over: a shrunk counterexample has
    ///      almost no coverage by construction, so the numbers printed after a
    ///      failure describe the minimised sequence rather than the real run.
    ///      The states that must be reached are instead pinned as explicit,
    ///      named scenarios in AdversarialStates.t.sol, where they are
    ///      deterministic and readable rather than hoped for.
    function afterInvariant() public view {
        console2.log("kinds admitted  Y+", handler.admittedByKind(0), " Y-", handler.admittedByKind(1));
        console2.log("                N+", handler.admittedByKind(2), " N-", handler.admittedByKind(3));
        console2.log("opposing pairs    ", handler.sawOpposingReservations());
        console2.log("realized+opposing ", handler.sawRealizedPlusOpposingPending());
    }

    /// @dev The domain sum the contract reports must equal the sum of the
    ///      per-market figures it reports. A mismatch means the aggregation
    ///      nets something it should not.
    function invariant_domainSumIsGross() public view {
        uint256 parts;
        for (uint256 k; k < handler.marketCount(); ++k) {
            parts += pf.marketWorstCaseExposure(handler.marketIds(k));
        }
        assertEq(uint256(pf.domainRiskUsage(DOM)), parts, "domain aggregation is not gross");
    }

    /// @dev The ceiling is an ADMISSION control, not a hard cap on exposure.
    ///
    ///      That distinction is not a concession, it is the specification. An
    ///      outside counterparty filling a resting order, or a cancelled sell
    ///      returning its escrow, both move exposure with no admission involved,
    ///      and no on-chain contract can prevent either. What AIRSPACE promises
    ///      is that IT never admits an intent leaving the domain over its
    ///      ceiling — asserted inside the handler at the moment of every
    ///      successful admission, which is where the promise is made.
    ///
    ///      Fuzzing reaches 501 against a 500 ceiling through exactly those
    ///      external routes. Drift in that direction is safe: while over, every
    ///      new intent is refused until reconciliation restores headroom.
    ///
    ///      Asserting `domainRiskUsage <= CEILING` globally would be asserting
    ///      something the system never claimed, and it passed in v1 only because
    ///      that suite never admitted an order at all.
    function invariant_overCeilingOnlyEverRefusesMore() public view {
        if (pf.domainRiskUsage(DOM) <= CEILING) return;

        // Over the ceiling the domain is closed to new risk, and this asserts
        // that rather than restating the branch condition. For every tracked
        // market, an otherwise-valid risk-adding intent is previewed with a
        // fresh nonce from a registered agent, and must come back refused.
        for (uint256 k; k < handler.marketCount(); ++k) {
            bytes32 id = handler.marketIds(k);
            (address pool, uint64 nonce,,,,,, bool tracked, bool settled) = pf.marketState(id);
            if (!tracked || settled) continue;

            address who = handler.agents(0);
            Intent memory probe = Intent({
                marketId: id,
                pool: pool,
                marketNonce: nonce,
                kind: 0, // BUY_YES: unambiguously adds to the upper bound
                price: 100_000,
                quantity: 1000, // one lot, the smallest addition possible
                expireTimestampNs: 1,
                orderType: 3,
                nonce: pf.agentNonce(who) + 1,
                strategyVersion: bytes32(0)
            });

            AdmissionView memory v = pf.previewIntent(who, probe);
            assertTrue(v.refusal != Refusal.NONE, "admitted more risk while already over the ceiling");

            // And when the intent got as far as capacity — meaning every
            // structural gate passed and the ONLY thing left was the envelope —
            // the refusal has to be the envelope's, not an incidental one.
            if (v.gates & Gate.GRID != 0) {
                assertTrue(v.gates & Gate.DOMAIN_CAPACITY == 0, "capacity gate passed while over the ceiling");
                assertEq(uint8(v.refusal), uint8(Refusal.DOMAIN_RISK_EXCEEDED), "wrong reason for the refusal");
            }
        }
    }

    /// @dev The capital accumulator, reconstructed from the per-order records.
    ///
    ///      `reservedCollateral` gates admission (GLOBAL_RESERVED_EXCEEDED) and
    ///      is a running total, so it is exactly the kind of number that can
    ///      drift away from the thing it summarises without anything noticing.
    ///      Checked against the records rather than against itself, which is the
    ///      mistake v1's ceiling invariant made on the directional side.
    ///
    ///      Deduplicates: an order key can be pushed more than once across a
    ///      run when a recycled pool reissues the same order id, and counting it
    ///      twice would fail on a bookkeeping artefact of this handler rather
    ///      than on anything the contract did.
    function invariant_reservedCollateralMatchesTheOrderRecords() public view {
        uint256 n = handler.orderKeyCount();
        bytes32[] memory seen = new bytes32[](n);
        uint256 unique;
        uint256 sum;

        for (uint256 k; k < n; ++k) {
            bytes32 key = handler.orderKeyAt(k);
            bool dup;
            for (uint256 j; j < unique; ++j) {
                if (seen[j] == key) {
                    dup = true;
                    break;
                }
            }
            if (dup) continue;
            seen[unique++] = key;
            (,,,,,,, uint128 coll) = pf.orderRec(key);
            sum += coll;
        }

        assertEq(uint256(pf.reservedCollateral()), sum, "reservedCollateral drifted from the order records");
    }

    /// @dev Reserved collateral can never exceed what the portfolio and the
    ///      venue hold between them. If it did, admission would be rationing
    ///      capital that does not exist.
    function invariant_reservedCollateralIsBackedByRealCapital() public view {
        assertLe(uint256(pf.reservedCollateral()), uint256(pf.capitalBase()), "reserved more than was ever funded");
    }

    /// @dev PRD 5.1/5.3 — agents can never move capital. The handler asserts
    ///      loudly inside itself; this confirms the portfolio still holds assets.
    function invariant_portfolioRetainsItsCollateral() public view {
        assertGt(tok.balanceOf(address(pf)) + pf.reservedCollateral(), 0, "portfolio drained");
    }

    /// @dev PRD 5.10 — owner recovery is callable regardless of portfolio state.
    function invariant_ownerRecoveryAlwaysAvailable() public {
        uint256 bal = tok.balanceOf(address(pf));
        if (bal == 0) return;
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        pf.withdraw(address(tok), owner, bal);
        assertEq(tok.balanceOf(address(pf)), 0, "owner could not recover");
        vm.revertToState(snap);
    }

    /// @dev PRD 5.8/5.9 — the tracked domain set stays bounded, so admission gas
    ///      cannot grow without limit and the contract cannot be wedged open.
    function invariant_domainCollectionStaysBounded() public view {
        assertLe(pf.domainMarketCount(DOM), pf.MAX_MARKETS_PER_DOMAIN(), "domain set unbounded");
    }

    /// @dev Committed capital is derived from a real balance, so it can never
    ///      exceed the capital actually placed under management.
    function invariant_committedNeverExceedsCapitalBase() public view {
        assertLe(pf.committedCapital(), pf.capitalBase(), "committed exceeds capital base");
    }
}
