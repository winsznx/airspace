// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {FlightAccount} from "../src/FlightAccount.sol";
import {FlightFactory} from "../src/FlightFactory.sol";
import {
    IBinaryMarketsModule, IBinaryPool, IBinaryMarket, IMarketCreator, IOutcomeToken6909, IERC20Min
} from "../src/interfaces/IDreamDex.sol";

interface ITestUsdc is IERC20Min {
    function faucet(uint256 amount) external;
}

/// @notice Live-state fork proofs against the real DreamDEX Event Contract
///         deployment on Somnia Shannon (chainId 50312).
///
/// Nothing here is mocked. The module, pool, market, outcome-token singleton and
/// order book are the deployed contracts, and the positive test crosses a real
/// resting ask on the real book.
contract FlightAccountForkTest is Test {
    // Protocol (CREATE3 -- identical on testnet and mainnet)
    address constant MODULE = 0x3ecC694Cef705358864a646142ac17A90E29e388;
    address constant OUTCOME = 0xB52c5934113Af5c0Bb20eb3C72290C8215f755b9;
    address constant TUSDC = 0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E;
    address constant MARKET_CREATOR = 0x94D963B6670AB96E78C8d0C46ca35D196d606EFE;

    // Live market under test, resolved from the module registry at setUp.
    bytes32 marketId;
    address pool;
    address market;
    uint64 marketNonce;
    uint64 tradingStart;
    uint64 expiry;
    uint256 yesId;
    uint256 noId;

    address owner = makeAddr("OWNER");
    address agent = makeAddr("AGENT");
    address attacker = makeAddr("ATTACKER");

    FlightFactory factory;
    FlightAccount acct;

    uint256 constant ONE = 1e6; // tUSDC has 6 decimals
    uint64 constant DAILY = 86400;

    function setUp() public {
        // Pinned so the proofs are reproducible; see evidence/FORK.md.
        vm.createSelectFork(vm.envString("SHANNON_RPC"), vm.envUint("FORK_BLOCK"));

        marketId = bytes32(vm.envUint("MARKET_ID"));
        (,,,,,,,, address m, address p,,,,) = IBinaryMarketsModule(MODULE).markets(marketId);
        require(p != address(0), "market not found at fork block");
        pool = p;
        market = m;

        (,,,,,,,,,, uint256 y, uint256 n, uint64 ts, uint64 ex) = IBinaryMarketsModule(MODULE).markets(marketId);
        yesId = y;
        noId = n;
        tradingStart = ts;
        expiry = ex;
        marketNonce = IBinaryPool(pool).marketNonce();

        require(block.timestamp >= tradingStart && block.timestamp < expiry, "market not live at fork block");

        factory = new FlightFactory(MODULE, OUTCOME);
        vm.prank(owner);
        acct = FlightAccount(payable(factory.createAccount(owner, agent, bytes32(0))));

        // Owner funds the account.
        vm.prank(address(acct));
        ITestUsdc(TUSDC).faucet(5_000 * ONE);

        vm.prank(owner);
        acct.setPolicy(_basePolicy());
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _basePolicy() internal view returns (FlightAccount.Policy memory p) {
        p = FlightAccount.Policy({
            mode: FlightAccount.BindMode.EXACT,
            marketId: marketId,
            marketCreator: MARKET_CREATOR,
            seriesId: 8, // ETH / 86400s
            assetHash: keccak256(bytes("ETH")),
            collateral: TUSDC,
            intervalSec: DAILY,
            maxOrderNotional: uint128(500 * ONE),
            maxExposure: uint128(1_000 * ONE),
            maxBuyPrice: 700_000, // 0.70
            minSellPrice: 300_000, // 0.30
            minHeadroomSec: 300,
            cooldownSec: 0,
            policyExpiry: uint64(block.timestamp + 7 days)
        });
    }

    function _intent() internal view returns (FlightAccount.Intent memory i) {
        (uint256 px, uint256 qty) = _bestAsk();
        i = FlightAccount.Intent({
            marketId: marketId,
            pool: pool,
            marketNonce: marketNonce,
            kind: 0, // BUY_YES
            price: px,
            quantity: qty,
            expireTimestampNs: IBinaryPool(pool).marketExpiryNs(),
            orderType: 2, // ImmediateOrCancel -- take what crosses now
            nonce: 1,
            strategyVersion: keccak256("flightpath-spike/v1")
        });
    }

    function _bestAsk() internal view returns (uint256 price, uint256 qty) {
        (bool ok, bytes memory ret) =
            pool.staticcall(abi.encodeWithSignature("getBookLevels(bool,uint64)", false, uint64(1)));
        require(ok, "book read failed");
        (uint256[2][] memory lv) = abi.decode(ret, (uint256[2][]));
        require(lv.length > 0, "empty ask book");
        return (lv[0][0], lv[0][1]);
    }

    // ==================================================================
    // POSITIVE: owner funds, agent trades, position belongs to the ACCOUNT
    // ==================================================================

    function test_P1_agentTradeSucceedsAndPositionBelongsToAccount() public {
        uint256 collBefore = IERC20Min(TUSDC).balanceOf(address(acct));
        uint256 yesBefore = IOutcomeToken6909(OUTCOME).balanceOf(address(acct), yesId);
        assertEq(yesBefore, 0, "account should start flat");

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        acct.execute(i);

        uint256 collAfter = IERC20Min(TUSDC).balanceOf(address(acct));
        uint256 yesAfter = IOutcomeToken6909(OUTCOME).balanceOf(address(acct), yesId);

        console2.log("collateral spent :", collBefore - collAfter);
        console2.log("YES acquired     :", yesAfter);

        assertGt(yesAfter, 0, "account must hold the resulting YES position");
        assertLt(collAfter, collBefore, "collateral must have been spent");

        // The position is the ACCOUNT's, not the agent's and not the owner's.
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(agent, yesId), 0, "agent must hold nothing");
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(owner, yesId), 0, "owner EOA must hold nothing");
        assertEq(IERC20Min(TUSDC).balanceOf(agent), 0, "agent must hold no collateral");
    }

    // ==================================================================
    // NEGATIVE: the agent cannot move capital
    // ==================================================================

    function test_N1_agentCannotWithdrawCollateral() public {
        vm.prank(agent);
        vm.expectRevert(FlightAccount.NotOwner.selector);
        acct.withdraw(TUSDC, agent, 1);
    }

    function test_N2_agentCannotWithdrawOutcomeTokens() public {
        // Give the account a real position first.
        FlightAccount.Intent memory pre = _intent();
        vm.prank(agent);
        acct.execute(pre);

        vm.prank(agent);
        vm.expectRevert(FlightAccount.NotOwner.selector);
        acct.withdrawOutcome(yesId, agent, 1);
    }

    function test_N3_agentCannotEscalateViaOwnerCallOrPolicy() public {
        vm.prank(agent);
        vm.expectRevert(FlightAccount.NotOwner.selector);
        acct.ownerCall(TUSDC, 0, abi.encodeWithSignature("transfer(address,uint256)", agent, 1));

        vm.prank(agent);
        vm.expectRevert(FlightAccount.NotOwner.selector);
        acct.setPolicy(_basePolicy());

        vm.prank(agent);
        vm.expectRevert(FlightAccount.NotOwner.selector);
        acct.setAgent(agent);
    }

    function test_N4_thirdPartyCannotExecute() public {
        FlightAccount.Intent memory i = _intent();
        vm.prank(attacker);
        vm.expectRevert(FlightAccount.NotAgent.selector);
        acct.execute(i);
    }

    // ==================================================================
    // NEGATIVE: policy limits
    // ==================================================================

    function test_N5_overOrderNotionalFails() public {
        FlightAccount.Policy memory p = _basePolicy();
        p.maxOrderNotional = uint128(1 * ONE); // 1 tUSDC ceiling
        vm.prank(owner);
        acct.setPolicy(p);

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        vm.expectRevert(FlightAccount.OrderNotionalExceeded.selector);
        acct.execute(i);
    }

    function test_N6_aggregateExposureCapFails() public {
        FlightAccount.Policy memory p = _basePolicy();
        p.maxExposure = uint128(1 * ONE);
        p.maxOrderNotional = uint128(500 * ONE);
        vm.prank(owner);
        acct.setPolicy(p);

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        vm.expectRevert(FlightAccount.ExposureExceeded.selector);
        acct.execute(i);
    }

    function test_N7_priceOutsidePolicyFails() public {
        FlightAccount.Policy memory p = _basePolicy();
        (uint256 ask,) = _bestAsk();
        p.maxBuyPrice = uint64(ask - 1); // one wei under the ask
        vm.prank(owner);
        acct.setPolicy(p);

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        vm.expectRevert(FlightAccount.PriceOutsidePolicy.selector);
        acct.execute(i);
    }

    function test_N8_wrongCadenceFails() public {
        FlightAccount.Policy memory p = _basePolicy();
        p.intervalSec = 900; // policy says 15m; this market is daily
        vm.prank(owner);
        acct.setPolicy(p);

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        vm.expectRevert(FlightAccount.CadenceMismatch.selector);
        acct.execute(i);
    }

    function test_N9_wrongAssetFailsInSeriesMode() public {
        FlightAccount.Policy memory p = _basePolicy();
        p.mode = FlightAccount.BindMode.SERIES;
        p.marketId = bytes32(0);
        p.seriesId = 7; // BTC / 86400s
        p.assetHash = keccak256(bytes("ETH")); // policy demands ETH
        vm.prank(owner);
        acct.setPolicy(p);

        // Series 7 reports "BTC" on-chain, so the asset commitment fails.
        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        vm.expectRevert(FlightAccount.AssetMismatch.selector);
        acct.execute(i);
    }

    function test_N10_wrongMarketIdFailsExactBinding() public {
        FlightAccount.Intent memory i = _intent();
        i.marketId = bytes32(uint256(marketId) - 1); // a different, real market

        vm.prank(agent);
        vm.expectRevert(FlightAccount.MarketNotBound.selector);
        acct.execute(i);
    }

    function test_N11_staleRecycledGenerationFails() public {
        FlightAccount.Intent memory i = _intent();
        i.marketNonce = marketNonce - 1; // the pool's PREVIOUS market

        vm.prank(agent);
        vm.expectRevert(FlightAccount.GenerationMismatch.selector);
        acct.execute(i);
    }

    function test_N12_poolSubstitutionFails() public {
        FlightAccount.Intent memory i = _intent();
        i.pool = address(0xdead); // a pool the registry does not bind to this market

        vm.prank(agent);
        vm.expectRevert(FlightAccount.PoolMismatch.selector);
        acct.execute(i);
    }

    function test_N13_replayFails() public {
        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        acct.execute(i);

        vm.prank(agent);
        vm.expectRevert(FlightAccount.IntentReplayed.selector);
        acct.execute(i); // identical nonce
    }

    function test_N14_cooldownFails() public {
        FlightAccount.Policy memory p = _basePolicy();
        p.cooldownSec = 600;
        vm.prank(owner);
        acct.setPolicy(p);

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        acct.execute(i);

        i.nonce = 2; // fresh nonce, so only the cooldown can stop it
        vm.prank(agent);
        vm.expectRevert(FlightAccount.CooldownActive.selector);
        acct.execute(i);
    }

    function test_N15_insufficientWindowHeadroomFails() public {
        FlightAccount.Policy memory p = _basePolicy();
        p.minHeadroomSec = uint64(expiry - block.timestamp) + 1;
        vm.prank(owner);
        acct.setPolicy(p);

        FlightAccount.Intent memory i = _intent();
        vm.prank(agent);
        vm.expectRevert(FlightAccount.InsufficientHeadroom.selector);
        acct.execute(i);
    }

    function test_N16_marketPastExpiryIsNotTrading() public {
        FlightAccount.Intent memory i = _intent();
        vm.warp(uint256(expiry) + 1);

        vm.prank(agent);
        vm.expectRevert(FlightAccount.MarketNotTrading.selector);
        acct.execute(i);
    }

    function test_N17_offGridOrderFails() public {
        IBinaryPool.OrderBookParams memory g = IBinaryPool(pool).getOrderBookParameters();
        FlightAccount.Intent memory i = _intent();
        i.price = i.price + 1; // off the tick grid

        vm.prank(agent);
        if (g.tickSize > 1) {
            vm.expectRevert(FlightAccount.OffTickGrid.selector);
            acct.execute(i);
        }
    }

    function test_N18_expiredPolicyFails() public {
        // Snapshot a valid intent while the book is still live, then let the
        // policy lapse. PolicyExpired must fire before any market-state gate.
        FlightAccount.Intent memory i = _intent();
        vm.warp(block.timestamp + 8 days);
        vm.prank(agent);
        vm.expectRevert(FlightAccount.PolicyExpired.selector);
        acct.execute(i);
    }

    // ==================================================================
    // OWNER RECOVERY: unconditional, independent of agent state
    // ==================================================================

    function test_R1_ownerRecoversIdleCollateralRegardlessOfAgentState() public {
        // Worst case: policy expired, agent revoked to address(0).
        vm.warp(block.timestamp + 8 days);
        vm.prank(owner);
        acct.setAgent(address(0));

        uint256 bal = IERC20Min(TUSDC).balanceOf(address(acct));
        assertGt(bal, 0);

        vm.prank(owner);
        acct.withdraw(TUSDC, owner, bal);

        assertEq(IERC20Min(TUSDC).balanceOf(address(acct)), 0);
        assertEq(IERC20Min(TUSDC).balanceOf(owner), bal, "owner recovered everything");
    }

    function test_R2_ownerRecoversOutcomeTokensAfterAgentTrade() public {
        FlightAccount.Intent memory pre = _intent();
        vm.prank(agent);
        acct.execute(pre);

        uint256 pos = IOutcomeToken6909(OUTCOME).balanceOf(address(acct), yesId);
        assertGt(pos, 0);

        vm.prank(owner);
        acct.setAgent(address(0)); // agent fully revoked

        vm.prank(owner);
        acct.withdrawOutcome(yesId, owner, pos);

        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(owner, yesId), pos, "owner recovered the position");
        assertEq(IOutcomeToken6909(OUTCOME).balanceOf(address(acct), yesId), 0);
    }
}
