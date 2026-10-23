const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/speech");

test("speech API uses the configured OpenRouter key and returns MP3 audio", async (t) => {
  const previous = {
    key: process.env.OPENRPUTER_SPEECH_AI,
    model: process.env.OPENROUTER_TTS_MODEL,
    voice: process.env.OPENROUTER_TTS_VOICE
  };
  process.env.OPENRPUTER_SPEECH_AI = "test-speech-key";
  delete process.env.OPENROUTER_TTS_MODEL;
  delete process.env.OPENROUTER_TTS_VOICE;
  t.after(() => {
    if (previous.key === undefined) delete process.env.OPENRPUTER_SPEECH_AI; else process.env.OPENRPUTER_SPEECH_AI = previous.key;
    if (previous.model === undefined) delete process.env.OPENROUTER_TTS_MODEL; else process.env.OPENROUTER_TTS_MODEL = previous.model;
    if (previous.voice === undefined) delete process.env.OPENROUTER_TTS_VOICE; else process.env.OPENROUTER_TTS_VOICE = previous.voice;
  });

  let requestBody;
  let providerAuthorization;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) return new Response(JSON.stringify({ id: "verified-user-id" }), { status: 200 });
    if (target.endsWith("/rest/v1/rpc/consume_api_rate_limit")) return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    if (target.endsWith("/api/v1/audio/speech")) {
      providerAuthorization = options.headers.Authorization;
      requestBody = JSON.parse(options.body);
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
    }
    throw new Error("Unexpected fetch URL: " + target);
  });

  const res = {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    send(value) { this.body = value; this.writableEnded = true; return this; },
    json(value) { this.payload = value; this.writableEnded = true; return this; }
  };
  await handler({
    method: "POST",
    headers: { authorization: "Bearer test-access-token" },
    body: { text: "Hello from Vanshu AI." }
  }, res);

  assert.equal(providerAuthorization, "Bearer test-speech-key");
  assert.equal(requestBody.model, "microsoft/mai-voice-2.1-flash");
  assert.equal(requestBody.voice, "en-US-Harper:MAI-Voice-2.1-Flash");
  assert.equal(requestBody.response_format, "mp3");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "audio/mpeg");
  assert.equal(res.body.length, 3);
});
