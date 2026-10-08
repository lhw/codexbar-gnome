// Pure preference helpers and UI wiring, without opening a Shell preferences window.
import Gio from "gi://Gio";
import GLib from "gi://GLib";

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

const stateSource = src.match(/function browserServiceState\(load, active, unitFile\) \{[\s\S]*?\n\}/)?.[0];
const serviceState = new Function("_", `${stateSource}; return browserServiceState;`)((text) => text);
check("not-found unit is distinct", serviceState("not-found", "inactive", "disabled"), "Not installed");
check("running unit state", serviceState("loaded", "active", "enabled"), "Running");
check("active but disabled unit", serviceState("loaded", "active", "disabled"), "Running · not enabled at login");
check("failed unit state", serviceState("loaded", "failed", "enabled"), "Service failed; check the user journal");

check("subprocess stdout is asynchronously drained", /read_bytes_async\(16 \* 1024/.test(src), true);
check("subprocess output is capped while reading", /size \+ data\.length > 128 \* 1024/.test(src), true);
check("subprocess stderr is silenced", /Gio\.SubprocessFlags\.STDERR_SILENCE/.test(src), true);
check("no synchronous subprocess", /spawn_sync|spawn_command_line_sync/.test(src), false);
check("provider list uses config providers", /"config", "providers"/.test(src), true);
check("provider list avoids live usage request", /"usage"/.test(src), false);
check("disabled providers are excluded", /entry\.enabled !== true/.test(src), true);
check("provider display names are preferred", /names\.get\(id\) \|\| id/.test(src), true);
check("provider loading is dispatched asynchronously", /fetchProvidersAsync\(\(providerIds, names\)/.test(src), true);
check("unknown primary provider remains visible", /not enabled/.test(src), true);
check("service is checked from systemd on window open", /"systemctl", "--user", "show"/.test(src), true);
check("profile scan is explicit and JSON-only", /"profiles", "--json"/.test(src), true);
check("setup requires an explicit confirmation", /heading: _\("Set up and start the browser helper\?"\)/.test(src), true);
check("saved selection is retained after discovery", /saved; not found/.test(src), true);
check("initial saved selection says not scanned", /saved; not scanned/.test(src), true);
check("saved selection can be cleared with placeholder", /index > 0 \? profileValues\[index - 1\] : ""/.test(src), true);
check("settings continue to own profile and interval", /settings\.set_string\("browser-profile"/.test(src), true);
check("browser access remains settings-bound opt-in", /settings\.bind\("show-browser-summary", browser, "active"/.test(src), true);
check("solver cookie disclosure remains visible", /receives ChatGPT session cookies/.test(src), true);
check("helper path is rooted at installed extension", /\[this\.path, "browser-session"\]/.test(src), true);
check("setup rechecks current opt-in", /!browser\.active \|\| !settings\.get_string\("browser-profile"\)/.test(src), true);
check("setup failure survives status refresh", /Setup failed; check uv\/network and the user journal/.test(src), true);

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
