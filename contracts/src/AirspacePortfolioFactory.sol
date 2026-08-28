// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AirspacePortfolio} from "./AirspacePortfolio.sol";

/// @title AirspacePortfolioFactory
/// @notice Deterministic minimal-proxy factory for AIRSPACE portfolios.
///
/// Portfolios are fully independent: no shared storage, no global registry that
/// execution touches, no operator-run service. Scaling to hundreds of portfolios
/// is a deployment question, not an architecture question.
///
/// @dev Deliberately NOT an upgradeable-proxy pattern. The implementation address
///      is immutable and a new version means a new factory, because upgrade
///      authority over a live portfolio would invalidate the agent-boundary claim
///      the whole product rests on (PRD 19.2).
///
///      The implementation is deployed SEPARATELY and passed in, rather than
///      created inside this constructor. Two reasons: Somnia rejects the nested
///      CREATE (a constructor deploying a ~24KB contract fails on-chain even
///      though it simulates cleanly), and an independently deployed
///      implementation can be source-verified on its own before any factory
///      points at it.
contract AirspacePortfolioFactory {
    error DeployFailed();
    error AlreadyDeployed();
    error ZeroAddress();

    string public constant VERSION = "1.0.0";

    /// @notice The immutable portfolio implementation every clone delegates to.
    address public immutable implementation;
    address public immutable module;
    address public immutable outcomeToken;
    address public immutable collateral;

    /// @notice Portfolios created by each owner, for discovery without an indexer.
    mapping(address => address[]) internal _byOwner;
    /// @notice Every portfolio this factory produced.
    mapping(address => bool) public isPortfolio;
    uint256 public portfolioCount;

    event PortfolioCreated(
        address indexed portfolio, address indexed owner, bytes32 indexed salt, string version, uint256 index
    );

    constructor(address implementation_, address module_, address outcomeToken_, address collateral_) {
        if (
            implementation_ == address(0) || module_ == address(0) || outcomeToken_ == address(0)
                || collateral_ == address(0)
        ) revert ZeroAddress();
        if (implementation_.code.length == 0) revert ZeroAddress();
        implementation = implementation_;
        module = module_;
        outcomeToken = outcomeToken_;
        collateral = collateral_;
    }

    /// @notice Deploy a portfolio for `owner_` at a deterministic address.
    /// @dev The salt is namespaced by owner so two owners cannot collide, and the
    ///      address is derivable off-chain before deployment — which is what lets
    ///      a receipt name the portfolio before it exists.
    function createPortfolio(address owner_, bytes32 salt) external returns (address portfolio) {
        if (owner_ == address(0)) revert ZeroAddress();
        bytes32 s = keccak256(abi.encode(owner_, salt));
        portfolio = _predict(s);
        if (portfolio.code.length != 0) revert AlreadyDeployed();

        portfolio = _clone(s);
        AirspacePortfolio(payable(portfolio)).initialize(owner_, module, outcomeToken, collateral);

        _byOwner[owner_].push(portfolio);
        isPortfolio[portfolio] = true;
        unchecked {
            portfolioCount += 1;
        }
        emit PortfolioCreated(portfolio, owner_, salt, VERSION, _byOwner[owner_].length - 1);
    }

    function portfolioFor(address owner_, bytes32 salt) external view returns (address) {
        return _predict(keccak256(abi.encode(owner_, salt)));
    }

    function portfoliosOf(address owner_) external view returns (address[] memory) {
        return _byOwner[owner_];
    }

    function portfolioCountOf(address owner_) external view returns (uint256) {
        return _byOwner[owner_].length;
    }

    // ------------------------------------------------------------- internals

    function _predict(bytes32 salt) internal view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, keccak256(_creationCode())))
                )
            )
        );
    }

    function _creationCode() internal view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", implementation, hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _clone(bytes32 salt) internal returns (address addr) {
        bytes memory code = _creationCode();
        assembly ("memory-safe") {
            addr := create2(0, add(code, 0x20), mload(code), salt)
        }
        if (addr == address(0)) revert DeployFailed();
    }
}
