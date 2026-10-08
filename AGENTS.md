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
| `prefs.js` | Preferences window: refresh interval, pace toggle, primary provider |
| `stylesheet.css` | Spacing and fill colours only, never backgrounds or fonts |
| `test/` | Headless suites plus a throwaway dumper extension |
| `docs/screenshots/` | README images, deliberately outside `media/` so they stay out of the packaged zip |

The split is deliberate: `parse.js`, `cost.js` and `links.js` import no `gi://`
modules, so they can be unit-tested with a bare `gjs -m` and no shell. Keep it
that way. `extension.js` cannot be imported outside a shell, so
`test/test-display.js` reads its source and evaluates just the pure helpers.

## Build and test

```sh
./build.sh      # compiles schemas, runs all six suites, packs the zip
./ui-test.sh    # headless shell, dumps the rendered menu
./install.sh    # build, then install into the user extension dir
```

`build.sh` runs `test-parse`, `test-cost`, `test-display`, `test-links`,
`test-prefs` and `test-cli` against fixtures in `fixtures/`. `test-cli.js` shells
out to the real binary; the rest are pure.

`ui-test.sh` loads the extension into a headless GNOME Shell, has a throwaway
companion extension dump the rendered menu, and asserts the shell reports no
errors. It also reports bar geometry and x offsets, which is how layout bugs get
caught.

## GJS and St traps

These cost real debugging time. All four bit during development.

- **`read_bytes_finish` returns a single `GLib.Bytes`, not an `[ok, bytes]`
  tuple.** `const [ok, bytes] = ...` throws "not iterable" inside the callback,
  which fails silently wherever the callback's result is ignored.
- **`read_bytes_async`'s count is a per-read size, not a total.** One call
  truncates at the limit. `codexbar config providers` emits about 8KB, which
  lands mid-key and yields unparseable JSON. Drain until EOF.
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
cd /tmp/ziptest && unzip -q ~/src/codexbar-gnome/codexbar-gnome/*.zip && ls -R
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