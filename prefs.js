import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

export default class CodexBarPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();

    const page = new Adw.PreferencesPage({
      title: _("CodexBar"),
      icon_name: "utilities-system-monitor-symbolic",
    });

    const general = new Adw.PreferencesGroup({
      title: _("Usage"),
    });

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
    general.add(interval);

    const pace = new Adw.SwitchRow({
      title: _("Show pace"),
      subtitle: _("Whether each window is running ahead of or behind its expected pace"),
    });
    settings.bind("show-pace", pace, "active", Gio.SettingsBindFlags.DEFAULT);
    general.add(pace);

    page.add(general);

    const about = new Adw.PreferencesGroup({ title: _("About") });
    const row = new Adw.ActionRow({
      title: _("codexbar CLI"),
      subtitle: _("Providers and usage come from the codexbar command line tool"),
    });
    row.set_subtitle_lines(0);
    about.add(row);
    page.add(about);

    window.add(page);
  }
}