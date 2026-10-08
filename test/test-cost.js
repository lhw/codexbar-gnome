// Headless parsing tests for cost. Run: gjs -m test/test-cost.js

import GLib from "gi://GLib";

const ROOT = GLib.get_current_dir();
const { parseCostPayload, formatMoney, formatTokens } = await import(
  GLib.filename_to_uri(GLib.build_filenamev([ROOT, "cost.js"]), null)
);

let failed = 0;
let passed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}\n         got:      ${a}\n         expected: ${e}`);
  }
}

console.log("money formatting matches the macOS rows");
check("sub-dollar", formatMoney(0.04), "$0.04");
check("dollars", formatMoney(254.24), "$254.24");
check("zero", formatMoney(0), "$0");
check("whole", formatMoney(2000), "$2000");
check("other currency", formatMoney(12.5, "EUR"), "€12.50");
check("not a number", formatMoney("x"), "-");

console.log("token formatting");
check("thousands", formatTokens(15000), "15K");
check("millions", formatTokens(218000000), "218.0M");
check("billions", formatTokens(1226402124), "1.2B");
check("small", formatTokens(842), "842");
check("zero", formatTokens(0), "0");

console.log("real CLI payload with no usage hides the section");
const [ok, bytes] = GLib.file_get_contents(
  GLib.build_filenamev([ROOT, "fixtures", "cost-all.json"]),
);
const real = parseCostPayload(JSON.parse(new TextDecoder().decode(bytes)));
check("all-zero payload", real, null);

console.log("payload with spend sums into the two rows");
const spent = parseCostPayload([
  { provider: "codex", currencyCode: "USD", totals: { totalCost: 12.5, totalTokens: 1_500_000 }, sessionCostUSD: 0.04, sessionTokens: 15_000 },
  { provider: "claude", currencyCode: "USD", totals: { totalCost: 241.74, totalTokens: 216_500_000 }, sessionCostUSD: 0, sessionTokens: 0 },
]);
check("total cost", spent.total, 254.24);
check("total tokens", spent.totalTokens, 218_000_000);
check("today cost", spent.today, 0.04);
check("today tokens", spent.todayTokens, 15_000);
check("currency", spent.currency, "USD");
check("provider count", spent.providers.length, 2);

console.log("per-provider errors and empties are skipped");
const mixed = parseCostPayload([
  { provider: "opencodego", error: { message: "cost is only supported for..." } },
  { provider: "codex", totals: { totalCost: 0, totalTokens: 0 } },
  { provider: "claude", totals: { totalCost: 3, totalTokens: 100 } },
]);
check("one survivor", mixed.providers.length, 1);
check("survivor id", mixed.providers[0].id, "claude");

console.log("malformed payloads do not throw");
check("null", parseCostPayload(null), null);
check("empty", parseCostPayload([]), null);
check("not an array", parseCostPayload({ totalCost: 5 }), null);
check("null entries", parseCostPayload([null, undefined]), null);

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);
