// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AirspaceAccount} from "./AirspaceAccount.sol";

/// @title AirspaceFactory
/// @notice Deterministic minimal-proxy factory for portfolios.
/// @dev One portfolio per (owner, salt). Portfolios are independent of one
///      another -- no shared storage, no shared capital, no global registry the
///      operator has to run. This is what makes "hundreds of portfolios" a
///      deployment question rather than an architecture question.
contract AirspaceFactory {
    error DeployFailed();

    address public immutable implementation;
    address public immutable module;
    address public immutable outcomeToken;

    event PortfolioCreated(address indexed portfolio, address indexed owner, bytes32 salt);

    constructor(address module_, address outcomeToken_) {
        implementation = address(new AirspaceAccount());
        module = module_;
        outcomeToken = outcomeToken_;
    }

    function createPortfolio(address owner_, bytes32 salt) external returns (address portfolio) {
        bytes32 s = keccak256(abi.encode(owner_, salt));
        portfolio = _clone(implementation, s);
        AirspaceAccount(payable(portfolio)).initialize(owner_, module, outcomeToken);
        emit PortfolioCreated(portfolio, owner_, salt);
    }

    function portfolioFor(address owner_, bytes32 salt) external view returns (address) {
        bytes32 s = keccak256(abi.encode(owner_, salt));
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), s, keccak256(_creationCode(implementation)))
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

    function _clone(address impl, bytes32 salt) internal returns (address addr) {
        bytes memory code = _creationCode(impl);
        assembly {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
    }
}
