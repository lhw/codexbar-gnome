# CodexBar for GNOME

A GNOME Shell panel extension that shows AI provider usage limits, matching the
layout of the macOS CodexBar menu. It reads from the
[`codexbar`](https://github.com/steipete/CodexBar) command line tool, so nothing
is scraped and no browser cookies are handled here.

Targets GNOME Shell 50. Uses the default theme; `stylesheet.css` only sets
spacing and fill colours.

## Install

```sh
git clone https://github.com/lhw/codexbar-gnome
cd codexbar-gnome
./install.sh
```

You need the `codexbar` CLI on `PATH` (`brew install steipete/tap/codexbar`, or
a Linux build). On Wayland, log out and back in after installing so the shell
picks up the new extension.

## What it shows

The popup mirrors the macOS app:

- A tab per provider, shown as its logo with a load underline, so you can see
  which one needs attention without switching to it
- A compact line with the account and a relative "Updated" stamp
- One section per rate window: the label the CLI reports (Session, Weekly,
  Monthly), a usage bar, the percentage, and a reset countdown
- A pace line per window, using the CLI's own pace data
- Balance providers, such as DeepSeek, render as a value line rather than a
  misleading empty bar
- A cost summary (today and the last 30 days) for providers `codexbar cost`
  supports: Antigravity, Claude, Codex, Muse Code, and Pi
- Footer actions: Add Account, Usage Dashboard, Status Page, Refresh Now,
  Settings, About CodexBar, Quit

## Layout

| File | Role |
| --- | --- |
| `extension.js` | Panel button, widget tree, refresh and disable lifecycle |
| `cli.js` | Runs the `codexbar` binary over `Gio.Subprocess`, with timeouts |
| `parse.js` | Pure parsing of `codexbar usage --format json` |
| `cost.js` | Pure parsing of `codexbar cost --format json`, plus formatting |
| `prefs.js` | Preferences window: refresh interval, pace toggle |
| `stylesheet.css` | Spacing and fill colours only |

Providers are discovered automatically. `codexbar usage --format json` returns
every enabled provider in one call, so there is no provider list to configure.

## Tests

```sh
./build.sh      # compiles schemas, runs tests, packs the zip
./ui-test.sh    # loads the extension in a headless shell and dumps the menu
```

`build.sh` runs four headless suites (`test/test-parse.js`,
`test/test-cost.js`, `test/test-display.js`, `test/test-links.js`) against JSON
fixtures captured from the real CLI in `fixtures/`.

`ui-test.sh` starts an isolated headless GNOME Shell, enables the extension,
and prints the rendered menu's icon, label, and bar geometry, which catches
layout errors the unit tests cannot. It never touches your live session. Set
`CODEXBAR_TEST_PRIMARY=<provider id>` to check the primary-provider setting.

## Panel indicator and tabs

The top-panel indicator is a small bar that fills as the **primary provider**
burns through its worst window, going blue, then amber, then red. Pick the
provider in Settings, or leave it on automatic to track the first one with
usage data. Its accessible name announces which provider and how much is used.

The tab strip is provider icons only, each with a load underline, so the
provider name no longer needs repeating in a header. A dot marks the primary
provider. Icons come from the CodexBar logo set; providers without a bundled
logo get a letter tile instead.

## Links

Usage Dashboard and Status Page follow whichever provider tab is active, using
the map in `links.js`. Add Account opens codexbar's configuration docs, where
credentials are set.

## Differences from the macOS app

- GNOME's theme draws the popup background, so there is no frosted-glass
  translucency.
- Add Account, Usage Dashboard, and Status Page open web pages. The macOS app
  links into its own UI.
- No Sonnet or Extra usage rows. Those come from Claude-specific fields that the
  current CLI JSON does not expose; they will appear if a provider reports them.

## Credits

Fork of [InledGroup/codexbar-gnome](https://github.com/InledGroup/codexbar-gnome),
which is published as [extension 9841](https://extensions.gnome.org/extension/9841/codexbar/)
and linked from the CodexBar README.

Provider logos come from the
[CodexBar logo set](https://github.com/steipete/CodexBar/tree/main/docs/logos),
converted to GNOME symbolic icons so they follow the theme's foreground.

See `LICENSE.md` for its terms (MIT).