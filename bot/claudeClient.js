const Anthropic = require("@anthropic-ai/sdk").default;

module.exports = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
