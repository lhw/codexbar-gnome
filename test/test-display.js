// Load-time tests for the display helpers in extension.js.
//
// extension.js imports shell-only modules (St, PanelMenu, Main), so it cannot
// be imported outside a shell. These tests read the source and evaluate just the
// pure helpers and the sizing math, which keeps the whole thing runnable with a
// bare `gjs -m`.
import GLib from "gi://GLib";

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
  `${helperSrc}; return { formatResetsIn, formatUpdated, isExceedingPace, formatPace, barColor, fillWidth, activeProviderIndex };`,
)(gettext);
const { formatResetsIn, formatUpdated, isExceedingPace, formatPace, barColor, fillWidth, activeProviderIndex } = helpers;

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

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);
