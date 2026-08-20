// Voice-note trading: transcribes a Telegram voice message (OGG/Opus) via
// OpenAI's Whisper API. Kept as a separate provider/key on purpose — Claude's
// Messages API doesn't do audio input, so this is a genuine second dependency,
// not something fakeable with what we already have.

// Whisper has no crypto vocabulary out of the box — it transcribed "WETH" as
// "WEF" in testing, and a mangled ticker turns a valid instruction into a
// guess. The prompt parameter biases decoding toward these terms; it is a hint,
// not a constraint, so unrelated speech still transcribes normally.
const DOMAIN_HINT =
  "Crypto trading commands on X Layer. Vocabulary: WETH, USDT, USDC, OKB, ETH, " +
  "swap, DCA, dollar-cost average, buy the dip, stop loss, take profit, " +
  "portfolio, vault, slippage, basis points, wallet address.";

async function transcribeAudio(audioBuffer, filename = "voice.ogg") {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY not set — voice trading needs it for Whisper transcription.");
  }

  const form = new FormData();
  form.append("file", new Blob([audioBuffer]), filename);
  form.append("model", "whisper-1");
  form.append("prompt", DOMAIN_HINT);
  form.append("language", "en");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper transcription failed: ${res.status} ${body}`);
  }

  const { text } = await res.json();
  return text;
}

module.exports = { transcribeAudio };
