// Load-time tests for the display helpers in extension.js.
//
// extension.js imports shell-only modules (St, PanelMenu, Main), so it cannot
// be imported outside a shell. These tests read the source and evaluate just the
// pure helpers and the sizing math, which keeps the whole thing runnable with a
// bare `gjs -m`.
import GLib from "gi://GLib";
import { browserSessionMessage, validBrowserSessionError } from "../browser-status.js";

const src = new TextDecoder().decode(
  GLib.file_get_contents(GLib.build_filenamev([GLib.get_current_dir(), "extension.js"]))[1],
);

// The shell's gettext returns a string with String.prototype.format attached.
// Stand in for it so the helpers under test behave as they do in the shell.
// Positional args (%s, %d) consume the values in order, so "Resets in %dh %dm"
// with (3, 53) becomes "Resets in 3h 53m".
const gettext = (s) => {
  const str = new String(s);
  str.format = (...values) => {
    let i = 0;
    // Matches the shell: %% is a literal percent, %s and %d consume values.
    return s.replace(/%%|%[sd]/g, (m) => (m === "%%" ? "%" : String(values[i++])));
  };
  return str;
};

const helperSrc = src.slice(src.indexOf("function formatResetsIn"), src.indexOf("export default class"));
const helpers = new Function(
  "_",
  "validBrowserSessionError",
  `${helperSrc}; return { formatResetsIn, formatUpdated, isExceedingPace, formatPace, formatCodexPace, formatCodexDetails, barColor, fillWidth, activeProviderIndex, validBrowserSummary, validActivityHistory, validCreditHistory, historyDayDetail, browserHelperNotice };`,
)(gettext, validBrowserSessionError);
const { formatResetsIn, formatUpdated, isExceedingPace, formatPace, formatCodexPace, formatCodexDetails, barColor, fillWidth, activeProviderIndex, validBrowserSummary, validActivityHistory, validCreditHistory, historyDayDetail, browserHelperNotice } = helpers;

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

const NOW = new Date("2026-10-08T12:00:00Z");

console.log("reset countdowns match the macOS wording");
check("minutes", formatResetsIn("2026-10-08T12:53:00Z", NOW), "Resets in 53m");
check("hours and minutes", formatResetsIn("2026-10-08T15:53:00Z", NOW), "Resets in 3h 53m");
check("days and hours", formatResetsIn("2026-10-11T23:00:00Z", NOW), "Resets in 3d 11h");
check("already past", formatResetsIn("2026-10-08T11:00:00Z", NOW), "");
check("missing", formatResetsIn(null, NOW), "");

console.log("relative update stamps");
check("fresh", formatUpdated("2026-10-08T11:59:30Z", NOW), "Updated just now");
check("minutes", formatUpdated("2026-10-08T11:55:00Z", NOW), "Updated 5m ago");
check("hours", formatUpdated("2026-10-08T10:00:00Z", NOW), "Updated 2h ago");
check("days", formatUpdated("2026-10-06T12:00:00Z", NOW), "Updated 2d ago");
check("missing", formatUpdated(null, NOW), "");

console.log("pace warnings only appear when a window is over-consumed");
const win = (used, pace) => ({ usedPercent: used, pace });
check(
  "well over pace warns",
  isExceedingPace(win(97, { expectedUsedPercent: 65, stage: "farAhead", willLastToReset: false })),
  true,
);
check(
  "just over pace warns",
  isExceedingPace(win(51, { expectedUsedPercent: 50, stage: "slightlyAhead", willLastToReset: false })),
  true,
);
check(
  "exactly on pace is quiet",
  isExceedingPace(win(50, { expectedUsedPercent: 50, stage: "ahead", willLastToReset: true })),
  false,
);
check(
  "under pace is quiet",
  isExceedingPace(win(10, { expectedUsedPercent: 65, stage: "behind", willLastToReset: true })),
  false,
);
check(
  "no pace data is quiet",
  isExceedingPace(win(90, null)),
  false,
);
check(
  "willLastToReset true silences an ahead stage",
  isExceedingPace(win(90, { expectedUsedPercent: 10, stage: "ahead", willLastToReset: true })),
  false,
);
check(
  "falls back to stage without an expected percentage",
  isExceedingPace(win(90, { stage: "farAhead" })),
  true,
);
check(
  "unknown stage without expected is quiet",
  isExceedingPace(win(90, { stage: "somethingNew" })),
  false,
);

console.log("pace lines read like the macOS app");
check(
  "behind, lasts",
  formatPace({ stage: "slightlyBehind", deltaPercent: -4, willLastToReset: true }, 56),
  "Pace: Slightly behind · -4% · Lasts to reset",
);
check(
  "ahead, may run out",
  formatPace({ stage: "ahead", deltaPercent: 9, willLastToReset: false }, 56),
  "Pace: Ahead · +9% · May run out",
);
check(
  "far ahead",
  formatPace({ stage: "farAhead", deltaPercent: 20, willLastToReset: false }, 5),
  "Pace: Well ahead · +20% · May run out",
);
check("no pace data", formatPace(null, 56), "");

console.log("Codex shows a compact pace summary and account details");
check("Codex pace summary", formatCodexPace({ summary: "On pace | Expected 5% used | Runs out in 6d 14h" }), "Pace: On pace");
check("Codex deficit reserve summary", formatCodexPace({ summary: "Deficit reserve | Expected 5% used" }), "Pace: Deficit reserve");
check("Codex summary without separators", formatCodexPace({ summary: "  On pace  " }), "Pace: On pace");
check("empty Codex summary", formatCodexPace({ summary: "   | expected" }), "");
check("missing Codex summary", formatCodexPace({}), "");
check("missing Codex pace", formatCodexPace(null), "");
check("Codex details omit zero balances", formatCodexDetails({
  creditsRemaining: 0,
  resetCreditsAvailable: 0,
  plan: "plus",
}), ["Plan: Plus"]);
check("Codex details omit missing values", formatCodexDetails({}), []);

// A 296px track is the popup content width minus padding.
const TRACK = 296;

// The pace tick sits at the expected percentage, so its x offset must land
// inside the track for any realistic value.
console.log("pace tick position stays within the track");
check("0% expected clamps to the start", fillWidth(TRACK, 0), 1);
check("50% expected is the midpoint", fillWidth(TRACK, 50), 148);
check("100% expected is the end", fillWidth(TRACK, 100), TRACK);
check("over 100 clamps", fillWidth(TRACK, 130), TRACK);
check("negative clamps", fillWidth(TRACK, -5), 1);

console.log("bar colours follow the macOS thresholds");
check("low", barColor(10), "#3584e4");
check("half", barColor(55), "#f6d32d");
check("high", barColor(80), "#ff7800");
check("critical", barColor(95), "#e01b24");

console.log("fills size from the measured track, never as a percentage");
check("empty", fillWidth(TRACK, 0), 1);
check("half", fillWidth(TRACK, 50), 148);
check("full", fillWidth(TRACK, 100), TRACK);
check("six percent", fillWidth(TRACK, 6), 18);
check("never zero", fillWidth(TRACK, 0.1), 1);
check("zero-width track still shows something", fillWidth(0, 50), 1);

console.log("the panel bar inset accounts for its border and padding");
check("panel empty", fillWidth(22, 0, 2), 1);
check("panel half", fillWidth(22, 50, 2), 10);
check("panel full", fillWidth(22, 100, 2), 20);
check("panel clamps over 100", fillWidth(22, 140, 2), 20);
check("panel clamps below zero", fillWidth(22, -20, 2), 1);

console.log("provider errors do not hide healthy providers");
const providers = [
  { id: "codex", kind: "error" },
  { id: "opencodego", kind: "windows" },
  { id: "deepseek", kind: "balance" },
];
check("skip first errored provider on initial selection", activeProviderIndex(providers, 0), 1);
check("keep selected healthy provider", activeProviderIndex(providers, 2), 2);
check("all errors stay visible", activeProviderIndex([{ kind: "error" }], 0), 0);

console.log("browser data is fresh, successful, and tied to the selected profile");
const browserCache = { source: "firefox:profile", provider: "deepseek", updatedAt: "2026-10-08T11:59:00Z",
  todayTokens: 2, periodTokens: 4, todayCost: 0.1, periodCost: 0.2, requestCount: 1, periodRequests: 2,
  apiKeyCount: 1, periodLabel: "Last 30 days", currency: "CNY", topModel: null, modelCosts: [],
  daily: [{ date: "2026-10-08", tokens: 2, cost: 0.1 }] };
check("matching recent profile", validBrowserSummary(browserCache, "firefox:profile", NOW.getTime()), true);
check("different profile is rejected", validBrowserSummary(browserCache, "chromium:Default", NOW.getTime()), false);
check("expired cache is rejected", validBrowserSummary(browserCache, "firefox:profile", NOW.getTime() + 3601_000), false);
check("fresh helper error remains visible", validBrowserSummary({ ...browserCache, status: "error", error: "No supported browser session found" }, "firefox:profile", NOW.getTime()), true);
check("stale helper error is rejected", validBrowserSummary({ ...browserCache, status: "error", error: "No session" }, "firefox:profile", NOW.getTime() + 3601_000), false);
const sessionError = { ...browserCache, status: "error", error: "browser session expired or rejected", errorCode: "session-invalid" };
check("invalid-session cache is accepted for its profile", validBrowserSummary(sessionError, "firefox:profile", NOW.getTime()), true);
check("unknown session error codes fail closed", validBrowserSummary({ ...sessionError, errorCode: "invented" }, "firefox:profile", NOW.getTime()), false);
check("invalid session gives sign-in recovery", browserSessionMessage(sessionError).includes("Sign in again"), true);
check("legacy auth errors also give sign-in recovery", browserSessionMessage({ error: "browser session expired or rejected" }).includes("Sign in again"), true);
check("missing local credentials do not claim confirmed expiry", browserSessionMessage({ errorCode: "session-missing" }).includes("expired"), false);
check("access denied is not labeled invalid", browserSessionMessage({ errorCode: "access-denied" }).includes("session may still be valid"), true);
check("Cloudflare is not labeled invalid", browserSessionMessage({ errorCode: "cloudflare-challenge" }).includes("session may still be valid"), true);
check("network error offers connection recovery", browserSessionMessage({ errorCode: "network-error" }).includes("Check your connection"), true);
check("cache without a provider tag is rejected", validBrowserSummary({ ...browserCache, provider: undefined }, "firefox:profile", NOW.getTime()), false);
check("disabled browser enrichment needs no setup notice", browserHelperNotice(false, "", null), "");
check("unselected browser profile points to Settings", String(browserHelperNotice(true, "", null)).includes("Choose a browser profile"), true);
check("missing browser data points to service controls", String(browserHelperNotice(true, "firefox:profile", null)).includes("helper service in Settings"), true);
check("fresh data needs no service warning", browserHelperNotice(true, "firefox:profile", browserCache, NOW.getTime()), "");
check("expired data points to service controls", String(browserHelperNotice(true, "firefox:profile", browserCache, NOW.getTime() + 3601_000)).includes("helper service"), true);

console.log("optional Codex history validates independently from its quota summary");
const activityHistory = { periodLabel: "Last 30 days", todayTokens: 0, periodTokens: 12,
  daily: [{ date: "2026-10-07", tokens: 12 }, { date: "2026-10-08", tokens: 0 }] };
const creditHistory = { periodLabel: "Last 30 days", todayCredits: 0, periodCredits: 0,
  daily: [], events: [], eventsPartial: false };
check("empty token day is valid", validActivityHistory(activityHistory), true);
check("empty successful credits are valid", validCreditHistory(creditHistory), true);
check("invalid dates fail history validation", validActivityHistory({ ...activityHistory,
  daily: [{ date: "2026-02-30", tokens: 1 }] }), false);
check("non-finite events fail credit validation", validCreditHistory({ ...creditHistory,
  events: [{ date: "2026-10-08", service: "test", credits: Infinity }] }), false);
check("null events fail credit validation without throwing", validCreditHistory({ ...creditHistory, events: [null] }), false);
check("duplicate dates fail token history validation", validActivityHistory({ ...activityHistory,
  daily: [{ date: "2026-10-08", tokens: 0 }, { date: "2026-10-08", tokens: 12 }] }), false);
check("fractional tokens fail token history validation", validActivityHistory({ ...activityHistory,
  daily: [{ date: "2026-10-08", tokens: 0.25 }] }), false);
check("fractional paid credits are valid", validCreditHistory({ ...creditHistory,
  todayCredits: 1.25, periodCredits: 1.25, daily: [{ date: "2026-10-08", credits: 1.25 }],
  events: [{ date: "2026-10-08", service: "CLI", credits: 1.25 }] }), true);
check("day details retain actual zero", historyDayDetail("2026-10-08", 0, (v) => `${v} tokens`),
  `${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date("2026-10-08T00:00:00Z"))} · 0 tokens`);
const hourlyDetail = historyDayDetail("2026-10-08T15:00:00Z", 0.08, (v) => `$${v.toFixed(2)}`);
check("hourly details omit ISO date and seconds", /2026|T15|:00Z/.test(hourlyDetail), false);
check("hourly details retain a clock time and cost", /\d{2}:\d{2}/.test(hourlyDetail) && hourlyDetail.endsWith("$0.08"), true);

const chartBody = src.slice(src.indexOf("  _addChartToMenu(menu, days, field, format, labelField = \"date\") {") +
  "  _addChartToMenu(menu, days, field, format, labelField = \"date\") {".length, src.indexOf("  _buildBrowserWindows(")).trim().replace(/\}$/, "");
class ChartActor {
  constructor(props) { Object.assign(this, props); this.children = []; this.layout_manager = {}; this.clutter_text = {}; this.handlers = {}; }
  add_child(actor) { this.children.push(actor); }
  set_child(actor) { this.children = [actor]; }
  connect(signal, fn) { this.handlers[signal] = fn; }
}
const renderChart = new Function("menu", "days", "field", "format", "labelField", "_", "dimLabel", "St", "Clutter", "historyDayDetail", "formatTokens", "BAR_WIDTH_PX", "Pango", chartBody);
const modelMenu = { box: new ChartActor({}) };
renderChart(modelMenu, [{ model: "model-a", cost: 100000000 }, { model: "model-b", cost: 250000000 }], "cost",
  (v) => `$${(v / 100000000).toFixed(2)}`, "model", gettext, (params) => new ChartActor(params),
   { BoxLayout: ChartActor, Button: ChartActor, Widget: ChartActor }, { ActorAlign: { END: "end", FILL: "fill" } }, historyDayDetail, String, 296, { EllipsizeMode: { END: 3 } });
const [modelDetail, modelChart] = modelMenu.box.children;
check("model names are hidden until inspection", String(modelDetail.children[0].text).includes("model-a"), false);
check("chart gives every model an equal expanding slot", modelChart.layout_manager.homogeneous && modelChart.children.every((button) => button.x_expand), true);
check("bars fill their expanding slots", modelChart.children.every((button) => button.children[0].x_expand), true);
modelChart.children[1].handlers["enter-event"]();
check("hover reveals model name and reported cost", String(modelDetail.children[0].text), "model-b · $2.50");
modelChart.children[0].handlers["key-focus-in"]();
check("keyboard focus also reveals model details", String(modelDetail.children[0].text), "model-a · $1.00");
const opencodeRenderSource = src.slice(src.indexOf('    if (provider.id === "opencodego" && browserSummary'),
  src.indexOf("    // Bars are sized in pixels against the track"));
check("OpenCode helper does not repeat quota windows", opencodeRenderSource.includes("_buildBrowserWindows"), false);

const codexHistoryBody = src.slice(src.indexOf("  _addCodexHistory(data) {") + "  _addCodexHistory(data) {".length,
  src.indexOf("  _addChartToMenu(")).trim().replace(/\}$/, "");
const renderCodexHistory = new Function("data", "_", "validActivityHistory", "validCreditHistory", "St", "PopupMenu", "dimLabel", "formatTokens", "nonzeroDetails", codexHistoryBody);
const historyLabels = [];
const historyActors = [];
class HistorySubmenu {
  constructor() { this.menu = { box: { add_child: (actor) => { historyLabels.push(String(actor.text)); historyActors.push(actor); } } }; }
}
renderCodexHistory.call({ _historyBox: { addMenuItem() {} }, _addChartToMenu() { throw new Error("Empty paid history drew a chart"); } },
  { creditHistory: { ...creditHistory, daily: [{ date: "2026-10-08", credits: 0 }] } },
  gettext, validActivityHistory, validCreditHistory, { Label: class { constructor(props) { Object.assign(this, props); } } },
  { PopupSubMenuMenuItem: HistorySubmenu }, (params) => params, String);
check("zero-filled credit history is hidden", historyLabels.length, 0);
const nonzeroDetails = new Function("parts", helperSrc.slice(helperSrc.indexOf("function nonzeroDetails(parts) {") +
  "function nonzeroDetails(parts) {".length).split("\n}")[0]);
check("summary details omit zero and invalid values", nonzeroDetails([[0, "zero"], [NaN, "invalid"], [12, "12 tokens"], [0.25, "$0.25"]]), "12 tokens · $0.25");
const drawnDays = [];
renderCodexHistory.call({ _historyBox: { addMenuItem() {} }, _addChartToMenu(menu, days) { drawnDays.push(...days); } },
  { activityHistory, creditHistory }, gettext, validActivityHistory, validCreditHistory,
  { Label: class { constructor(props) { Object.assign(this, props); } } }, { PopupSubMenuMenuItem: HistorySubmenu },
  (params) => params, String, nonzeroDetails);
check("non-empty token history retains its zero-usage day", drawnDays, activityHistory.daily);
check("history summary hides zero today without hiding period totals", historyLabels.includes("Last 30 days: 12"), true);
check("zero credits do not add an empty section to token history", historyLabels.includes("Credits"), false);
check("history heading and totals share the chart inset", historyActors.filter((actor) =>
  String(actor.text) === "Token activity" || String(actor.text) === "Last 30 days: 12")
  .every((actor) => actor.style_class.includes("codexbar-history-inset")), true);

const browserRender = new Function("provider", "_", "dimLabel", "validBrowserSummary", "browserHelperNotice", "browserSessionMessage", "BAR_WIDTH_PX", src.slice(
  src.lastIndexOf('    const profile = this._settings.get_string("browser-profile");'),
  src.indexOf("    // Bars are sized in pixels against the track"),
));
for (const id of ["deepseek", "codex", "opencodego"]) {
  const labels = [];
  browserRender.call({
    _settings: { get_string: () => "firefox:profile", get_boolean: () => true },
    _browserSummaries: { [id]: { provider: id, status: "error", error: "Session expired", source: "firefox:profile", updatedAt: new Date().toISOString() } },
    _contentBox: { add_child: (label) => labels.push(label.text) },
    _buildBrowserSummary: () => { throw new Error("Error cache rendered as usage"); },
    _buildBrowserWindows: () => { throw new Error("Error cache rendered as windows"); },
  }, { id }, gettext, (params) => ({ ...params, clutter_text: {} }), validBrowserSummary, browserHelperNotice, browserSessionMessage, 296);
  check(`${id} helper errors show only the error`, labels, ["Browser helper: Session expired"]);
  labels.length = 0;
  browserRender.call({
    _settings: { get_string: () => "firefox:profile", get_boolean: () => true },
    _browserSummaries: { [id]: { ...sessionError, provider: id, updatedAt: new Date().toISOString() } },
    _contentBox: { add_child: (label) => { labels.push(label.text); check(`${id} session recovery text wraps`, label.clutter_text.line_wrap, true); } },
    _buildBrowserSummary: () => { throw new Error("Invalid session rendered as usage"); },
    _buildBrowserWindows: () => { throw new Error("Invalid session rendered as windows"); },
  }, { id }, gettext, (params) => ({ ...params, clutter_text: {} }), validBrowserSummary, browserHelperNotice, browserSessionMessage, 296);
  check(`${id} invalid session appears in popup with recovery`, String(labels[0]).includes("Sign in again"), true);
}

console.log("chart details reserve two non-wrapping lines");
const chartMethod = src.slice(src.indexOf("  _addChartToMenu("), src.indexOf("  _buildBrowserWindows("));
const addChart = new Function("St", "Clutter", "Pango", "dimLabel", "_", "BAR_WIDTH_PX", "historyDayDetail", "formatTokens",
  `return ({${chartMethod}})._addChartToMenu;`)(
  { BoxLayout: ChartActor, Button: ChartActor, Widget: ChartActor }, { ActorAlign: { END: 1, FILL: 2 } },
  { EllipsizeMode: { END: 3 } }, (params) => new ChartActor(params), gettext, 296, historyDayDetail, (n) => String(n));
const chartMenu = { box: new ChartActor({}) };
const points = [
  { date: "2026-10-09T11:00:00Z", cost: 0, tokens: 772000, requests: 5 },
  { date: "2026-10-09T14:00:00Z", cost: 0.12, tokens: 19500000, requests: 95 },
  { date: "2026-10-09T15:00:00Z", cost: 0, tokens: 0, requests: 0 },
];
addChart(chartMenu, points, "cost", (value) => `$${value.toFixed(2)}`);
const detailLines = chartMenu.box.children[0].children;
check("exactly two detail labels exist before hovering", detailLines.length, 2);
check("both detail lines disable wrapping", detailLines.map((line) => line.clutter_text.line_wrap), [false, false]);
check("empty second line reserves space before hover", detailLines[1].text.length > 0, true);
const bars = chartMenu.box.children[1].children;
for (let i = 0; i < points.length; i++) {
  bars[i].handlers["enter-event"]();
  check(`point ${i} first line contains only date and cost`, detailLines[0].text, historyDayDetail(points[i].date, points[i].cost, (v) => `$${v.toFixed(2)}`));
  check(`point ${i} second line keeps its space`, detailLines[1].text.length > 0, true);
}
bars[1].handlers["key-focus-in"]();
check("keyboard focus shows tokens on second line", detailLines[1].text.includes("19500000 tokens"), true);
check("keyboard focus shows requests on second line", detailLines[1].text.includes("95 requests"), true);

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);
