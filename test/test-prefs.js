// Pure preference helpers and UI wiring, without opening a Shell preferences window.
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { validBrowserSessionError, browserSessionMessage } from "../browser-status.js";

const src = new TextDecoder().decode(
  GLib.file_get_contents(GLib.build_filenamev([GLib.get_current_dir(), "prefs.js"]))[1],
);
let failed = 0;
let passed = 0;
function check(label, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) passed++;
  else { failed++; console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`); }
}

const parserSource = src.match(/function parseBrowserProfiles\(raw\) \{[\s\S]*?\n\}/)?.[0];
const parseBrowserProfiles = new Function(`${parserSource}; return parseBrowserProfiles;`)();
check("parses, sorts, and deduplicates profile providers", parseBrowserProfiles(JSON.stringify({ profiles: [
  { label: "Firefox", providers: ["codex", "codex", "opencodego"] },
  { label: "Chrome", providers: ["deepseek"] },
]})), [
  { label: "Chrome", providers: ["deepseek"] },
  { label: "Firefox", providers: ["codex", "opencodego"] },
]);
check("rejects control characters and invalid provider ids", parseBrowserProfiles(JSON.stringify({ profiles: [
  { label: "bad\nlabel", providers: ["codex"] }, { label: "bad-id", providers: ["../token"] },
]})), []);
check("bounds profile result count", parseBrowserProfiles(JSON.stringify({ profiles: Array(1001).fill({ label: "x", providers: ["codex"] }) })), []);
check("malformed JSON is empty", parseBrowserProfiles("not json"), []);
check("deduplicates profile labels", parseBrowserProfiles(JSON.stringify({ profiles: [
  { label: "Firefox", providers: ["codex"] }, { label: "Firefox", providers: ["deepseek"] },
]})), [{ label: "Firefox", providers: ["codex"] }]);

const sessionError = {
  status: "error", source: "Firefox", provider: "codex", error: "expired",
  errorCode: "session-invalid", updatedAt: new Date().toISOString(),
};
check("accepts a fresh matching session error", validBrowserSessionError(sessionError, "Firefox", "codex"), true);
check("rejects a stale session error", validBrowserSessionError({ ...sessionError, updatedAt: new Date(Date.now() - 3601_000).toISOString() }, "Firefox", "codex"), false);
check("rejects an error from another profile", validBrowserSessionError(sessionError, "Chrome", "codex"), false);
check("rejects unknown error codes", validBrowserSessionError({ ...sessionError, errorCode: "secret" }, "Firefox", "codex"), false);
check("formats session-invalid recovery copy", browserSessionMessage(sessionError), "Browser session expired or invalid. Sign in again in the selected browser profile; usage retries automatically.");

const stateSource = src.match(/function browserServiceState\(load, active, unitFile\) \{[\s\S]*?\n\}/)?.[0];
const serviceState = new Function("_", `${stateSource}; return browserServiceState;`)((text) => text);
check("not-found unit is distinct", serviceState("not-found", "inactive", "disabled"), "Not installed");
check("running unit state", serviceState("loaded", "active", "enabled"), "Running");
check("active but disabled unit", serviceState("loaded", "active", "disabled"), "Running · not enabled at login");
check("failed unit state", serviceState("loaded", "failed", "enabled"), "Service failed; check the user journal");

const runSource = src.match(/function runAsync\(argv, timeoutMs, done\) \{[\s\S]*?\n\}/)?.[0];
const runAsync = new Function("Gio", "GLib", `${runSource}; return runAsync;`)(Gio, GLib);
const python = GLib.find_program_in_path("python3");
if (python) {
  const loop = new GLib.MainLoop(null, false);
  let actualRuns = 0;
  runAsync([python, "-c", "print('a' * 16383 + '\u00e9'); print('LoadState=not-found')"], 5000, (ok, output) => {
    check("normal output survives a split UTF-8 character", [ok, output], [true, "a".repeat(16383) + "\u00e9\nLoadState=not-found\n"]);
    actualRuns++;
  runAsync([python, "-c", "print('x' * 200000)"], 5000, (ok, output) => {
    check("actual subprocess output is capped", [ok, output.length <= 128 * 1024], [false, true]);
    actualRuns++;
    runAsync([python, "-c", "import time; time.sleep(5)"], 50, (timedOut, timeoutOutput) => {
      check("timed out process exits asynchronously", [timedOut, timeoutOutput], [false, ""]);
      actualRuns++;
      loop.quit();
    });
  });
  });
  GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10000, () => { loop.quit(); return GLib.SOURCE_REMOVE; });
  loop.run();
  check("subprocess checks completed", actualRuns, 3);
} else {
  check("python3 available for subprocess checks", Boolean(python), true);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);
