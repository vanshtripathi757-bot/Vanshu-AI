const DEFAULT_SUPABASE_URL = "https://whogvqksufltywnexkyx.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7bCvEzVBaTqL5spkLLKQ2A_xpRBCYQg";
const AUTH_TIMEOUT_MS = 8000;

module.exports = async function requireAuth(req, res, endpoint) {
  const header = req && req.headers && req.headers.authorization;
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/i.exec(header.trim()) : null;
  if (!match || match[1].length > 8192) {
    res.status(401).json({ error: "Sign in is required. Please sign in and try again." });
    return false;
  }

  const supabaseUrl = String(process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, "");
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || DEFAULT_SUPABASE_PUBLISHABLE_KEY;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(supabaseUrl + "/auth/v1/user", {
      method: "GET",
      headers: {
        "Authorization": "Bearer " + match[1],
        "apikey": publishableKey,
        "Accept": "application/json"
      },
      cache: "no-store",
      signal: controller.signal
    });
  } catch {
    res.status(503).json({ error: "Authentication service is temporarily unavailable. Please try again." });
    return false;
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    res.status(401).json({ error: "Your sign-in session is invalid or expired. Please sign in again." });
    return false;
  }
  if (!response.ok) {
    res.status(503).json({ error: "Authentication service is temporarily unavailable. Please try again." });
    return false;
  }

  let verifiedUser;
  try {
    verifiedUser = await response.json();
  } catch {
    res.status(503).json({ error: "Could not verify the sign-in session. Please try again." });
    return false;
  }
  if (!verifiedUser || typeof verifiedUser.id !== "string" || !verifiedUser.id) {
    res.status(401).json({ error: "Your sign-in session is invalid or expired. Please sign in again." });
    return false;
  }

  if (!["chat", "agent", "speech"].includes(endpoint)) {
    res.status(500).json({ error: "API protection is misconfigured. Please try again later." });
    return false;
  }

  // This RPC applies fixed per-user quotas atomically in Postgres, shared across
  // serverless instances. Its migration must be applied before deploying this code.
  const rateController = new AbortController();
  const rateTimer = setTimeout(() => rateController.abort(), AUTH_TIMEOUT_MS);
  let rateResponse;
  try {
    rateResponse = await fetch(supabaseUrl + "/rest/v1/rpc/consume_api_rate_limit", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + match[1],
        "apikey": publishableKey,
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ p_endpoint: endpoint }),
      cache: "no-store",
      signal: rateController.signal
    });
  } catch {
    res.status(503).json({ error: "Request protection is temporarily unavailable. Please try again." });
    return false;
  } finally {
    clearTimeout(rateTimer);
  }

  if (!rateResponse.ok) {
    // Fail closed if the shared limiter is unavailable or not yet installed.
    res.status(503).json({ error: "Request protection is temporarily unavailable. Please try again." });
    return false;
  }

  let allowed;
  try { allowed = await rateResponse.json(); }
  catch {
    res.status(503).json({ error: "Could not verify the request limit. Please try again." });
    return false;
  }
  if (allowed !== true) {
    res.setHeader("Retry-After", "60");
    res.status(429).json({ error: "Rate limit reached for this feature. Wait a minute and try again." });
    return false;
  }

  // Only this server-verified identity should be trusted by API handlers.
  req.authUser = Object.freeze({ id: verifiedUser.id });
  return true;
};
