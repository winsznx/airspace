// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FlightAccount} from "./FlightAccount.sol";

/// @title FlightFactory
/// @notice Deterministic minimal-proxy factory for per-user FlightAccounts.
/// @dev One account per (owner, salt). The account address is derivable off-chain,
///      which is what lets a receipt name the execution account before it exists.
contract FlightFactory {
    error DeployFailed();

    address public immutable implementation;
    address public immutable module;
    address public immutable outcomeToken;

    event AccountCreated(address indexed account, address indexed owner, address indexed agent, bytes32 salt);

    constructor(address module_, address outcomeToken_) {
        implementation = address(new FlightAccount());
        module = module_;
        outcomeToken = outcomeToken_;
    }

    function createAccount(address owner_, address agent_, bytes32 salt) external returns (address account) {
        bytes32 s = keccak256(abi.encode(owner_, salt));
        account = _clone(implementation, s);
        FlightAccount(payable(account)).initialize(owner_, agent_, module, outcomeToken);
        emit AccountCreated(account, owner_, agent_, salt);
    }

    function accountFor(address owner_, bytes32 salt) external view returns (address) {
        bytes32 s = keccak256(abi.encode(owner_, salt));
        bytes32 hash = keccak256(
            abi.encodePacked(bytes1(0xff), address(this), s, keccak256(_creationCode(implementation)))
        );
        return address(uint160(uint256(hash)));
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
