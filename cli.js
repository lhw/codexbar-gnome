// Thin async wrapper around the codexbar CLI. Runs one subprocess per call,
// with a timeout, and returns parsed JSON or an error string. Never throws into
// the shell.

import Gio from "gi://Gio";
import GLib from "gi://GLib";

const USAGE_TIMEOUT_S = 30;
const COST_TIMEOUT_S = 45;

export class CodexBarError extends Error {
  constructor(message, {stderr = "", exitStatus = null} = {}) {
    super(message);
    this.name = "CodexBarError";
    this.stderr = stderr;
    this.exitStatus = exitStatus;
  }
}

/**
 * Find the codexbar binary. PATH first so a user's own install wins, then the
 * usual fallbacks including Homebrew on Linux, which is not on the shell's
 * default PATH for GUI sessions.
 * @returns {string|null} Absolute path, or null if not found.
 */
export function findCodexBar() {
  const found = GLib.find_program_in_path("codexbar");
  if (found) return found;

  const candidates = [
    GLib.build_filenamev([GLib.get_home_dir(), ".local", "bin", "codexbar"]),
    "/home/linuxbrew/.linuxbrew/bin/codexbar",
    "/usr/local/bin/codexbar",
    "/usr/bin/codexbar",
  ];
  return candidates.find((p) => GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) || null;
}

/**
 * Run the CLI and return parsed JSON.
 * @param {string[]} args Arguments after the binary name.
 * @param {Gio.Cancellable} cancellable
 * @param {number} timeoutS
 * @returns {Promise<unknown>} Parsed JSON payload.
 * @throws {CodexBarError} On missing binary, timeout, or non-JSON output.
 */
export async function runCodexBar(args, cancellable, timeoutS = USAGE_TIMEOUT_S) {
  const bin = findCodexBar();
  if (!bin) throw new CodexBarError("codexbar not found on PATH");

  const proc = Gio.Subprocess.new(
    [bin, ...args],
    // A GUI session's PATH often misses Homebrew and ~/.local/bin, which
    // codexbar's own child processes need.
    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
  );

  // Read both pipes concurrently: waiting on stdout first can deadlock once the
  // stderr buffer fills, and waiting on stderr first can deadlock the same way
  // if stdout fills instead.
  const readPipe = (pipe, limit) =>
    new Promise((resolve, reject) => {
      pipe.read_bytes_async(limit, GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
        try {
          resolve(src.read_bytes_finish(res));
        } catch (e) {
          reject(e);
        }
      });
    });

  let stdoutBytes;
  let stderrText = "";
  try {
    [stdoutBytes, stderrText] = await Promise.all([
      readPipe(proc.get_stdout_pipe(), 1024 * 1024),
      readPipe(proc.get_stderr_pipe(), 64 * 1024).catch(() => new Uint8Array()),
    ]);
  } catch (e) {
    proc.force_exit();
    throw new CodexBarError(e.message);
  }
  const stderr = new TextDecoder().decode(stderrText);

  const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutS, () => {
    proc.force_exit();
    return GLib.SOURCE_REMOVE;
  });

  // wait_check_async reaps the child and yields the exit status. wait_async does
  // not, and querying the status afterwards trips a g_subprocess assertion.
  let exitStatus = null;
  try {
    exitStatus = await new Promise((resolve, reject) => {
      proc.wait_check_async(cancellable, (src, res) => {
        try {
          resolve(src.wait_check_finish(res));
        } catch (e) {
          // A non-zero exit is not fatal: the CLI reports per-provider problems
          // inside its JSON payload, and the message is worth keeping.
          resolve(e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED) ? null : 1);
        }
      });
    });
  } finally {
    GLib.Source.remove(timeout);
  }

  const text = new TextDecoder().decode(stdoutBytes).trim();

  if (!text) {
    const detail = stderr.trim().split("\n").slice(-1)[0] || `exit ${exitStatus}`;
    throw new CodexBarError(detail, { stderr, exitStatus });
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    throw new CodexBarError(`Unreadable output: ${e.message}`, { stderr, exitStatus });
  }
}

/**
 * Fetch usage for every enabled provider in one call.
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<unknown>} Raw `codexbar usage --format json` payload.
 */
export function fetchUsage(cancellable) {
  return runCodexBar(["usage", "--format", "json"], cancellable, USAGE_TIMEOUT_S);
}

/**
 * Fetch local cost data. Unsupported providers come back as per-provider error
 * objects rather than failing the call.
 * @param {Gio.Cancellable} cancellable
 * @returns {Promise<unknown>} Raw `codexbar cost --format json` payload.
 */
export function fetchCost(cancellable) {
  return runCodexBar(["cost", "--provider", "all", "--format", "json"], cancellable, COST_TIMEOUT_S);
}