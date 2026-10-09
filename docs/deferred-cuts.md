# Deferred over-engineering cuts

The over-engineering audit of the browser-session helper made four code cuts
that are deliberately **not** applied. This file records what each one is, why
it was left alone, and what would have to be true to do it.

The cuts that *were* applied (redundant shell-side cache validation, single-use
`browserCacheFilename`/`_fetch_*` adapters, the `session_profiles`/
`matching_sessions` split, the locked-SQLite retry loop, the duplicated
`_MAX_COUNT`, the dead `browser_profiles` helper, the test-only `runtime.py`
`--service-text` CLI, and the source-text assertions in `test-prefs.js`) landed
in the commit that added this file.

## 1. Consolidate the four browser render blocks (`yagni`)

`_buildBrowserSummary`, `_buildBrowserWindows`, `_addCodexHistory` and the
per-provider `if (provider.id === …)` blocks in `_updateUI` share a shape but
present genuinely different data: DeepSeek summary rows, Codex quota bars plus
token/credit history, and OpenCode console cost plus a model chart.

**Deferred because** a "generic extra-usage renderer" would have to be
config-driven to cover those differences, and the pieces already share
`dimLabel`, `nonzeroDetails` and `_addChartToMenu`. The abstraction would add
indirection without deleting much.

**Revisit when** a fourth browser-data provider lands, or when a third render
path needs the same row/chart helper. Until then the bespoke blocks are
shorter than the generic one would be.

## 2. Share `prefs.js runAsync` with `cli.js` (`shrink`)

Both drain a `Gio.Subprocess` pipe with a timeout, an output cap, and a
final decode. They look like one function.

**Deferred because** the contracts differ in ways that matter: `cli.js` decodes
incrementally per chunk, while `prefs.js` collects bounded chunks and decodes
once at EOF to survive a UTF-8 character split across a read. `cli.js`'s
incremental decoder is the exact trap `AGENTS.md` warns about. Merging means
picking the one-shot decoder for both, i.e. a correctness change to
`runCodexBar`, not a pure reduction.

**Revisit when** `test-cli.js` and `test-prefs.js` can both run (`gjs`), so the
merged helper can be verified end to end. At that point move the one-shot
reader into `cli.js`, export it, and have `prefs.js` import it.

## 3. Collapse the `Provider` registry to a plain dict (`yagni`)

`Provider` (a frozen dataclass) plus `register_provider`'s type/scope checks
plus dynamic dispatch serve three providers that all live in `daemon.py`.

**Deferred because** the registry is the documented provider extension point
(`AGENTS.md`: "Add a `Provider` registration with three hooks") and
`register_provider` is what rejects unsafe ids. The id ends up in
`cache_path()` as a filename, so its `[a-z][a-z0-9_-]*` check is the guard
against a path-traversal id. Deleting the seam saves ~35 lines and removes that
validation.

**Revisit only if** the goal is to freeze the provider set. Otherwise the seam
is the cheaper half of the trade.

## 4. `shutil.copytree` in `snapshot_leveldb` (`stdlib`)

The manual "clear destination, copy each candidate, chmod" loop reads like
`shutil.copytree` with an `ignore` callable.

**Deferred because** it is not actually shorter: `copytree` still needs an
`ignore` predicate to skip `LOCK`/`LOG`/symlinks and directories, and the
function keeps its size/mtime stability bookkeeping either way.

**Revisit if** the stability check is removed first; then `copytree` is a clean
win.

## Verification gap

The applied cuts were verified with the Python suite (51 tests, run against a
temporary `plyvel` stub) and `test-display.js` (86 checks, via a Node
`gi://GLib` shim). The `gjs`-only suites (`test-prefs`, `test-parse`,
`test-cost`, `test-links`, `test-cli`) and `ui-test.sh`, plus the one test that
needs a real LevelDB, were **not** run in the environment where the cuts were
made. Run `./build.sh` and `./ui-test.sh` on a machine with `gjs` before relying
on this branch.
