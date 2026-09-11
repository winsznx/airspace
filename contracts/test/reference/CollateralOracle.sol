// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice An INDEPENDENT reference model of collateral reservation.
///
/// Companion to `ExposureOracle`, and written for the same reason: the
/// directional bug was found because a second implementation disagreed with the
/// first. Assuming the capital side is fine because the last bug was elsewhere
/// is how the next one survives.
///
/// It shares no code with the production path and does not use the same
/// formulation. `AirspacePortfolio._reserveFor` rounds up with the `+ one - 1`
/// idiom; this rounds up by asking whether the division left a remainder. They
/// should agree on every input, and the fuzz test exists to find out where they
/// do not.
library CollateralOracle {
    /// @notice Collateral a BUY must escrow, in raw collateral units.
    ///
    /// DreamDEX quotes `price` as the YES-side price always, so the NO side
    /// costs `one - price`. A SELL escrows outcome tokens instead and locks no
    /// collateral at all; the figure returned for a sell kind is a NOTIONAL,
    /// used only for order-size ceilings, and must never reach committed capital.
    ///
    /// Rounding is UP. A venue that rounds up and a portfolio that rounds down
    /// disagree by a unit the portfolio then does not have.
    function reserve(uint8 kind, uint256 price, uint256 quantity, uint256 one) internal pure returns (uint256) {
        uint256 unit = (kind == 0 || kind == 1) ? price : one - price;
        uint256 gross = unit * quantity;
        uint256 whole = gross / one;
        return gross % one == 0 ? whole : whole + 1;
    }

    /// @notice True when this kind moves collateral out of the portfolio.
    function escrowsCollateral(uint8 kind) internal pure returns (bool) {
        return kind == 0 || kind == 2;
    }
}
