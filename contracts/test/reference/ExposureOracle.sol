// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOutcomeToken6909} from "../../src/interfaces/IDreamDex.sol";

/// @notice An INDEPENDENT reference model of worst-case directional exposure.
///
/// This exists to disagree with the production contract. It deliberately shares
/// no helper, no library and no code path with `AirspacePortfolio`: it takes
/// only primitive inputs, and it derives the answer by ENUMERATING the reachable
/// outcomes rather than by evaluating a closed-form bound.
///
/// That difference is the whole point. v1's ceiling invariant asserted
/// `domainRiskUsage <= CEILING` — the number under test against itself — so an
/// understatement made the assertion pass. A second implementation that arrives
/// at the answer a different way cannot collude with the first.
///
/// THE MODEL
///
/// DreamDEX escrows a SELL's outcome tokens at PLACEMENT, not at fill. Verified
/// live on four independent pools: each pool's outcome-token balance equalled
/// its resting ask depth exactly (`scripts/escrow-probe.mjs`, re-runnable
/// against current chain state). So for a resting order:
///
///   BUY_YES   fills   -> +q YES        cancels -> nothing
///   BUY_NO    fills   -> +q NO         cancels -> nothing
///   SELL_YES  fills   -> nothing       cancels -> +q YES returns
///   SELL_NO   fills   -> nothing       cancels -> +q NO  returns
///
/// Every resting order resolves independently. The reachable set of directional
/// positions is therefore every combination of "each order fills or does not",
/// and the worst case is the maximum absolute value over that set.
library ExposureOracle {
    struct Market {
        uint256 balYes; // realized YES held by the portfolio
        uint256 balNo; // realized NO held by the portfolio
        uint256 buyYes; // resting BUY_YES quantity
        uint256 sellYes; // resting SELL_YES quantity (tokens already escrowed)
        uint256 buyNo; // resting BUY_NO quantity
        uint256 sellNo; // resting SELL_NO quantity (tokens already escrowed)
    }

    /// @notice Worst case by EXHAUSTIVE ENUMERATION of the 16 fill combinations.
    /// @dev Deliberately brute force. It is the slowest correct way to get the
    ///      answer, which is exactly what a reference oracle should be: there is
    ///      no algebra here to share a mistake with the production formula.
    function worstCase(Market memory m) internal pure returns (uint256) {
        uint256 worst;
        for (uint256 mask; mask < 16; ++mask) {
            // Each bit: does this resting order fill?
            bool fBuyYes = mask & 1 != 0;
            bool fSellYes = mask & 2 != 0;
            bool fBuyNo = mask & 4 != 0;
            bool fSellNo = mask & 8 != 0;

            int256 yes = int256(m.balYes);
            int256 no = int256(m.balNo);

            // A filled buy delivers tokens.
            if (fBuyYes) yes += int256(m.buyYes);
            if (fBuyNo) no += int256(m.buyNo);
            // An UNFILLED sell is cancelled or expires, and its escrow returns.
            if (!fSellYes) yes += int256(m.sellYes);
            if (!fSellNo) no += int256(m.sellNo);

            int256 d = yes - no;
            uint256 a = d < 0 ? uint256(-d) : uint256(d);
            if (a > worst) worst = a;
        }
        return worst;
    }

    /// @notice Read a market's inputs straight from primary sources.
    /// @dev Balances come from the token, reservations from the caller. Nothing
    ///      is read through the portfolio's own accounting.
    function readMarket(
        IOutcomeToken6909 token,
        address portfolio,
        uint256 yesId,
        uint256 buyYes,
        uint256 sellYes,
        uint256 buyNo,
        uint256 sellNo
    ) internal view returns (Market memory) {
        return Market({
            balYes: token.balanceOf(portfolio, yesId),
            balNo: token.balanceOf(portfolio, yesId + 1),
            buyYes: buyYes,
            sellYes: sellYes,
            buyNo: buyNo,
            sellNo: sellNo
        });
    }

    /// @notice Domain usage: the gross sum of per-market worst cases.
    /// @dev No netting across markets. Nothing establishes that two markets in
    ///      one cadence domain have equivalent payoffs, so nothing may offset.
    function domainWorstCase(Market[] memory markets) internal pure returns (uint256 total) {
        for (uint256 k; k < markets.length; ++k) {
            total += worstCase(markets[k]);
        }
    }
}
