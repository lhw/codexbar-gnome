#!/usr/bin/env python3
"""Opt-in read-only browser session helper; credentials are never persisted or logged."""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import datetime as dt
import hashlib
from html.parser import HTMLParser
import json
import os
import re
import shutil
import sqlite3
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

import cramjam
import plyvel

HOME = Path.home()
CACHE_DIR = Path(os.environ.get("XDG_CACHE_HOME", HOME / ".cache")) / "codexbar"


def cache_path(provider):
    return CACHE_DIR / f"browser-usage-{provider}.json"


class SessionError(Exception):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise SessionError("redirect rejected")


HTTP = urllib.request.build_opener(NoRedirect, urllib.request.HTTPSHandler(context=ssl.create_default_context()))
FLARE_MAX_TIMEOUT = 60000
MAX_RESPONSE = 4 * 1024 * 1024


def validate_flaresolverr_url(value):
    if not value:
        return None
    try:
        parsed = urllib.parse.urlsplit(value)
        valid = (parsed.scheme in {"http", "https"} and parsed.hostname and parsed.port != 0 and
                 not parsed.username and not parsed.password and not parsed.query and not parsed.fragment and
                 parsed.path in {"", "/", "/v1"} and not any(char.isspace() for char in value))
    except ValueError:
        valid = False
        parsed = None
    if not valid:
        raise argparse.ArgumentTypeError("expected an HTTP(S) FlareSolverr base URL or /v1 endpoint")
    return value.rstrip("/") + ("" if parsed.path == "/v1" else "/v1")


class _PreText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.depth = 0
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag.lower() == "pre":
            self.depth += 1

    def handle_endtag(self, tag):
        if tag.lower() == "pre" and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if self.depth:
            self.parts.append(data)


def firefox_profiles():
    roots = (("firefox", HOME / ".mozilla/firefox"), ("waterfox", HOME / ".waterfox"),
             ("firefox-flatpak", HOME / ".var/app/org.mozilla.firefox/.mozilla/firefox"),
             ("waterfox-flatpak", HOME / ".var/app/net.waterfox.waterfox/.waterfox"))
    return [(f"{browser}:{p.name}", p) for browser, root in roots if root.is_dir()
            for p in root.iterdir() if p.is_dir()]


def chromium_profiles():
    roots = (HOME / ".config/google-chrome", HOME / ".config/chromium",
             HOME / ".var/app/com.google.Chrome/config/google-chrome", HOME / ".var/app/org.chromium.Chromium/config/chromium")
    return [("chromium:" + root.name + "/" + p.name, p) for root in roots if root.is_dir()
            for p in root.iterdir() if (p / "Local Storage/leveldb").is_dir()]


@contextmanager
def _readonly_sqlite(path):
    # URI-quote the path so ?, #, and spaces cannot change SQLite URI options.
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=1)
    try:
        conn.execute("SELECT name FROM sqlite_master LIMIT 1").fetchone()
    except sqlite3.OperationalError as exc:
        conn.close()
        if "locked" not in str(exc):
            raise
    else:
        try:
            yield conn
        finally:
            conn.close()
        return
    # Firefox-family browsers can hold an exclusive lock. Preserve the WAL in
    # a private snapshot rather than opening or modifying their live databases.
    with tempfile.TemporaryDirectory(prefix="codexbar-sqlite-") as temp:
        target = Path(temp) / path.name
        for _ in range(3):
            files = [p for p in (path, Path(str(path) + "-wal"), Path(str(path) + "-journal")) if p.is_file()]
            before = [(p, p.stat().st_size, p.stat().st_mtime_ns) for p in files]
            for child in Path(temp).iterdir():
                child.unlink()
            for original in files:
                copy = Path(temp) / original.name
                shutil.copyfile(original, copy)
                os.chmod(copy, 0o600)
            try:
                stable = all((p.stat().st_size, p.stat().st_mtime_ns) == (size, stamp)
                             for p, size, stamp in before)
                stable = stable and files == [p for p in (path, Path(str(path) + "-wal"), Path(str(path) + "-journal")) if p.is_file()]
            except FileNotFoundError:
                stable = False
            if stable:
                break
        else:
            raise sqlite3.OperationalError("browser database changed during snapshot")
        snapshot = sqlite3.connect(target)
        try:
            snapshot.execute("PRAGMA query_only=ON")
            yield snapshot
        finally:
            snapshot.close()


def decode_firefox_value(value, utf16_length, compression_type, conversion_type):
    raw = bytes(value)
    if compression_type == 1:
        raw = bytes(cramjam.snappy.decompress_raw(raw))
    elif compression_type != 0:
        raise ValueError("unsupported Firefox local-storage compression")
    encoding = "utf-8" if conversion_type == 1 else "utf-16-le"
    result = raw.decode(encoding, "strict")
    if utf16_length and len(result.encode("utf-16-le")) // 2 != utf16_length:
        raise ValueError("Firefox local-storage length mismatch")
    return result


def firefox_local_token(profile):
    db = profile / "storage/default/https+++platform.deepseek.com/ls/data.sqlite"
    if not db.is_file():
        return None
    try:
        with _readonly_sqlite(db) as conn:
            columns = {r[1] for r in conn.execute("PRAGMA table_info(data)")}
            required = {"key", "value", "utf16_length", "compression_type", "conversion_type"}
            if not required <= columns:
                return None
            row = conn.execute("SELECT value, utf16_length, compression_type, conversion_type FROM data WHERE key=?",
                               ("userToken",)).fetchone()
            if not row:
                return None
            return parse_token(decode_firefox_value(*row))
    except (OSError, sqlite3.Error, UnicodeError, ValueError, cramjam.DecompressionError):
        return None


def decode_chromium_string(raw):
    if not raw:
        return ""
    prefix, payload = raw[0], raw[1:]
    if prefix == 0:
        return payload.decode("utf-16-le", "strict")
    if prefix == 1:
        return payload.decode("latin-1")
    raise ValueError("unknown Chromium string encoding")


def snapshot_leveldb(source, destination):
    # Tables/manifests are immutable; retry if CURRENT or an active log changes while copying.
    for _attempt in range(2):
        files = []
        total = 0
        for item in source.iterdir():
            if item.is_symlink() or item.name in {"LOCK", "LOG", "LOG.old"} or not item.is_file():
                continue
            if item.name == "CURRENT" or item.name.startswith("MANIFEST-") or item.suffix in {".log", ".ldb", ".sst"}:
                stat = item.stat()
                total += stat.st_size
                files.append((item, stat.st_size, stat.st_mtime_ns))
        if total > 512 * 1024 * 1024:
            raise SessionError("Chromium Local Storage snapshot exceeds 512 MiB safety limit")
        current_path = source / "CURRENT"
        current = current_path.read_bytes() if current_path.is_file() else None
        for child in Path(destination).iterdir():
            child.unlink()
        for item, _, _ in files:
            target = Path(destination) / item.name
            shutil.copyfile(item, target)
            os.chmod(target, 0o600)
        current_after = current_path.read_bytes() if current_path.is_file() else None
        stable = current == current_after and all(
            (item.stat().st_size, item.stat().st_mtime_ns) == (size, mtime)
            for item, size, mtime in files)
        if stable:
            return
    raise SessionError("Chromium Local Storage changed during snapshot; retry on next refresh")


def chromium_local_token(profile):
    path = profile / "Local Storage/leveldb"
    if not path.is_dir():
        return None
    # Snapshot only the Local Storage DB; never open Chromium's cookie DB or copy its full profile.
    db = None
    snapshot_dir = None
    try:
        snapshot_dir = tempfile.mkdtemp(prefix="codexbar-leveldb-")
        os.chmod(snapshot_dir, 0o700)
        snapshot_leveldb(path, snapshot_dir)
        db = plyvel.DB(snapshot_dir, create_if_missing=False)
        snapshot = db.snapshot()
        try:
            prefix = b"_https://platform.deepseek.com"
            for key, value in snapshot.iterator(start=prefix):
                # Chromium DOMStorage keys: '_' + origin + NUL + encoded script key.
                if not key.startswith(prefix):
                    break
                origin, sep, rawkey = key[1:].partition(b"\x00")
                target = b"https://platform.deepseek.com"
                if not sep or (origin != target and not origin.startswith(target + b"^")):
                    continue
                if decode_chromium_string(rawkey) != "userToken":
                    continue
                token = parse_token(decode_chromium_string(value))
                if token:
                    return token
        finally:
            snapshot.close()
    except (OSError, plyvel.Error, ValueError, UnicodeError):
        return None
    finally:
        if db:
            db.close()
        if snapshot_dir:
            shutil.rmtree(snapshot_dir, ignore_errors=True)
    return None


def parse_token(value):
    try:
        parsed = json.loads(value)
        if isinstance(parsed, str):
            value = parsed
        elif isinstance(parsed, dict):
            value = next((parsed[key] for key in ("value", "token", "access_token", "accessToken", "userToken")
                          if isinstance(parsed.get(key), str)), "")
    except (ValueError, TypeError):
        pass
    return value.strip() if isinstance(value, str) and len(value.strip()) >= 20 and not any(c.isspace() for c in value.strip()) else None


@dataclass(frozen=True)
class Provider:
    id: str
    auth_method: str
    domains: tuple = ()
    cookie_names: tuple = ()
    request_paths: tuple = ()
    token_bases: tuple = ()
    discovery_browsers: tuple = ("firefox",)
    discover_profiles: object = None
    read_session: object = None
    fetch: object = None
    normalize_cookies: object = None


PROVIDERS = {}


def register_provider(provider):
    if (not isinstance(provider, Provider) or not isinstance(provider.id, str) or
            not re.fullmatch(r"[a-z][a-z0-9_-]*", provider.id) or provider.id in PROVIDERS or
            not isinstance(provider.auth_method, str) or not provider.auth_method or
            not callable(provider.discover_profiles) or not callable(provider.read_session) or
            not callable(provider.fetch) or
            (provider.normalize_cookies is not None and not callable(provider.normalize_cookies)) or
            not isinstance(provider.discovery_browsers, tuple) or
            any(not isinstance(browser, str) or browser not in {"firefox", "chromium"}
                for browser in provider.discovery_browsers) or
            any(not isinstance(values, tuple) for values in
                (provider.domains, provider.cookie_names, provider.request_paths, provider.token_bases))):
        raise ValueError("invalid or duplicate provider")
    if provider.auth_method == "cookies" and any(
            not values or any(not isinstance(value, str) or not value for value in values)
            for values in (provider.domains, provider.cookie_names, provider.request_paths)):
        raise ValueError("cookie providers require explicit scope metadata")
    PROVIDERS[provider.id] = provider
    return provider


def _discover_browser_profiles(provider):
    profiles = []
    if "firefox" in provider.discovery_browsers:
        profiles.extend(firefox_profiles())
    if "chromium" in provider.discovery_browsers:
        profiles.extend(chromium_profiles())
    return profiles


def _read_deepseek_session(profile):
    if (profile / "storage/default/https+++platform.deepseek.com/ls/data.sqlite").is_file():
        return firefox_local_token(profile)
    return chromium_local_token(profile)


def browser_profiles(provider):
    adapter = PROVIDERS.get(provider)
    return adapter.discover_profiles() if adapter else []


def session_profiles(provider):
    adapter = PROVIDERS.get(provider)
    if adapter is None:
        return []
    found = []
    for label, profile in adapter.discover_profiles():
        try:
            if adapter.read_session(profile):
                found.append((label, profile))
        except Exception:
            # One corrupt or ambiguous profile must not hide other local sessions.
            continue
    return found


def find_sessions(provider, selected=None):
    found = matching_sessions(provider, selected)
    if selected and not found:
        raise SessionError("selected browser profile has no matching provider session")
    if len(found) != 1:
        if found:
            raise SessionError("multiple matching profiles; choose one in Preferences (available: " +
                               ", ".join(item[0] for item in found) + ")")
        raise SessionError("no supported browser session found")
    return found[0]


def matching_sessions(provider, selected=None):
    adapter = PROVIDERS.get(provider)
    if adapter is None:
        return []
    found = []
    for label, profile in adapter.discover_profiles():
        if selected and selected != label:
            continue
        session = adapter.read_session(profile)
        if session:
            found.append((label, profile, session))
    return found


def firefox_cookies(profile, provider, now=None):
    db = profile / "cookies.sqlite"
    if not db.is_file():
        return None
    adapter = PROVIDERS.get(provider)
    if not adapter or adapter.auth_method != "cookies":
        return None
    domains = set(adapter.domains)
    now = int(now if now is not None else time.time())
    try:
        with _readonly_sqlite(db) as conn:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(moz_cookies)")}
            if not {"host", "name", "value", "path", "expiry", "originAttributes", "isSecure"} <= columns:
                return None
            hosts, params = [], []
            for domain in domains:
                hosts.append("(host=? OR host=?)")
                params.extend((domain, "." + domain))
            names = "name IN (" + ",".join("?" for _ in adapter.cookie_names) + ")"
            params.extend(adapter.cookie_names)
            if adapter.token_bases:
                names += " OR " + " OR ".join("name GLOB ?" for _ in adapter.token_bases)
                params.extend(base + ".[0-9]*" for base in adapter.token_bases)
            names = "(" + names + ")"
            rows = conn.execute("SELECT host, name, value, path, expiry, originAttributes, isSecure FROM moz_cookies WHERE " +
                                "(" + " OR ".join(hosts) + ") AND " + names, params).fetchall()
        groups = {}
        for host, name, value, path, expiry, origin_attributes, secure in rows:
            if (not isinstance(host, str) or not isinstance(name, str) or
                    host.lower() not in domains and host.lower() not in {"." + d for d in domains}):
                continue
            if isinstance(expiry, bool) or not isinstance(expiry, int) or (expiry and expiry <= now):
                continue
            if not isinstance(value, str) or not value or any(ord(char) < 33 or ord(char) == 127 for char in value) or ";" in value:
                continue
            request_paths = adapter.request_paths
            if not isinstance(path, str) or not all(path == request_path or path == "/" or request_path.startswith(path.rstrip("/") + "/")
                                                     for request_path in request_paths):
                continue
            if name.startswith("__Host-") and (host.lower().startswith(".") or path != "/" or secure != 1):
                continue
            if name.startswith("__Secure-") and secure != 1:
                continue
            wanted = name in adapter.cookie_names or any(name == base or name.startswith(base + ".")
                                                         for base in adapter.token_bases)
            if wanted:
                groups.setdefault(origin_attributes or "", {}).setdefault(name, []).append((path, value))
        viable = []
        for entries in groups.values():
            selected = {}
            for name, values in entries.items():
                if len({value for _, value in values}) != 1:
                    raise SessionError("ambiguous same-name browser cookies; choose a separate profile")
                selected[name] = values[0][1]
            if adapter.normalize_cookies:
                selected = adapter.normalize_cookies(selected)
            if selected:
                viable.append(selected)
        if len(viable) > 1:
            raise SessionError("multiple Firefox cookie containers have provider sessions; use a separate profile")
        if not viable:
            return None
        return viable[0]
    except (OSError, sqlite3.Error):
        return None


def codex_cookie_header(cookies):
    bases = ("__Secure-next-auth.session-token", "next-auth.session-token",
             "__Secure-authjs.session-token", "authjs.session-token")
    supplemental = {key: cookies[key] for key in ("_account", "oai-did", "cf_clearance") if key in cookies}
    for base in bases:
        if base in cookies:
            return {base: cookies[base], **supplemental}
        chunks = {}
        for name, value in cookies.items():
            match = re.fullmatch(re.escape(base) + r"\.(\d+)", name)
            if match:
                chunks[int(match.group(1))] = value
        if chunks:
            if sorted(chunks) == list(range(len(chunks))):
                return {**{f"{base}.{index}": value for index, value in chunks.items()}, **supplemental}
    return {}


def request_json(url, token_or_cookies, *, platform=False, headers=None, query=None):
    if query:
        url += "?" + urllib.parse.urlencode(query)
    h = {"Accept": "application/json", "User-Agent": "CodexBar browser-session helper"}
    if isinstance(token_or_cookies, str):
        h["Authorization"] = "Bearer " + token_or_cookies
    else:
        h["Cookie"] = cookie_header(token_or_cookies)
    if platform:
        h["x-client-platform"] = "web"
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, headers=h)
    try:
        with HTTP.open(req, timeout=15) as response:
            if response.status != 200:
                raise SessionError(f"HTTP {response.status}")
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise SessionError("provider response exceeds 4 MiB safety limit")
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        if exc.code == 403 and exc.headers and exc.headers.get("cf-mitigated", "").lower() == "challenge":
            raise SessionError("Cloudflare challenge", status=403) from None
        if exc.code in (401, 403):
            raise SessionError("browser session expired or rejected", status=exc.code) from None
        raise SessionError(f"HTTP {exc.code}", status=exc.code) from None
    except urllib.error.URLError as exc:
        raise SessionError("network request failed") from None


def flaresolverr_json(base_url, url, cookies):
    target = urllib.parse.urlsplit(url)
    cookie_list = [{"name": name, "value": value, "domain": target.hostname, "path": "/",
                    "secure": target.scheme == "https"} for name, value in cookies.items()]
    payload = json.dumps({"cmd": "request.get", "url": url, "maxTimeout": FLARE_MAX_TIMEOUT,
                          "cookies": cookie_list}).encode()
    req = urllib.request.Request(base_url, data=payload, headers={"Content-Type": "application/json"})
    try:
        with HTTP.open(req, timeout=FLARE_MAX_TIMEOUT / 1000 + 5) as response:
            raw = response.read(MAX_RESPONSE + 1)
    except (urllib.error.URLError, OSError):
        raise SessionError("FlareSolverr request failed") from None
    if len(raw) > MAX_RESPONSE:
        raise SessionError("FlareSolverr response exceeds 4 MiB safety limit")
    try:
        envelope = json.loads(raw)
        solution = envelope["solution"]
        final = urllib.parse.urlsplit(solution["url"])
        if envelope.get("status") != "ok":
            raise ValueError
        if solution.get("status") != 200 or (final.scheme, final.netloc, final.path) != (target.scheme, target.netloc, target.path):
            raise ValueError
        rendered = solution["response"]
        parser = _PreText()
        parser.feed(rendered)
        body = "".join(parser.parts).strip() if parser.parts else rendered.strip()
        result = json.loads(body)
        user_agent = solution.get("userAgent")
        if not isinstance(user_agent, str) or not user_agent or len(user_agent) > 1024 or any(ord(char) < 32 or ord(char) == 127 for char in user_agent):
            raise ValueError
        returned = solution.get("cookies", [])
        allowed = set(cookies) | {"cf_clearance"}
        merged = dict(cookies)
        for cookie in returned if isinstance(returned, list) else []:
            if (isinstance(cookie, dict) and cookie.get("name") in allowed and
                    cookie.get("domain", "").lstrip(".") == target.hostname and
                    cookie.get("path", "/") == "/" and isinstance(cookie.get("value"), str) and
                    not any(ord(char) < 33 or ord(char) == 127 or char == ";" for char in cookie["value"])):
                merged[cookie["name"]] = cookie["value"]
        return result, merged, user_agent
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        raise SessionError("FlareSolverr did not return a verified Codex session response") from None


def cookie_header(cookies):
    return "; ".join(f"{key}={value}" for key, value in cookies.items())


def opencode_server_text(cookies, server_id, *, args=None, referer="https://opencode.ai", method="GET"):
    query = {"id": server_id}
    if args is not None and method == "GET":
        query["args"] = json.dumps(args, separators=(",", ":"))
    url = "https://opencode.ai/_server" + ("?" + urllib.parse.urlencode(query) if method == "GET" else "")
    headers = {"Cookie": "; ".join(f"{k}={v}" for k, v in cookies.items()),
               "Accept": "text/javascript, application/json;q=0.9, */*;q=0.8",
               "X-Server-Id": server_id, "X-Server-Instance": "server-fn:" + str(uuid.uuid4()),
               "Origin": "https://opencode.ai", "Referer": referer}
    body = json.dumps(args, separators=(",", ":")).encode() if method != "GET" and args is not None else None
    if body is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with HTTP.open(req, timeout=15) as response:
            if response.status != 200:
                raise SessionError(f"HTTP {response.status}")
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise SessionError("OpenCode response exceeds 4 MiB safety limit")
            return raw.decode("utf-8", "strict")
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise SessionError("browser session expired or rejected") from None
        raise SessionError(f"HTTP {exc.code}") from None
    except (urllib.error.URLError, UnicodeError):
        raise SessionError("OpenCode legacy request failed") from None


def opencode_workspace_ids(text):
    ids = list(dict.fromkeys(re.findall(r'id\s*:\s*["\'](wrk_[A-Za-z0-9_-]+)["\']', text)))
    try:
        root = json.loads(text)
    except ValueError:
        return ids
    def visit(value):
        if isinstance(value, dict):
            for item in value.values():
                visit(item)
        elif isinstance(value, list):
            for item in value:
                visit(item)
        elif isinstance(value, str) and re.fullmatch(r"wrk_[A-Za-z0-9_-]+", value) and value not in ids:
            ids.append(value)
    visit(root)
    return ids


def parse_opencode_legacy(text):
    try:
        root = json.loads(text)
    except ValueError:
        root = None
    stack = [root] if root is not None else []
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            if isinstance(current.get("rollingUsage"), dict):
                break
            stack.extend(current.values())
        elif isinstance(current, list):
            stack.extend(current)
    else:
        current = {}
    now = dt.datetime.now(dt.timezone.utc)
    windows = []
    for key, label in (("rollingUsage", "5 hours"), ("weeklyUsage", "Weekly")):
        meter = current.get(key) if isinstance(current, dict) else None
        if isinstance(meter, dict):
            percent, reset = scalar(meter.get("usagePercent")), scalar(meter.get("resetInSec"))
        else:
            match = re.search(rf"{key}[^}}]*?usagePercent\s*:\s*([0-9]+(?:\.[0-9]+)?)", text)
            reset_match = re.search(rf"{key}[^}}]*?resetInSec\s*:\s*([0-9]+)", text)
            percent = scalar(match.group(1)) if match else None
            reset = scalar(reset_match.group(1)) if reset_match else None
        if percent is None or percent > 100:
            raise SessionError("OpenCode legacy response has incomplete usage meters")
        window = {"label": label, "usedPercent": percent}
        if reset is not None:
            window["resetsAt"] = (now + dt.timedelta(seconds=reset)).isoformat()
        windows.append(window)
    if len(windows) != 2:
        raise SessionError("OpenCode legacy response has incomplete usage meters")
    return {"provider": "opencodego", "updatedAt": now.isoformat(), "windows": windows}


def opencode_legacy(cookies):
    workspace_server_id = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f"
    usage_server_id = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4"
    ids = opencode_workspace_ids(opencode_server_text(cookies, workspace_server_id))
    if len(ids) != 1:
        raise SessionError("OpenCode legacy session must resolve to exactly one workspace")
    workspace_id = ids[0]
    referer = f"https://opencode.ai/workspace/{workspace_id}/go"
    text = opencode_server_text(cookies, usage_server_id, args=[workspace_id], referer=referer)
    if text.strip().lower() == "null" or re.search(r"\]\s*=\s*\[\s*\]\s*,\s*null\s*\)\s*$", text):
        raise SessionError("OpenCode workspace has no subscription usage")
    try:
        parse_opencode_legacy(text)
    except SessionError:
        text = opencode_server_text(cookies, usage_server_id, args=[workspace_id], referer=referer, method="POST")
    result = parse_opencode_legacy(text)
    result["legacy"] = True
    return result


def deepseek_call(token, endpoint, query):
    body = request_json("https://platform.deepseek.com/api/v0/" + endpoint, token, platform=True, query=query)
    if not isinstance(body, dict):
        raise SessionError("invalid DeepSeek response")
    data = body.get("data") if isinstance(body.get("data"), dict) else {}
    codes = (body.get("code"), data.get("biz_code"))
    if any(code not in (0, None) for code in codes):
        if any(code in (40002, 40003) for code in codes):
            raise SessionError("browser session expired or rejected")
        raise SessionError("DeepSeek rejected usage request")
    business = data.get("biz_data")
    if business is None or (endpoint.endswith("/amount") and not isinstance(business, dict)) or (
            endpoint.endswith("/cost") and not isinstance(business, (dict, list))):
        raise SessionError("DeepSeek usage response missing business data")
    return body


def scalar(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, dict) and "value" in value:
        value = value["value"]
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
        return number if number >= 0 and number < 1e18 else None
    except (TypeError, ValueError):
        return None


def iso_timestamp(value):
    try:
        if isinstance(value, (int, float)):
            return dt.datetime.fromtimestamp(value, dt.timezone.utc).isoformat()
        if isinstance(value, str):
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return None
            return parsed.astimezone(dt.timezone.utc).isoformat()
    except (OverflowError, OSError, ValueError):
        pass
    return None


def safe_label(value):
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= 100 and value.isprintable() else None


def parse_deepseek(amount, cost, *, now=None, offset=None):
    now = int(now if now is not None else time.time())
    offset = int(offset if offset is not None else time.localtime(now).tm_gmtoff)
    def biz(payload):
        if not isinstance(payload, dict):
            return None
        data = payload.get("data")
        if not isinstance(data, dict):
            return None
        return data.get("biz_data") if data.get("biz_code", 0) == 0 else None
    abiz, cbiz = biz(amount), biz(cost)
    if not isinstance(abiz, dict) or not isinstance(cbiz, dict):
        raise SessionError("DeepSeek usage response has no biz_data")
    totals = abiz.get("series", [])
    cost_blocks = (cbiz.get("data") or [])
    if not isinstance(totals, list) or not isinstance(cost_blocks, list):
        raise SessionError("DeepSeek usage response has invalid series")
    totals = [item for item in totals if isinstance(item, dict)]
    cost_blocks = [block for block in cost_blocks if isinstance(block, dict)]
    def block_spend(block):
        series_list = block.get("series")
        if not isinstance(series_list, list):
            return 0
        return sum(scalar(bucket.get("cost")) or 0 for series in series_list if isinstance(series, dict)
                   for bucket in (series.get("buckets") if isinstance(series.get("buckets"), list) else [])
                   if isinstance(bucket, dict))
    chosen = (next((b for b in cost_blocks if b.get("currency") == "USD" and block_spend(b) > 0), None)
              or next((b for b in cost_blocks if block_spend(b) > 0), None)
              or next((b for b in cost_blocks if b.get("currency") == "USD"), None)
              or (cost_blocks[0] if cost_blocks else {}))
    models, daily_tokens, daily_cost, requests = {}, {}, {}, {}
    api_keys = set()
    current_day = dt.datetime.fromtimestamp(now, dt.timezone(dt.timedelta(seconds=offset))).replace(
        hour=0, minute=0, second=0, microsecond=0)
    start = int((current_day - dt.timedelta(days=29)).timestamp())
    end = int((current_day + dt.timedelta(days=1)).timestamp())
    for item in totals:
        model = safe_label(item.get("model"))
        if not model:
            continue
        key = item.get("api_key") or {}
        if isinstance(key, dict):
            api_keys.add(str(key.get("tracking_id") or key.get("name") or "unknown"))
        elif isinstance(key, str):
            api_keys.add(key)
        buckets = item.get("buckets")
        if not isinstance(buckets, list):
            continue
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            stamp = bucket.get("time")
            if isinstance(stamp, bool) or not isinstance(stamp, (int, float)) or not start <= stamp < end:
                continue
            date = dt.datetime.fromtimestamp(stamp, dt.timezone(dt.timedelta(seconds=offset))).date().isoformat()
            usage = bucket.get("usage")
            if not isinstance(usage, dict):
                continue
            count = sum(scalar(v) or 0 for k, v in usage.items() if k != "REQUEST")
            req = sum(scalar(v) or 0 for k, v in usage.items() if k == "REQUEST")
            models[model] = models.get(model, 0) + count
            daily_tokens[date] = daily_tokens.get(date, 0) + int(count)
            requests[date] = requests.get(date, 0) + int(req)
    model_cost = {}
    for series in (chosen.get("series", []) if isinstance(chosen, dict) and isinstance(chosen.get("series", []), list) else []):
        if not isinstance(series, dict):
            continue
        key = series.get("api_key") or {}
        if isinstance(key, dict):
            api_keys.add(str(key.get("tracking_id") or key.get("name") or "unknown"))
        elif isinstance(key, str):
            api_keys.add(key)
        model = safe_label(series.get("model"))
        if not model:
            continue
        buckets = series.get("buckets")
        if not isinstance(buckets, list):
            continue
        for bucket in buckets:
            if not isinstance(bucket, dict):
                continue
            stamp, value = bucket.get("time"), scalar(bucket.get("cost"))
            if not isinstance(stamp, bool) and isinstance(stamp, (int, float)) and start <= stamp < end and value is not None:
                date = dt.datetime.fromtimestamp(stamp, dt.timezone(dt.timedelta(seconds=offset))).date().isoformat()
                daily_cost[date] = daily_cost.get(date, 0.0) + value
                model_cost[model] = model_cost.get(model, 0.0) + value
    today = dt.datetime.fromtimestamp(now, dt.timezone(dt.timedelta(seconds=offset))).date().isoformat()
    dates = sorted(set(daily_tokens) | set(daily_cost))
    daily = [{"date": d, "tokens": daily_tokens.get(d, 0), "cost": round(daily_cost.get(d, 0), 8),
              "requests": requests.get(d, 0)} for d in dates]
    currency = chosen.get("currency") if isinstance(chosen, dict) else None
    currency = "CNY" if currency is None else currency if currency in {"USD", "CNY", "EUR", "GBP", "JPY"} else "?"
    return {"provider": "deepseek", "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "currency": currency,
            "todayTokens": daily_tokens.get(today, 0), "todayCost": round(daily_cost.get(today, 0), 8),
            "periodLabel": "Last 30 days", "periodTokens": sum(daily_tokens.values()),
            "periodCost": round(sum(daily_cost.values()), 8),
            "periodRequests": sum(requests.values()),
            "requestCount": requests.get(today, 0), "apiKeyCount": len(api_keys),
            "topModel": max(models, key=models.get) if models else None,
            "modelCosts": [{"model": m, "cost": round(v, 8)} for m, v in sorted(model_cost.items(), key=lambda x: -x[1])],
            "daily": daily}


def deepseek(token, now=None):
    now = int(now if now is not None else time.time())
    local_now = dt.datetime.fromtimestamp(now).astimezone()
    offset = int(local_now.utcoffset().total_seconds())  # Current UTC offset in seconds, including DST.
    today = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
    start = int((today - dt.timedelta(days=29)).timestamp())
    end = int((today + dt.timedelta(days=1)).timestamp())
    query = {"start": start, "end": end, "tz": offset}
    try:
        amount = deepseek_call(token, "usage/by_api_key/amount", query)
        cost = deepseek_call(token, "usage/by_api_key/cost", query)
        return parse_deepseek(amount, cost, now=now, offset=offset)
    except SessionError as by_key_error:
        if by_key_error.status in (401, 403) or "expired or rejected" in str(by_key_error):
            raise
        # Upstream CodexBar falls back to monthly amount/cost when by-key series fail.
        month = dt.datetime.fromtimestamp(now).astimezone()
        query = {"month": month.month, "year": month.year}
        try:
            amount = deepseek_call(token, "usage/amount", query)
            cost = deepseek_call(token, "usage/cost", query)
            return parse_deepseek_month(amount, cost, now)
        except SessionError:
            raise by_key_error


def parse_deepseek_month(amount, cost, now):
    def biz(p):
        if not isinstance(p, dict):
            return None
        data = p.get("data")
        if not isinstance(data, dict):
            return None
        return data.get("biz_data") if data.get("biz_code", 0) == 0 else None
    abiz, cbiz = biz(amount), biz(cost)
    if not isinstance(abiz, dict) or not isinstance(cbiz, list):
        raise SessionError("DeepSeek monthly response has no biz_data")
    totals = abiz.get("total")
    days = abiz.get("days")
    if not isinstance(totals, list) or not isinstance(days, list) or any(not isinstance(x, dict) for x in totals + days):
        raise SessionError("DeepSeek monthly response has invalid usage lists")
    if any(not isinstance(block, dict) for block in cbiz):
        raise SessionError("DeepSeek monthly response has invalid cost blocks")
    block = cbiz[0] if cbiz else {}
    if not isinstance(block.get("total", []), list) or not isinstance(block.get("days", []), list):
        raise SessionError("DeepSeek monthly response has invalid cost lists")
    model_tokens, model_costs = {}, {}
    daily_tokens, daily_cost, daily_requests = {}, {}, {}
    def amount_sum(items):
        if not isinstance(items, list):
            return 0
        return sum(scalar(i.get("amount")) or 0 for i in items if isinstance(i, dict) and i.get("type") != "REQUEST")
    for item in totals:
        model = safe_label(item.get("model"))
        if model: model_tokens[model] = amount_sum(item.get("usage"))
    for day in days:
        date = day.get("date")
        try: date = dt.date.fromisoformat(date).isoformat()
        except (TypeError, ValueError): continue
        if len(date) == 10:
            models = day.get("data")
            if not isinstance(models, list) or any(not isinstance(m, dict) for m in models):
                continue
            token_items = [i for m in models for i in (m.get("usage") if isinstance(m.get("usage"), list) else [])
                           if isinstance(i, dict)]
            daily_tokens[date] = amount_sum(token_items)
            requests = sum(scalar(i.get("amount")) or 0 for i in token_items if i.get("type") == "REQUEST")
            if requests:
                daily_requests[date] = int(requests)
    for item in block.get("total", []):
        if not isinstance(item, dict): continue
        model = safe_label(item.get("model"))
        if model: model_costs[model] = amount_sum(item.get("usage"))
    for day in block.get("days", []):
        if not isinstance(day, dict): continue
        date = day.get("date")
        try: date = dt.date.fromisoformat(date).isoformat()
        except (TypeError, ValueError): continue
        if len(date) == 10:
            models = day.get("data")
            if not isinstance(models, list) or any(not isinstance(m, dict) for m in models):
                continue
            daily_cost[date] = sum(scalar(i.get("amount")) or 0 for m in models
                                   for i in (m.get("usage") if isinstance(m.get("usage"), list) else [])
                                   if isinstance(i, dict) and i.get("type") != "REQUEST")
    ds = sorted(set(daily_tokens) | set(daily_cost))
    today = dt.datetime.fromtimestamp(now).astimezone().date().isoformat()
    month = today[:7]
    currency = block.get("currency")
    currency = "CNY" if currency is None else currency if currency in {"USD", "CNY", "EUR", "GBP", "JPY"} else "?"
    return {"provider": "deepseek", "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "currency": currency,
            "todayTokens": daily_tokens.get(today, 0), "todayCost": daily_cost.get(today, 0),
            "periodLabel": "This month", "periodTokens": sum(v for d, v in daily_tokens.items() if d.startswith(month)),
            "periodCost": sum(v for d, v in daily_cost.items() if d.startswith(month)),
            "periodRequests": sum(v for d, v in daily_requests.items() if d.startswith(month)),
            "requestCount": daily_requests.get(today, 0), "apiKeyCount": 0,
            "topModel": max(model_tokens, key=model_tokens.get) if model_tokens else None,
            "modelCosts": [{"model": m, "cost": v} for m, v in model_costs.items()],
            "daily": [{"date": d, "tokens": daily_tokens.get(d, 0), "cost": daily_cost.get(d, 0), "requests": daily_requests.get(d, 0)} for d in ds]}


def _console_count(value):
    if not isinstance(value, str) or len(value) > 16 or not re.fullmatch(r"[0-9]+", value):
        return None
    number = int(value)
    return number if number <= 9007199254740991 else None


def normalize_opencode_usage(summary, hours, models, since, now):
    fields = ("totalRequests", "totalInputTokens", "totalOutputTokens", "totalCacheReadTokens",
              "totalCacheWrite5mTokens", "totalCacheWrite1hTokens", "totalCostMicroCents")
    values = {key: _console_count(summary.get(key)) for key in fields} if isinstance(summary, dict) else {}
    if len(values) != len(fields) or any(value is None for value in values.values()):
        return None
    if sum(values[key] for key in fields[1:6]) > 9007199254740991:
        return None
    result = {"summary": values}
    start = since.replace(minute=0, second=0, microsecond=0)
    normalized_hours = {}
    if isinstance(hours, list) and len(hours) <= 25:
        for row in hours:
            if not isinstance(row, dict):
                return {"summary": values, "historyUnavailable": True}
            stamp = row.get("date")
            try:
                parsed = dt.datetime.fromisoformat(stamp.replace("Z", "+00:00")) if isinstance(stamp, str) else None
            except ValueError:
                parsed = None
            if parsed is None or parsed.tzinfo != dt.timezone.utc or parsed.minute or parsed.second or parsed.microsecond:
                return {"summary": values, "historyUnavailable": True}
            if parsed < start or parsed > now or parsed - start > dt.timedelta(hours=24):
                continue
            counts = [_console_count(row.get(key)) for key in ("totalCostMicroCents", "totalTokens", "totalRequests")]
            if any(value is None for value in counts):
                return {"summary": values, "historyUnavailable": True}
            date = parsed.isoformat().replace("+00:00", "Z")
            if date in normalized_hours:
                return {"summary": values, "historyUnavailable": True}
            normalized_hours[date] = {"date": date, "cost": counts[0], "tokens": counts[1], "requests": counts[2]}
        result["hours"] = []
        for i in range(25):
            stamp = start + dt.timedelta(hours=i)
            if stamp > now:
                break
            date = stamp.isoformat().replace("+00:00", "Z")
            result["hours"].append(normalized_hours.get(date, {"date": date, "cost": 0, "tokens": 0, "requests": 0}))
    else:
        result["historyUnavailable"] = True
    if isinstance(models, dict) and isinstance(models.get("items"), list) and len(models["items"]) <= 10:
        items = []
        valid = True
        for row in models["items"]:
            label = safe_label(row.get("model")) if isinstance(row, dict) else None
            cost = _console_count(row.get("totalCostMicroCents")) if isinstance(row, dict) else None
            if not label or cost is None:
                valid = False
                break
            items.append({"model": label[:100], "cost": cost})
        page_info = models.get("pageInfo")
        if valid and isinstance(page_info, dict) and isinstance(page_info.get("pageCount"), int) and page_info["pageCount"] >= 1:
            result["models"] = items
            result["modelsPartial"] = page_info["pageCount"] > 1
        else:
            result["historyUnavailable"] = True
    else:
        result["historyUnavailable"] = True
    return result


def opencode(cookies):
    try:
        orgs = request_json("https://opencode.ai/console/api/orgs", cookies)
    except SessionError as exc:
        if "HTTP 404" in str(exc):
            return opencode_legacy(cookies)
        raise
    if not isinstance(orgs, list) or len(orgs) != 1:
        raise SessionError("OpenCode Console returned no organizations")
    org_id = orgs[0].get("id") if isinstance(orgs[0], dict) else None
    if not isinstance(org_id, str) or not org_id:
        raise SessionError("OpenCode Console organization response is unsupported")
    if len(org_id) > 200 or not all(c.isalnum() or c in "_-" for c in org_id):
        raise SessionError("OpenCode Console organization id is malformed")
    headers = {"x-org-id": org_id}
    try:
        status = request_json("https://opencode.ai/console/api/go/status", cookies, headers=headers)
    except SessionError as exc:
        if "HTTP 404" in str(exc):
            return opencode_legacy(cookies)
        raise
    if status is None or (isinstance(status, dict) and status.get("access") is None):
        raise SessionError("OpenCode account has no Go subscription")
    if not isinstance(status, dict) or not isinstance(status.get("access"), dict):
        raise SessionError("OpenCode Go response is unsupported")
    access = status["access"]
    meters = access.get("meters")
    if not isinstance(meters, dict) or not isinstance(meters.get("fiveHour"), dict):
        raise SessionError("OpenCode Go response has no five-hour meter")
    windows = []
    for key, label in (("fiveHour", "5 hours"), ("week", "Weekly"), ("month", "Monthly")):
        meter = meters.get(key)
        if not isinstance(meter, dict):
            continue
        used, limit = scalar(meter.get("usedMicroCents")), scalar(meter.get("limitMicroCents"))
        if used is None or limit is None or limit <= 0:
            continue
        reset = iso_timestamp(meter.get("resetsAt") or (access.get("endsAt") if key == "month" else None))
        window = {"label": label, "usedPercent": max(0, min(100, used * 100 / limit))}
        if reset: window["resetsAt"] = reset
        windows.append(window)
    if not windows:
        raise SessionError("OpenCode Go response has no usable quota meters")
    try:
        billing = request_json("https://opencode.ai/console/api/billing/status", cookies, headers=headers)
    except SessionError:
        billing = None  # Optional balance failure does not discard valid quota windows.
    raw_balance = billing.get("balanceMicroCents") if isinstance(billing, dict) and billing.get("mode") == "pay-as-you-go" else None
    try:
        balance = float(raw_balance)
        if not abs(balance) < 1e18: balance = None
    except (TypeError, ValueError):
        balance = None
    result = {"provider": "opencodego", "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "windows": windows}
    if balance is not None:
        result["balanceUSD"] = balance / 100_000_000
    now = dt.datetime.now(dt.timezone.utc)
    since_dt = now - dt.timedelta(hours=24)
    since = since_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
    def optional(path, query):
        try:
            return request_json("https://opencode.ai/console/api/usage/" + path, cookies,
                                headers=headers, query=query)
        except (SessionError, ValueError, TypeError, json.JSONDecodeError):
            return None
    summary = optional("summary", {"since": since})
    if summary is not None:
        history = optional("cost-by-day", {"since": since, "bucket": "hour"})
        models = optional("models", {"since": since, "pageSize": 10, "page": 1, "costOrder": "desc"})
        usage = normalize_opencode_usage(summary, history, models, since_dt, now)
        if usage:
            result["consoleUsage"] = usage
        else:
            result["consoleUsageError"] = "Usage history unavailable"
    else:
        result["consoleUsageError"] = "Usage history unavailable"
    return result


def find_email(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key.lower() == "email" and isinstance(item, str) and "@" in item:
                return item.strip().lower()
            result = find_email(item)
            if result:
                return result
    elif isinstance(value, list):
        for item in value:
            if result := find_email(item):
                return result
    return None


def email_fingerprint(email):
    return hashlib.sha256(email.strip().casefold().encode("utf-8")).hexdigest() if email else None


def codex_window(window, label):
    if not isinstance(window, dict):
        return None
    used, seconds, reset = window.get("used_percent"), window.get("limit_window_seconds"), window.get("reset_at")
    used, seconds = scalar(used), scalar(seconds)
    if used is None or seconds is None:
        return None
    result = {"label": label, "usedPercent": max(0, min(100, used)), "windowMinutes": int(seconds // 60)}
    if reset := iso_timestamp(reset):
        result["resetsAt"] = reset
    return result


_MAX_COUNT = 9007199254740991


def _history_count(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= _MAX_COUNT or int(value) != value:
        raise ValueError
    return int(value)


def normalize_codex_activity(payload, today):
    if isinstance(payload, dict) and isinstance(payload.get("metadata"), dict) and payload["metadata"].get("stats_error"):
        raise ValueError
    buckets = payload.get("stats", {}).get("daily_usage_buckets") if isinstance(payload, dict) and isinstance(payload.get("stats"), dict) else None
    if not isinstance(buckets, list) or len(buckets) > 5000:
        raise ValueError
    start = today - dt.timedelta(days=29)
    days = {}
    for bucket in buckets:
        if not isinstance(bucket, dict) or not isinstance(bucket.get("start_date"), str):
            raise ValueError
        date = bucket["start_date"]
        try:
            parsed = dt.date.fromisoformat(date)
        except ValueError:
            raise ValueError from None
        if parsed.isoformat() != date or date in days:
            raise ValueError
        days[date] = _history_count(bucket.get("tokens"))
    daily = [{"date": (start + dt.timedelta(days=i)).isoformat(), "tokens": days.get((start + dt.timedelta(days=i)).isoformat(), 0)} for i in range(30)]
    today_text = today.isoformat()
    period = sum(row["tokens"] for row in daily)
    if period > _MAX_COUNT:
        raise ValueError
    return {"periodLabel": "Last 30 days", "daily": daily, "todayTokens": days.get(today_text, 0),
            "periodTokens": period}


def normalize_codex_credits(payload, today):
    events = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(events, list) or len(events) > 5000:
        raise ValueError
    start = today - dt.timedelta(days=29)
    totals = {}
    normalized = []
    for event in events:
        if not isinstance(event, dict) or not isinstance(event.get("date"), str):
            raise ValueError
        try:
            stamp = dt.datetime.fromisoformat(event["date"].replace("Z", "+00:00"))
            if stamp.tzinfo is None:
                stamp = stamp.replace(tzinfo=dt.timezone.utc)
            date = stamp.astimezone(dt.timezone.utc).date().isoformat()
        except (ValueError, OverflowError):
            raise ValueError from None
        amount = event.get("credit_amount")
        if isinstance(amount, bool) or not isinstance(amount, (int, float)) or not 0 <= amount <= _MAX_COUNT:
            raise ValueError
        service = safe_label(event.get("product_surface"))
        if not service:
            raise ValueError
        if start.isoformat() <= date <= today.isoformat():
            totals[date] = totals.get(date, 0) + amount
            if totals[date] > _MAX_COUNT:
                raise ValueError
            normalized.append({"date": date, "service": service[:100], "credits": amount, "_stamp": stamp})
    daily = [{"date": (start + dt.timedelta(days=i)).isoformat(), "credits": totals.get((start + dt.timedelta(days=i)).isoformat(), 0)} for i in range(30)]
    period = sum(row["credits"] for row in daily)
    if period > _MAX_COUNT:
        raise ValueError
    normalized.sort(key=lambda item: item["_stamp"], reverse=True)
    rows = [{key: value for key, value in item.items() if key != "_stamp"} for item in normalized[:10]]
    return {"periodLabel": "Last 30 days", "daily": daily, "todayCredits": totals.get(today.isoformat(), 0),
            "periodCredits": period, "events": rows, "eventsPartial": len(normalized) > 10}


def _codex_optional_history(url, auth, headers, normalizer, today):
    try:
        return normalizer(request_json(url, auth, headers=headers), today)
    except (SessionError, ValueError, TypeError, OverflowError, json.JSONDecodeError):
        return None


def codex(cookies, expected_email=None, flaresolverr_url=None):
    session = None
    auth_headers = {"Cookie": cookie_header(cookies)}
    user_agent = "CodexBar browser-session helper"
    try:
        usage = request_json("https://chatgpt.com/backend-api/wham/usage", cookies)
    except SessionError as exc:
        user_agent = "CodexBar browser-session helper"
        if exc.status == 403 and str(exc) == "Cloudflare challenge" and flaresolverr_url:
            session, cookies, user_agent = flaresolverr_json(flaresolverr_url, "https://chatgpt.com/api/auth/session", cookies)
        elif exc.status == 401:
            try:
                session = request_json("https://chatgpt.com/api/auth/session", cookies)
            except SessionError as session_exc:
                if session_exc.status != 403 or str(session_exc) != "Cloudflare challenge" or not flaresolverr_url:
                    raise
                session, cookies, user_agent = flaresolverr_json(flaresolverr_url, "https://chatgpt.com/api/auth/session", cookies)
        else:
            raise
        if (not isinstance(session, dict) or not isinstance(session.get("accessToken"), str) or
                not session["accessToken"] or any(ord(char) < 33 or ord(char) == 127 for char in session["accessToken"])):
            raise SessionError("Codex browser session has no bearer authorization")
        email = find_email(session)
        if expected_email and (not email or email.casefold() != expected_email.strip().casefold()):
            raise SessionError("Codex browser session email does not match the selected Codex account")
        try:
            usage = request_json("https://chatgpt.com/backend-api/wham/usage", session["accessToken"],
                                 headers={"Cookie": cookie_header(cookies), "User-Agent": user_agent})
            auth_headers = {"Cookie": cookie_header(cookies), "User-Agent": user_agent}
        except SessionError as retry:
            if flaresolverr_url and retry.status == 403 and str(retry) == "Cloudflare challenge":
                raise SessionError("Cloudflare still blocks the API after FlareSolverr; clearance may be tied to the solver's network or browser") from None
            raise
    if session is None:
        try:
            session = request_json("https://chatgpt.com/api/auth/session", cookies)
        except SessionError:
            if expected_email:
                raise SessionError("Codex browser session email could not be verified") from None
            session = None
    email = find_email(session)
    if expected_email and (not email or email.casefold() != expected_email.strip().casefold()):
        raise SessionError("Codex browser session email does not match the selected Codex account")
    if (isinstance(session, dict) and isinstance(session.get("accessToken"), str) and session["accessToken"] and
            not any(ord(char) < 33 or ord(char) == 127 for char in session["accessToken"])):
        history_auth = session["accessToken"]
    else:
        history_auth = cookies
    if not isinstance(usage, dict):
        raise SessionError("Codex web usage response is unsupported")
    rate = usage.get("rate_limit")
    if not isinstance(rate, dict):
        rate = {}
    primary = codex_window(rate.get("primary_window"), "Session")
    secondary = codex_window(rate.get("secondary_window"), "Weekly")
    if not primary and not secondary:
        raise SessionError("Codex web usage response has no rate limits")
    extra = []
    extras = usage.get("additional_rate_limits")
    if not isinstance(extras, list):
        extras = []
    for item in extras:
        if not isinstance(item, dict):
            continue
        rate_limit = item.get("rate_limit") if isinstance(item, dict) else None
        if not isinstance(rate_limit, dict):
            continue
        window = codex_window((rate_limit or {}).get("primary_window"), safe_label(item.get("limit_name")) or "Extra")
        if window:
            extra.append(window)
    credits = usage.get("credits") if isinstance(usage.get("credits"), dict) else {}
    spend_control = usage.get("spend_control")
    if not isinstance(spend_control, dict):
        spend_control = {}
    individual = usage.get("individual_limit") or rate.get("individual_limit") or spend_control.get("individual_limit")
    limit = None
    if isinstance(individual, dict):
        used, maximum = scalar(individual.get("used")), scalar(individual.get("limit"))
        if used is not None and maximum is not None:
            limit = {"used": used, "limit": maximum}
            if reset := iso_timestamp(individual.get("reset_at") or individual.get("resets_at")):
                limit["resetsAt"] = reset
    today = dt.datetime.now(dt.timezone.utc).date()
    activity = _codex_optional_history("https://chatgpt.com/backend-api/wham/profiles/me", history_auth,
                                       auth_headers, normalize_codex_activity, today)
    credit_headers = {**auth_headers, "x-openai-codex-usage-categories": "1"}
    credit_history = _codex_optional_history("https://chatgpt.com/backend-api/wham/usage/credit-usage-events",
                                             history_auth, credit_headers, normalize_codex_credits, today)
    result = {"provider": "codex", "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(), "emailHash": email_fingerprint(email),
            "plan": safe_label(usage.get("plan_type")),
            "windows": [w for w in (primary, secondary) if w], "extraWindows": extra,
            "credits": scalar(credits.get("balance")) if credits.get("has_credits") and not credits.get("unlimited") else None,
            "creditLimit": limit}
    if activity is None:
        result["activityHistoryError"] = "Token activity unavailable"
    else:
        result["activityHistory"] = activity
    if credit_history is None:
        result["creditHistoryError"] = "Credit history unavailable"
    else:
        result["creditHistory"] = credit_history
    return result


def _fetch_deepseek(session, _options):
    return deepseek(session)


def _fetch_opencode(session, _options):
    return opencode(session)


def _fetch_codex(session, options):
    return codex(session, options.get("codex_email"), options.get("flaresolverr_url"))


register_provider(Provider(
    "deepseek", "local-storage", discovery_browsers=("firefox", "chromium"),
    discover_profiles=lambda: _discover_browser_profiles(PROVIDERS["deepseek"]),
    read_session=_read_deepseek_session,
    fetch=_fetch_deepseek))
register_provider(Provider(
    "opencodego", "cookies", domains=("opencode.ai",),
    cookie_names=("auth", "__Host-auth", "__Host-console_session"),
    request_paths=("/_server", "/console/api/orgs"),
    discover_profiles=lambda: firefox_profiles(),
    read_session=lambda profile: firefox_cookies(profile, "opencodego"), fetch=_fetch_opencode))
register_provider(Provider(
    "codex", "cookies", domains=("chatgpt.com",),
    cookie_names=("_account", "oai-did", "cf_clearance", "__Secure-next-auth.session-token",
                  "next-auth.session-token", "__Secure-authjs.session-token", "authjs.session-token"),
    token_bases=("__Secure-next-auth.session-token", "next-auth.session-token",
                 "__Secure-authjs.session-token", "authjs.session-token"),
    request_paths=("/api/auth/session", "/backend-api/wham/usage"),
    discover_profiles=firefox_profiles,
    read_session=lambda profile: firefox_cookies(profile, "codex"), fetch=_fetch_codex,
    normalize_cookies=codex_cookie_header))


def publish(data):
    target = cache_path(data["provider"])
    target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(target.parent, 0o700)
    fd, name = tempfile.mkstemp(dir=target.parent, prefix=".usage-")
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), allow_nan=False)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(name, target)
    finally:
        try: os.unlink(name)
        except FileNotFoundError: pass


def refresh(provider, selected, codex_email=None, flaresolverr_url=None):
    adapter = PROVIDERS.get(provider)
    if adapter is None:
        raise SessionError("unsupported provider")
    label, _profile, session = find_sessions(provider, selected)
    # Re-resolve every time; profile switching/expiry never keeps an old token alive.
    data = adapter.fetch(session, {"codex_email": codex_email, "flaresolverr_url": flaresolverr_url})
    data["source"] = label
    data["accountKey"] = provider + ":" + label
    publish(data)


def refresh_provider(provider, selected, codex_email=None, flaresolverr_url=None):
    try:
        refresh(provider, selected, codex_email, flaresolverr_url)
    except Exception as exc:
        message = str(exc) if isinstance(exc, SessionError) else "unsupported response or local read failure"
        try:
            publish({"provider": provider, "status": "error", "error": message,
                     "source": selected, "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat()})
        except OSError:
            print(f"{provider} cache write failed", flush=True)
            return False
        print(f"{provider} refresh failed: {message}", flush=True)
        return False
    return True


def _settings_snapshot(runtime):
    settings = runtime.load_settings()
    if (not isinstance(settings, dict) or type(settings.get("enabled")) is not bool or
            not isinstance(settings.get("profile"), str) or
            isinstance(settings.get("interval"), bool) or not isinstance(settings.get("interval"), int) or
            not 60 <= settings["interval"] <= 14400 or
            (settings.get("codex_email") is not None and not isinstance(settings.get("codex_email"), str)) or
            (settings.get("flaresolverr_url") is not None and not isinstance(settings.get("flaresolverr_url"), str))):
        raise ValueError
    profile = settings["profile"].strip()
    solver = validate_flaresolverr_url(settings["flaresolverr_url"])
    return (settings["enabled"], profile, settings["interval"], settings["codex_email"], solver)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--enable", action="store_true", help="acknowledge that matching browser credentials will be read")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--provider", choices=("all", *PROVIDERS), default="all")
    parser.add_argument("--list-profiles", action="store_true")
    parser.add_argument("--json", action="store_true", help="emit profile listing as JSON")
    args = parser.parse_args()
    if args.json and not args.list_profiles:
        parser.error("--json is only supported with --list-profiles")
    if args.list_profiles and not args.enable:
        parser.error("--list-profiles reads matching local credentials; pass --enable to consent")
    if args.list_profiles:
        print("Checking local stored sessions only; credentials are never printed. Server validity is not checked.",
              file=sys.stderr)
        grouped = {}
        for provider in PROVIDERS:
            for label, _ in session_profiles(provider):
                if (not isinstance(label, str) or not 0 < len(label) <= 500 or
                        any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in label)):
                    continue
                try:
                    label.encode("utf-8", "strict")
                except UnicodeEncodeError:
                    continue
                providers = grouped.setdefault(label, [])
                if provider not in providers:
                    providers.append(provider)
        if args.json:
            print(json.dumps({"profiles": [{"label": label, "providers": providers}
                                             for label, providers in sorted(grouped.items())[:1000]]},
                             separators=(",", ":")))
        else:
            for provider in PROVIDERS:
                labels = [label for label, providers in grouped.items() if provider in providers]
                print(f"{provider}: {', '.join(labels) if labels else 'no supported session'}")
        return 0
    if not args.enable:
        parser.error("disabled by default; read the security notice and pass --enable to consent")
    providers = tuple(PROVIDERS) if args.provider == "all" else (args.provider,)
    try:
        import runtime
    except ImportError:
        print("browser-session settings are unavailable", file=sys.stderr)
        return 1

    previous = None
    next_refresh = 0
    try:
        while True:
            try:
                current = _settings_snapshot(runtime)
            except (RuntimeError, ValueError, TypeError, argparse.ArgumentTypeError):
                if args.once:
                    print("browser-session settings are invalid or unavailable", file=sys.stderr)
                    return 1
                print("browser-session settings are invalid or unavailable", file=sys.stderr)
                time.sleep(60)
                continue

            enabled, profile, interval, email, solver = current
            if not enabled or not profile:
                if args.once:
                    print("browser-session is disabled or has no selected profile", file=sys.stderr)
                    return 1
                previous = current
                time.sleep(60)
                continue

            now = time.monotonic()
            if current != previous:
                next_refresh = now
            previous = current
            if now >= next_refresh:
                ok = []
                changed = False
                for provider in providers:
                    try:
                        if _settings_snapshot(runtime) != current:
                            changed = True
                            break
                    except (RuntimeError, ValueError, TypeError, argparse.ArgumentTypeError):
                        print("browser-session settings are invalid or unavailable", file=sys.stderr)
                        changed = True
                        break
                    ok.append(refresh_provider(provider, profile, email, solver))
                if args.once and not changed:
                    return 0 if all(ok) else 1
                if changed:
                    if args.once:
                        return 1
                    next_refresh = 0
                    time.sleep(60)
                    continue
                next_refresh = time.monotonic() + interval
            time.sleep(min(60, max(0, next_refresh - time.monotonic())))
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
