// Test-only extension. Prints the CodexBar popup menu's label tree to the
// shell log so ui-test.sh can assert on it, including after switching tabs.
// Never shipped.
import GLib from "gi://GLib";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

export default class CodexBarDumper extends Extension {
  enable() {
    const target = GLib.getenv("CODEXBAR_DUMP_TARGET");
    this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 12, () => {
      this._dump(target);
      return GLib.SOURCE_REMOVE;
    });
  }

  _walk(actor, depth, lines) {
    const pad = "  ".repeat(depth);
    const text = actor instanceof St.Label ? actor.text : "";
    const acc = actor.accessible_name ? `(a11y:${actor.accessible_name})` : "";
    if (text || acc) {
      const cls = actor.style_class ? `[${actor.style_class}]` : "";
      lines.push(`${pad}${cls}${acc} ${JSON.stringify(text)}`);
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
    let lines = [];
    this._walk(button.menu.actor, 0, lines);
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