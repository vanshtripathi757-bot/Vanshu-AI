const MAX_MESSAGES = 16;
const MAX_MESSAGE_LENGTH = 8000;
const MAX_TOTAL_LENGTH = 24000;
const MODEL_TIMEOUT_MS = 30000;

const requireAuth = require("../lib/require-auth");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!(await requireAuth(req, res, "chat"))) return;

  const apiKey = process.env.OPENROUTER_API_KEY || process.env.INTELLIGENCE_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "Intelligence backend not configured. Add OPENROUTER_API_KEY in Vercel, then redeploy." });
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
    ? "You are Vanshu AI Agent, a precise task-oriented assistant. For complex requests, identify the goal, break it into ordered steps, track constraints, check assumptions, and verify the final result before answering. Never claim external actions were completed unless they actually were. "
    : "You are Vanshu AI, a highly capable general assistant. Prioritize correctness, useful reasoning, clear explanations, and practical next steps. Adapt detail to the question: concise for simple questions, structured and thorough for complex ones. For math, calculate carefully and show key steps when useful. For coding, explain root cause, provide complete working fixes, check edge cases, and never invent test results. For ambiguous requests, ask one focused clarification; otherwise state reasonable assumptions. For uncertain or changing facts, be transparent and do not fabricate citations, sources, or current information. For school topics, explain at the learner's level without sacrificing accuracy. ") +
    "Follow the user's language, including natural Hindi/Hinglish when they use it. Use plain text only. Never output Markdown formatting or decorative symbols: do not use **, ##, backticks, bullet characters, or heading markers. Use short paragraphs and simple numbered lines only when needed. Keep simple answers to 1–4 sentences. Do not repeat the question. Do not mention hidden reasoning or internal tools." + personalization;
  
  const messages = contents.map(item => ({ role: item.role === "model" ? "assistant" : "user", content: item.parts[0].text }));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + apiKey,
        "HTTP-Referer": "https://vanshu-ai.vercel.app",
        "X-Title": "Vanshu AI"
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_FAST_MODEL || process.env.INTELLIGENCE_MODEL || process.env.OPENROUTER_MODEL || "nvidia/nemotron-3.5-lightning:free",
        messages: [{ role: "system", content: system }, ...messages],
        temperature: 0.3,
        max_tokens: 700,
        stream: true
      }),
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(timeoutId);
    return res.status(error && error.name === "AbortError" ? 504 : 503).json({
      error: error && error.name === "AbortError" ? "The AI request timed out. Please try again." : "Could not connect to the AI service. Please try again."
    });
  }

  if (!response.ok) {
    clearTimeout(timeoutId);
    let detail = "";
    try {
      const data = await response.json();
      detail = String(data && data.error && data.error.message || "");
    } catch {}
    if (response.status === 401 || response.status === 403) return res.status(502).json({ error: "OpenRouter rejected the API key. Check OPENROUTER_API_KEY in Vercel." });
    if (response.status === 402) return res.status(503).json({ error: "OpenRouter requires available credits or payment. Check your account limits." });
    if (response.status === 429) return res.status(503).json({ error: "OpenRouter rate limit reached. Please wait and try again." });
    return res.status(503).json({ error: "OpenRouter request failed (" + response.status + "). " + detail.slice(0, 160) });
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    clearTimeout(timeoutId);
    return res.status(502).json({ error: "The AI service did not provide a streaming response." });
  }

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  function sendText(piece) {
    if (!piece) return;
    res.write("data: " + JSON.stringify({ candidates: [{ content: { parts: [{ text: piece }] } }] }) + "\n\n");
  }

  function consumeEvent(event) {
    for (const line of event.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (!raw) continue;
      if (raw === "[DONE]") { finished = true; return; }
      let data;
      try { data = JSON.parse(raw); } catch { continue; }
      if (data && data.error) throw new Error(String(data.error.message || data.error).slice(0, 180));
      const delta = data && data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content;
      const piece = typeof delta === "string"
        ? delta
        : Array.isArray(delta)
          ? delta.map(part => typeof part === "string" ? part : String(part && part.text || "")).join("")
          : "";
      sendText(piece);
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        consumeEvent(event);
        if (finished) break;
      }
      if (done) {
        if (buffer.trim() && !finished) consumeEvent(buffer);
        break;
      }
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  } catch {
    try { await reader.cancel(); } catch {}
    if (!res.writableEnded) {
      res.write("data: " + JSON.stringify({ error: "The AI response was interrupted. Please try again." }) + "\n\n");
      res.write("data: [DONE]\n\n");
      return res.end();
    }
  } finally {
    clearTimeout(timeoutId);
  }
};
