# Changelog

## 1.0.0

First release of this fork. Rewritten around a single `codexbar usage` call so
every enabled provider is discovered automatically, with nothing to configure.

### Breaking changes

- The uuid is now `codexbar-gnome@lhw`, so it installs alongside the upstream
  extension rather than replacing it.
- The settings schema is reduced to `refresh-interval`, `show-pace` and
  `primary-provider`. The per-provider command list is gone, since the CLI is
  the only configuration point now.

### Features

- Provider tabs as logos with a per-tab load underline, and the big
  provider-name header dropped in favour of a compact account and update line
- A top-panel bar that fills as the primary provider burns through its worst
  window, selectable in Settings
- Pace ticks inside each usage bar at the point where usage should be by now,
  with a pace line shown only when a window is over-consumed
- Balance providers such as DeepSeek render as a value rather than a misleading
  empty bar
- A cost summary for providers `codexbar cost` supports
- Footer actions with per-provider Usage Dashboard and Status Page links, and an
  About submenu listing this repository, the CLI, the upstream extension and the
  license

Full detail is in the commit history; this tag covers the rewrite and everything
on top of it.