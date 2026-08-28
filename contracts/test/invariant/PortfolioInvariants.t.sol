// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {AirspacePortfolio} from "../../src/AirspacePortfolio.sol";
import {AirspacePortfolioFactory} from "../../src/AirspacePortfolioFactory.sol";
import {GlobalPolicy, DomainPolicy, AgentPolicy, Intent, Refusal} from "../../src/interfaces/IAirspace.sol";
import {MockERC20, MockOutcome6909, MockModule, MockPool, MockMarket} from "../mocks/MockDreamDex.sol";

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

    function addMarket(bytes32 id, MockPool p) external {
        marketIds.push(id);
        pools.push(p);
    }

    function addAgent(address a) external {
        agents.push(a);
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        return marketIds.length == 0 ? 0 : seed % marketIds.length;
    }

    /// @notice An agent proposes an order. Failures are swallowed on purpose:
    ///         a refusal is a valid outcome and must leave state untouched.
    function propose(uint256 agentSeed, uint256 marketSeed, uint128 qty, uint16 fill) public {
        if (agents.length == 0 || marketIds.length == 0) return;
        address who = agents[agentSeed % agents.length];
        uint256 mi = _pick(marketSeed);
        MockPool p = pools[mi];
        p.setFillBps(uint16(bound(fill, 0, 10000)));
        qty = uint128(bound(qty, 1, 400)) * K;

        Intent memory i = Intent({
            marketId: marketIds[mi],
            pool: address(p),
            marketNonce: p.marketNonce(),
            kind: 0,
            price: 100_000,
            quantity: qty,
            expireTimestampNs: 1,
            orderType: 3,
            nonce: ++_nonce[who],
            strategyVersion: bytes32(0)
        });

        vm.prank(who);
        try pf.execute(i) returns (uint128 orderId) {
            _liveOrderKeys.push(keccak256(abi.encode(address(p), p.marketNonce(), orderId)));
        } catch {}
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
        try p.externalFill(uint128(bound(seed, 1, 20)), qty) {} catch {}
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
        factory = new AirspacePortfolioFactory(address(mod), address(oc), address(tok));

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
        uint64 expiry = uint64((block.timestamp / cadence + 3) * cadence);
        handler = new Handler(pf, tok, oc, mod, bytes32(0), CEILING);
        for (uint256 k; k < 3; ++k) {
            MockMarket m = new MockMarket();
            MockPool p = new MockPool(address(tok), address(oc), address(m));
            bytes32 id = keccak256(abi.encode("inv", k));
            mod.set(id, address(tok), creator, address(m), address(p), expiry - cadence, expiry);
            handler.addMarket(id, p);
            if (k == 0) DOM = pf.domainOf(id);
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
        bytes4[] memory sel = new bytes4[](6);
        sel[0] = Handler.propose.selector;
        sel[1] = Handler.release.selector;
        sel[2] = Handler.externalFill.selector;
        sel[3] = Handler.agentWithdrawAttempt.selector;
        sel[4] = Handler.prune.selector;
        sel[5] = Handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
        targetContract(address(handler));
    }

    /// @dev PRD 5.7 / 5.6 — the central safety property. Whatever sequence of
    ///      admissions, fills, external fills, releases and prunes occurred, the
    ///      domain's measured usage never exceeds the configured ceiling.
    function invariant_domainUsageNeverExceedsCeiling() public view {
        assertLe(pf.domainRiskUsage(DOM), CEILING, "domain ceiling breached");
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
