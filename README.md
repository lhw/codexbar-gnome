# CodexBar for GNOME

A GNOME Shell panel extension that shows AI provider usage limits, matching the
layout of the macOS CodexBar menu. It reads from the
[`codexbar`](https://github.com/steipete/CodexBar) command line tool, so nothing
is scraped and no browser cookies are handled here.

Targets GNOME Shell 50. Uses the default theme, so it follows your light and dark
settings.

## Screenshots

Each bar carries a tick at the point where usage *should* be by now, so running
hot is visible at a glance. A pace line appears only when a window is actually
over-consumed, which here is all three. The dot in the tab strip marks the
provider the panel bar is tracking.

<table>
  <tr>
    <td align="center" valign="top">
      <img src="docs/screenshots/popup.png" width="300" alt="Popup with OpenCode Go selected: provider tabs with load underlines, three usage bars with pace ticks, and the footer actions"><br>
      <sub><b>OpenCode Go</b><br>Three rate windows, all running hot</sub>
    </td>
    <td align="center" valign="top">
      <img src="docs/screenshots/balance.png" width="300" alt="DeepSeek tab showing a balance value rather than a usage bar"><br>
      <sub><b>DeepSeek</b><br>A balance has no percentage, so it shows its value</sub>
    </td>
    <td align="center" valign="top">
      <img src="docs/screenshots/codex.png" width="300" alt="Codex tab with the account redacted"><br>
      <sub><b>Codex</b><br>Weekly window, running under pace</sub>
    </td>
  </tr>
</table>

## Install

```sh
git clone https://github.com/lhw/codexbar-gnome
cd codexbar-gnome
./install.sh
```

Or download `codexbar-gnome@lhw.shell-extension.zip` from the
[releases page](https://github.com/lhw/codexbar-gnome/releases) and install it
with `gnome-extensions install --force <zip>`.

You need the `codexbar` CLI on `PATH` (`brew install steipete/tap/codexbar`, or
a Linux build). On Wayland, log out and back in after installing so the shell
picks up the new extension.

## What it shows

- A tab per provider, as its logo with a load underline, so you can see which one
  needs attention without switching to it
- One section per rate window: the label the CLI reports (Session, Weekly,
  Monthly), a usage bar, the percentage, and a reset countdown
- A pace warning when usage exceeds the elapsed-time estimate; Codex shows its
  full pace summary, including expected usage and run-out estimate
- Codex credit balance, limit-reset credits, and plan when the CLI provides them
- Balance providers such as DeepSeek, as a value rather than a bar
- A cost summary, today and the last 30 days, for providers `codexbar cost`
  supports: Antigravity, Claude, Codex, Muse Code, and Pi
- Footer actions: Add Account, Usage Dashboard, Status Page, Refresh Now,
  Settings, About CodexBar

Usage Dashboard and Status Page follow whichever provider tab you are on.
Providers are discovered automatically, so there is nothing to configure: enabling
one in codexbar is enough for it to appear here.

## Settings

Usage options:

- **Refresh interval**, 1 to 240 minutes. Countdowns between fetches still tick
  every minute, so they stay accurate without polling more often.
- **Show pace**, which controls both the pace lines and the tick on each bar.
- **Browser helper data**, off by default, plus the exact profile label to bind
  the cache to. See the security notice and setup instructions below before
  enabling the separate helper.

## Panel bar

The top-panel indicator is a small bar that fills as the **primary provider**
burns through its worst window, going blue, then amber, then red. Pick the
provider under Settings, or leave it on automatic to track the first one with
usage data.

## Optional browser-session helper (experimental, off by default)

The normal `codexbar` quota and cost paths remain primary. The separate helper
can add DeepSeek detailed usage, Codex web rate-limit extras, and OpenCode Go
Console quota/balance plus optional last-24-hour Console usage history. The
history shows organization-wide reported cost, token/request totals, hourly
activity, and up to ten model costs; it is not out-of-pocket billing or a
Go-only charge. Installing the extension does not start the helper or enable a
service. The extension reads only its sanitized cache when **Allow browser-session
access and show usage** is enabled, the matching **Browser profile** is
configured, and that cache is less than one hour old. DeepSeek details include
today/period totals, requests, top model, per-model cost, and daily token/spend
bars. The period is the current month when monthly fallback is used and the
last 30 days for the by-key endpoint.

It reads only the target provider's credentials: the exact `userToken` key for
`platform.deepseek.com` (Firefox/Waterfox SQLite or Chrome/Chromium Local Storage
LevelDB), OpenCode's named session cookies for `opencode.ai`, or cookies scoped
to `chatgpt.com` for Codex. Firefox databases are SQLite read-only; when the
running browser holds an exclusive lock, the helper briefly copies the database
and its WAL/journal to a private temporary directory, queries that snapshot,
and removes it. Cookie snapshots can contain other sites' cookies, and a crash
may leave them behind, just like the Chromium snapshot described below.
Chromium's complete Local Storage LevelDB store (which can contain other sites'
local-storage values) is copied to a 0700 temporary directory with 0600 files
for a consistent read-only snapshot and removed afterward. A crash may leave
that temporary snapshot behind. No cookie database is opened for Chromium;
Chromium cookie sessions are not supported yet. Firefox cookie selection is
restricted to exact request domains, live paths, unexpired records, and one
origin-attributes container; ambiguous containers fail closed. A chosen browser
profile is re-read each poll; select it once in Preferences. A blank profile
prevents credential access rather than guessing an account. Tokens, cookies, and raw provider responses are never written to
the persistent cache or logs; Chromium's temporary snapshot is the exception
described above. Codex browser results are checked
against the CLI account email when available.

The cache is split into `browser-usage-deepseek.json`,
`browser-usage-opencodego.json`, and `browser-usage-codex.json`, so one provider
cannot replace another. `--provider all` refreshes all three independently;
one provider can still be selected explicitly.

The endpoints are private and may change. For Codex, the helper also reads daily
token totals from the profile activity buckets and paid-credit events from the
credit-usage-events endpoint. These are distinct histories: token activity is
not paid credits, and percentage-based model breakdowns are not credit amounts.
Profile details, including names, email, and avatar, are never cached. OpenCode uses the upstream
Console organization/status/billing routes, with the upstream legacy
server-function fallback for older accounts. The browser-session endpoint behavior
and response shapes were checked against the MIT-licensed
[CodexBar project](https://github.com/steipete/CodexBar); this helper is an
independent implementation, not copied source. Existing CLI data continues to
show if helper access fails.

The popup keeps totals compact and puts daily/hourly charts in expandable native
GNOME history menus. Hover, click, or keyboard-focus a bar for its details.
DeepSeek shows today, 7-day, and period spend/token totals; OpenCode shows 24-hour
reported usage and model-cost bars. Codex shows 30-day token activity and separate
paid-credit history. Zero balances and summary totals are hidden; non-empty
history charts retain zero-usage days and hours. CLI cost estimates
remain separate and are scoped to the selected provider, not added to web totals.

### Setup and start

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) first. The
helper uses its locked Python 3.12 environment; it needs no browser extension or
system-wide Python dependencies. Then use **Preferences → Optional browser helper**:

1. Click **Find profiles** and confirm the local session scan.
2. Select a browser profile from the dropdown; its available providers are listed.
3. Enable **Allow browser-session access and show usage**. Set the polling interval
   (15 minutes by default), optional Codex email, and optional trusted solver URL.
4. Click **Set up & start** and confirm downloads and the login service.

Preferences checks the user service and provides a **Stop** control. Opening
Preferences does not scan browser sessions, download dependencies, or start the
service. Scanning and starting are explicit actions. Configuration is shared by
the helper and popup; no second profile or solver configuration is needed.

The profile scan checks only provider-specific origins and stored sessions. It
reads matching session values in memory but never prints or caches them and makes
no provider API requests. Expired cookies, unrelated domains, and empty/unreadable
stores do not qualify. Stored credentials do not prove the provider still accepts
the session. Preparing the locked environment may download Python and dependencies.

### Command-line alternative

From the checkout or installed extension directory:

```sh
cd browser-session
uv run --locked --python 3.12 python helper.py setup
uv run --locked --python 3.12 python helper.py profiles
```

For a packaged install, the directory is normally
`~/.local/share/gnome-shell/extensions/codexbar-gnome@lhw/`.

Select the profile and enable access in Preferences, then choose a foreground run
or a single refresh:

```sh
uv run --locked --python 3.12 python helper.py start  # stop with Ctrl+C
uv run --locked --python 3.12 python helper.py once
```

The helper checks settings at least once per minute between refreshes. Switching
access off pauses new refreshes; a request already in flight can finish. Changing
the profile triggers a fresh poll and the popup rejects the old profile's cache.
Errors from one provider do not hide healthy providers or existing CLI usage.

If a provider rejects the browser session, the popup and Preferences show
**Browser session expired or invalid**, with instructions to sign in again in
the selected browser profile. The helper retries automatically; the warning
clears after a successful refresh. Preferences checks these cached session errors
every 30 seconds while open, independently of the service's **Running** status.
Missing local sessions, access denials, Cloudflare challenges, and connection
failures have separate messages; they are not all treated as expired credentials.

### Optional login service

For automatic startup, explicitly install and enable the systemd **user** service:

```sh
uv run --locked --python 3.12 python helper.py enable-service
systemctl --user status codexbar-browser-session.service
journalctl --user -u codexbar-browser-session.service -n 30
```

It uses the same Preferences and runs as your user, not root. To stop automatic
startup:

```sh
uv run --locked --python 3.12 python helper.py disable-service
```

Enable the service from the installed extension directory if you want it to
survive moving/removing a checkout. Re-run `enable-service` after relocating the
helper. Nothing in the build/install scripts enables a service or reads browser
credentials. Setup downloads the locked dependencies and may download Python.

### FlareSolverr trust

The FlareSolverr URL is empty (disabled) by default and used only after a confirmed Codex
Cloudflare challenge. It sends the selected `chatgpt.com` session cookies (and
account data returned by the session endpoint) to that FlareSolverr server.
Use only a server you trust. Local HTTP is suitable for localhost; remote HTTP
exposes credentials in transit, so use HTTPS for a remote server. FlareSolverr's
`request.get` recovers the cookie-backed session response; the helper then retries
the API with its bearer token, scoped cookies, and the solver's browser User-Agent.
Clearance may be tied to the solver's network or browser, so this retry can still
be challenged. The same bearer token, scoped cookies, and solver User-Agent are
used for optional Codex history requests; failures leave quota available and are
reported without exposing server details.

The normal launcher polls all registered providers. From the helper directory,
diagnostics for a single provider can be run with `uv run --locked --python 3.12
python daemon.py --enable --once --provider codex`. Profile,
interval, email, and solver CLI flags from earlier helper versions have been
removed; move their values into Preferences. The packaged helper now lives under
`browser-session/`, not as loose files at the zip root.

## Differences from the macOS app

- GNOME's theme draws the popup background, so there is no frosted-glass
  translucency.
- Add Account, Usage Dashboard, and Status Page open web pages. The macOS app
  links into its own UI.
- No Sonnet or Extra usage rows. Those come from Claude-specific fields that the
  current CLI does not expose; they will appear if a provider reports them.

About CodexBar opens a plain dialog with the version, credits and project links,
without dimming the desktop.

## Credits

Fork of [InledGroup/codexbar-gnome](https://github.com/InledGroup/codexbar-gnome),
which is published as [extension 9841](https://extensions.gnome.org/extension/9841/codexbar/)
and linked from the CodexBar README. Rewritten around a single CLI call.

Provider logos come from the
[CodexBar logo set](https://github.com/steipete/CodexBar/tree/main/docs/logos),
converted to GNOME symbolic icons so they follow the theme's foreground.

See `LICENSE.md` for its terms (MIT).

Working on the extension? See [AGENTS.md](AGENTS.md).
