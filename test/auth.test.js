const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const requireAuth = require("../lib/require-auth");

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.payload = value; return this; }
  };
}

function mockSuccessfulSupabase(t, allowed = true) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/auth/v1/user")) {
      return new Response(JSON.stringify({ id: "verified-user-id", email: "test@example.invalid" }), {
        status: 200, headers: { "Content-Type": "application/json" }
      });
    }
    if (String(url).endsWith("/rest/v1/rpc/consume_api_rate_limit")) {
      return new Response(JSON.stringify(allowed), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    throw new Error("Unexpected Supabase endpoint");
  });
  return calls;
}

test("missing bearer token is rejected without contacting Supabase", async (t) => {
  let called = false;
  t.mock.method(globalThis, "fetch", async () => { called = true; throw new Error("unexpected fetch"); });
  const res = makeResponse();
  const ok = await requireAuth({ headers: {} }, res, "chat");
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.payload.error, /sign in/i);
  assert.equal(called, false);
});

test("valid bearer token is verified and rate-limited", async (t) => {
  const calls = mockSuccessfulSupabase(t, true);
  const req = { headers: { authorization: "Bearer test-access-token" } };
  const res = makeResponse();
  const ok = await requireAuth(req, res, "chat");
  assert.equal(ok, true);
  assert.equal(req.authUser.id, "verified-user-id");
  assert.match(calls[0].url, /\/auth\/v1\/user$/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer test-access-token");
  assert.ok(calls[0].options.headers.apikey);
  assert.match(calls[1].url, /\/rest\/v1\/rpc\/consume_api_rate_limit$/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { p_endpoint: "chat" });
});

test("invalid or expired bearer token is rejected", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ message: "invalid token" }), { status: 401 }));
  const res = makeResponse();
  const ok = await requireAuth({ headers: { authorization: "Bearer expired-token" } }, res, "chat");
  assert.equal(ok, false);
  assert.equal(res.statusCode, 401);
  assert.match(res.payload.error, /invalid or expired/i);
});

test("authentication provider outage fails closed", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network down"); });
  const res = makeResponse();
  const ok = await requireAuth({ headers: { authorization: "Bearer token" } }, res, "chat");
  assert.equal(ok, false);
  assert.equal(res.statusCode, 503);
});

test("requests over the per-user quota receive 429 and Retry-After", async (t) => {
  mockSuccessfulSupabase(t, false);
  const res = makeResponse();
  const ok = await requireAuth({ headers: { authorization: "Bearer token" } }, res, "agent");
  assert.equal(ok, false);
  assert.equal(res.statusCode, 429);
  assert.equal(res.headers["Retry-After"], "60");
});

test("all AI and speech endpoints enforce authentication before processing", () => {
  for (const [file, endpoint] of [["api/chat.js", "chat"], ["api/agent.js", "agent"], ["api/speech.js", "speech"]]) {
    const source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    assert.match(source, /require\(["']\.\.\/lib\/require-auth["']\)/, file + " imports auth helper");
    const callAt = source.indexOf('await requireAuth(req, res, "' + endpoint + '")');
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

test("message insert migration requires ownership of the linked conversation", () => {
  const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20261023164000_enforce_message_conversation_ownership.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /ON public\.chat_messages\s+FOR INSERT\s+TO authenticated/i);
  assert.match(sql, /owner_id = \(SELECT auth\.uid\(\)\)/i);
  assert.match(sql, /c\.owner_id = \(SELECT auth\.uid\(\)\)/i);
  assert.match(sql, /c\.id = chat_messages\.conversation_id/i);
});

test("rate-limit migration uses fixed quotas and denies direct table access", () => {
  const migrationPath = path.join(__dirname, "..", "supabase", "migrations", "20261023165000_add_database_api_rate_limits.sql");
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.api_rate_limits FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /WHEN 'chat' THEN v_limit := 20/i);
  assert.match(sql, /WHEN 'agent' THEN v_limit := 6/i);
  assert.match(sql, /WHEN 'speech' THEN v_limit := 30/i);
  assert.match(sql, /auth\.uid\(\)/i);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.consume_api_rate_limit\(text\) FROM PUBLIC, anon/i);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.consume_api_rate_limit\(text\) TO authenticated/i);
});
