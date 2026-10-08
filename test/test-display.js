// Load-time tests for the display helpers in extension.js. These are exported
// for testing; the shell imports the same module for the UI.
import GLib from "gi://GLib";

const EXT = GLib.filename_to_uri(
  GLib.build_filenamev([GLib.get_current_dir(), "extension.js"]),
  null,
);

// extension.js imports shell-only modules, so pull the pure helpers out of the
// source instead of importing it. Keeps the test runnable outside a shell.
const src = new TextDecoder().decode(
  GLib.file_get_contents(GLib.build_filenamev([GLib.get_current_dir(), "extension.js"]))[1],
);
const start = src.indexOf("function formatResetsIn");
const end = src.indexOf("export default class");
const helperSrc = src.slice(start, end);
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

const factory = new Function(
  "_",
  `${helperSrc}; return { formatResetsIn, formatUpdated, formatPace, barColor };`,
);
const { formatResetsIn, formatUpdated, formatPace, barColor } = factory(gettext);

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

console.log("bar colours follow the macOS thresholds");
check("low", barColor(10), "#3584e4");
check("half", barColor(55), "#f6d32d");
check("high", barColor(80), "#ff7800");
check("critical", barColor(95), "#e01b24");

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);