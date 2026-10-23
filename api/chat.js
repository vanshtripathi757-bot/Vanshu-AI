const MAX_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TOTAL_LENGTH = 24000;
const MODEL_TIMEOUT_MS = 25000;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = process.env.INTELLIGENCE_API_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Intelligence backend not configured. Add INTELLIGENCE_API_KEY (an OpenRouter-compatible key) or OPENROUTER_API_KEY in Vercel, then redeploy." });
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

  const mode = body.mode === "agent" ? "agent" : "chat";
  const p = body.profile && typeof body.profile === "object" ? body.profile : {};
  const safeName = typeof p.display_name === "string" ? p.display_name.replace(/[<>\r\n]/g, "").slice(0, 40) : "";
  const safeAge = ["13–15", "16–17", "18–24", "25+", "Prefer not to say"].includes(p.age_range) ? p.age_range : "";
  const safeProfession = ["Student", "Developer", "Designer / video editor", "Content creator", "Business / entrepreneur", "Other", "Prefer not to say"].includes(p.profession) ? p.profession : "";
  const personalization = safeName
    ? "\nThe user's preferred name is " + safeName + (safeAge ? ". Their age range is " + safeAge : "") + (safeProfession ? ". Their role is " + safeProfession : "") + ". Use this only to personalize tone and examples appropriately; do not assume anything else."
    : "";

  const system = (mode === "agent"
    ? "You are Vanshu AI Agent, a task-oriented assistant. Identify goals, plan multi-step work, and only claim actions actually completed. "
    : "You are Vanshu AI, a helpful, thoughtful, honest personal assistant. Answer clearly and explain complex things step by step when useful. ") +
    "Use clean plain text. Do not use Markdown heading markers (#), bold markers (**), or dollar signs ($). Do not mention internal tools or how an answer was computed." + personalization;
  const messages = contents.map(item => ({ role: item.role === "model" ? "assistant" : "user", content: item.parts[0].text }));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey, "HTTP-Referer": "https://vanshu-ai.vercel.app", "X-Title": "Vanshu AI" },
      body: JSON.stringify({ model: process.env.INTELLIGENCE_MODEL || process.env.OPENROUTER_FAST_MODEL || process.env.OPENROUTER_MODEL || "openrouter/free", messages: [{ role: "system", content: system }, ...messages], temperature: 0.6, max_tokens: 900 }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeoutId);
    return res.status(error && error.name === "AbortError" ? 504 : 503).json({ error: error && error.name === "AbortError" ? "The AI request timed out. Please try again." : "Could not connect to the AI service. Please try again." });
  }
  clearTimeout(timeoutId);
  if (!response.ok) {
    let detail = ""; try { const data = await response.json(); detail = String(data && data.error && data.error.message || ""); } catch {}
    if (response.status === 401 || response.status === 403) return res.status(502).json({ error: "OpenRouter rejected the API key. Check OPENROUTER_API_KEY in Vercel." });
    if (response.status === 402) return res.status(503).json({ error: "OpenRouter requires available credits or payment. Check your account limits." });
    if (response.status === 429) return res.status(503).json({ error: "OpenRouter rate limit reached. Please wait and try again." });
    return res.status(503).json({ error: "OpenRouter request failed (" + response.status + "). " + detail.slice(0, 160) });
  }
  let data; try { data = await response.json(); } catch { return res.status(502).json({ error: "The AI service returned an unreadable response." }); }
  const answer = String(data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content || "").trim();
  if (!answer) return res.status(502).json({ error: "The AI service returned an empty response." });
  res.status(200); res.setHeader("Content-Type", "text/event-stream; charset=utf-8"); res.setHeader("Cache-Control", "no-cache, no-transform"); res.setHeader("Connection", "keep-alive"); res.setHeader("X-Accel-Buffering", "no");
  res.write("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] } }] }) + "\n\n"); res.write("data: [DONE]\n\n"); return res.end();
  
};
