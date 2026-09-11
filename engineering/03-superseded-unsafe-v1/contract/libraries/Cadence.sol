// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Cadence
/// @notice Canonical series-cadence derivation for DreamDEX Event Contract markets.
///
/// Raw `expiry - tradingStart` is NOT safe to key a risk domain on. Scanning
/// 1,200 consecutive live Shannon markets during product-lock validation found
/// two genuine **898-second** markets belonging to a 900-second series (a late
/// roll). Keyed raw, those would have formed their own structural domain and
/// escaped the 900-second ceiling entirely.
///
/// The rule below is exact and deterministic — not a tolerance heuristic:
///
///   cadence = the SMALLEST canonical C such that
///                C >= (expiry - tradingStart)   AND   expiry % C == 0
///
/// Both conditions are load-bearing:
///   - `C >= window` stops a short market escalating into a longer domain.
///   - `expiry % C == 0` exploits the fact that series expiries are wall-clock
///     aligned, so a 60-second market cannot satisfy it for 900 unless its
///     window also fits.
///   - taking the SMALLEST match makes this a function rather than a choice.
///
/// Validated against 1,200 consecutive live markets: zero unresolved, the 898s
/// markets absorbed into 900s, and 60s markets never escalated. Evidence:
/// `engineering/02-product-lock/STRUCTURAL_DOMAINS.md`.
///
/// @dev The supported set is fixed at deployment. It matches the cadences the
///      live DreamDEX MarketCreators actually produce (60, 300, 900, 3600,
///      14400, 86400) plus 1800 for headroom. Changing it changes every derived
///      domain id, so it is a constant rather than configurable state.
library Cadence {
    uint32 internal constant C0 = 60; // 1m
    uint32 internal constant C1 = 300; // 5m
    uint32 internal constant C2 = 900; // 15m
    uint32 internal constant C3 = 1800; // 30m
    uint32 internal constant C4 = 3600; // 1h
    uint32 internal constant C5 = 14400; // 4h
    uint32 internal constant C6 = 86400; // 24h

    /// @notice Canonical cadence in seconds, or 0 when the window matches none.
    /// @dev Returning 0 means "no structural domain", and callers must treat that
    ///      as deny. Failing closed on an unrecognised window is deliberate: an
    ///      unknown cadence must never land in an enforced domain by accident.
    function canonical(uint64 tradingStart, uint64 expiry) internal pure returns (uint32) {
        if (expiry <= tradingStart) return 0;
        uint64 window = expiry - tradingStart;

        if (window <= C0 && expiry % C0 == 0) return C0;
        if (window <= C1 && expiry % C1 == 0) return C1;
        if (window <= C2 && expiry % C2 == 0) return C2;
        if (window <= C3 && expiry % C3 == 0) return C3;
        if (window <= C4 && expiry % C4 == 0) return C4;
        if (window <= C5 && expiry % C5 == 0) return C5;
        if (window <= C6 && expiry % C6 == 0) return C6;
        return 0;
    }

    /// @notice True when `c` is one of the supported canonical cadences.
    function isSupported(uint32 c) internal pure returns (bool) {
        return c == C0 || c == C1 || c == C2 || c == C3 || c == C4 || c == C5 || c == C6;
    }
}
