# Changelog

## [2.0.0](https://github.com/lhw/codexbar-gnome/compare/codexbar-gnome-v1.0.0...codexbar-gnome-v2.0.0) (2026-10-08)


### ⚠ BREAKING CHANGES

* the uuid changes to codexbar-gnome@lhw and the settings schema is reduced to refresh-interval, show-pace and primary-provider. The per-provider command list, display-mode, show-logos, show-pacing-info and show-provider-details keys are gone, since the CLI is now the only configuration point.

### Features

* add anonymised screenshots optimised with yoga ([c789baf](https://github.com/lhw/codexbar-gnome/commit/c789bafd132d60215c50193e2c7c6bb9475c9e96))
* add antigravity provider and restore prefs.js to main state ([ff0471d](https://github.com/lhw/codexbar-gnome/commit/ff0471d46a25781bf869b11fecf6a891b9912f56))
* add antigravity support ([090e871](https://github.com/lhw/codexbar-gnome/commit/090e87107edb3ba16327abfa2f9acc0c704350b6))
* add claude provider ([1eb57cb](https://github.com/lhw/codexbar-gnome/commit/1eb57cb8331567872c4133051c5a5e98d563bc25))
* add claude provider ([81ae53d](https://github.com/lhw/codexbar-gnome/commit/81ae53dccf1c5ee47b1e581fc5382be530da2705))
* add setting to optionally show weekly usage pacing ([64c0c6c](https://github.com/lhw/codexbar-gnome/commit/64c0c6c56d0728926e899da2a7f038b7b26b79b1))
* draw a pace tick inside the usage bars ([2c36447](https://github.com/lhw/codexbar-gnome/commit/2c36447513c1d656b6578ef0f5004a2e7c06e364))
* fix Auto-Login and update auth flow for ChatGPT API ([0b30da9](https://github.com/lhw/codexbar-gnome/commit/0b30da9c26b9adbdb55ac58b09d81b6350e82682))
* give About CodexBar a submenu with links and credits ([f8047ee](https://github.com/lhw/codexbar-gnome/commit/f8047eeaa33623d3638c280e3fb5edc5f182540c))
* only warn about pace when a window is over-consumed ([60b1a3e](https://github.com/lhw/codexbar-gnome/commit/60b1a3e45cb7ac644cdbeec1946f083e2633696a))
* **panel:** show provider usage as text in the top bar ([a8bd04f](https://github.com/lhw/codexbar-gnome/commit/a8bd04f8817eb8e70c6bd7651a6685b424922da0))
* **panel:** show provider usage as text in the top bar ([1993e0a](https://github.com/lhw/codexbar-gnome/commit/1993e0a7afdad403887185b531881b2c04c413b3))
* **prefs:** let each provider choose how it connects ([aa3d47f](https://github.com/lhw/codexbar-gnome/commit/aa3d47f653a1f6e8f13825da456c15382f50ba13))
* **providers:** add a source model for provider connections ([270ccbc](https://github.com/lhw/codexbar-gnome/commit/270ccbc1cf2ab4493fd6c84e064410ade1593051))
* remove the Quit menu item ([797df6f](https://github.com/lhw/codexbar-gnome/commit/797df6f467e460b0258d40a1da90a4286d2d1d93))
* rewrite around a single codexbar CLI call ([bc5b947](https://github.com/lhw/codexbar-gnome/commit/bc5b94766ea6f5cae9500a33bddff48d582701e9))
* track a primary provider in the panel bar and switch tabs to icons ([2bf9461](https://github.com/lhw/codexbar-gnome/commit/2bf946110a57ecdf00c0e1b617872998d6018dc8))
* **usage-api:** Conditionally display date in usage reset descriptions ([b2c24d6](https://github.com/lhw/codexbar-gnome/commit/b2c24d60b970d3fe18f87c4dbabbc619ffa755c1))
* **usageApi:** Support Codex Spark usage tiers ([294143f](https://github.com/lhw/codexbar-gnome/commit/294143feab363ad84ad6808c78b777a88c5bbac9))
* **usageApi:** Support Codex Spark usage tiers ([294143f](https://github.com/lhw/codexbar-gnome/commit/294143feab363ad84ad6808c78b777a88c5bbac9))
* **usageApi:** Support Codex Spark usage tiers ([0e5ffda](https://github.com/lhw/codexbar-gnome/commit/0e5ffdac03ac09cd84298a2e31b7c96f68929cb4))
* **welcome:** install helper scripts via raw GitHub instead of PyPI ([0e82bd7](https://github.com/lhw/codexbar-gnome/commit/0e82bd749d9a0f4ad512117a27a56a2ff7c8e275))


### Bug Fixes

* Codex shows only Spark windows — don't misdetect extraRateWindows as Antigravity ([5d08bb1](https://github.com/lhw/codexbar-gnome/commit/5d08bb1460c675ec2f738fbc2d12f7f87e71e717))
* don't treat Codex extraRateWindows as Antigravity; append them after canonical windows ([e43f9ac](https://github.com/lhw/codexbar-gnome/commit/e43f9acd944ac58c2d7f3ef8b96f58f3076140cf))
* drain CLI output fully so the provider list parses ([5e62972](https://github.com/lhw/codexbar-gnome/commit/5e62972fe4340fcefd4e05c44916e2e80c27f8d7))
* **extension:** destroy UI elements in disable() to fix EGO-L-002 ([21b9862](https://github.com/lhw/codexbar-gnome/commit/21b98624d1a6fa1f0075d25212ab9de8d34dfdb4))
* give provider tabs more padding around smaller logos ([d011bf8](https://github.com/lhw/codexbar-gnome/commit/d011bf82b8828ef228e068424d524c7a4cc77345))
* let CI pass and give metadata.json a string version ([839ecd4](https://github.com/lhw/codexbar-gnome/commit/839ecd4fb287ba53f3ee3327420f00653e1b95fb))
* **logos:** use the official Claude and Codex marks ([58ec29e](https://github.com/lhw/codexbar-gnome/commit/58ec29e87a4c9f8b99bf5986f8db2546011ef051))
* **panel:** shrink and center the usage indicator ([8a4cd29](https://github.com/lhw/codexbar-gnome/commit/8a4cd2940f6e90bbbe4d76a0fc89a4b342220bf4))
* preserve short session token chunks ([afe61ee](https://github.com/lhw/codexbar-gnome/commit/afe61eec98fe4252b7d4ec00073555d1cd7776de))
* read the provider list from config instead of a live usage fetch ([91a1ea1](https://github.com/lhw/codexbar-gnome/commit/91a1ea144ce3d37577ff4a7a609c9c35b665c91d))
* refactor mapSingle to use shared parsing helpers and support remaining_percent ([d60c383](https://github.com/lhw/codexbar-gnome/commit/d60c3833ec0e4801b143e1f2fa7d7a119c3d3ae5))
* **secret:** lazily initialize Secret.Schema to fix EGO-L-001 ([cf2bb8f](https://github.com/lhw/codexbar-gnome/commit/cf2bb8f6e4bad1527191ce9f3e4f217219326e35))
* size the panel bar to the panel and unblock the settings window ([84617f8](https://github.com/lhw/codexbar-gnome/commit/84617f8b37cec5b6cf7945572ac012959cee556c))
* stop the UI test disabling extensions at the next login ([b2afed3](https://github.com/lhw/codexbar-gnome/commit/b2afed3d2f55a10f8fd040c4fef0e9e8b9ad8778))
* **theme:** fix illegible colors in light mode ([d86cf9a](https://github.com/lhw/codexbar-gnome/commit/d86cf9ac69389b89eea3956bd46d605e1ad6ab65))
* **theme:** fix illegible colors in light mode ([434b253](https://github.com/lhw/codexbar-gnome/commit/434b253c3ee87fb8c1d7dfbf71885d065131d630))
* **theme:** inherit GNOME theme colors ([2f179b6](https://github.com/lhw/codexbar-gnome/commit/2f179b6b4c5c240f0e123bb15ce2c1caa4f1b12f))

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
