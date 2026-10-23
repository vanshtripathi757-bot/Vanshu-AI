const MAX_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TOTAL_LENGTH = 24000;
const MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: "AI backend not configured. Add GEMINI_API_KEY in this Vercel project's Environment Variables, then redeploy."
    });
  }

  const body = req.body || {};
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: "Send at least one message." });
  }

  const contents = [];
  let total = 0;
  for (const item of body.messages.slice(-MAX_MESSAGES)) {
    if (!item || !["user", "assistant"].includes(item.role) || typeof item.content !== "string") {
      return res.status(400).json({ error: "Invalid chat message format." });
    }
    const text = item.content.trim();
    if (!text || text.length > MAX_MESSAGE_LENGTH) {
      return res.status(400).json({ error: "Each message must be between 1 and 8,000 characters." });
    }
    total += text.length;
    contents.push({ role: item.role === "assistant" ? "model" : "user", parts: [{ text }] });
  }
  if (total > MAX_TOTAL_LENGTH) {
    return res.status(413).json({ error: "Conversation too long. Start a new chat and try again." });
  }
  if (contents[contents.length - 1].role !== "user") {
    return res.status(400).json({ error: "The latest message must be from the user." });
  }

  const payload = {
    system_instruction: {
      parts: [{
        text: "You are Vanshu AI, a helpful, thoughtful, honest personal assistant. Answer clearly and naturally. Explain complex things step by step when useful. For schoolwork, help the learner understand rather than only giving unexplained answers. Never claim to have performed actions you did not perform. If unsure, say so."
      }]
    },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
  };

  try {
    let lastStatus = 502;
    let lastMessage = "The AI provider returned an error.";

    for (const model of MODELS) {
      const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(45000)
        }
      );
      const result = await response.json().catch(() => ({}));

      if (response.ok) {
        const reply = (result.candidates?.[0]?.content?.parts || [])
          .map(part => part.text || "")
          .join("")
          .trim();
        if (reply) return res.status(200).json({ reply, model });
        lastStatus = 502;
        lastMessage = "Gemini returned an empty answer.";
        continue;
      }

      lastStatus = response.status;
      lastMessage = result?.error?.message || "The AI provider returned an error.";

      // Try the next listed model when this model is temporarily overloaded.
      const temporary = response.status === 429 || response.status === 503 ||
        /high demand|overload|temporarily unavailable|resource exhausted/i.test(lastMessage);
      if (!temporary) {
        return res.status(response.status === 429 ? 429 : 502).json({
          error: response.status === 429
            ? "AI usage limit reached. Please wait and try again."
            : "Gemini API error: " + lastMessage.slice(0, 220)
        });
      }
    }

    return res.status(lastStatus === 429 ? 429 : 503).json({
      error: "Gemini models are temporarily busy or unavailable. Please wait a little and try again. Details: " + lastMessage.slice(0, 160)
    });
  } catch (error) {
    return res.status(502).json({
      error: error?.name === "TimeoutError"
        ? "The AI request timed out. Please try again."
        : "Could not reach Gemini. Check your deployment and try again."
    });
  }
};