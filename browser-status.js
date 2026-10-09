// Sanitized session-error copy shared by the popup and Preferences.
const ERROR_CODES = ["session-invalid", "session-missing", "access-denied", "cloudflare-challenge", "network-error"];

export function validBrowserSessionError(data, profile, provider, now = Date.now()) {
  const age = (now - Date.parse(data?.updatedAt)) / 1000;
  return data?.status === "error" && data.source === profile && data.provider === provider &&
    typeof provider === "string" && Number.isFinite(age) && age >= 0 && age <= 3600 &&
    typeof data.error === "string" && data.error.length <= 200 &&
    (data.errorCode === undefined || ERROR_CODES.includes(data.errorCode));
}

export function browserSessionMessage(data, _ = (text) => text) {
  // Recognize old daemon caches until the installed helper has been upgraded.
  const code = data.errorCode || ({
    "browser session expired or rejected": "session-invalid",
    "selected browser profile has no matching provider session": "session-missing",
    "Cloudflare challenge": "cloudflare-challenge",
  })[data.error];
  switch (code) {
    case "session-invalid":
      return _("Browser session expired or invalid. Sign in again in the selected browser profile; usage retries automatically.");
    case "session-missing":
      return _("No usable browser session found. Sign in to this provider or choose another profile in Settings.");
    case "access-denied":
      return _("Browser usage access denied. Check this account's access; the session may still be valid.");
    case "cloudflare-challenge":
      return _("Browser usage blocked by Cloudflare. The session may still be valid; check FlareSolverr in Settings for Codex.");
    case "network-error":
      return _("Browser usage could not connect. Check your connection; the helper will retry automatically.");
    default:
      return `${_("Browser helper")}: ${data.error}`;
  }
}
