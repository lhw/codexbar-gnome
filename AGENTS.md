# Working on this extension

Notes for agents and contributors. The README is for people installing and using
the extension and deliberately contains none of this.

## What this is

A GNOME Shell 50 panel extension that shows AI provider usage limits, laid out
like the macOS CodexBar menu. It shells out to the
[`codexbar`](https://github.com/steipete/CodexBar) CLI and parses its JSON. It
does not talk to providers itself and holds no credentials.

Forked from [InledGroup/codexbar-gnome](https://github.com/InledGroup/codexbar-gnome)
(extension 9841), rewritten around a single CLI call. The fork is far enough from
upstream that merging is not practical; treat it as independent.

## Layout

| File | Role |
| --- | --- |
| `extension.js` | Panel button, widget tree, refresh and disable lifecycle |
| `cli.js` | Runs the `codexbar` binary over `Gio.Subprocess`, with timeouts |
| `parse.js` | Pure parsing of `codexbar usage --format json` |
| `cost.js` | Pure parsing of `codexbar cost --format json`, plus formatting |
| `links.js` | Per-provider dashboard and status URLs, plus the About links |
| `prefs.js` | Native preferences, explicit profile discovery, shared helper settings, and user-service controls |
| `stylesheet.css` | Spacing and fill colours only, never backgrounds or fonts |
| `test/` | Headless suites plus a throwaway dumper extension |
| `browser-session/daemon.py` | Optional helper: browser readers, provider adapters/registry, sanitized caches, polling |
| `browser-session/runtime.py` | Shared GSettings configuration and user-service unit generation |
| `browser-session/helper.py` | Explicit helper setup, foreground runs, and opt-in user-service management |
| `docs/screenshots/` | README images, deliberately outside `media/` so they stay out of the packaged zip |

The split is deliberate: `parse.js`, `cost.js` and `links.js` import no `gi://`
modules, so they can be unit-tested with a bare `gjs -m` and no shell. Keep it
that way. `extension.js` cannot be imported outside a shell, so
`test/test-display.js` reads its source and evaluates just the pure helpers.

## Build and test

```sh
./build.sh      # compiles schemas, runs six GJS suites plus browser-session tests, packs the zip
./ui-test.sh    # headless shell, dumps the rendered menu
./install.sh    # build, then install into the user extension dir
```

There is no test CI. It was tried and removed: `gnome-extensions pack` needs the
`gnome-shell` package, which takes several minutes to install on a runner, and
that cost outweighed the benefit for six suites that run in under a second
locally. Run them before pushing.

Release-please still maintains the version and cuts releases, and `.github/workflows/release.yml`
builds the zip and attaches it to the published release, so that path still
installs `gnome-shell`.

`build.sh` runs `test-parse`, `test-cost`, `test-display`, `test-links`,
`test-prefs` and `test-cli` against fixtures in `fixtures/`, plus the
`browser-session` Python tests through `uv`. `test-cli.js` shells out to the real
binary; the rest are pure or use temporary browser database fixtures.

`ui-test.sh` loads the extension into a headless GNOME Shell, has a throwaway
companion extension dump the rendered menu, and asserts the shell reports no
errors. It also reports bar geometry and x offsets, which is how layout bugs get
caught.

## GJS and St traps

These cost real debugging time. All of them bit during development.

- **Do not initialise GTK in the shell process.** A local `Gtk.init()` probe
  terminated the headless shell. Use the shell's own themed `ModalDialog`.
  Its `shellReactive: true` option omits the dimming lightbox; disable fades
  for the plain About dialog. This is in GNOME 50's `ui/modalDialog.js`.
- **`Dialog.MessageDialogContent.description` takes a string, not an actor** in
  GNOME 50, and its buttons live on `ModalDialog`, not on the content. For
  anything richer than a title and a paragraph, add your own actor to
  `dialog.contentLayout`.
- **`St.Label` has no `line_wrap` property.** It is on the `Clutter.Text`:
  `label.clutter_text.line_wrap = true`. Without it a long URL runs past the
  dialog's 28em content limit.
- **`St.Button.label` is null in GNOME 50.** The text is the button's child, so
  read `get_first_child()?.text`. A button's label is also single-line, so put
  wrapping text in an `St.Label` next to it rather than in the button.
- **`new Clutter.Event(...)` throws** — it has no default constructor. So
  `PopupBaseMenuItem.activate()` cannot be synthesised and the dumper calls the
  handler directly instead.
- **`read_bytes_finish` returns a single `GLib.Bytes`, not an `[ok, bytes]`
  tuple.** `const [ok, bytes] = ...` throws "not iterable" inside the callback,
  which fails silently wherever the callback's result is ignored.
- **`read_bytes_async`'s count is a per-read size, not a total.** One call
  truncates at the limit. `codexbar config providers` emits about 8KB, which
  lands mid-key and yields unparseable JSON. Drain until EOF.
- **GJS `TextDecoder` does not implement `{stream: true}`.** Collect bounded
  byte chunks and decode once at EOF, preserving UTF-8 characters across reads.
  Test normal output as well as failure paths; output-cap tests alone can pass
  while a decoder error is silently discarding every successful response.
- **A percentage width on a `St.Widget` with no layout manager resolves to
  nothing.** Every bar fill sizes itself in pixels from a fixed track width
  instead. See `fillWidth` in `extension.js`.
- **A `St.BoxLayout` places children side by side, not overlapped.** Putting a
  fill and a pace tick in a box layout pushes the tick past the end of the bar.
  The bar track is a plain `St.Widget` so the tick can overlap at an explicit `x`.

## Packaging gotchas

`gnome-extensions pack` flattens `--extra-source=<file-or-dir>` to the basename
at the zip root. Passing `--extra-source=media/logos/` produced `logos/` and the
extension's `media/logos/<id>-symbolic.svg` lookups all 404'd. Pass the parent
directory instead.

`gnome-extensions install` compiles the schema itself, so the zip should carry
only the `.gschema.xml` from `--schema=`. Adding
`--extra-source=schemas/gschemas.compiled` put a stray copy at the zip root,
where nothing reads it.

Because `--extra-source=media/` sweeps the whole tree, README images live in
`docs/screenshots/` rather than `media/screenshots/`. Keeping them out of `media/`
is what stops 150KB of screenshots shipping in every install.

Verify a packaging change rather than trusting it:

```sh
./build.sh
rm -rf /tmp/ziptest && mkdir /tmp/ziptest
cd /tmp/ziptest && unzip -q ~/src/codexbar-gnome/*.zip && ls -R
```

## Environment hazards

- **`ui-test.sh` must kill its shell with `SIGTERM`, well inside its own
  timeout.** A shell killed with `SIGKILL` writes
  `$XDG_RUNTIME_DIR/gnome-shell-disable-extensions`. Ubuntu's
  `org.gnome.Shell-disable-extensions.service` then sets
  `disable-user-extensions=true`, which switches off *every* user extension at
  the next login. The script also clears the flag if a run is cut short.
- **`dbus-run-session` gives a new bus but not a new dconf database.** Enabling
  the throwaway dumper writes to the real one, so `ui-test.sh` snapshots and
  restores `enabled-extensions`. `GSETTINGS_BACKEND=keyfile` does **not** isolate
  it; it is not honoured by the GLib in this environment.
- **`org.gnome.Shell.Eval` is unavailable** unless the session runs in unsafe
  mode. To inspect shell internals, probe from a companion extension instead,
  which is what `test/dumper` is for.
- **Shell-process JS errors only appear in the shell log, not the errors file.**
  `ui-test.sh` redirects `gnome-shell` output to `codexbar-ui-shell.log`, so
  `codexbar-ui-errors.txt` only ever sees what `dbus-run-session` itself printed.
  An earlier check grepped only that file and reported "clean" while the dumper
  was throwing. The check scans both now.
- **Code changes need a logout to take effect.** GNOME Shell caches extension
  ES modules for the session, so disable/enable over D-Bus silently serves stale
  code. A file that throws on enable will still "load" if this bites. Use
  `./ui-test.sh` to test, which starts a fresh shell.
- **Screenshots cannot be captured programmatically.** The shell's `Screenshot`
  D-Bus is denied and `gnome-screenshot` falls back to X11, which has no display
  under Wayland.
- **`yoga-image-optimizer` needs its doc directory to exist** or bwrap refuses to
  start with a bare "can't find source path" and no other output:
  `mkdir -p "$XDG_RUNTIME_DIR/doc/by-app/org.flozz.yoga-image-optimizer"`. It
  takes no flags and writes `.opti.png` siblings.

## Adding a provider

Nothing is required. Enable the provider in codexbar and the CLI returns it in
`codexbar usage --format json`; the extension builds a tab, bars, a pace tick
and a panel reading from the generic shape. The CLI is the integration point.

Three tables are optional polish, and anything missing falls back gracefully:

- `PROVIDER_NAMES` in `parse.js` — falls back to the raw provider id
- `USAGE_URLS` and `STATUS_URLS` in `links.js` — fall back to codexbar.app
- `media/logos/<id>-symbolic.svg` — falls back to a letter tile

Adding an entry is worth it only when a provider looks wrong, since none of them
affect correctness.

## Changing the data model

### Adding browser enrichment

The optional Python helper is separate from the credential-free Shell process.
Its `PROVIDERS` registry controls discovery, session reading, refresh dispatch,
profile listing, and CLI choices. Add a `Provider` registration with three hooks:

- `discover_profiles()` returns `(label, Path)` pairs without reading credentials.
- `read_session(profile)` reads only that provider's scoped credentials.
- `fetch(session, options)` returns validated, sanitized usage with `provider` and
  `updatedAt`; no tokens, cookies, account details, or raw responses in the cache.

Cookie adapters declare exact domains, allowed names/token bases, and request
paths; reuse `firefox_cookies()` to retain expiry, path, prefix, and container
checks. Use the optional `normalize_cookies` hook for provider-specific cookie
assembly. Other credential stores use a provider-specific reader. Never treat an
unknown provider as Codex. A provider-specific fetcher can live in a new Python
module imported by the daemon; non-test helper `.py` files ship automatically.
Keep normalization tests and add a discovery/refresh registration test.

`session_profiles()` filters discovery candidates using the scoped session reader.
Listing usable sessions therefore requires explicit `--enable --list-profiles`
consent (provided by `helper.py profiles`), makes no network requests, and never
publishes credentials or caches. A locally stored session is not server-validated.
`helper.py profiles --json` returns `{profiles: [{label, providers}]}` for the
Preferences dropdown. Never store scan results as credentials or auto-scan when
Preferences opens. Opening Preferences may only check the service's read-only
systemd state; setup/start and local session scanning require explicit actions.

Browser profile, interval, expected Codex email, solver URL, and consent come
from the extension's GSettings, not a second config file or service arguments.
Do not start a new provider after consent/config changes; an in-flight request
may finish. New cache shapes still need corresponding Shell validation/rendering
and display tests; the registry does not invent UI for an unknown payload.

`build.sh` packages a clean `browser-session/` directory, excluding tests and
virtual environments. `install.sh` installs that zip rather than copying the
working tree. Test helper setup in an extracted temporary zip; never run
`enable-service` against the real user merely to verify packaging.

The CLI's JSON schema is the one external contract this depends on, and it can
change without warning. `parse.js` and `cost.js` normalise it; `test-parse.js`
and `test-cost.js` assert against fixtures captured from the real CLI in
`fixtures/`. Re-capture them and check the tests when upgrading codexbar:

```sh
codexbar usage --format json --pretty > fixtures/usage-all.json
codexbar usage --provider opencodego --format json --pretty > fixtures/usage-opencodego.json
codexbar usage --provider deepseek --format json --pretty > fixtures/usage-deepseek.json
codexbar cost --provider all --format json --pretty > fixtures/cost-all.json
```

Two shapes matter. Window providers (`opencodego`) send positional
`primary`/`secondary`/`tertiary` windows with `usedPercent`, `windowMinutes` and
`resetsAt`, plus a matching `pace` object. Balance providers (`deepseek`) send a
single window with no duration and no reset, only a `resetDescription`. A
window is a meter only if it has `windowMinutes` or `resetsAt`; without one it
is a balance and must not render as a bar, which would read as "exhausted".
