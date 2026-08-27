# contracts/

Canonical AIRSPACE production contracts. **Intentionally empty** until the
PRD/DESIGN pass.

The validated prototype that reached product lock lives at
[`engineering/02-product-lock/contracts/`](../engineering/02-product-lock/contracts/)
(`AirspacePortfolio.sol`, `AirspacePortfolioFactory.sol`, `IAirspaceV2.sol`) with
the shared DreamDEX interface at
[`engineering/shared/interfaces/IDreamDex.sol`](../engineering/shared/interfaces/IDreamDex.sol).
Those are the pieces to port; they are not production code yet (no audit, no
upgrade path, no deployment scripts).
