const MAX_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TOTAL_LENGTH = 24000;
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-3.8-flash"];
const MODEL_TIMEOUT_MS = 12000;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "AI backend not configured. Add GEMINI_API_KEY in this Vercel project's Environment Variables, then redeploy." });
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

  const p = body.profile && typeof body.profile === "object" ? body.profile : {};
  const safeName = typeof p.display_name === "string" ? p.display_name.replace(/[<>\r\n]/g, "").slice(0, 40) : "";
  const safeAge = ["13–15", "16–17", "18–24", "25+", "Prefer not to say"].includes(p.age_range) ? p.age_range : "";
  const safeProfession = ["Student", "Developer", "Designer / video editor", "Content creator", "Business / entrepreneur", "Other", "Prefer not to say"].includes(p.profession) ? p.profession : "";
  const personalization = safeName
    ? "\nThe user's preferred name is " + safeName + (safeAge ? ". Their age range is " + safeAge : "") + (safeProfession ? ". Their role is " + safeProfession : "") + ". Use this only to personalize tone and examples appropriately; do not assume anything else."
    : "";

  const payload = {
    system_instruction: {
      parts: [{
        text: "You are Vanshu AI, a helpful, thoughtful, honest personal assistant. Answer clearly and naturally. Explain complex things step by step when useful. For schoolwork, help the learner understand rather than only giving unexplained answers. Never claim to have performed actions you did not perform. If unsure, say so." + personalization
      }]
    },
    contents,
    generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
  };

  let lastMessage = "The AI provider returned an error.";
  let sawTimeout = false;
  for (const model of MODELS) {
    let response;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse",
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify(payload),
          signal: controller.signal
        }
      );
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        sawTimeout = true;
        lastMessage = model + " timed out before streaming began.";
        continue;
      }
      lastMessage = "Could not reach Gemini: " + (error?.message || "network error");
      continue;
    } finally {
      // Limit the connection/header wait, not the full response stream.
      clearTimeout(timeoutId);
    }

    if (response.ok && response.body) {
      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!res.write(Buffer.from(value))) {
            await new Promise(resolve => res.once("drain", resolve));
          }
        }
      } catch (error) {
        // Client disconnects are expected sometimes; do not expose provider details.
      } finally {
        try { reader.releaseLock(); } catch {}
        res.end();
      }
      return;
    }

    let result = {};
    try { result = await response.json(); } catch {}
    lastMessage = result?.error?.message || "The AI provider returned an error.";
    const temporary = response.status === 429 || response.status === 503 ||
      /high demand|overload|temporarily unavailable|resource exhausted|try again later/i.test(lastMessage);
    if (!temporary && response.status !== 500 && response.status !== 502) {
      return res.status(response.status === 401 || response.status === 403 ? 502 : response.status).json({
        error: "Gemini API error: " + lastMessage.slice(0, 220)
      });
    }
  }

  return res.status(503).json({
    error: sawTimeout
      ? "Gemini is taking too long right now. I tried multiple models; please wait a moment and try again."
      : "Gemini models are temporarily busy or unavailable. Please wait a moment and try again. Details: " + lastMessage.slice(0, 140)
  });
};
