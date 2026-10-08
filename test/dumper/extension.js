// Test-only extension. Prints the CodexBar popup menu's label tree to the
// shell log so ui-test.sh can assert on it, including after switching tabs.
// Never shipped.
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class CodexBarDumper extends Extension {
  // Style-resolved width, which is what a fill is computed against. Reading the
  // real value is the only way to catch an invisible bar.
  _widthOf(actor) {
    try {
      return Math.round(actor.get_width());
    } catch (e) {
      return -1;
    }
  }

  enable() {
    const target = GLib.getenv("CODEXBAR_DUMP_TARGET");
    this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
      this._dump(target);
      return GLib.SOURCE_REMOVE;
    });
  }

  // The tabs are icons now, so labels alone would show almost nothing. Report
  // any actor that carries identity (label text, a11y name) or geometry worth
  // checking (icons, bars, tracks).
  _describe(actor) {
    const cls = String(actor.style_class || "");
    const isIcon = actor instanceof St.Icon;
    const isBar = /codexbar-(bar|tab|panel)-(track|fill|marker|marker-tick)/.test(cls);
    if (actor instanceof St.Label) return `label ${JSON.stringify(actor.text)}`;
    if (isIcon) return `icon size=${actor.icon_size}`;
    // Bars report geometry and a11y together. Height matters as much as width:
    // a panel indicator taller than its neighbours is the obvious defect, and
    // only the real allocation shows it.
    if (isBar) {
      const acc = actor.accessible_name ? ` a11y:${actor.accessible_name}` : "";
      return `${cls} ${this._sizeOf(actor)}${acc}`;
    }
    if (actor.accessible_name) return `a11y:${actor.accessible_name}`;
    return null;
  }

  // Natural size, i.e. what the style asks for before allocation.
  _sizeOf(actor) {
    return `${this._widthOf(actor)}x${this._heightOf(actor)}`;
  }

  _heightOf(actor) {
    try {
      return Math.round(actor.get_height());
    } catch (e) {
      return -1;
    }
  }

  _walk(actor, depth, lines) {
    const pad = "  ".repeat(depth);
    const described = this._describe(actor);
    if (described) {
      const cls = actor.style_class ? `[${actor.style_class}] ` : "";
      lines.push(`${pad}${cls}${described}`);
    }
    actor.get_children().forEach((c) => this._walk(c, depth + 1, lines));
  }

  _dump(uuid) {
    const button = Main.panel.statusArea[uuid];
    print("CODEXBAR-DUMP-START");
    if (!button) {
      print("NO-PANEL-BUTTON");
      print("CODEXBAR-DUMP-END");
      return;
    }

    // Read the setting straight from dconf so a mis-set value is visible rather
// than inferred from the bar width. The target extension's own settings object
// is not reachable from here.
    try {
      const source = Gio.SettingsSchemaSource.get_default();
      const schema = source.lookup("org.gnome.shell.extensions.codexbar", true);
      const settings = new Gio.Settings({ settings_schema: schema });
      print(
        `CODEXBAR-DUMP setting primary-provider=${JSON.stringify(settings.get_string("primary-provider"))}`,
      );
    } catch (e) {
      print(`CODEXBAR-DUMP setting read failed: ${e.message}`);
    }

    button.menu.open();
    const lines = [];
    this._walk(button.menu.actor, 0, lines);
    lines.forEach((l) => print(`CODEXBAR-DUMP ${l}`));

    // The panel indicator lives outside the menu, so dump it separately.
    lines.length = 0;
    this._walk(button.container.get_children()[0], 0, lines);
    print("CODEXBAR-DUMP --- panel indicator ---");
    lines.forEach((l) => print(`CODEXBAR-DUMP ${l}`));

    // Click through each tab so every provider's rendering is covered. Buttons
    // are recreated on each switch, so re-collect them every time.
    const clickTab = (index) => {
      const tabs = [];
      const collect = (actor) => {
        if (actor instanceof St.Button && String(actor.style_class).includes("codexbar-tab")) {
          tabs.push(actor);
        }
        actor.get_children().forEach(collect);
      };
      collect(button.menu.actor);
      const tab = tabs[index];
      if (!tab) {
        print(`CODEXBAR-DUMP --- tab ${index} not found ---`);
        return;
      }
      tab.emit("clicked", null);
      const tabLines = [];
      this._walk(button.menu.actor, 0, tabLines);
      print(`CODEXBAR-DUMP --- after clicking tab ${index} ---`);
      tabLines.forEach((l) => print(`CODEXBAR-DUMP ${l}`));
    };

    const count = [];
    const countTabs = (actor) => {
      if (actor instanceof St.Button && String(actor.style_class).includes("codexbar-tab")) {
        count.push(actor);
      }
      actor.get_children().forEach(countTabs);
    };
    countTabs(button.menu.actor);
    for (let i = 0; i < count.length; i++) clickTab(i);

    button.menu.close();
    print("CODEXBAR-DUMP-END");
  }

  disable() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }
  }
}