// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AirspacePortfolio} from "./AirspacePortfolio.sol";

/// @title AirspacePortfolioFactory
/// @notice Deterministic minimal-proxy factory for portfolios.
/// @dev Portfolios are fully independent: no shared storage, no global registry,
///      no operator-run service. Scaling to hundreds of portfolios is a
///      deployment question, not an architecture question.
contract AirspacePortfolioFactory {
    error DeployFailed();

    address public immutable implementation;
    address public immutable module;
    address public immutable outcomeToken;

    event PortfolioCreated(address indexed portfolio, address indexed owner, bytes32 salt);

    constructor(address module_, address outcomeToken_) {
        implementation = address(new AirspacePortfolio());
        module = module_;
        outcomeToken = outcomeToken_;
    }

    function createPortfolio(address owner_, bytes32 salt) external returns (address portfolio) {
        portfolio = _clone(keccak256(abi.encode(owner_, salt)));
        AirspacePortfolio(payable(portfolio)).initialize(owner_, module, outcomeToken);
        emit PortfolioCreated(portfolio, owner_, salt);
    }

    function portfolioFor(address owner_, bytes32 salt) external view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(
                            bytes1(0xff),
                            address(this),
                            keccak256(abi.encode(owner_, salt)),
                            keccak256(_creationCode(implementation))
                        )
                    )
                )
            )
        );
    }

    function _creationCode(address impl) internal pure returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _clone(bytes32 salt) internal returns (address addr) {
        bytes memory code = _creationCode(implementation);
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
    }
}
