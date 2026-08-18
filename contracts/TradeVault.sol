// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title TradeVault
/// @notice One vault per user, owned by the user from the moment it is created.
///         The owner may grant a revocable, capped "agent" session key that can
///         swap allowlisted tokens through a single allowlisted router — nothing
///         else. The agent can never withdraw funds or change the router / token
///         allowlists; only the owner can. This is what makes custody stay with
///         the user even though a bot is trading on their behalf.
/// @dev Router vs. spender: aggregators like OKX DEX use two different
///      addresses — a "router" that the swap transaction is sent to (tx.to),
///      and a separate "approval"/"spender" contract that actually holds the
///      ERC20 allowance and pulls funds. These are NOT the same address (see
///      OKX's dex-smart-contract and dex-swap docs: `tx.to` vs.
///      `signatureData[].approveContract` / `dexTokenApproveAddress`). Approving
///      the wrong one means the swap call will simply fail to pull funds.
contract TradeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TokenLimits {
        bool allowed;
        uint256 perTradeCap; // max amountIn per single trade, in tokenIn's own units
        uint256 perDayCap; // max cumulative amountIn per rolling 24h window
    }

    address public immutable owner;
    address public agent;
    address public router; // call target (tx.to) for the swap; must be explicitly set by the owner
    address public spender; // address granted the ERC20 allowance; may differ from router — see contract-level note

    mapping(address => TokenLimits) public tokenIn; // asset the agent is allowed to spend
    mapping(address => bool) public tokenOut; // asset the agent is allowed to buy
    mapping(address => uint256) public spentToday; // tokenIn => amount spent in current window
    mapping(address => uint256) public windowStart; // tokenIn => start of current 24h window

    event Deposited(address indexed token, uint256 amount);
    event Withdrawn(address indexed token, uint256 amount, address indexed to);
    event AgentUpdated(address indexed agent);
    event RouterUpdated(address indexed router);
    event SpenderUpdated(address indexed spender);
    event TokenInUpdated(address indexed token, bool allowed, uint256 perTradeCap, uint256 perDayCap);
    event TokenOutUpdated(address indexed token, bool allowed);
    event TradeExecuted(
        address indexed tokenIn_,
        address indexed tokenOut_,
        uint256 amountIn,
        uint256 amountOut
    );

    modifier onlyOwner() {
        require(msg.sender == owner, "TradeVault: not owner");
        _;
    }

    modifier onlyAgent() {
        require(msg.sender == agent, "TradeVault: not agent");
        _;
    }

    constructor(address _owner, address _agent) {
        require(_owner != address(0), "TradeVault: owner=0");
        owner = _owner;
        agent = _agent;
    }

    // ---------- owner controls ----------

    function setAgent(address newAgent) external onlyOwner {
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    function setRouter(address newRouter) external onlyOwner {
        router = newRouter;
        emit RouterUpdated(newRouter);
    }

    function setSpender(address newSpender) external onlyOwner {
        spender = newSpender;
        emit SpenderUpdated(newSpender);
    }

    function setTokenIn(
        address token,
        bool allowed,
        uint256 perTradeCap,
        uint256 perDayCap
    ) external onlyOwner {
        tokenIn[token] = TokenLimits(allowed, perTradeCap, perDayCap);
        emit TokenInUpdated(token, allowed, perTradeCap, perDayCap);
    }

    function setTokenOut(address token, bool allowed) external onlyOwner {
        tokenOut[token] = allowed;
        emit TokenOutUpdated(token, allowed);
    }

    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, amount, to);
    }

    // ---------- deposits (anyone can top up the vault; only owner can withdraw) ----------

    function depositToken(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, amount);
    }

    // ---------- agent execution ----------

    /// @param swapCalldata pre-built calldata for `router` (tx.to from the OKX
    ///        swap quote), prepared off-chain. `spender` is granted the ERC20
    ///        allowance and is what actually pulls `amountIn` of `tokenIn_` —
    ///        it is commonly a different address than `router`.
    function executeTrade(
        address tokenIn_,
        address tokenOut_,
        uint256 amountIn,
        uint256 minAmountOut,
        bytes calldata swapCalldata
    ) external onlyAgent nonReentrant returns (uint256 amountOut) {
        require(router != address(0), "TradeVault: router not set");
        require(spender != address(0), "TradeVault: spender not set");

        TokenLimits memory limits = tokenIn[tokenIn_];
        require(limits.allowed, "TradeVault: tokenIn not allowed");
        require(tokenOut[tokenOut_], "TradeVault: tokenOut not allowed");
        require(amountIn <= limits.perTradeCap, "TradeVault: exceeds per-trade cap");

        if (block.timestamp >= windowStart[tokenIn_] + 1 days) {
            windowStart[tokenIn_] = block.timestamp;
            spentToday[tokenIn_] = 0;
        }
        require(spentToday[tokenIn_] + amountIn <= limits.perDayCap, "TradeVault: exceeds per-day cap");
        spentToday[tokenIn_] += amountIn;

        IERC20 tokenInErc20 = IERC20(tokenIn_);
        IERC20 tokenOutErc20 = IERC20(tokenOut_);

        uint256 balBefore = tokenOutErc20.balanceOf(address(this));

        tokenInErc20.forceApprove(spender, amountIn);
        (bool ok, ) = router.call(swapCalldata);
        require(ok, "TradeVault: swap call failed");
        tokenInErc20.forceApprove(spender, 0);

        amountOut = tokenOutErc20.balanceOf(address(this)) - balBefore;
        require(amountOut >= minAmountOut, "TradeVault: slippage");

        emit TradeExecuted(tokenIn_, tokenOut_, amountIn, amountOut);
    }
}
