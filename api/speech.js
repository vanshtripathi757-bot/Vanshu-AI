const MAX_TEXT_LENGTH = 3500;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }
  const apiKey = process.env.SPEECH_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "Speech is not configured. Add SPEECH_API_KEY in Vercel and redeploy." });
  const body = req.body || {};
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || text.length > MAX_TEXT_LENGTH) return res.status(400).json({ error: "Speech text must be between 1 and 3,500 characters." });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let response;
  try {
    response = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
        "model": process.env.SPEECH_MODEL || "s2.1-pro-free",
        "Accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text,
        format: "mp3",
        mp3_bitrate: 128,
        normalize: true,
        latency: "normal"
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timer);
    return res.status(error && error.name === "AbortError" ? 504 : 503).json({ error: error && error.name === "AbortError" ? "Fish Audio request timed out. Please try again." : "Could not connect to Fish Audio." });
  }
  clearTimeout(timer);
  if (!response.ok) {
    let detail = "";
    try { detail = String((await response.text()).slice(0, 180)); } catch {}
    if (response.status === 401 || response.status === 403) return res.status(502).json({ error: "Fish Audio rejected SPEECH_API_KEY. Check that it is a valid Fish Audio API key." });
    if (response.status === 402) return res.status(503).json({ error: "Fish Audio requires available credits or an eligible plan for this request." });
    if (response.status === 429) return res.status(503).json({ error: "Fish Audio rate limit reached. Please wait and try again." });
    return res.status(503).json({ error: "Fish Audio TTS failed with status " + response.status + (detail ? ". " + detail : "") });
  }
  const audio = Buffer.from(await response.arrayBuffer());
  res.status(200);
  res.setHeader("Content-Type", response.headers.get("content-type") || "audio/mpeg");
  res.setHeader("Content-Length", String(audio.length));
  res.setHeader("Content-Disposition", "inline; filename=answer.mp3");
  return res.send(audio);
};
