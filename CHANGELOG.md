# Changelog

## [1.1.0](https://github.com/lhw/codexbar-gnome/compare/v1.0.0...v1.1.0) (2026-10-08)


### Features

* show About CodexBar as a shell dialog ([476ae36](https://github.com/lhw/codexbar-gnome/commit/476ae36c74e8d7c71f5c7a432c830627f89fffec))


### Bug Fixes

* trigger the release build on workflow_run, not release: published ([b12b470](https://github.com/lhw/codexbar-gnome/commit/b12b47025c5769b381cda010c1a8cc21ccce54d4))

## [1.0.0](https://github.com/lhw/codexbar-gnome/compare/v0.0.0...v1.0.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* the uuid changes to codexbar-gnome@lhw and the settings schema is reduced to refresh-interval, show-pace and primary-provider. The per-provider command list, display-mode, show-logos, show-pacing-info and show-provider-details keys are gone, since the CLI is now the only configuration point.

### Features

* add anonymised screenshots optimised with yoga ([c789baf](https://github.com/lhw/codexbar-gnome/commit/c789bafd132d60215c50193e2c7c6bb9475c9e96))
* draw a pace tick inside the usage bars ([2c36447](https://github.com/lhw/codexbar-gnome/commit/2c36447513c1d656b6578ef0f5004a2e7c06e364))
* give About CodexBar a submenu with links and credits ([f8047ee](https://github.com/lhw/codexbar-gnome/commit/f8047eeaa33623d3638c280e3fb5edc5f182540c))
* only warn about pace when a window is over-consumed ([60b1a3e](https://github.com/lhw/codexbar-gnome/commit/60b1a3e45cb7ac644cdbeec1946f083e2633696a))
* remove the Quit menu item ([797df6f](https://github.com/lhw/codexbar-gnome/commit/797df6f467e460b0258d40a1da90a4286d2d1d93))
* rewrite around a single codexbar CLI call ([bc5b947](https://github.com/lhw/codexbar-gnome/commit/bc5b94766ea6f5cae9500a33bddff48d582701e9))
* track a primary provider in the panel bar and switch tabs to icons ([2bf9461](https://github.com/lhw/codexbar-gnome/commit/2bf946110a57ecdf00c0e1b617872998d6018dc8))


### Bug Fixes

* drain CLI output fully so the provider list parses ([5e62972](https://github.com/lhw/codexbar-gnome/commit/5e62972fe4340fcefd4e05c44916e2e80c27f8d7))
* give provider tabs more padding around smaller logos ([d011bf8](https://github.com/lhw/codexbar-gnome/commit/d011bf82b8828ef228e068424d524c7a4cc77345))
* let CI pass and give metadata.json a string version ([839ecd4](https://github.com/lhw/codexbar-gnome/commit/839ecd4fb287ba53f3ee3327420f00653e1b95fb))
* let release-please own tagging with plain vX.Y.Z tags ([eb5d007](https://github.com/lhw/codexbar-gnome/commit/eb5d007520f3ebc4d9de8d21150f816e973713b8))
* read the provider list from config instead of a live usage fetch ([91a1ea1](https://github.com/lhw/codexbar-gnome/commit/91a1ea144ce3d37577ff4a7a609c9c35b665c91d))
* size the panel bar to the panel and unblock the settings window ([84617f8](https://github.com/lhw/codexbar-gnome/commit/84617f8b37cec5b6cf7945572ac012959cee556c))
* stop the UI test disabling extensions at the next login ([b2afed3](https://github.com/lhw/codexbar-gnome/commit/b2afed3d2f55a10f8fd040c4fef0e9e8b9ad8778))

## 0.0.0

Baseline. Everything before this tag is upstream history carried in through the
fork, and is not part of this extension's releases.
