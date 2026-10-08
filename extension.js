// GNOME Shell extension entry point.
//
// Widget layout follows the macOS CodexBar menu: a provider tab strip, the
// active provider's window meters, an optional balance block, a cost summary,
// then footer actions. Providers come from one `codexbar usage` call, so
// nothing is configured by hand.

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

const DEFAULT_REFRESH_MINUTES = 15;

// Secondary text keeps the theme's foreground colour and is dimmed with actor
// opacity. St has no CSS `opacity`, and a single extension stylesheet cannot
// ship separate light and dark foregrounds.
const SECONDARY_TEXT_OPACITY = 200;
const FAINT_TEXT_OPACITY = 150;

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
  const target = new Date(iso);
  const ms = target.getTime() - now.getTime();
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
 * Pace line, in the macOS wording. The CLI sends a ready-made summary, but it
 * is phrased for a terminal, so the stage and last-to-reset flags drive the
 * short popup line instead.
 * @param {object|null} pace
 * @param {number} usedPercent
 * @returns {string}
 */
function formatPace(pace, usedPercent) {
  if (!pace) return "";
  const stage = pace.stage || "";
  const delta = Math.round(Math.abs(Number(pace.deltaPercent) || 0));
  const lasts = pace.willLastToReset === true;

  // Stages observed from the CLI: farAhead, slightlyAhead, ahead, behind,
  // slightlyBehind, farBehind.
  const lead = {
    farAhead: _("Well ahead"),
    slightlyAhead: _("Slightly ahead"),
    ahead: _("Ahead"),
    farBehind: _("Far behind"),
    slightlyBehind: _("Slightly behind"),
    behind: _("Behind"),
  }[stage];

  const direction = Number(pace.deltaPercent) < 0 ? "-" : "+";
  const head = lead ? _("Pace: %s").format(lead) : _("Pace: %d%%").format(usedPercent);
  const tail = lasts
    ? _("%s%d%% · Lasts to reset").format(direction, delta)
    : _("%s%d%% · May run out").format(direction, delta);
  return `${head} · ${tail}`;
}

/**
 * Threshold colour for a fill percentage. Matches the macOS app: green while
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

export default class CodexBarExtension extends Extension {
  enable() {
    this._settings = this.getSettings();

    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);
    this._panelIcon = new St.Icon({
      icon_name: "utilities-system-monitor-symbolic",
      style_class: "system-status-icon",
    });
    this._indicator.add_child(this._panelIcon);

    // Tab strip, provider content, and footer, added to the menu's box so they
    // span the full popup width rather than sitting in menu items.
    this._tabsBox = new St.BoxLayout({ style_class: "codexbar-tabs" });
    this._contentBox = new St.BoxLayout({
      style_class: "codexbar-content",
      vertical: true,
      x_expand: true,
    });
    // PopupMenuSection is not a St widget, so it cannot go in the menu box like
    // the others. Keep it in the menu and let it sit below our content.
    this._footerBox = new PopupMenu.PopupMenuSection();
    this._indicator.menu.box.add_child(this._tabsBox);
    this._indicator.menu.box.add_child(this._contentBox);
    // The section's own actor has to join the menu box: addMenuItem fills the
    // section's box, which renders only when the section is in the tree.
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
      this._updateUI();
    } catch (e) {
      if (this._cancellable?.is_cancelled() || !this._indicator) return;
      this._error = e.message || String(e);
      this._stale = this._providers.length > 0;
      this._updateUI();
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
      // Only the countdown text needs recomputing, and only when open.
      if (this._indicator?.menu.isOpen) this._updateUI();
      return GLib.SOURCE_CONTINUE;
    });
  }

  /**
   * Worst usage across the active provider's meters, for the panel icon.
   * @returns {number} 0 to 100.
   */
  _activePercent() {
    const provider = this._providers[this._activeIndex];
    if (!provider) return 0;
    const meters = provider.windows.filter((w) => w.meter);
    if (meters.length === 0) return 0;
    return Math.max(...meters.map((w) => w.usedPercent));
  }

  _updatePanelIcon() {
    if (!this._panelIcon) return;
    if (this._error && this._providers.length === 0) {
      this._panelIcon.icon_name = "dialog-error-symbolic";
    } else {
      this._panelIcon.icon_name = "utilities-system-monitor-symbolic";
    }
    this._panelIcon.opacity = this._stale ? FAINT_TEXT_OPACITY : 255;
  }

  _buildFooter() {
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
      return item;
    };

    const open = (uri) => () => {
      Gio.AppInfo.launch_default_for_uri(uri, null);
      this._indicator.menu.close();
    };

    add(_("Add Account..."), "list-add-symbolic", open("https://github.com/steipete/CodexBar#readme"));
    add(_("Usage Dashboard"), "view-list-symbolic", open("https://github.com/steipete/CodexBar"));
    add(_("Status Page"), "network-transmit-receive-symbolic", open("https://status.openai.com"));
    add(_("Refresh Now"), "view-refresh-symbolic", () => {
      this._indicator.menu.close();
      this._refresh();
    });
    add(_("Settings..."), "preferences-system-symbolic", () => {
      this._indicator.menu.close();
      this.openPreferences();
    });

    this._footerBox.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

    add(_("Quit"), "application-exit-symbolic", () => {
      this._indicator.menu.close();
      this.disable();
    });
  }

  _updateUI() {
    if (!this._contentBox) return;
    this._updatePanelIcon();

    this._tabsBox.destroy_all_children();
    this._contentBox.destroy_all_children();

    if (!findCodexBar()) {
      this._contentBox.add_child(this._messageBox(
        _("codexbar not found"),
        _("Install it with: brew install steipete/tap/codexbar"),
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

    this._contentBox.add_child(this._buildHeader(provider));

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

    // Bars are sized as a percentage of the track, so they fill whatever width
    // the theme gives the popup. Ask for it explicitly, otherwise the menu
    // shrinks to fit the widest child and long provider names stretch it.
    this._contentBox.set_style("min-width: 320px;");
    this._tabsBox.set_style("min-width: 320px;");
  }

  _buildTabs() {
    this._providers.forEach((provider, index) => {
      const active = index === this._activeIndex;

      const button = new St.Button({
        style_class: active ? "codexbar-tab codexbar-tab-active" : "codexbar-tab",
        can_focus: true,
        accessible_name: provider.name,
      });

      const column = new St.BoxLayout({ vertical: true, y_align: Clutter.ActorAlign.CENTER });
      column.add_child(
        new St.Label({
          text: provider.name,
          style_class: active ? "codexbar-tab-label codexbar-tab-label-active" : "codexbar-tab-label",
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );

      // The underline is the macOS touch: each tab carries its own load, so you
      // can see which provider needs attention without switching to it. Balance
      // providers have no usage meter, so their tab gets a dim full-width track
      // instead of a misleading near-empty fill.
      const meters = provider.windows.filter((w) => w.meter);
      const isBalance = provider.kind === "balance";
      const percent = meters.length
        ? Math.max(...meters.map((w) => w.usedPercent))
        : 0;

      const track = new St.Widget({
        style_class: "codexbar-tab-track",
        y_align: Clutter.ActorAlign.CENTER,
      });
      if (provider.kind !== "error") {
        const fillPercent = isBalance ? 100 : percent;
        track.add_child(
          new St.Widget({
            style_class: isBalance ? "codexbar-tab-fill codexbar-tab-fill-balance" : "codexbar-tab-fill",
            style: `width: ${Math.max(2, Math.round(fillPercent))}%; background-color: ${isBalance ? "#77767b" : barColor(percent)};`,
          }),
        );
      }
      column.add_child(track);
      button.set_child(column);

      button.connect("clicked", () => {
        this._activeIndex = index;
        this._updateUI();
      });
      this._tabsBox.add_child(button);
    });
  }

  _buildHeader(provider) {
    const box = new St.BoxLayout({ vertical: true, x_expand: true });

    const titleRow = new St.BoxLayout({ x_expand: true });
    titleRow.add_child(
      new St.Label({
        text: provider.name,
        style_class: "codexbar-title",
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
      }),
    );
    if (provider.account) {
      titleRow.add_child(dimLabel({
        text: provider.account,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
      }));
    }
    box.add_child(titleRow);

    box.add_child(dimLabel({
      text: formatUpdated(provider.updatedAt) || _("Updating..."),
    }));

    return box;
  }

  /**
   * A window with a duration or a reset time: title, bar, percent, countdown.
   * @param {object} window
   * @returns {St.BoxLayout}
   */
  _buildMeter(window) {
    const box = new St.BoxLayout({ vertical: true, x_expand: true });
    box.add_child(new St.Label({ text: window.label, style_class: "codexbar-section" }));

    const track = new St.Widget({ style_class: "codexbar-bar-track" });
    track.add_child(
      new St.Widget({
        style_class: "codexbar-bar-fill",
        style: `width: ${Math.max(1, window.usedPercent)}%; background-color: ${barColor(window.usedPercent)};`,
      }),
    );
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

    if (this._settings.get_boolean("show-pace")) {
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
      line.add_child(dimLabel({ text: `${label}: ${formatMoney(cost, this._cost.currency)} · ${formatTokens(tokens)} tokens` }));
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
    box.add_child(new St.Label({
      text: title,
      style_class: "codexbar-section",
    }));
    const detailLabel = dimLabel({ text: detail });
    detailLabel.clutter_text.line_wrap = true;
    box.add_child(detailLabel);
    return box;
  }
}