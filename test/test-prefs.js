// Prefs behaviour that is worth pinning down without opening a window.
//
// The settings window used to run `codexbar usage` synchronously, which froze it
// for as long as the CLI took (seconds to tens of seconds). These checks fail if
// a blocking call creeps back in.

import GLib from "gi://GLib";

const src = new TextDecoder().decode(
  GLib.file_get_contents(GLib.build_filenamev([GLib.get_current_dir(), "prefs.js"]))[1],
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

console.log("the provider list is fetched without blocking the main loop");
check("no spawn_sync", /spawn_sync/.test(src), false);
check("no spawn_command_line_sync", /spawn_command_line_sync/.test(src), false);
check("no subprocess launcher used", /Gio\.SubprocessLauncher/.test(src), false);
check("reads asynchronously", /read_bytes_async/.test(src), true);
check("uses Gio.Subprocess directly", /Gio\.Subprocess\.new/.test(src), true);

console.log("the window is built without waiting for the CLI");
check("fetch is dispatched, not awaited", /fetchProvidersAsync\(\(providerIds\)/.test(src), true);
check("no async/await in fillPreferencesWindow", /async fillPreferencesWindow/.test(src), false);
check("window.add is not behind the fetch", !/await[\s\S]{0,200}window\.add/.test(src), true);

console.log("the combo row is not interactive until the list arrives");
check("starts insensitive", /sensitive:\s*false/.test(src), true);
check("becomes sensitive after load", /primary\.sensitive = true/.test(src), true);
check("reports progress", /Reading providers/.test(src), true);

console.log("providers that errored are not offered as tracked");
check("filters errored entries", /\.filter\(\(entry\) => entry\?\.provider && !entry\.error\)/.test(src), true);

console.log("an unknown stored value stays visible instead of being dropped");
check("keeps unknown value", /not enabled/.test(src), true);

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);