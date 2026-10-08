// GNOME Shell extension entry point.
//
// Widget layout follows the macOS CodexBar menu: a strip of provider icons,
// the active provider's window meters, an optional balance block, a cost
// summary, then footer actions. Providers come from one `codexbar usage` call,
// so nothing is configured by hand.

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";

import { Extension, gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { fetchCost, fetchUsage, findCodexBar } from "./cli.js";
import { parseUsagePayload } from "./parse.js";
import { formatMoney, formatTokens, parseCostPayload } from "./cost.js";
import {
  ADD_ACCOUNT_URL,
  CLI_REPO_URL,
  EXTENSION_REPO_URL,
  FORK_ORIGIN_EXTENSION_URL,
  FORK_ORIGIN_URL,
  INSTALL_URL,
  LICENSE_URL,
  statusUrl,
  usageUrl,
} from "./links.js";

// Secondary text keeps the theme's foreground colour and is dimmed with actor
// opacity. St has no CSS `opacity`, and a single extension stylesheet cannot
// ship separate light and dark foregrounds.
const SECONDARY_TEXT_OPACITY = 200;
const FAINT_TEXT_OPACITY = 150;

// Tab logos. Sized so the padded tab reads as a comfortable target, the way the
// macOS app spaces its provider strip.
const TAB_ICON_SIZE = 22;
const TAB_TRACK_WIDTH = TAB_ICON_SIZE;

// Panel indicator. The GNOME top panel is 32px tall with 16px icons. This bar
// was first far too tall (it inherited the panel height), then too small to read
// next to the system icons, so it sits in between: a bit wider than a symbol and
// about half the panel height, which is where the eye expects a meter.
const PANEL_BAR_WIDTH = 22;
const PANEL_BAR_HEIGHT = 9;
// 1px border per side, no padding.
const PANEL_BAR_INSET = 2;
// Popup bar track. The popup sets min-width 320px and the content box pads 12px
// per side, leaving this. Kept in sync with stylesheet.css.
const BAR_WIDTH_PX = 296;

/**
 * Dimmed label.
 * @param {object} params Extra St.Label properties.
 * @returns {St.Label}
 */
function dimLabel(params) {
  const label = new St.Label({
    style_class: "codexbar-subtitle",
    ...params,
  });
  label.opacity = SECONDARY_TEXT_OPACITY;
  return label;
}

/**
 * "Resets in 3h 53m" from an absolute timestamp.
 * @param {string} iso
 * @param {Date} now
 * @returns {string} Empty when the timestamp is missing or already past.
 */
function formatResetsIn(iso, now = new Date()) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "";

  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return _("Resets in %dd %dh").format(days, hours);
  if (hours > 0) return _("Resets in %dh %dm").format(hours, minutes);
  return _("Resets in %dm").format(minutes);
}

/**
 * "Updated just now" / "Updated 5m ago" / "Updated 2h ago".
 * @param {string} iso
 * @param {Date} now
 * @returns {string}
 */
function formatUpdated(iso, now = new Date()) {
  if (!iso) return "";
  const ms = now.getTime() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return _("Updating...");
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return _("Updated just now");
  if (minutes < 60) return _("Updated %dm ago").format(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return _("Updated %dh ago").format(hours);
  return _("Updated %dd ago").format(Math.floor(hours / 24));
}

/**
 * True when a window is being consumed faster than its elapsed time allows.
 *
 * @param {object} window Normalized window from parse.js.
 * @returns {boolean}
 */
function isExceedingPace(window) {
  const pace = window?.pace;
  if (!pace) return false;

  // willLastToReset is the CLI's own verdict, but only the eta form carries it.
  // Fall back to comparing against the expected percentage, which is always
  // present, and treat an unknown stage as "no opinion" rather than a warning.
  if (pace.willLastToReset === true) return false;

  const expected = Number(pace.expectedUsedPercent);
  if (Number.isFinite(expected)) {
    return Number(window.usedPercent) > expected;
  }

  // No expected percentage: fall back to the stage names the CLI uses.
  return ["farAhead", "slightlyAhead", "ahead"].includes(pace.stage);
}

/**
 * Pace line, in the macOS wording. The CLI sends a ready-made summary, but it
 * is phrased for a terminal, so the stage and last-to-reset flags drive the
 * short popup line instead.
 * @param {object|null} pace
 * @param {number} usedPercent
 * @returns {string}
 */
function formatPace(pace, usedPercent) {
  if (!pace) return "";

  // Stages observed from the CLI: farAhead, slightlyAhead, ahead, behind,
  // slightlyBehind, farBehind.
  const lead = {
    farAhead: _("Well ahead"),
    slightlyAhead: _("Slightly ahead"),
    ahead: _("Ahead"),
    farBehind: _("Far behind"),
    slightlyBehind: _("Slightly behind"),
    behind: _("Behind"),
  }[pace.stage];

  const direction = Number(pace.deltaPercent) < 0 ? "-" : "+";
  const delta = Math.round(Math.abs(Number(pace.deltaPercent) || 0));
  const head = lead ? _("Pace: %s").format(lead) : _("Pace: %d%%").format(usedPercent);
  const tail = lastsWord(pace.willLastToReset, direction, delta);
  return `${head} · ${tail}`;
}

/**
 * @param {unknown} willLastToReset
 * @param {string} direction "+" or "-".
 * @param {number} delta
 * @returns {string}
 */
function lastsWord(willLastToReset, direction, delta) {
  return willLastToReset === true
    ? _("%s%d%% · Lasts to reset").format(direction, delta)
    : _("%s%d%% · May run out").format(direction, delta);
}

/**
 * Threshold colour for a fill percentage. Matches the macOS app: blue while
 * there is room, amber then red as a window runs out.
 * @param {number} percent
 * @returns {string} Adwaita palette colour.
 */
function barColor(percent) {
  if (percent >= 90) return "#e01b24";
  if (percent >= 75) return "#ff7800";
  if (percent >= 50) return "#f6d32d";
  return "#3584e4";
}

/**
 * Pixel width for a fill inside a track of `trackWidth`.
 *
 * Tracks are plain St.Widgets with no layout manager, so a CSS percentage width
 * resolves against an unallocated parent and the fill renders at zero width.
 * Track widths are fixed constants (see BAR_WIDTH_PX) and fills are computed
 * from them, so no measurement is needed.
 *
 * @param {number} trackWidth Track width in pixels.
 * @param {number} percent 0 to 100.
 * @param {number} inset Pixels reserved by the track's border and padding.
 * @returns {number} At least 1, so a tiny usage still shows.
 */
function fillWidth(trackWidth, percent, inset = 0) {
  const inner = Math.max(1, trackWidth - inset);
  const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
  return Math.max(1, Math.round((inner * clamped) / 100));
}

export default class CodexBarExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);

    // Panel indicator: a bar that fills as the primary provider burns through
    // its worst window, matching the macOS menu bar icon. Height is set here
    // rather than only in CSS because the panel button stretches its child to
    // the full 32px panel height, which is what made the bar tower over its
    // neighbours.
    this._panelTrack = new St.BoxLayout({
      style_class: "codexbar-panel-track",
      vertical: false,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      height: PANEL_BAR_HEIGHT,
      width: PANEL_BAR_WIDTH,
    });
    this._panelFill = new St.Widget({
      style_class: "codexbar-panel-fill",
      height: PANEL_BAR_HEIGHT - PANEL_BAR_INSET,
      width: 1,
      x_align: Clutter.ActorAlign.START,
    });
    this._panelTrack.add_child(this._panelFill);
    this._panelIcon = this._panelTrack;
    this._indicator.add_child(this._panelTrack);

    this._tabsBox = new St.BoxLayout({ style_class: "codexbar-tabs" });
    this._contentBox = new St.BoxLayout({
      style_class: "codexbar-content",
      vertical: true,
      x_expand: true,
    });
    // The section's own actor has to join the menu box: addMenuItem fills the
    // section's box, which renders only when the section is in the tree.
    this._footerBox = new PopupMenu.PopupMenuSection();
    this._indicator.menu.box.add_child(this._tabsBox);
    this._indicator.menu.box.add_child(this._contentBox);
    this._indicator.menu.box.add_child(this._footerBox.actor);

    this._providers = [];
    this._activeIndex = 0;
    this._cost = null;
    this._stale = false;
    this._error = null;
    this._refreshing = false;
    this._firstRun = true;
    this._cancellable = null;

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._settings.connectObject(
      "changed::refresh-interval",
      () => this._setupTimer(),
      "changed::show-pace",
      () => this._updateUI(),
      "changed::primary-provider",
      () => this._updateUI(),
      this,
    );

    this._buildFooter();
    this._setupTimer();
    this._refresh();
  }

  disable() {
    this._clearTimer();
    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }
    if (this._tickId) {
      GLib.Source.remove(this._tickId);
      this._tickId = null;
    }
    if (this._settings) {
      this._settings.disconnectObject(this);
      this._settings = null;
    }
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }
    this._tabsBox = null;
    this._contentBox = null;
    this._footerBox = null;
    this._panelTrack = null;
    this._panelFill = null;
    this._providers = [];
    this._refreshing = false;
  }

  _clearTimer() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }
  }

  _setupTimer() {
    this._clearTimer();
    const minutes = this._settings.get_int("refresh-interval");
    if (minutes <= 0) return;
    this._timeoutId = GLib.timeout_add_seconds(
      GLib.PRIORITY_DEFAULT,
      minutes * 60,
      () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      },
    );
  }

  /**
   * Fetch usage and cost, then render. Keeps the previous data on screen if
   * the fetch fails, so a transient CLI error does not blank the popup.
   */
  async _refresh() {
    if (this._refreshing || !this._indicator) return;
    this._refreshing = true;
    this._cancellable = new Gio.Cancellable();

    try {
      const payload = await fetchUsage(this._cancellable);
      const { providers } = parseUsagePayload(payload);

      // Cost is a separate command that only supports some providers. A failure
      // here must not take the usage view down with it.
      let cost = null;
      try {
        cost = parseCostPayload(await fetchCost(this._cancellable));
      } catch (e) {
        cost = null;
      }

      if (this._cancellable?.is_cancelled() || !this._indicator) return;

      this._providers = providers;
      this._cost = cost;
      this._error = null;
      this._stale = false;
      if (this._firstRun) {
        this._firstRun = false;
        this._startTick();
      }
      if (this._activeIndex >= providers.length) this._activeIndex = 0;
      try {
        this._updateUI();
      } catch (uiError) {
        console.error(`[CodexBar] _updateUI failed: ${uiError}`);
      }
    } catch (e) {
      if (this._cancellable?.is_cancelled() || !this._indicator) return;
      this._error = e.message || String(e);
      this._stale = this._providers.length > 0;
      try {
        this._updateUI();
      } catch (uiError) {
        console.error(`[CodexBar] _updateUI failed: ${uiError}`);
      }
    } finally {
      this._refreshing = false;
    }
  }

  /**
   * Re-render once a minute so "Resets in ..." and "Updated ..." count down
   * between fetches.
   */
  _startTick() {
    if (this._tickId) GLib.Source.remove(this._tickId);
    this._tickId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
      this._updatePanelIcon();
      if (this._indicator?.menu.isOpen) this._updateUI();
      return GLib.SOURCE_CONTINUE;
    });
  }

  /**
   * The provider the panel bar tracks. Falls back to the first provider with
   * usage data when the configured one is missing or erroring.
   * @returns {object|null}
   */
  _primaryProvider() {
    if (this._providers.length === 0) return null;
    const wanted = this._settings?.get_string("primary-provider") || "";
    if (wanted) {
      const match = this._providers.find((p) => p.id === wanted && p.kind !== "error");
      if (match) return match;
    }
    return this._providers.find((p) => p.kind !== "error") || this._providers[0];
  }

  /**
   * Worst usage across a provider's meters.
   * @param {object} provider
   * @returns {number} 0 to 100.
   */
  _worstPercent(provider) {
    const meters = provider.windows.filter((w) => w.meter);
    if (meters.length === 0) return 0;
    return Math.max(...meters.map((w) => w.usedPercent));
  }

  _updatePanelIcon() {
    if (!this._panelFill) return;

    const provider = this._primaryProvider();
    const percent = provider ? this._worstPercent(provider) : 0;

    // Pixel widths, not percentages: the track has no layout manager, so a
    // percentage fill would resolve against an unallocated parent and vanish.
    this._panelFill.set_width(fillWidth(PANEL_BAR_WIDTH, percent, PANEL_BAR_INSET));
    this._panelFill.set_style(`background-color: ${barColor(percent)};`);

    this._panelTrack.opacity = this._stale || this._error ? FAINT_TEXT_OPACITY : 255;
    this._panelTrack.accessible_name = provider
      ? _("%s: %d%% used").format(provider.name, percent)
      : _("CodexBar");
  }

  /**
   * Provider logo as an St.Icon, falling back to a letter tile for providers
   * with no bundled logo.
   * @param {object} provider
   * @param {number} size
   * @returns {St.Widget}
   */
  _providerIcon(provider, size) {
    const path = GLib.build_filenamev([
      this.path,
      "media",
      "logos",
      `${provider.id}-symbolic.svg`,
    ]);

    if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
      return new St.Icon({
        gicon: Gio.icon_new_for_string(path),
        icon_size: size,
        style_class: "codexbar-provider-icon",
      });
    }

    // No logo: a letter tile keeps the strip evenly spaced and still tells the
    // providers apart at a glance.
    const initial = (provider.name || provider.id || "?").trim().charAt(0).toUpperCase();
    return new St.Label({
      text: initial,
      style_class: "codexbar-provider-letter",
      y_align: Clutter.ActorAlign.CENTER,
      width: size,
      height: size,
    });
  }

  _buildFooter() {
    const providerId = () => this._providers[this._activeIndex]?.id || "";

    const add = (label, iconName, onActivate) => {
      const item = new PopupMenu.PopupMenuItem(label, {
        style_class: "codexbar-action",
      });
      if (iconName) {
        item.add_child(
          new St.Icon({
            icon_name: iconName,
            style_class: "popup-menu-icon codexbar-action-icon",
          }),
        );
      }
      item.connect("activate", onActivate);
      this._footerBox.addMenuItem(item);
    };

    const open = (uri) => () => {
      Gio.AppInfo.launch_default_for_uri(uri, null);
      this._indicator.menu.close();
    };

    add(_("Add Account..."), "list-add-symbolic", open(ADD_ACCOUNT_URL));
    add(_("Usage Dashboard"), "view-list-symbolic", () => open(usageUrl(providerId()))());
    add(_("Status Page"), "network-transmit-receive-symbolic", () => open(statusUrl(providerId()))());
    add(_("Refresh Now"), "view-refresh-symbolic", () => {
      this._indicator.menu.close();
      this._refresh();
    });
    add(_("Settings..."), "preferences-system-symbolic", () => {
      this._indicator.menu.close();
      this.openPreferences();
    });

    this._footerBox.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    // No Quit item: this is an extension, not an application, so there is no
    // process to exit. Disabling is the shell's job, via the Extensions app or
    // `gnome-extensions disable`.
    this._buildAboutMenu();
  }

  /**
   * "About CodexBar" opens a submenu rather than a page, so the credits and the
   * project links live in the shell instead of bouncing out to a browser.
   */
  _buildAboutMenu() {
    const open = (uri) => () => {
      Gio.AppInfo.launch_default_for_uri(uri, null);
      this._indicator.menu.close();
    };

    const submenu = new PopupMenu.PopupSubMenuMenuItem(_("About CodexBar"), true);
    // PopupSubMenuMenuItem builds its own ornament; leave it alone.

    const item = (label, uri) => {
      const entry = new PopupMenu.PopupMenuItem(label, {
        style_class: "codexbar-action",
      });
      entry.connect("activate", open(uri));
      submenu.menu.addMenuItem(entry);
    };

    item(_("This extension"), EXTENSION_REPO_URL);
    item(_("codexbar CLI"), CLI_REPO_URL);
    item(_("Upstream extension"), FORK_ORIGIN_URL);
    item(_("Upstream on extensions.gnome.org"), FORK_ORIGIN_EXTENSION_URL);
    item(_("License"), LICENSE_URL);

    const note = new PopupMenu.PopupMenuItem(
      _("A fork of the extension by @inled.es, published as 9841 and linked from the CodexBar README. Rewritten around a single CLI call."),
      { style_class: "codexbar-about-note", reactive: false },
    );
    submenu.menu.addMenuItem(note);

    this._footerBox.addMenuItem(submenu);
  }

  _updateUI() {
    if (!this._contentBox) return;
    this._updatePanelIcon();

    this._tabsBox.destroy_all_children();
    this._contentBox.destroy_all_children();

    if (!findCodexBar()) {
      this._contentBox.add_child(this._messageBox(
        _("codexbar not found"),
        _("Install it, then refresh. See %s").replace("%s", INSTALL_URL),
      ));
      return;
    }

    if (this._error && this._providers.length === 0) {
      this._contentBox.add_child(this._messageBox(_("Could not read usage"), this._error));
      return;
    }

    if (this._providers.length === 0) {
      this._contentBox.add_child(this._messageBox(
        _("No providers enabled"),
        _("Enable a provider in CodexBar, then refresh."),
      ));
      return;
    }

    this._buildTabs();

    const provider = this._providers[this._activeIndex];
    if (!provider) return;

    if (provider.kind === "error") {
      this._contentBox.add_child(this._messageBox(provider.name, provider.error));
      return;
    }

    // The tab icons carry identity, so no repeated provider-name header here.
    // The account and update stamp go on one compact line instead.
    const meta = new St.BoxLayout({ x_expand: true });
    const stamp = formatUpdated(provider.updatedAt) || _("Updating...");
    if (provider.account) {
      meta.add_child(dimLabel({
        text: `${stamp} · ${provider.account}`,
        x_align: Clutter.ActorAlign.START,
        x_expand: true,
      }));
    } else {
      meta.add_child(dimLabel({ text: stamp, x_expand: true }));
    }
    this._contentBox.add_child(meta);

    if (this._stale) {
      const stale = dimLabel({ text: _("Showing last known values") });
      stale.opacity = FAINT_TEXT_OPACITY;
      this._contentBox.add_child(stale);
    }

    for (const window of provider.windows) {
      this._contentBox.add_child(
        window.meter ? this._buildMeter(window) : this._buildBalance(window),
      );
    }

    if (this._cost) this._contentBox.add_child(this._buildCost());

    // Bars are sized in pixels against the track, so the popup needs a fixed
    // width to fill. Without it the menu shrinks to the widest label.
    this._contentBox.set_style("min-width: 320px;");
    this._tabsBox.set_style("min-width: 320px;");
  }

  _buildTabs() {
    const primaryId = this._primaryProvider()?.id;

    this._providers.forEach((provider, index) => {
      const active = index === this._activeIndex;

      const button = new St.Button({
        style_class: active ? "codexbar-tab codexbar-tab-active" : "codexbar-tab",
        can_focus: true,
        accessible_name: provider.name,
      });

      const column = new St.BoxLayout({
        vertical: true,
        y_align: Clutter.ActorAlign.CENTER,
      });
      column.add_child(this._providerIcon(provider, TAB_ICON_SIZE));

      // The underline is the macOS touch: each tab carries its own load, so
      // you can see which provider needs attention without switching to it.
      // Balance providers have no usage meter, so they get a dim full-width
      // track rather than a misleading near-empty fill.
      const isBalance = provider.kind === "balance";
      const percent = isBalance ? 0 : this._worstPercent(provider);
      const fillPercent = isBalance ? 100 : percent;

      const track = new St.BoxLayout({ style_class: "codexbar-tab-track" });
      track.add_child(
        new St.Widget({
          style_class: isBalance
            ? "codexbar-tab-fill codexbar-tab-fill-balance"
            : "codexbar-tab-fill",
          style: `width: ${fillWidth(TAB_TRACK_WIDTH, fillPercent)}px; background-color: ${isBalance ? "#77767b" : barColor(percent)};`,
        }),
      );
      column.add_child(track);
      button.set_child(column);

      button.connect("clicked", () => {
        this._activeIndex = index;
        this._updateUI();
      });
      this._tabsBox.add_child(button);

      // A dot marks which provider the panel bar is tracking.
      if (provider.id === primaryId && this._providers.length > 1) {
        this._tabsBox.add_child(
          new St.Widget({
            style_class: "codexbar-tab-primary-dot",
            y_align: Clutter.ActorAlign.CENTER,
          }),
        );
      }
    });
  }

  /**
   * A window with a duration or a reset time: title, bar, percent, countdown.
   * @param {object} window
   * @returns {St.BoxLayout}
   */
  _buildMeter(window) {
    const box = new St.BoxLayout({ vertical: true, x_expand: true });
    box.add_child(new St.Label({ text: window.label, style_class: "codexbar-section" }));

    // A plain St.Widget, not a BoxLayout: the fill and the tick have to overlap
    // inside one track, and a BoxLayout would place them side by side, pushing
    // the tick past the end of the bar.
    const track = new St.Widget({ style_class: "codexbar-bar-track" });
    track.add_child(
      new St.Widget({
        style_class: "codexbar-bar-fill",
        x: 0,
        style: `width: ${fillWidth(BAR_WIDTH_PX, window.usedPercent)}px; background-color: ${barColor(window.usedPercent)};`,
      }),
    );

    // A tick at the point where usage "should" be by now, so ahead and behind
    // read at a glance instead of having to compare two numbers.
    if (this._settings.get_boolean("show-pace")) {
      const expected = Number(window.pace?.expectedUsedPercent);
      if (Number.isFinite(expected) && expected > 0) {
        track.add_child(
          new St.Widget({
            style_class: "codexbar-bar-marker",
            x: fillWidth(BAR_WIDTH_PX, expected) - 1,
          }),
        );
      }
    }
    box.add_child(track);

    const row = new St.BoxLayout({ x_expand: true });
    row.add_child(dimLabel({ text: _("%d%% used").format(window.usedPercent) }));
    const resets = formatResetsIn(window.resetsAt);
    if (resets) {
      row.add_child(dimLabel({
        text: resets,
        x_align: Clutter.ActorAlign.END,
        x_expand: true,
      }));
    }
    box.add_child(row);

    // Only warn when the window is actually being over-consumed. The macOS app
    // does the same: a healthy window says nothing, and the tick in the bar
    // already carries the "you are fine" signal.
    if (this._settings.get_boolean("show-pace") && isExceedingPace(window)) {
      const pace = formatPace(window.pace, window.usedPercent);
      if (pace) {
        const paceLabel = dimLabel({ text: pace });
        paceLabel.opacity = FAINT_TEXT_OPACITY;
        box.add_child(paceLabel);
      }
    }

    box.add_child(new St.Widget({ style_class: "codexbar-separator" }));
    return box;
  }

  /**
   * A balance window has no duration and no reset, only a value. Rendering it
   * as a 0% bar would read as "exhausted", so it gets a value line instead.
   * @param {object} window
   * @returns {St.BoxLayout}
   */
  _buildBalance(window) {
    const box = new St.BoxLayout({ vertical: true, x_expand: true });
    box.add_child(new St.Label({ text: window.label, style_class: "codexbar-section" }));

    const row = new St.BoxLayout({ x_expand: true });
    row.add_child(dimLabel({ text: window.value || "-" }));
    row.add_child(dimLabel({
      text: _("%d%% used").format(window.usedPercent),
      x_align: Clutter.ActorAlign.END,
      x_expand: true,
    }));
    box.add_child(row);

    box.add_child(new St.Widget({ style_class: "codexbar-separator" }));
    return box;
  }

  /**
   * The macOS cost summary: today and the last 30 days, cost and tokens.
   * @returns {St.BoxLayout}
   */
  _buildCost() {
    const box = new St.BoxLayout({ vertical: true, x_expand: true });
    box.add_child(new St.Label({ text: _("Cost"), style_class: "codexbar-section" }));

    const row = (label, cost, tokens) => {
      const line = new St.BoxLayout({ x_expand: true });
      line.add_child(dimLabel({
        text: `${label}: ${formatMoney(cost, this._cost.currency)} · ${formatTokens(tokens)} tokens`,
      }));
      return line;
    };

    box.add_child(row(_("Today"), this._cost.today, this._cost.todayTokens));
    box.add_child(row(_("Last 30 days"), this._cost.total, this._cost.totalTokens));
    return box;
  }

  /**
   * @param {string} title
   * @param {string} detail
   * @returns {St.BoxLayout}
   */
  _messageBox(title, detail) {
    const box = new St.BoxLayout({ vertical: true, x_expand: true });
    box.add_child(new St.Label({ text: title, style_class: "codexbar-section" }));
    const detailLabel = dimLabel({ text: detail });
    detailLabel.clutter_text.line_wrap = true;
    box.add_child(detailLabel);
    return box;
  }
}