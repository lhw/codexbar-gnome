import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

// Runs the CLI synchronously and returns its JSON, or an empty array on failure.
// The prefs window is a normal process, so a blocking call is fine here.
function fetchUsageSync() {
  const source = GLib.getenv("PATH") || "";
  const candidates = [
    "codexbar",
    GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "codexbar"]),
    "/home/linuxbrew/.linuxbrew/bin/codexbar",
    "/usr/local/bin/codexbar",
    "/usr/bin/codexbar",
  ];

  for (const bin of candidates) {
    const path = bin.includes("/") ? bin : GLib.find_program_in_path(bin);
    if (!path || !GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) continue;

    try {
      const [ok, stdout] = GLib.spawn_sync(
        null,
        [path, "usage", "--format", "json"],
        null,
        GLib.SpawnFlags.SEARCH_PATH,
        null,
      );
      if (!ok) continue;
      const text = new TextDecoder().decode(stdout).trim();
      if (!text) continue;
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // Try the next candidate.
    }
  }
  return [];
}

export default class CodexBarPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: _("CodexBar"),
      icon_name: "utilities-system-monitor-symbolic",
    });

    const usage = new Adw.PreferencesGroup({ title: _("Usage") });

    const interval = new Adw.SpinRow({
      title: _("Refresh interval"),
      subtitle: _("Minutes between polls of the codexbar CLI"),
      adjustment: new Gtk.Adjustment({
        lower: 1,
        upper: 240,
        step_increment: 1,
        page_increment: 15,
      }),
    });
    settings.bind("refresh-interval", interval, "value", Gio.SettingsBindFlags.DEFAULT);
    usage.add(interval);

    const pace = new Adw.SwitchRow({
      title: _("Show pace"),
      subtitle: _("Whether each window is running ahead of or behind its expected pace"),
    });
    settings.bind("show-pace", pace, "active", Gio.SettingsBindFlags.DEFAULT);
    usage.add(pace);

    // The panel bar tracks one provider. Populate from the CLI so the list
    // matches what is actually enabled.
    const models = new Gtk.StringList();
    models.append(_("Automatic (first provider with usage)"));
    const ids = [];
    for (const entry of fetchUsageSync()) {
      if (!entry?.provider || entry.error) continue;
      const id = String(entry.provider);
      ids.push(id);
      models.append(id);
    }

    const primary = new Adw.ComboRow({
      title: _("Panel bar tracks"),
      subtitle: _("Which provider fills the indicator in the top panel"),
      model: models,
      selected: Math.max(0, ids.indexOf(settings.get_string("primary-provider")) + 1),
    });
    primary.connect("notify::selected", () => {
      const index = primary.selected;
      // Index 0 is the automatic option, which stores an empty string.
      settings.set_string("primary-provider", index > 0 ? ids[index - 1] : "");
    });
    usage.add(primary);

    page.add(usage);

    const about = new Adw.PreferencesGroup({ title: _("About") });
    about.add(
      new Adw.ActionRow({
        title: _("codexbar CLI"),
        subtitle: _("Providers and usage come from the codexbar command line tool"),
      }),
    );
    page.add(about);

    window.add(page);
  }
}