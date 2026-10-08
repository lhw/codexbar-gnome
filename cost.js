// Pure parsing of `codexbar cost --format json` into the two rows the popup
// shows. No gi:// imports.

/**
 * @param {number} value
 * @param {string} currency ISO code.
 * @returns {string} e.g. "$0.04"
 */
export function formatMoney(value, currency = "USD") {
  const n = Number(value);
  if (!Number.isFinite(n)) return "-";
  const symbol = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" }[currency];
  const abs = Math.abs(n);
  // Whole amounts read better without decimals; everything else keeps cents.
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  const sign = n < 0 ? "-" : "";
  return symbol ? `${sign}${symbol}${body}` : `${sign}${body} ${currency}`;
}

/**
 * @param {number} value
 * @returns {string} e.g. "15K", "1.2M"
 */
export function formatTokens(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * Parse the CLI payload into a cost summary.
 * `codexbar cost` only supports a subset of providers, so the payload can be
 * a mix of entries and per-provider error objects. Entries with no usage are
 * dropped; an all-error payload yields null so the caller hides the section.
 *
 * @param {unknown} payload Parsed JSON from `codexbar cost --format json`.
 * @returns {{total: number, totalTokens: number, currency: string,
 *            providers: Array<object>}|null}
 */
export function parseCostPayload(payload) {
  const list = Array.isArray(payload) ? payload : [];
  const providers = [];

  for (const entry of list) {
    if (!entry || typeof entry !== "object" || entry.error) continue;
    const cost = entry.totals?.totalCost;
    const tokens = entry.totals?.totalTokens;
    if (!Number.isFinite(Number(cost)) && !Number.isFinite(Number(tokens))) continue;
    // A provider with neither spend nor tokens has nothing to show.
    if (!Number(cost) && !Number(tokens)) continue;

    providers.push({
      id: entry.provider,
      cost: Number(cost) || 0,
      tokens: Number(tokens) || 0,
      currency: entry.currencyCode || "USD",
      todayCost: Number(entry.sessionCostUSD) || 0,
      todayTokens: Number(entry.sessionTokens) || 0,
    });
  }

  if (providers.length === 0) return null;

  return {
    total: providers.reduce((sum, p) => sum + p.cost, 0),
    totalTokens: providers.reduce((sum, p) => sum + p.tokens, 0),
    today: providers.reduce((sum, p) => sum + p.todayCost, 0),
    todayTokens: providers.reduce((sum, p) => sum + p.todayTokens, 0),
    currency: providers[0].currency,
    providers,
  };
}