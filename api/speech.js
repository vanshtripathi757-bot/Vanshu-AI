const MAX_TEXT_LENGTH = 3500;
const REQUEST_TIMEOUT_MS = 25000;

const requireAuth = require("../lib/require-auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  // The API key stays server-side.

  if (!(await requireAuth(req, res))) return; This name matches the Vercel environment variable.
  const apiKey = process.env.OPENRPUTER_SPEECH_AI;
  if (!apiKey) {
    return res.status(503).json({ error: "Voice replies are not configured. Add OPENRPUTER_SPEECH_AI to Vercel and redeploy." });
  }

  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT_LENGTH) {
    return res.status(400).json({ error: "Speech text must be between 1 and 3,500 characters." });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vanshu-ai.vercel.app",
        "X-Title": "Vanshu AI",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_TTS_MODEL || "microsoft/mai-voice-2.1-flash",
        input: text,
        voice: process.env.OPENROUTER_TTS_VOICE || "en-US-Harper:MAI-Voice-2.1-Flash",
        response_format: "mp3"
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    return res.status(error && error.name === "AbortError" ? 504 : 503).json({
      error: error && error.name === "AbortError" ? "Voice generation timed out. Please try again." : "Could not connect to the speech service."
    });
  }
  clearTimeout(timer);

  if (!response.ok) {
    let detail = "";
    try {
      const data = await response.json();
      detail = String(data && data.error && (data.error.message || data.error) || "");
    } catch {}
    if (response.status === 401 || response.status === 403) return res.status(502).json({ error: "OpenRouter rejected OPENRPUTER_SPEECH_AI. Check that the configured key is valid." });
    if (response.status === 402) return res.status(503).json({ error: "OpenRouter TTS requires available credits or an eligible plan." });
    if (response.status === 429) return res.status(503).json({ error: "The speech service rate limit was reached. Please try again shortly." });
    return res.status(503).json({ error: "OpenRouter TTS failed (" + response.status + "). " + detail.slice(0, 160) });
  }

  const contentType = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "audio/mpeg") {
    try { await response.body?.cancel(); } catch {}
    return res.status(502).json({ error: "The speech service returned an unexpected audio format." });
  }
  let audio;
  try { audio = Buffer.from(await response.arrayBuffer()); }
  catch { return res.status(502).json({ error: "Could not read the generated audio. Please try again." }); }
  if (!audio.length) return res.status(502).json({ error: "The speech service returned empty audio." });

  res.status(200);
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Content-Length", String(audio.length));
  res.setHeader("Content-Disposition", "inline; filename=answer.mp3");
  return res.send(audio);
};
