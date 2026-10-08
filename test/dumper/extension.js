// Test-only extension. Prints the CodexBar popup menu's label tree to the
// shell log so ui-test.sh can assert on it, including after switching tabs.
// Never shipped.
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";
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
    const isBar = /codexbar-(bar|tab|panel)-(track|fill|marker)/.test(cls);
    const isSub = actor instanceof PopupMenu.PopupSubMenuMenuItem;
    if (actor instanceof St.Label) return `label ${JSON.stringify(actor.text)}`;
    // Buttons carry their text as a label child, not as a text property, and
    // St.Button.label is null in GNOME 50, so read the child. The width matters
    // too: text wider than the dialog would run past its edge.
    if (actor instanceof St.Button) {
      const text = actor.get_first_child()?.text;
      return `button ${JSON.stringify(text ?? null)} ${this._sizeOf(actor)}`;
    }
    if (isSub) return `SUBMENU ${JSON.stringify(actor.label.text)}`;
    if (isIcon) return `icon size=${actor.icon_size}`;
    // Bars report geometry, x offset, and a11y together. The x offset matters:
    // the pace tick overlaps the fill inside one track, so a tick positioned
    // past the track width is a defect that width alone would not reveal.
    if (isBar) {
      const acc = actor.accessible_name ? ` a11y:${actor.accessible_name}` : "";
      return `${cls} ${this._sizeOf(actor)} x=${this._xOf(actor)}${acc}`;
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

  _xOf(actor) {
    try {
      return Math.round(actor.get_x());
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

    button.menu.open();
    const lines = [];
    this._walk(button.menu.actor, 0, lines);
    lines.forEach((l) => print(`CODEXBAR-DUMP ${l}`));

    // Submenus are not in the actor tree until opened, so open each one and dump
    // what it holds.
    const subs = [];
    const collectSubs = (actor) => {
      if (actor instanceof PopupMenu.PopupSubMenuMenuItem) subs.push(actor);
      actor.get_children().forEach(collectSubs);
    };
    collectSubs(button.menu.actor);
    for (const sub of subs) {
      sub.menu.open();
      const subLines = [];
      this._walk(sub.menu.actor, 0, subLines);
      print(`CODEXBAR-DUMP --- submenu ${sub.label.text} ---`);
      subLines.forEach((l) => print(`CODEXBAR-DUMP ${l}`));
      sub.menu.close();
    }

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

    // The About dialog is a modal outside the menu's actor tree. Activating the
    // menu item is not an option: `activate` needs a real ClutterEvent, which
    // cannot be constructed. Call the handler directly instead, which is the
    // same reach this harness already has into the widget tree.
    try {
      const target = Extension.lookupByUUID(uuid);
      target._showAbout();
      const dialogLines = [];
      Main.layoutManager.modalDialogGroup.get_children().forEach((dlg) => {
        this._walk(dlg, 0, dialogLines);
        dialogLines.push(`  width=${Math.round(dlg.get_width())}`);
      });
      print("CODEXBAR-DUMP --- about dialog ---");
      dialogLines.forEach((l) => print(`CODEXBAR-DUMP ${l}`));
    } catch (e) {
      print(`CODEXBAR-DUMP --- about dialog --- THREW ${e.message}`);
      print(`CODEXBAR-DUMP --- about stack --- ${e.stack}`);
    }
    print("CODEXBAR-DUMP-END");
  }

  disable() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }
  }
}