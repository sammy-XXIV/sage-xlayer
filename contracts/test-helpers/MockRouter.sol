// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Test-only stand-in for the OKX DEX router. Swaps at a fixed rate,
///         pulling tokenIn from the caller (the vault) via the allowance it
///         was just granted, and paying tokenOut from its own balance.
///         Not deployed as part of the real product.
contract MockRouter {
    bool public forceFail;

    function setForceFail(bool value) external {
        forceFail = value;
    }

    /// @param rate scaled by 1e18, e.g. rate = 2e18 means 1 tokenIn -> 2 tokenOut
    function swap(address tokenInAddr, address tokenOutAddr, uint256 amountIn, uint256 rate) external {
        require(!forceFail, "MockRouter: forced failure");
        IERC20(tokenInAddr).transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = (amountIn * rate) / 1e18;
        IERC20(tokenOutAddr).transfer(msg.sender, amountOut);
    }
}
