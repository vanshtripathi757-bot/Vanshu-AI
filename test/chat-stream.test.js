const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/chat");

test("chat API streams OpenRouter deltas as client-compatible SSE events", async (t) => {
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  let upstreamBody;
  const encoder = new TextEncoder();
  const upstreamEvents = [
    'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"world!"}}]}\n\n',
    "data: [DONE]\n\n"
  ];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    const target = String(url);
    if (target.endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "verified-user-id" }), { status: 200 });
    }
    if (target.endsWith("/rest/v1/rpc/consume_api_rate_limit")) {
      return new Response("true", { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (target.endsWith("/api/v1/chat/completions")) {
      upstreamBody = JSON.parse(options.body);
      const stream = new ReadableStream({
        start(controller) {
          for (const event of upstreamEvents) controller.enqueue(encoder.encode(event));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error("Unexpected fetch URL: " + target);
  });

  const output = [];
  const res = {
    statusCode: 200,
    headers: {},
    writableEnded: false,
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    flushHeaders() {},
    write(value) { output.push(String(value)); return true; },
    end() { this.writableEnded = true; return this; },
    json(value) { this.payload = value; this.writableEnded = true; return this; }
  };

  await handler({
    method: "POST",
    headers: { authorization: "Bearer test-access-token" },
    body: { messages: [{ role: "user", content: "Say hello" }], mode: "chat", profile: {} }
  }, res);

  assert.equal(upstreamBody.stream, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.writableEnded, true);
  const events = output.join("");
  assert.match(events, /"text":"Hello "/);
  assert.match(events, /"text":"world!"/);
  assert.match(events, /data: \[DONE\]/);
});
