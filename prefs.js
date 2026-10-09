import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { browserSessionMessage, validBrowserSessionError } from "./browser-status.js";

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
 * Ask the CLI which providers are enabled, in the background.
 *
 * Uses `config providers`, not `usage`: the latter queries every provider and
 * took about four seconds on this machine, which froze the window before it
 * painted. `config providers` only reads the config file and returns in
 * milliseconds, which is all this list needs.
 *
 * @param {(ids: string[], names: Map<string,string>) => void} onDone
 *   Receives provider ids and their display names, both empty on failure.
 */
function fetchProvidersAsync(onDone) {
  const bin = findCodexBar();
  if (!bin) {
    onDone([], new Map());
    return;
  }

  let proc;
  try {
    proc = Gio.Subprocess.new(
      [bin, "config", "providers", "--format", "json"],
      Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
    );
  } catch (e) {
    onDone([], new Map());
    return;
  }

  // read_bytes_async's count is a per-read size, not a total, so a single call
  // truncates anything longer than it. `config providers` is around 4.5KB for
  // the full provider list, so drain the stream until EOF instead.
  const decoder = new TextDecoder();
  let text = "";
  const readMore = () => {
    proc.get_stdout_pipe().read_bytes_async(
      64 * 1024,
      GLib.PRIORITY_DEFAULT,
      null,
      (stream, result) => {
        try {
          const bytes = stream.read_bytes_finish(result);
          if (bytes.get_size() === 0) {
            finish(text);
            return;
          }
          text += decoder.decode(bytes.get_data());
          readMore();
        } catch (e) {
          onDone([], new Map());
        }
      },
    );
  };

  const finish = (raw) => {
    const ids = [];
    const names = new Map();
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : [];
      for (const entry of Array.isArray(parsed) ? parsed : []) {
        // Disabled providers cannot be tracked, and default-disabled ones are
        // simply not configured.
        if (!entry?.provider || entry.enabled !== true) continue;
        ids.push(String(entry.provider));
        if (entry.displayName) names.set(ids[ids.length - 1], String(entry.displayName));
      }
    } catch (e) {
      onDone([], new Map());
      return;
    }
    onDone(ids, names);
  };

  readMore();
}

function parseBrowserProfiles(raw) {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value?.profiles) || value.profiles.length > 1000) return [];
    const seen = new Set();
    return value.profiles.flatMap((profile) => {
      if (typeof profile?.label !== "string" || profile.label.length > 500 ||
          /[\x00-\x1f\x7f]/.test(profile.label) || !Array.isArray(profile.providers) ||
          profile.providers.length > 20) return [];
      const providers = [...new Set(profile.providers.filter((id) =>
        typeof id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(id)))].sort();
      if (!profile.label || !providers.length || seen.has(profile.label)) return [];
      seen.add(profile.label);
      return [{ label: profile.label, providers }];
    }).sort((a, b) => a.label.localeCompare(b.label));
  } catch (e) {
    return [];
  }
}

function browserServiceState(load, active, unitFile) {
  if (load === "not-found") return _("Not installed");
  if (load === "error") return _("Service status is unavailable");
  if (load !== "loaded") return _("Service status is unavailable");
  if (active === "active") return unitFile === "disabled" ? _("Running · not enabled at login") : _("Running");
  if (active === "failed") return _("Service failed; check the user journal");
  return unitFile === "enabled" ? _("Stopped · starts at login") : _("Stopped");
}

function findUv() {
  return GLib.find_program_in_path("uv") ||
    (GLib.file_test(GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "uv"]), GLib.FileTest.IS_EXECUTABLE)
      ? GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "uv"]) : null);
}

function runAsync(argv, timeoutMs, done) {
  let proc;
  try {
    proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
  } catch (e) {
    done(false, "", "");
    return;
  }
  let finished = false;
  let finishing = false;
  let timedOut = false;
  let overflow = false;
  let readFailed = false;
  let timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
    timeout = 0;
    if (!finished) {
      timedOut = true;
      proc.force_exit();
      finish();
    }
    return GLib.SOURCE_REMOVE;
  });
  const stream = proc.get_stdout_pipe();
  const decoder = new TextDecoder();
  let output = "";
  let size = 0;
  const chunks = [];
  const finish = () => {
    if (finishing) return;
    finishing = true;
    proc.wait_async(null, (p, result) => {
      if (finished) return;
      finished = true;
      if (timeout) GLib.Source.remove(timeout);
      try { p.wait_finish(result); } catch (e) { }
      done(!timedOut && !overflow && !readFailed && p.get_successful(), output);
    });
  };
  const readMore = () => stream.read_bytes_async(16 * 1024, GLib.PRIORITY_DEFAULT, null, (s, result) => {
    if (finishing) return;
    try {
      const bytes = s.read_bytes_finish(result);
      if (!bytes.get_size()) {
        // GJS has no streaming TextDecoder; decode bounded bytes together at EOF.
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        output = decoder.decode(data);
        finish();
        return;
      }
      const data = bytes.get_data();
      if (size + data.length > 128 * 1024) {
        overflow = true;
        proc.force_exit();
        finish();
        return;
      } else {
        size += data.length;
        chunks.push(data);
      }
      readMore();
    } catch (e) {
      readFailed = true;
      proc.force_exit();
      finish();
    }
  });
  readMore();
}

export default class CodexBarPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    let closed = false;
    let sessionStatusTimer = 0;
    window.connect("close-request", () => {
      closed = true;
      if (sessionStatusTimer) GLib.Source.remove(sessionStatusTimer);
      return false;
    });

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

    const browserGroup = new Adw.PreferencesGroup({
      title: _("Optional browser helper"),
      description: _("The optional user service reads matching browser credentials and uses unofficial provider APIs."),
    });
    const sessionStatusRows = new Map(["codex", "deepseek", "opencodego"].map((id) => {
      const names = { codex: "Codex", deepseek: "DeepSeek", opencodego: "OpenCode Go" };
      const row = new Adw.ActionRow({ title: `${names[id]} ${_("browser session")}`, subtitle_lines: 4, visible: false });
      browserGroup.add(row);
      return [id, row];
    }));
    let sessionStatusGeneration = 0;
    const refreshSessionErrors = () => {
      const generation = ++sessionStatusGeneration;
      const profile = settings.get_string("browser-profile");
      for (const row of sessionStatusRows.values()) row.visible = false;
      if (closed || !browser.active || !profile) return;
      for (const [provider, row] of sessionStatusRows) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([
          GLib.get_user_cache_dir(), "codexbar", `browser-usage-${provider}.json`,
        ]));
        file.load_contents_async(null, (source, result) => {
          if (closed || generation !== sessionStatusGeneration || !browser.active ||
              settings.get_string("browser-profile") !== profile) return;
          try {
            const bytes = source.load_contents_finish(result)[1];
            if (bytes.length > 128 * 1024) return;
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (!validBrowserSessionError(data, profile, provider)) return;
            row.subtitle = browserSessionMessage(data, _);
            row.visible = true;
          } catch (e) { }
        });
      }
    };
    sessionStatusTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
      refreshSessionErrors();
      return closed ? GLib.SOURCE_REMOVE : GLib.SOURCE_CONTINUE;
    });
    const browser = new Adw.SwitchRow({
      title: _("Allow browser-session access and show usage"),
      subtitle: _("Off by default. Switching off pauses new refreshes; requests already in flight may finish."),
    });
    settings.bind("show-browser-summary", browser, "active", Gio.SettingsBindFlags.DEFAULT);
    browserGroup.add(browser);

    const profileModel = new Gtk.StringList();
    profileModel.append(_("Select a browser profile"));
    const profileValues = [];
    const browserProfile = new Adw.ComboRow({ title: _("Browser profile"), model: profileModel, selected: 0 });
    let updatingProfile = false;
    let serviceBusy = false;
    let operationHint = "";
    const savedProfile = settings.get_string("browser-profile");
    const uvPath = findUv();
    const profileFind = new Gtk.Button({ label: _("Find profiles") });
    profileFind.sensitive = Boolean(uvPath);
    profileFind.connect("clicked", () => {
      const dialog = new Adw.MessageDialog({
        heading: _("Find stored browser profiles?"),
        body: _("This reads matching stored credentials locally in memory, without contacting providers or printing tokens. It may prepare a locked Python environment and download its dependencies."),
        transient_for: window,
        modal: true,
      });
      dialog.add_response("cancel", _("Cancel"));
      dialog.add_response("find", _("Find profiles"));
      dialog.set_response_appearance("find", Adw.ResponseAppearance.SUGGESTED);
      dialog.connect("response", (_dialog, response) => {
        dialog.close();
        if (response !== "find") return;
        if (closed || serviceBusy || !uvPath) return;
        serviceBusy = true;
        updateServiceButtons();
        browserProfile.subtitle = _("Finding stored profiles…");
        runAsync([uvPath, "run", "--locked", "--python", "3.12", "--directory", helperDir,
          "python", "helper.py", "profiles", "--json"], 120000, (ok, stdout) => {
          if (closed) return;
          serviceBusy = false;
          updateServiceButtons();
          if (!ok) {
            browserProfile.subtitle = _("Could not read profiles. Check the user journal for details.");
            return;
          }
          const profiles = parseBrowserProfiles(stdout);
          const retained = settings.get_string("browser-profile");
          updatingProfile = true;
          profileModel.splice(0, profileModel.get_n_items(), [_ ("Select a browser profile")]);
          profileValues.length = 0;
          for (const profile of profiles) {
            const providers = profile.providers.map((id) => ({ deepseek: "DeepSeek", codex: "Codex", opencodego: "OpenCode Go" })[id] || id).join(", ");
            profileValues.push(profile.label);
            profileModel.append(`${profile.label} · ${providers}`);
          }
          if (retained && !profileValues.includes(retained)) {
            profileValues.push(retained);
            profileModel.append(`${retained} (${_("saved; not found")})`);
          }
          browserProfile.selected = retained ? profileValues.indexOf(retained) + 1 : 0;
          updatingProfile = false;
          browserProfile.sensitive = profileModel.get_n_items() > 1;
          browserProfile.subtitle = profiles.length
            ? _("Choose a profile to enable the service")
            : _("No stored supported sessions found. Sign in to a supported provider, then try again.");
        });
      });
      dialog.present();
    });
    const profileRow = new Adw.ActionRow({ title: _("Browser profile") });
    profileRow.add_suffix(profileFind);
    profileRow.activatable_widget = profileFind;
    browserGroup.add(profileRow);
    browserGroup.add(browserProfile);
    if (savedProfile) {
      profileValues.push(savedProfile);
      profileModel.append(`${savedProfile} (${_("saved; not scanned")})`);
      browserProfile.selected = 1;
    }
    browserProfile.sensitive = profileModel.get_n_items() > 1;
    browserProfile.connect("notify::selected", () => {
      if (updatingProfile) return;
      const index = browserProfile.selected;
      settings.set_string("browser-profile", index > 0 ? profileValues[index - 1] : "");
      refreshSessionErrors();
      updateServiceButtons();
    });

    const browserInterval = new Adw.SpinRow({
      title: _("Browser usage refresh interval"),
      subtitle: _("Minutes between helper polls; configuration changes apply within one minute"),
      adjustment: new Gtk.Adjustment({ lower: 1, upper: 240, step_increment: 1, page_increment: 15 }),
    });
    settings.bind("browser-refresh-interval", browserInterval, "value", Gio.SettingsBindFlags.DEFAULT);
    browserGroup.add(browserInterval);

    for (const [key, title] of [
      ["browser-codex-email", _("Codex account email (optional match check)")],
      ["browser-flaresolverr-url", _("Codex FlareSolverr URL (optional)")],
    ]) {
      const row = new Adw.EntryRow({ title, text: settings.get_string(key) });
      row.connect("changed", () => settings.set_string(key, row.text.trim()));
      browserGroup.add(row);
    }
    browserGroup.add(new Adw.ActionRow({
      title: _("Use only a trusted FlareSolverr server"),
      subtitle: _("A configured server receives ChatGPT session cookies when solving a Cloudflare challenge. Leave the URL empty to disable it."),
    }));
    const helperDir = GLib.build_filenamev([this.path, "browser-session"]);
    const serviceName = "codexbar-browser-session.service";
    const browserStatus = new Adw.ActionRow({ title: _("User service"), subtitle: _("Checking service…") });
    const refreshStatus = new Gtk.Button({ icon_name: "view-refresh-symbolic", tooltip_text: _("Refresh service status") });
    const startService = new Gtk.Button({ label: _("Set up & start") });
    const stopService = new Gtk.Button({ label: _("Stop") });
    browserStatus.add_suffix(refreshStatus);
    browserStatus.add_suffix(startService);
    browserStatus.add_suffix(stopService);
    browserGroup.add(browserStatus);
    const uvLink = new Gtk.LinkButton({ uri: "https://docs.astral.sh/uv/", label: _("Install uv") });
    const uvRow = new Adw.ActionRow({ title: _("uv is required for profile discovery and setup") });
    uvRow.add_suffix(uvLink);
    uvRow.activatable_widget = uvLink;
    uvRow.visible = !uvPath;
    browserGroup.add(uvRow);
    const updateServiceButtons = () => {
      const available = browser.active && Boolean(settings.get_string("browser-profile")) && Boolean(uvPath);
      startService.sensitive = available && !serviceBusy;
      stopService.sensitive = !serviceBusy;
      refreshStatus.sensitive = !serviceBusy;
      profileFind.sensitive = Boolean(uvPath) && !serviceBusy;
    };
    const refreshServiceStatus = () => runAsync(["systemctl", "--user", "show", serviceName,
      "--property=LoadState", "--property=ActiveState", "--property=UnitFileState"], 10000, (ok, stdout) => {
      const props = Object.fromEntries(stdout.trim().split("\n").map((line) => line.split("=")));
      if (closed) return;
      serviceBusy = false;
      const actual = props.LoadState === "not-found" ? _("Not installed")
        : (ok ? browserServiceState(props.LoadState, props.ActiveState, props.UnitFileState)
          : _("Could not check systemd user-service support"));
      browserStatus.subtitle = operationHint ? `${actual} · ${operationHint}` : actual;
      if (ok && props.ActiveState === "active" && !browser.active)
        browserStatus.subtitle += _(" · access paused");
      updateServiceButtons();
    });
    refreshStatus.connect("clicked", () => {
      if (serviceBusy) return;
      serviceBusy = true;
      updateServiceButtons();
      refreshServiceStatus();
      refreshSessionErrors();
    });
    browser.connect("notify::active", updateServiceButtons);
    browser.connect("notify::active", refreshSessionErrors);
    startService.connect("clicked", () => {
      const dialog = new Adw.MessageDialog({
        heading: _("Set up and start the browser helper?"),
        body: _("This downloads locked Python dependencies, enables a user service at login, and reads matching browser credentials to call unofficial provider APIs."),
        transient_for: window,
        modal: true,
      });
      dialog.add_response("cancel", _("Cancel"));
      dialog.add_response("start", _("Set up & start"));
      dialog.set_response_appearance("start", Adw.ResponseAppearance.SUGGESTED);
      dialog.connect("response", (_dialog, response) => {
        dialog.close();
        if (response !== "start") return;
        if (closed || serviceBusy || !browser.active || !settings.get_string("browser-profile") || !uvPath) return;
        serviceBusy = true;
        operationHint = "";
        updateServiceButtons();
        browserStatus.subtitle = _("Setting up and starting…");
        runAsync([uvPath, "run", "--locked", "--python", "3.12", "--directory", helperDir,
          "python", "helper.py", "enable-service"], 300000, (ok) => {
          if (closed) return;
          operationHint = ok ? "" : _("Setup failed; check uv/network and the user journal");
          refreshServiceStatus();
        });
      });
      dialog.present();
    });
    stopService.connect("clicked", () => {
      if (serviceBusy) return;
      serviceBusy = true;
      operationHint = "";
      updateServiceButtons();
      browserStatus.subtitle = _("Stopping service…");
      runAsync(["systemctl", "--user", "disable", "--now", serviceName], 30000, (ok) => {
        if (closed) return;
        operationHint = ok ? "" : _("Stop failed; check the user journal");
        refreshServiceStatus();
      });
    });
    serviceBusy = true;
    updateServiceButtons();
    refreshServiceStatus();
    refreshSessionErrors();
    updateServiceButtons();

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

    fetchProvidersAsync((providerIds, names) => {
      if (closed) return;
      providerIds.forEach((id) => {
        ids.push(id);
        models.append(names.get(id) || id);
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
    page.add(browserGroup);

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
