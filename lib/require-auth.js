const DEFAULT_SUPABASE_URL = "https://whogvqksufltywnexkyx.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_7bCvEzVBaTqL5spkLLKQ2A_xpRBCYQg";
const AUTH_TIMEOUT_MS = 8000;

module.exports = async function requireAuth(req, res) {
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

  // Only this server-verified identity should be trusted by API handlers.
  req.authUser = Object.freeze({ id: verifiedUser.id });
  return true;
};
