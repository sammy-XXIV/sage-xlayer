// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./TradeVault.sol";

/// @title TradeVaultFactory
/// @notice Deploys one TradeVault per user. The caller of createVault becomes the
///         vault's owner immediately — there is no custodial window, ever.
contract TradeVaultFactory {
    mapping(address => address) public vaultOf;
    address[] public allVaults;

    event VaultCreated(address indexed owner, address vault);

    function createVault(address agent) external returns (address vault) {
        require(vaultOf[msg.sender] == address(0), "TradeVaultFactory: vault exists");
        TradeVault v = new TradeVault(msg.sender, agent);
        vaultOf[msg.sender] = address(v);
        allVaults.push(address(v));
        emit VaultCreated(msg.sender, address(v));
        return address(v);
    }

    function vaultCount() external view returns (uint256) {
        return allVaults.length;
    }
}
