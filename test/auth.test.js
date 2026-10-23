const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const requireAuth = require("../lib/require-auth");

function makeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
}

test("missing bearer token is rejected without contacting Supabase", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; throw new Error("unexpected fetch"); });
  const res = makeResponse();
  const ok = await requireAuth({ headers: {} }, res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.payload.error, /sign in/i);
  assert.equal(called, false);
});

test("valid bearer token is verified and server identity is attached", async (t) => {
  let captured;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    captured = { url: String(url), options };
    return new Response(JSON.stringify({ id: "verified-user-id", email: "test@example.invalid" }), {
      status: 200, headers: { "Content-Type": "application/json" }
    });
  });
  const req = { headers: { authorization: "Bearer test-access-token" } };
  const res = makeResponse();
  const ok = await requireAuth(req, res);
  assert.equal(ok, true);
  assert.equal(req.authUser.id, "verified-user-id");
  assert.match(captured.url, /\/auth\/v1\/user$/);
  assert.equal(captured.options.headers.Authorization, "Bearer test-access-token");
  assert.ok(captured.options.headers.apikey);
});

test("invalid or expired bearer token is rejected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "invalid token" }), { status: 401 }));
  const res = makeResponse();
  const ok = await requireAuth({ headers: { authorization: "Bearer expired-token" } }, res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.payload.error, /invalid or expired/i);
});

test("authentication provider outage fails closed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network down"); });
  const res = makeResponse();
  const ok = await requireAuth({ headers: { authorization: "Bearer token" } }, res);
  assert.equal(ok, false);
  assert.equal(res.statusCode, 503);
});

test("all AI and speech endpoints enforce authentication before processing", () => {
  for (const file of ["api/chat.js", "api/agent.js", "api/speech.js"]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(source, /require\(["']\.\.\/lib\/require-auth["']\)/, file + " imports auth helper");
    const callAt = source.indexOf("await requireAuth(req, res)");
    assert.notEqual(callAt, -1, file + " calls auth helper");
    const protectedWork = ["const apiKey", "const body", "const lastUser"].map((marker) => {
      const index = source.indexOf(marker);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    }).filter((index) => index !== Number.MAX_SAFE_INTEGER);
    assert.ok(protectedWork.every((index) => callAt < index), file + " authenticates before API/body work");
  }
});

test("frontend sends a session bearer token to chat, agent, and speech APIs", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.match(html, /async function apiAuthHeaders\(\)/);
  assert.equal((html.match(/\.\.\.await apiAuthHeaders\(\)/g) || []).length, 2);
});
