// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Cadence} from "../../src/libraries/Cadence.sol";

/// @notice Canonical cadence derivation — the rule that keeps a late-rolled
///         market inside the ceiling it belongs to.
contract CadenceTest is Test {
    uint32[7] internal TABLE = [uint32(60), 300, 900, 1800, 3600, 14400, 86400];

    function _exp(uint32 cadence, uint256 periods) internal pure returns (uint64) {
        return uint64(uint256(cadence) * periods);
    }

    // ---------------------------------------------------------------- exact

    function test_exactWindowsResolveToThemselves() public pure {
        assertEq(Cadence.canonical(1787842740, 1787842800), 60);
        assertEq(Cadence.canonical(1787842500, 1787842800), 300);
        assertEq(Cadence.canonical(1787841900, 1787842800), 900);
        assertEq(Cadence.canonical(1787839200, 1787842800), 3600);
        assertEq(Cadence.canonical(1787832000, 1787846400), 14400); // real live 4h expiry
        assertEq(Cadence.canonical(1787788800, 1787875200), 86400);
    }

    /// @notice The observed live anomaly: two real 898-second markets belonged to
    ///         a 900-second series. Keyed raw they would have formed their own
    ///         unenforced domain.
    function test_lateRollJitterAbsorbsIntoItsSeries() public pure {
        uint64 ex = 1787842800; // divisible by 900, observed live
        assertEq(Cadence.canonical(ex - 900, ex), 900, "exact");
        assertEq(Cadence.canonical(ex - 899, ex), 900, "899 -> 900");
        assertEq(Cadence.canonical(ex - 898, ex), 900, "898 -> 900 (the live case)");
        assertEq(Cadence.canonical(ex - 890, ex), 900, "890 -> 900");
    }

    /// @notice A short market must never be promoted into a longer domain merely
    ///         because the longer cadence divides its expiry.
    function test_shortMarketNeverEscalates() public pure {
        uint64 ex = 1787842800; // divisible by 60, 300, 900, 3600, 14400
        assertEq(Cadence.canonical(ex - 60, ex), 60, "60 stays 60");
        assertEq(Cadence.canonical(ex - 300, ex), 300, "300 stays 300");
        assertEq(Cadence.canonical(ex - 900, ex), 900, "900 stays 900");
        assertEq(Cadence.canonical(ex - 3600, ex), 3600, "3600 stays 3600");
    }

    function test_unknownWindowHasNoDomain() public pure {
        assertEq(Cadence.canonical(0, 200_000), 0, "longer than every cadence");
        assertEq(Cadence.canonical(100, 100), 0, "zero window");
        assertEq(Cadence.canonical(200, 100), 0, "inverted");
        // A window that fits 900 but whose expiry is not 900-aligned, and which
        // is too long for any smaller aligned cadence.
        assertEq(Cadence.canonical(1787842777 - 800, 1787842777), 0, "unaligned expiry");
    }

    // ---------------------------------------------------------------- fuzz

    /// @notice The result, when non-zero, always satisfies both defining
    ///         conditions and is always the SMALLEST such cadence.
    function testFuzz_resultIsTheSmallestValidCadence(uint64 expiry, uint32 window) public view {
        expiry = uint64(bound(expiry, 1, type(uint48).max));
        window = uint32(bound(window, 1, 200_000));
        if (expiry <= window) return;

        uint32 c = Cadence.canonical(expiry - window, expiry);
        if (c == 0) {
            // No canonical cadence may satisfy both conditions.
            for (uint256 k; k < 7; ++k) {
                uint32 t = TABLE[k];
                assertFalse(t >= window && expiry % t == 0, "a valid cadence was missed");
            }
            return;
        }
        assertTrue(Cadence.isSupported(c), "result is in the table");
        assertGe(c, window, "cadence covers the window");
        assertEq(expiry % c, 0, "expiry is aligned to the cadence");
        for (uint256 k; k < 7; ++k) {
            uint32 t = TABLE[k];
            if (t < c) assertFalse(t >= window && expiry % t == 0, "a smaller valid cadence existed");
        }
    }

    /// @notice Determinism: the same inputs always produce the same domain input.
    function testFuzz_deterministic(uint64 ts, uint64 ex) public pure {
        assertEq(Cadence.canonical(ts, ex), Cadence.canonical(ts, ex));
    }

    /// @notice A window exactly equal to a canonical cadence, on an aligned
    ///         expiry, always resolves to that cadence.
    function testFuzz_exactSeriesAlwaysResolves(uint8 idx, uint32 periods) public view {
        uint32 c = TABLE[bound(idx, 0, 6)];
        periods = uint32(bound(periods, 1, 100_000));
        uint64 expiry = uint64(uint256(c) * periods);
        assertEq(Cadence.canonical(expiry - c, expiry), c);
    }
}
