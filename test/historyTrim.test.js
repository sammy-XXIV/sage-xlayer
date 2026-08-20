// Regression test for the history-truncation bug.
//
// A naive slice(-N) could leave a window starting on a user message that
// carries tool_result blocks whose matching assistant tool_use had just been
// cut off. The Anthropic API rejects that, and because the bad prefix stayed
// cached, every subsequent message in that chat failed too.

const { expect } = require("chai");
const path = require("path");

const AGENT_PATH = path.join(__dirname, "..", "bot", "agent.js");

// agent.js pulls in the Anthropic client at require time, so stub the module
// it depends on rather than hitting the network.
function loadAgentInternals() {
  const CLIENT_PATH = path.join(__dirname, "..", "bot", "claudeClient.js");
  delete require.cache[require.resolve(AGENT_PATH)];
  delete require.cache[require.resolve(CLIENT_PATH)];
  require.cache[require.resolve(CLIENT_PATH)] = {
    id: require.resolve(CLIENT_PATH),
    filename: require.resolve(CLIENT_PATH),
    loaded: true,
    exports: { messages: { create: async () => ({}) } },
  };
  return require(AGENT_PATH);
}

// Mirrors the exported trimming contract: the first message must be one the
// API will accept as a conversation opener.
function isValidOpener(msg) {
  if (!msg) return false;
  if (msg.role !== "user") return false;
  if (Array.isArray(msg.content) && msg.content.some((b) => b.type === "tool_result")) return false;
  return true;
}

describe("agent history trimming", function () {
  let trimHistory;
  before(function () {
    const agent = loadAgentInternals();
    trimHistory = agent.__trimHistory;
  });

  function buildToolHeavyHistory(turns) {
    const history = [];
    for (let i = 0; i < turns; i++) {
      history.push({ role: "user", content: `msg ${i}` });
      history.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "get_portfolio", input: {} }] });
      history.push({ role: "user", content: [{ type: "tool_result", tool_use_id: `t${i}`, content: "{}" }] });
      history.push({ role: "assistant", content: [{ type: "text", text: `reply ${i}` }] });
    }
    return history;
  }

  it("never starts a trimmed window on an orphaned tool_result", function () {
    for (let turns = 1; turns <= 12; turns++) {
      const trimmed = trimHistory(buildToolHeavyHistory(turns), 20);
      expect(isValidOpener(trimmed[0]), `turns=${turns} produced an invalid opener`).to.equal(true);
    }
  });

  it("never starts a trimmed window on an assistant message", function () {
    const trimmed = trimHistory(buildToolHeavyHistory(10), 6);
    expect(trimmed[0].role).to.equal("user");
  });

  it("demonstrates the naive slice would have been invalid", function () {
    // Same input, old behaviour: plain slice(-N).
    const history = buildToolHeavyHistory(10);
    const naive = history.slice(-6);
    const fixed = trimHistory(history, 6);

    expect(isValidOpener(naive[0])).to.equal(false); // the bug
    expect(isValidOpener(fixed[0])).to.equal(true); // the fix
  });

  it("keeps the trimmed window within the requested limit", function () {
    const trimmed = trimHistory(buildToolHeavyHistory(10), 8);
    expect(trimmed.length).to.be.at.most(8);
    expect(trimmed.length).to.be.greaterThan(0);
  });

  it("falls back to a real opener when the window has none", function () {
    // A window landing entirely inside one tool exchange: the naive fallback
    // (history.slice(-1)) would hand back an assistant message.
    const history = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: "{}" }] },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];
    const trimmed = trimHistory(history, 2);
    expect(isValidOpener(trimmed[0])).to.equal(true);
  });

  it("returns an empty window rather than an invalid one", function () {
    const onlyAssistant = [{ role: "assistant", content: [{ type: "text", text: "orphan" }] }];
    expect(trimHistory(onlyAssistant, 5)).to.deep.equal([]);
  });
});
