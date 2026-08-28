// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {AirspacePortfolioFactory} from "../src/AirspacePortfolioFactory.sol";
import {AirspacePortfolio} from "../src/AirspacePortfolio.sol";

/// @notice Deploy the AIRSPACE factory.
///
/// The factory deploys its own immutable implementation in its constructor, so
/// one transaction produces both and there is no window in which a factory
/// points at an unverified implementation. There is deliberately no proxy and no
/// upgrade authority: upgrade rights over a live portfolio would invalidate the
/// agent-boundary claim the product rests on.
contract Deploy is Script {
    function run() external {
        address module = vm.envAddress("DREAMDEX_MODULE");
        address outcomeToken = vm.envAddress("DREAMDEX_OUTCOME_TOKEN");
        address collateral = vm.envAddress("DREAMDEX_COLLATERAL");

        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("chainId    :", block.chainid);
        console2.log("deployer   :", deployer);
        console2.log("module     :", module);
        console2.log("outcome    :", outcomeToken);
        console2.log("collateral :", collateral);

        // The implementation is deployed first, on its own transaction: Somnia
        // rejects a constructor that itself deploys a ~24KB contract, and a
        // standalone deployment can be source-verified independently.
        vm.startBroadcast(pk);
        AirspacePortfolio implementation = new AirspacePortfolio();
        AirspacePortfolioFactory factory =
            new AirspacePortfolioFactory(address(implementation), module, outcomeToken, collateral);
        vm.stopBroadcast();

        console2.log("FACTORY        :", address(factory));
        console2.log("IMPLEMENTATION :", factory.implementation());
        console2.log("VERSION        :", factory.VERSION());
    }
}
