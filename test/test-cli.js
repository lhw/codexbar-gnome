// Integration tests for the CLI wrapper, run against the real codexbar binary.
//
// These cover two bugs that were invisible until the settings window was opened
// by hand, and that no fixture test could have caught:
//
//   1. GJS returns a single GLib.Bytes from read_bytes_finish, not an
//      [ok, bytes] tuple, so destructuring it threw.
//   2. read_bytes_async's count is a per-read size, not a total, so one call
//      silently truncated longer output. `config providers` is ~8KB, which
//      landed mid-key and produced unparseable JSON.
//
// Run: gjs -m test/test-cli.js
import GLib from "gi://GLib";
import Gio from "gi://Gio";

const ROOT = GLib.get_current_dir();
const { fetchUsage, fetchCost, findCodexBar } = await import(
  GLib.filename_to_uri(GLib.build_filenamev([ROOT, "cli.js"]), null)
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

function ok(label, condition) {
  check(label, Boolean(condition), true);
}

const bin = findCodexBar();
if (!bin) {
  console.log("codexbar not found; skipping integration tests");
  imports.system.exit(0);
}

console.log("the binary resolves outside the interactive PATH");
ok("found codexbar", bin && bin.endsWith("codexbar"));

const cancellable = new Gio.Cancellable();

console.log("usage output is read whole, not truncated");
const usage = await fetchUsage(cancellable);
ok("usage is an array", Array.isArray(usage));
ok("usage has entries", usage.length > 0);
ok("every entry has a provider", usage.every((e) => typeof e.provider === "string"));
ok(
  "no entry has a truncated payload",
  usage.every((e) => e.error || e.usage),
  true,
);

console.log("cost output is read whole, not truncated");
const cost = await fetchCost(cancellable);
ok("cost is an array or null", cost === null || Array.isArray(cost));
if (Array.isArray(cost)) {
  ok("cost entries are well formed", cost.every((e) => e.error || e.provider));
}

console.log("a payload larger than one read buffer is fully drained");
{
  // Reproduces the truncation directly: the same drain loop the extension uses,
  // against output known to exceed a single 4KB read.
  const proc = Gio.Subprocess.new(
    [bin, "config", "providers", "--format", "json"],
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
  );

  const text = await new Promise((resolve) => {
    const decoder = new TextDecoder();
    let out = "";
    const readMore = () => {
      proc.get_stdout_pipe().read_bytes_async(64 * 1024, GLib.PRIORITY_DEFAULT, null, (s, r) => {
        const bytes = s.read_bytes_finish(r);
        if (bytes.get_size() === 0) {
          resolve(out);
          return;
        }
        out += decoder.decode(bytes.get_data());
        readMore();
      });
    };
    readMore();
  });

  ok("drained output exceeds a single 4KB read", text.length > 4096);
  const parsed = JSON.parse(text);
  ok("drained output parses as JSON", Array.isArray(parsed));
  ok("every provider is present", parsed.length > 80);

  const enabled = parsed.filter((e) => e?.provider && e.enabled === true);
  ok("at least one provider is enabled", enabled.length > 0);
  ok(
    "enabled entries carry display names",
    enabled.every((e) => typeof e.displayName === "string" && e.displayName.length > 0),
  );
  check(
    "enabled ids match what the extension would offer",
    enabled.map((e) => e.provider).sort(),
    ["codex", "deepseek", "opencodego"],
  );
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);