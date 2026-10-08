import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";

import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";

/**
 * Locate the codexbar binary. PATH first, then the usual install locations,
 * since a GUI session's PATH often misses Homebrew.
 * @returns {string|null}
 */
function findCodexBar() {
  const fromPath = GLib.find_program_in_path("codexbar");
  if (fromPath) return fromPath;

  const candidates = [
    GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "codexbar"]),
    "/home/linuxbrew/.linuxbrew/bin/codexbar",
    "/usr/local/bin/codexbar",
    "/usr/bin/codexbar",
  ];
  return candidates.find((p) => GLib.file_test(p, GLib.FileTest.EXISTS)) || null;
}

/**
 * Run `codexbar usage --format json` in the background.
 *
 * The CLI takes several seconds because it queries each provider, so it must
 * never run on the main loop: doing so freezes the window before it paints.
 *
 * @param {(ids: string[]) => void} onDone Receives provider ids, empty on failure.
 */
function fetchProvidersAsync(onDone) {
  const bin = findCodexBar();
  if (!bin) {
    onDone([]);
    return;
  }

  let proc;
  try {
    proc = Gio.Subprocess.new(
      [bin, "usage", "--format", "json"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
  } catch (e) {
    onDone([]);
    return;
  }

  proc.get_stdout_pipe().read_bytes_async(
    4 * 1024 * 1024,
    GLib.PRIORITY_DEFAULT,
    null,
    (stream, result) => {
      let ids = [];
      try {
        const [ok, bytes] = stream.read_bytes_finish(result);
        const parsed = ok && bytes.length ? JSON.parse(new TextDecoder().decode(bytes)) : [];
        // Keep the order the CLI reported, and skip providers that errored: the
        // panel bar cannot track those.
        ids = (Array.isArray(parsed) ? parsed : [])
          .filter((entry) => entry?.provider && !entry.error)
          .map((entry) => String(entry.provider));
      } catch (e) {
        ids = [];
      }
      onDone(ids);
    },
  );
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

    // The panel bar tracks one provider. The list comes from the CLI, which is
    // slow, so the row starts disabled and fills in when the call returns.
    const ids = [];
    const models = new Gtk.StringList();
    models.append(_("Automatic (first provider with usage)"));

    const primary = new Adw.ComboRow({
      title: _("Panel bar tracks"),
      subtitle: _("Reading providers..."),
      model: models,
      sensitive: false,
      selected: 0,
    });

    primary.connect("notify::selected", () => {
      const index = primary.selected;
      // Index 0 is the automatic option, which stores an empty string.
      settings.set_string("primary-provider", index > 0 ? ids[index - 1] : "");
    });
    usage.add(primary);

    fetchProvidersAsync((providerIds) => {
      providerIds.forEach((id) => {
        ids.push(id);
        models.append(id);
      });

      if (providerIds.length === 0) {
        primary.subtitle = _("Could not read providers from codexbar");
        return;
      }

      const current = settings.get_string("primary-provider");
      const found = ids.indexOf(current);
      // Keep an unknown stored value visible rather than silently reverting it.
      if (found === -1 && current !== "") {
        ids.push(current);
        models.append(`${current} (${_("not enabled")})`);
        primary.selected = ids.length;
      } else {
        primary.selected = found + 1;
      }

      primary.subtitle = _("Which provider fills the indicator in the top panel");
      primary.sensitive = true;
    });

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