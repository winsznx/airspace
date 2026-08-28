// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Intent} from "../../src/interfaces/IAirspace.sol";

/// @notice Cross-language check on the key derivations.
///
/// `packages/protocol/src/keys.ts` mirrors `AirspacePortfolio._intentHash` and
/// `_orderKey` so off-chain code can LOOK UP a record the contract produced. A
/// mirror that drifts does not fail loudly: it silently fails to find rows, and
/// the admission feed quietly loses receipts.
///
/// Both derivations are internal, so this test reproduces the exact expressions
/// from the contract and pins the result against vectors produced by the
/// TypeScript mirror. The same vectors are asserted in
/// `packages/protocol/src/keys.test.ts`. If either side changes, one of the two
/// suites goes red.
contract KeyMirrorTest is Test {
    address constant PORTFOLIO = 0x8CBA6655d29c4e72391040A90B15902b4f6fc220;
    address constant AGENT = 0x551051f987b011329F29E8c069D8cb6ff2C2b084;
    address constant POOL = 0x54D90260Fe949940A80602E7fDa8ebD729c5BE00;
    uint256 constant CHAIN_ID = 50312;

    function _intent() internal pure returns (Intent memory) {
        return Intent({
            marketId: bytes32(uint256(0xbd32)),
            pool: POOL,
            marketNonce: 99,
            kind: 0,
            price: 550_000,
            quantity: 180_000_000,
            expireTimestampNs: 1_787_900_000_000_000_000,
            orderType: 3,
            nonce: 7,
            strategyVersion: bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111))
        });
    }

    function test_intentHashMatchesTypeScriptMirror() public pure {
        Intent memory i = _intent();
        bytes32 got = keccak256(abi.encode(PORTFOLIO, CHAIN_ID, AGENT, i));
        assertEq(got, 0xa38101919795151707438d21645fd5e6ea0112c55da37c028f74c5c728132c15);
    }

    function test_orderKeyMatchesTypeScriptMirror() public pure {
        bytes32 got = keccak256(abi.encode(POOL, uint64(99), uint128(4242)));
        assertEq(got, 0x47183674f012b0b0ea2c79dd042afad0c0be4705471309b26d2dc24591cde677);
    }

    /// @dev The generation is what makes an order id safe as a key: DreamDEX
    ///      recycles pool addresses, so the same id on the same pool in two
    ///      market generations must not collide.
    function testFuzz_orderKeyBindsGeneration(uint64 a, uint64 b, uint128 orderId) public pure {
        vm.assume(a != b);
        assertTrue(keccak256(abi.encode(POOL, a, orderId)) != keccak256(abi.encode(POOL, b, orderId)));
    }

    /// @dev The portfolio address and chain id are in the preimage, so the same
    ///      intent from the same agent cannot be replayed onto another portfolio
    ///      or another chain under the same hash.
    function testFuzz_intentHashBindsPortfolioAndChain(address otherPortfolio, uint256 otherChain) public pure {
        Intent memory i = _intent();
        bytes32 base = keccak256(abi.encode(PORTFOLIO, CHAIN_ID, AGENT, i));
        if (otherPortfolio != PORTFOLIO) {
            assertTrue(keccak256(abi.encode(otherPortfolio, CHAIN_ID, AGENT, i)) != base);
        }
        if (otherChain != CHAIN_ID) {
            assertTrue(keccak256(abi.encode(PORTFOLIO, otherChain, AGENT, i)) != base);
        }
    }
}
