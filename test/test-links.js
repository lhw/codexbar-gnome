// Tests for the per-provider link maps. A wrong URL here is invisible until a
// user clicks it, so assert the shape instead.
import GLib from "gi://GLib";

const ROOT = GLib.get_current_dir();
const links = await import(
  GLib.filename_to_uri(GLib.build_filenamev([ROOT, "links.js"]), null)
);
const { USAGE_URLS, STATUS_URLS, usageUrl, statusUrl, ADD_ACCOUNT_URL, ABOUT_URL, INSTALL_URL } = links;

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

const isHttp = (u) => typeof u === "string" && /^https:\/\/[^\s]+$/.test(u);

console.log("every URL is absolute https");
const bad = [];
for (const [id, url] of Object.entries(USAGE_URLS)) {
  if (!isHttp(url)) bad.push(`usage:${id}`);
}
for (const [id, url] of Object.entries(STATUS_URLS)) {
  if (!isHttp(url)) bad.push(`status:${id}`);
}
for (const [name, url] of [["add", ADD_ACCOUNT_URL], ["about", ABOUT_URL], ["install", INSTALL_URL]]) {
  if (!isHttp(url)) bad.push(name);
}
check("no malformed URLs", bad, []);

console.log("keys are lowercase and free of spaces");
const keyIssues = [...Object.keys(USAGE_URLS), ...Object.keys(STATUS_URLS)]
  .filter((k) => k !== k.toLowerCase() || /\s/.test(k));
check("clean keys", keyIssues, []);

console.log("resolvers fall back for unknown providers");
check("unknown usage", usageUrl("does-not-exist"), "https://codexbar.app");
check("unknown status", statusUrl("does-not-exist"), "https://codexbar.app");

console.log("resolvers return the mapped URL when known");
check("codex usage", usageUrl("codex"), USAGE_URLS.codex);
check("deepseek status", statusUrl("deepseek"), STATUS_URLS.deepseek);

console.log("the footer no longer points at the codexbar repo as a dashboard");
const notRepo = (id) => (USAGE_URLS[id] || "").includes("github.com/steipete/CodexBar");
check(
  "no dashboard points at the repo",
  Object.keys(USAGE_URLS).filter(notRepo),
  [],
);
check(
  "no status page points at the repo",
  Object.keys(STATUS_URLS).filter((id) => (STATUS_URLS[id] || "").includes("github.com")),
  [],
);

console.log("the providers on this machine are mapped");
check("opencodego usage", usageUrl("opencodego"), "https://opencode.ai/console/go/status");
check("deepseek usage", usageUrl("deepseek"), "https://platform.deepseek.com/usage");
check("claude usage", usageUrl("claude"), "https://claude.ai/settings/usage");

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) imports.system.exit(1);