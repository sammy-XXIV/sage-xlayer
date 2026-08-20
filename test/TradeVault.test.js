const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("TradeVault", function () {
  async function deployFixture() {
    const [ownerSigner, agentSigner, strangerSigner, otherOwnerSigner] = await ethers.getSigners();

    const Factory = await ethers.getContractFactory("TradeVaultFactory");
    const factory = await Factory.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdt = await MockERC20.deploy("Mock USDT", "USDT");
    const weth = await MockERC20.deploy("Mock WETH", "WETH");

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy();

    // vault created and owned by ownerSigner, agent set to agentSigner
    await factory.connect(ownerSigner).createVault(agentSigner.address);
    const vaultAddr = await factory.vaultOf(ownerSigner.address);
    const vault = await ethers.getContractAt("TradeVault", vaultAddr);

    // fund the vault with USDT (the asset it will spend)
    await usdt.mint(vaultAddr, ethers.parseUnits("1000", 18));
    // fund the router with WETH (the asset it pays out on swap)
    await weth.mint(await router.getAddress(), ethers.parseUnits("1000", 18));

    return { factory, vault, vaultAddr, usdt, weth, router, ownerSigner, agentSigner, strangerSigner, otherOwnerSigner };
  }

  it("sets the creating caller as owner with no custodial window", async function () {
    const { vault, ownerSigner, agentSigner } = await deployFixture();
    expect(await vault.owner()).to.equal(ownerSigner.address);
    expect(await vault.agent()).to.equal(agentSigner.address);
  });

  it("only allows one vault per owner", async function () {
    const { factory, ownerSigner, agentSigner } = await deployFixture();
    await expect(factory.connect(ownerSigner).createVault(agentSigner.address)).to.be.revertedWith(
      "TradeVaultFactory: vault exists"
    );
  });

  describe("owner controls", function () {
    it("lets the owner revoke the agent, and the old agent loses access", async function () {
      const { vault, ownerSigner, agentSigner, usdt, weth, router } = await deployFixture();
      await vault.connect(ownerSigner).setRouter(await router.getAddress());
      await vault.connect(ownerSigner).setSpender(await router.getAddress());
      await vault.connect(ownerSigner).setTokenIn(await usdt.getAddress(), true, ethers.parseUnits("100", 18), ethers.parseUnits("500", 18));
      await vault.connect(ownerSigner).setTokenOut(await weth.getAddress(), true);

      await vault.connect(ownerSigner).setAgent(ethers.ZeroAddress);

      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        ethers.parseUnits("10", 18),
        ethers.parseUnits("1", 18),
      ]);

      await expect(
        vault
          .connect(agentSigner)
          .executeTrade(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("10", 18), 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: not agent");
    });

    it("rejects owner-only calls from non-owners", async function () {
      const { vault, strangerSigner } = await deployFixture();
      await expect(vault.connect(strangerSigner).setAgent(strangerSigner.address)).to.be.revertedWith(
        "TradeVault: not owner"
      );
      await expect(vault.connect(strangerSigner).withdraw(ethers.ZeroAddress, 0, strangerSigner.address)).to.be.revertedWith(
        "TradeVault: not owner"
      );
    });

    it("lets only the owner withdraw funds", async function () {
      const { vault, ownerSigner, strangerSigner, usdt } = await deployFixture();
      const vaultAddr = await vault.getAddress();
      const before = await usdt.balanceOf(ownerSigner.address);

      await expect(
        vault.connect(strangerSigner).withdraw(await usdt.getAddress(), ethers.parseUnits("1", 18), strangerSigner.address)
      ).to.be.revertedWith("TradeVault: not owner");

      await vault.connect(ownerSigner).withdraw(await usdt.getAddress(), ethers.parseUnits("100", 18), ownerSigner.address);
      expect(await usdt.balanceOf(ownerSigner.address)).to.equal(before + ethers.parseUnits("100", 18));
      expect(await usdt.balanceOf(vaultAddr)).to.equal(ethers.parseUnits("900", 18));
    });
  });

  describe("executeTrade guardrails", function () {
    async function configuredVault() {
      const ctx = await deployFixture();
      await ctx.vault.connect(ctx.ownerSigner).setRouter(await ctx.router.getAddress());
      await ctx.vault.connect(ctx.ownerSigner).setSpender(await ctx.router.getAddress());
      await ctx.vault
        .connect(ctx.ownerSigner)
        .setTokenIn(await ctx.usdt.getAddress(), true, ethers.parseUnits("100", 18), ethers.parseUnits("150", 18));
      await ctx.vault.connect(ctx.ownerSigner).setTokenOut(await ctx.weth.getAddress(), true);
      return ctx;
    }

    it("executes a trade within caps and pays out via the router", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        ethers.parseUnits("50", 18),
        ethers.parseUnits("2", 18), // rate: 1 USDT -> 2 WETH (arbitrary test rate)
      ]);

      await expect(
        vault
          .connect(agentSigner)
          .executeTrade(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("50", 18), ethers.parseUnits("90", 18), swapCalldata)
      )
        .to.emit(vault, "TradeExecuted")
        .withArgs(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("50", 18), ethers.parseUnits("100", 18));

      expect(await weth.balanceOf(await vault.getAddress())).to.equal(ethers.parseUnits("100", 18));
    });

    it("blocks tokens that were never allowlisted", async function () {
      const { vault, agentSigner, usdt, weth, router } = await deployFixture(); // no config at all
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        ethers.parseUnits("10", 18),
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault
          .connect(agentSigner)
          .executeTrade(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("10", 18), 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: router not set");
    });

    it("blocks trades when router is set but spender is not", async function () {
      const { vault, ownerSigner, agentSigner, usdt, weth, router } = await deployFixture();
      await vault.connect(ownerSigner).setRouter(await router.getAddress());
      // note: setSpender never called
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        ethers.parseUnits("10", 18),
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault
          .connect(agentSigner)
          .executeTrade(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("10", 18), 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: spender not set");
    });

    it("rejects a tokenOut that isn't allowlisted even if tokenIn is", async function () {
      const { vault, ownerSigner, agentSigner, usdt, weth, router } = await deployFixture();
      await vault.connect(ownerSigner).setRouter(await router.getAddress());
      await vault.connect(ownerSigner).setSpender(await router.getAddress());
      await vault
        .connect(ownerSigner)
        .setTokenIn(await usdt.getAddress(), true, ethers.parseUnits("100", 18), ethers.parseUnits("150", 18));
      // note: tokenOut never allowlisted

      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        ethers.parseUnits("10", 18),
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault
          .connect(agentSigner)
          .executeTrade(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("10", 18), 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: tokenOut not allowed");
    });

    it("enforces the per-trade cap", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      const tooBig = ethers.parseUnits("101", 18); // cap is 100
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        tooBig,
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), tooBig, 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: exceeds per-trade cap");
    });

    it("enforces the rolling per-day cap across multiple trades", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      const first = ethers.parseUnits("80", 18);
      const second = ethers.parseUnits("80", 18); // 80 + 80 = 160 > 150 day cap

      const calldataFor = async (amt) =>
        router.interface.encodeFunctionData("swap", [await usdt.getAddress(), await weth.getAddress(), amt, ethers.parseUnits("1", 18)]);

      await vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), first, 1, await calldataFor(first));

      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), second, 1, await calldataFor(second))
      ).to.be.revertedWith("TradeVault: exceeds per-day cap");
    });

    it("reverts on slippage below minAmountOut", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      const amountIn = ethers.parseUnits("50", 18);
      // rate 1e18 -> 1:1, so amountOut = 50, but we demand 60 minimum
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault
          .connect(agentSigner)
          .executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, ethers.parseUnits("60", 18), swapCalldata)
      ).to.be.revertedWith("TradeVault: slippage");
    });

    it("reverts if the router call itself fails, and leaves the day cap untouched", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      await router.setForceFail(true);
      const amountIn = ethers.parseUnits("50", 18);
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: swap call failed");
    });

    it("blocks a non-agent caller from executing trades", async function () {
      const { vault, strangerSigner, usdt, weth, router } = await configuredVault();
      const amountIn = ethers.parseUnits("10", 18);
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault.connect(strangerSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: not agent");
    });
  });

  // The threat model here is a COMPROMISED AGENT KEY. `minAmountOut` is an
  // agent-supplied argument, so it cannot be trusted to protect the owner —
  // an attacker simply passes 1 wei. The owner-set rate floor is the bound the
  // agent has no way to talk past.
  describe("compromised-agent bounds", function () {
    async function configuredVault() {
      const ctx = await deployFixture();
      await ctx.vault.connect(ctx.ownerSigner).setRouter(await ctx.router.getAddress());
      await ctx.vault.connect(ctx.ownerSigner).setSpender(await ctx.router.getAddress());
      await ctx.vault
        .connect(ctx.ownerSigner)
        .setTokenIn(await ctx.usdt.getAddress(), true, ethers.parseUnits("100", 18), ethers.parseUnits("150", 18));
      await ctx.vault.connect(ctx.ownerSigner).setTokenOut(await ctx.weth.getAddress(), true);
      return ctx;
    }

    it("rejects minAmountOut of zero, which would accept any output at all", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      const amountIn = ethers.parseUnits("10", 18);
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("1", 18),
      ]);
      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, 0, swapCalldata)
      ).to.be.revertedWith("TradeVault: minAmountOut must be > 0");
    });

    it("stops an agent that passes 1 wei to dodge its own slippage check", async function () {
      const { vault, ownerSigner, agentSigner, usdt, weth, router } = await configuredVault();
      // Owner: "never accept worse than 0.9 WETH per 1 USDT on this pair."
      await vault
        .connect(ownerSigner)
        .setMinOutRate(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("0.9", 18));

      const amountIn = ethers.parseUnits("10", 18);
      // Attacker routes at a terrible rate (0.1 out per 1 in) and passes
      // minAmountOut = 1 so their own slippage check trivially passes.
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("0.1", 18),
      ]);

      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, 1, swapCalldata)
      ).to.be.revertedWith("TradeVault: below owner min rate");
    });

    it("still allows an honest trade that clears the owner's floor", async function () {
      const { vault, ownerSigner, agentSigner, usdt, weth, router } = await configuredVault();
      await vault
        .connect(ownerSigner)
        .setMinOutRate(await usdt.getAddress(), await weth.getAddress(), ethers.parseUnits("0.9", 18));

      const amountIn = ethers.parseUnits("10", 18);
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("1", 18), // 1:1, comfortably above the 0.9 floor
      ]);

      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, 1, swapCalldata)
      ).to.emit(vault, "TradeExecuted");
    });

    it("skips the floor when the owner has not configured one (rate 0)", async function () {
      const { vault, agentSigner, usdt, weth, router } = await configuredVault();
      const amountIn = ethers.parseUnits("10", 18);
      const swapCalldata = router.interface.encodeFunctionData("swap", [
        await usdt.getAddress(),
        await weth.getAddress(),
        amountIn,
        ethers.parseUnits("0.1", 18),
      ]);
      await expect(
        vault.connect(agentSigner).executeTrade(await usdt.getAddress(), await weth.getAddress(), amountIn, 1, swapCalldata)
      ).to.emit(vault, "TradeExecuted");
    });

    it("only lets the owner set the rate floor, not the agent", async function () {
      const { vault, agentSigner, strangerSigner, usdt, weth } = await configuredVault();
      for (const signer of [agentSigner, strangerSigner]) {
        await expect(
          vault.connect(signer).setMinOutRate(await usdt.getAddress(), await weth.getAddress(), 1)
        ).to.be.revertedWith("TradeVault: not owner");
      }
    });
  });
});
