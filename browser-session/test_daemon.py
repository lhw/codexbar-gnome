import importlib.util
import datetime as dt
import io
import json
import contextlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import os
from unittest.mock import patch
import time
import types
from pathlib import Path

spec = importlib.util.spec_from_file_location("daemon", Path(__file__).with_name("daemon.py"))
daemon = importlib.util.module_from_spec(spec)
spec.loader.exec_module(daemon)


class DaemonTests(unittest.TestCase):
    def test_cookie_adapter_uses_its_own_normalizer_not_codex(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            with sqlite3.connect(profile / "cookies.sqlite") as conn:
                conn.execute("CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, originAttributes TEXT, isSecure INTEGER)")
                conn.execute("INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?)",
                             ("provider.test", "session.0", "private", "/", 0, "", 1))
            adapter = daemon.Provider("test-cookies", "cookies", domains=("provider.test",),
                cookie_names=("session",), token_bases=("session",), request_paths=("/usage",),
                discover_profiles=lambda: [], read_session=lambda profile: None, fetch=lambda session, options: {},
                normalize_cookies=lambda cookies: {"session": cookies["session.0"]})
            with patch.dict(daemon.PROVIDERS, {adapter.id: adapter}), patch.object(daemon, "codex_cookie_header", side_effect=AssertionError("Wrong provider normalizer")):
                self.assertEqual(daemon.firefox_cookies(profile, adapter.id, now=1000), {"session": "private"})

    def test_codex_history_normalizers_bound_and_fill_utc_days(self):
        today = dt.date(2026, 10, 8)
        activity = daemon.normalize_codex_activity({"stats": {"daily_usage_buckets": [
            {"start_date": "2026-10-08", "tokens": 12}, {"start_date": "2026-09-09", "tokens": 5}]}}, today)
        self.assertEqual(len(activity["daily"]), 30)
        self.assertEqual((activity["todayTokens"], activity["periodTokens"]), (12, 17))
        credits = daemon.normalize_codex_credits({"data": [
            {"date": "2026-10-08T01:00:00-04:00", "product_surface": "Codex", "credit_amount": 2.25},
            {"date": "2026-10-08T23:00:00Z", "product_surface": "Codex", "credit_amount": 3}]}, today)
        self.assertEqual(credits["todayCredits"], 5.25)
        self.assertEqual(credits["periodCredits"], 5.25)
        self.assertEqual(credits["events"][0]["date"], "2026-10-08")
        for payload, normalizer in (({"stats": {"daily_usage_buckets": [{"start_date": "2026-10-08", "tokens": True}]}}, daemon.normalize_codex_activity),
                                    ({"data": [{"date": "bad", "product_surface": "Codex", "credit_amount": 1}]}, daemon.normalize_codex_credits),
                                    ({"data": [{"date": "2026-10-08", "product_surface": "Codex", "credit_amount": float("inf")}]}, daemon.normalize_codex_credits)):
            with self.assertRaises(ValueError): normalizer(payload, today)
        with self.assertRaises(ValueError):
            daemon.normalize_codex_activity({"stats": {"daily_usage_buckets": [
                {"start_date": "2026-10-08", "tokens": 1}, {"start_date": "2026-10-08", "tokens": 2}]}}, today)
        with self.assertRaises(ValueError):
            daemon.normalize_codex_activity({"stats": {"daily_usage_buckets": []},
                                             "metadata": {"stats_error": "unavailable"}}, today)

    def test_codex_optional_histories_are_independent_and_never_cache_credentials(self):
        usage = {"rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 60}}}
        session = {"accessToken": "bearer-secret", "user": {"email": "owner@example.com"}}
        calls = []
        def request(url, auth, **kwargs):
            calls.append((url, auth, kwargs))
            if url.endswith("wham/usage"):
                return usage
            if url.endswith("/api/auth/session"):
                return session
            if url.endswith("profiles/me"):
                return {"profile": {"email": "private@example.com"}, "stats": {"daily_usage_buckets": []}}
            if url.endswith("credit-usage-events"):
                return {"data": []}
            raise AssertionError(url)
        with patch.object(daemon, "request_json", side_effect=request):
            result = daemon.codex({"session": "cookie-secret"}, expected_email="owner@example.com")
        self.assertEqual(len(result["activityHistory"]["daily"]), 30)
        self.assertEqual(len(result["creditHistory"]["daily"]), 30)
        self.assertEqual(result["creditHistory"]["events"], [])
        self.assertEqual(calls[-1][2]["headers"]["x-openai-codex-usage-categories"], "1")
        self.assertTrue(all(call[1] == "bearer-secret" for call in calls[2:]))
        serialized = json.dumps(result)
        self.assertNotIn("bearer-secret", serialized)
        self.assertNotIn("cookie-secret", serialized)
        self.assertNotIn("private@example.com", serialized)

    def test_codex_history_failures_do_not_discard_quota(self):
        def request(url, *_args, **_kwargs):
            if url.endswith("wham/usage"):
                return {"rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 60}}}
            if url.endswith("/api/auth/session"):
                return {"user": {"email": "owner@example.com"}}
            raise daemon.SessionError("private server detail", status=403)
        with patch.object(daemon, "request_json", side_effect=request):
            result = daemon.codex({"session": "cookie"}, expected_email="owner@example.com")
        self.assertEqual(result["windows"][0]["usedPercent"], 1)
        self.assertEqual(result["activityHistoryError"], "Token activity unavailable")
        self.assertEqual(result["creditHistoryError"], "Credit history unavailable")
        self.assertNotIn("private server detail", json.dumps(result))

    def test_opencode_console_usage_normalizes_verified_payload_and_bounds(self):
        now = dt.datetime(2026, 10, 8, 12, tzinfo=dt.timezone.utc)
        since = now - dt.timedelta(hours=24)
        summary = {"totalRequests": "1060", "totalInputTokens": "123", "totalOutputTokens": "456",
                   "totalCacheReadTokens": "789", "totalCacheWrite5mTokens": "10", "totalCacheWrite1hTokens": "11",
                   "totalCostMicroCents": "634917662", "email": "never-cache@example.com"}
        hours = [{"date": "2026-10-08T11:00:00Z", "totalCostMicroCents": "123456789", "totalTokens": "20", "totalRequests": "2"}]
        models = {"items": [{"model": "deepseek-chat", "totalCostMicroCents": "25000000"}],
                  "pageInfo": {"page": 1, "pageSize": 10, "total": 11, "pageCount": 2}}
        result = daemon.normalize_opencode_usage(summary, hours, models, since, now)
        self.assertEqual(result["summary"]["totalCostMicroCents"], 634917662)
        self.assertEqual(result["models"], [{"model": "deepseek-chat", "cost": 25000000}])
        self.assertTrue(result["modelsPartial"])
        self.assertEqual(len(result["hours"]), 25)
        self.assertEqual(result["hours"][0]["cost"], 0)
        self.assertEqual(result["hours"][-2]["cost"], 123456789)
        self.assertTrue(daemon.normalize_opencode_usage(summary, hours * 2, models, since, now)["historyUnavailable"])
        self.assertNotIn("email", json.dumps(result))
        self.assertIsNone(daemon.normalize_opencode_usage({**summary, "totalRequests": "9007199254740992"}, hours, models, since, now))
        self.assertTrue(daemon.normalize_opencode_usage(summary, [{**hours[0], "date": "not-a-date"}], models, since, now)["historyUnavailable"])
        self.assertTrue(daemon.normalize_opencode_usage(summary, [{**hours[0], "totalTokens": "NaN"}], models, since, now)["historyUnavailable"])
        self.assertTrue(daemon.normalize_opencode_usage(summary, hours, {"items": [], "pageInfo": {}}, since, now)["historyUnavailable"])

    def test_running_browser_exclusive_lock_uses_private_snapshot(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "cookies.sqlite"
            live = sqlite3.connect(path)
            try:
                live.execute("PRAGMA journal_mode=WAL")
                live.execute("CREATE TABLE marker(value TEXT)")
                live.execute("INSERT INTO marker VALUES('committed')")
                live.commit()
                live.execute("PRAGMA locking_mode=EXCLUSIVE")
                live.execute("BEGIN EXCLUSIVE")
                before = path.read_bytes()
                with daemon._readonly_sqlite(path) as snapshot:
                    self.assertEqual(snapshot.execute("SELECT value FROM marker").fetchone(), ("committed",))
                    with self.assertRaises(sqlite3.OperationalError):
                        snapshot.execute("INSERT INTO marker VALUES('changed')")
                self.assertEqual(path.read_bytes(), before)
            finally:
                live.close()

    def test_deepseek_versioned_local_storage_token_wrapper(self):
        token = "synthetic-session-token-for-tests"
        self.assertEqual(daemon.parse_token(json.dumps({"value": token, "__version": 1})), token)

    def test_firefox_utf16_and_snappy_exact_key(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            db = profile / "storage/default/https+++platform.deepseek.com/ls/data.sqlite"
            db.parent.mkdir(parents=True)
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE data(key TEXT, utf16_length INTEGER, conversion_type INTEGER, compression_type INTEGER, value BLOB)")
                token = "deepseek-secret-session-token-value"
                encoded = __import__("cramjam").snappy.compress_raw(token.encode("utf-16-le"))
                conn.execute("INSERT INTO data VALUES(?,?,?,?,?)", ("not_userToken", len(token), 0, 1, encoded))
                self.assertIsNone(daemon.firefox_local_token(profile))
                conn.execute("INSERT INTO data VALUES(?,?,?,?,?)", ("userToken", len(token), 0, 1, encoded))
            self.assertEqual(daemon.firefox_local_token(profile), token)
            with sqlite3.connect(db) as conn:
                conn.execute("UPDATE data SET value=? WHERE key='userToken'", (b"bad",))
            self.assertIsNone(daemon.firefox_local_token(profile))

    def test_firefox_cookie_scope_and_provider_allowlist(self):
        with tempfile.TemporaryDirectory(prefix="profile with # ") as temp:
            profile = Path(temp)
            db = profile / "cookies.sqlite"
            with sqlite3.connect(db) as conn:
                conn.execute("CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, originAttributes TEXT, isSecure INTEGER)")
                conn.executemany("INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?)", [
                    ("opencode.ai", "__Host-console_session", "session-secret", "/", 0, "", 1),
                    ("opencode.ai.evil", "auth", "wrong-host", "/", 0, "", 0),
                    (".opencode.ai", "auth", "expired", "/", 100, "", 0),
                    (".opencode.ai", "unrelated", "not-read", "/", 0, "", 0),
                    (".chatgpt.com", "__Secure-next-auth.session-token.0", "chunk-a", "/", 0, "^userContextId=1", 1),
                    (".chatgpt.com", "__Secure-next-auth.session-token.1", "chunk-b", "/", 0, "^userContextId=1", 1),
                    (".openai.com", "__Secure-next-auth.session-token", "other-domain", "/", 0, "", 1),
                ])
            self.assertEqual(daemon.firefox_cookies(profile, "opencodego", now=1000),
                             {"__Host-console_session": "session-secret"})
            self.assertEqual(daemon.firefox_cookies(profile, "codex", now=1000),
                             {"__Secure-next-auth.session-token.0": "chunk-a",
                              "__Secure-next-auth.session-token.1": "chunk-b"})
            with sqlite3.connect(db) as conn:
                conn.executemany("INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?)", [
                    (".chatgpt.com", "__Secure-next-auth.session-token.0", "other-a", "/", 0, "^userContextId=2", 1),
                    (".chatgpt.com", "__Secure-next-auth.session-token.1", "other-b", "/", 0, "^userContextId=2", 1)])
            with self.assertRaisesRegex(daemon.SessionError, "multiple Firefox cookie containers"):
                daemon.firefox_cookies(profile, "codex", now=1000)

    def test_opencodego_provider_uses_canonical_cookie_provider_through_refresh(self):
        old_home, old_firefox_profiles, old_opencode, old_cache = (
            daemon.HOME, daemon.firefox_profiles, daemon.opencode, daemon.CACHE_DIR)
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp) / "Firefox Profile"
            profile.mkdir()
            with sqlite3.connect(profile / "cookies.sqlite") as conn:
                conn.execute("CREATE TABLE moz_cookies(host TEXT, name TEXT, value TEXT, path TEXT, expiry INTEGER, originAttributes TEXT, isSecure INTEGER)")
                conn.execute("INSERT INTO moz_cookies VALUES(?,?,?,?,?,?,?)",
                             (".opencode.ai", "auth", "auth-secret", "/", 0, "", 1))
            try:
                daemon.HOME = Path(temp)
                daemon.firefox_profiles = lambda: [("firefox:Firefox Profile", profile)]
                daemon.opencode = lambda cookies: {"provider": "opencodego", "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
                                                    "windows": [], "cookieSeen": cookies.get("auth")}
                daemon.CACHE_DIR = Path(temp) / "cache"
                self.assertTrue(daemon.refresh_provider("opencodego", "firefox:Firefox Profile"))
                result = json.loads(daemon.cache_path("opencodego").read_text())
                self.assertEqual(result["cookieSeen"], "auth-secret")
                self.assertEqual(result["provider"], "opencodego")
            finally:
                daemon.HOME = old_home
                daemon.firefox_profiles = old_firefox_profiles
                daemon.opencode = old_opencode
                daemon.CACHE_DIR = old_cache

    def test_chromium_leveldb_reads_only_exact_origin_and_key(self):
        with tempfile.TemporaryDirectory() as temp:
            profile = Path(temp)
            path = profile / "Local Storage/leveldb"
            path.mkdir(parents=True)
            db = daemon.plyvel.DB(str(path), create_if_missing=True)
            encode = lambda s: b"\x01" + s.encode()
            db.put(b"_https://platform.deepseek.com\x00" + encode("userToken"), encode('"' + "x" * 32 + '"'))
            db.put(b"_https://evil.example\x00" + encode("userToken"), encode("y" * 32))
            db.put(b"_https://platform.deepseek.com.evil\x00" + encode("userToken"), encode("q" * 32))
            db.put(b"_https://platform.deepseek.com\x00" + encode("notUserToken"), encode("z" * 32))
            db.close()
            before = set(Path(tempfile.gettempdir()).glob("codexbar-leveldb-*"))
            self.assertEqual(daemon.chromium_local_token(profile), "x" * 32)
            self.assertEqual(set(Path(tempfile.gettempdir()).glob("codexbar-leveldb-*")), before)
            db = daemon.plyvel.DB(str(path))
            db.delete(b"_https://platform.deepseek.com\x00" + encode("userToken"))
            db.close()
            self.assertIsNone(daemon.chromium_local_token(profile))

    def test_deepseek_nested_biz_data_normalized_allowlist(self):
        amount = {"code": 0, "data": {"biz_code": 0, "biz_data": {"series": [
            {"api_key": {"name": "private key", "tracking_id": "secret-id"}, "model": "deepseek-chat",
             "buckets": [{"time": 1720000000, "usage": {"PROMPT_CACHE_HIT_TOKEN": {"value": "120"},
                                                            "REQUEST": {"value": "3"}}}]}]}}}
        cost = {"code": 0, "data": {"biz_code": 0, "biz_data": {"data": [
            {"currency": "CNY", "series": [{"api_key": {"tracking_id": "secret-id"}, "model": "deepseek-chat",
                                                 "buckets": [{"time": 1720000000, "cost": {"value": "0.12"}}]}]}]}}}
        data = daemon.parse_deepseek(amount, cost, now=1720000000, offset=-25200)
        self.assertEqual(data["todayTokens"], 120)
        self.assertEqual(data["requestCount"], 3)
        self.assertEqual(data["apiKeyCount"], 1)
        self.assertEqual(data["daily"][0]["cost"], 0.12)
        self.assertNotIn("secret-id", json.dumps(data))
        self.assertNotIn("private key", json.dumps(data))

    def test_deepseek_query_uses_signed_seconds_and_dst(self):
        old_tz, old_call = os.environ.get("TZ"), daemon.deepseek_call
        try:
            os.environ["TZ"] = "America/Los_Angeles"
            time.tzset()
            calls = []
            amount = {"code": 0, "data": {"biz_code": 0, "biz_data": {"series": []}}}
            cost = {"code": 0, "data": {"biz_code": 0, "biz_data": {"data": []}}}
            daemon.deepseek_call = lambda _token, endpoint, query: (calls.append((endpoint, query)) or
                (amount if endpoint.endswith("amount") else cost))
            summer = int(dt.datetime(2026, 7, 1, tzinfo=dt.timezone.utc).timestamp())
            daemon.deepseek("secret", now=summer)
            self.assertEqual(calls[0][1]["tz"], -25200)
            self.assertEqual(dt.datetime.fromtimestamp(calls[0][1]["start"], dt.timezone(dt.timedelta(hours=-7))).hour, 0)
            self.assertEqual(dt.datetime.fromtimestamp(calls[0][1]["end"], dt.timezone(dt.timedelta(hours=-7))).hour, 0)
            self.assertEqual(calls[0][1]["end"] - calls[0][1]["start"], 30 * 86400)
        finally:
            daemon.deepseek_call = old_call
            if old_tz is None: os.environ.pop("TZ", None)
            else: os.environ["TZ"] = old_tz
            time.tzset()

    def test_deepseek_monthly_fallback_preserves_token_request_cost_metrics(self):
        old_call = daemon.deepseek_call
        now = int(dt.datetime(2024, 1, 1, 12, tzinfo=dt.timezone.utc).timestamp())
        amount = {"code": 0, "data": {"biz_code": 0, "biz_data": {"total": [
            {"model": "deepseek-chat", "usage": [{"type": "RESPONSE_TOKEN", "amount": "40"}]}],
            "days": [{"date": "2024-01-01", "data": [{"model": "deepseek-chat", "usage": [
                {"type": "RESPONSE_TOKEN", "amount": "40"}, {"type": "REQUEST", "amount": "2"}]}]}]}}}
        cost = {"code": 0, "data": {"biz_code": 0, "biz_data": [{"currency": "CNY", "total": [],
            "days": [{"date": "2024-01-01", "data": [{"model": "deepseek-chat", "usage": [
                {"type": "RESPONSE_TOKEN", "amount": "0.25"}]}]}]}]}}
        calls = []
        try:
            def fake(_token, endpoint, query):
                calls.append((endpoint, query))
                if "by_api_key" in endpoint:
                    raise daemon.SessionError("not available")
                return amount if endpoint.endswith("amount") else cost
            daemon.deepseek_call = fake
            result = daemon.deepseek("private-token", now=now)
            self.assertEqual(result["periodLabel"], "This month")
            self.assertEqual(result["periodTokens"], 40)
            self.assertEqual(result["requestCount"], 2)
            self.assertEqual(result["periodCost"], 0.25)
            self.assertEqual(calls[-1][1], {"month": 1, "year": 2024})
        finally:
            daemon.deepseek_call = old_call

    def test_deepseek_midnight_dates_work_for_east_and_west_offsets(self):
        for offset, now, expected in ((-8 * 3600, 1704078000, "2023-12-31"),
                                      (5 * 3600, 1704060000, "2024-01-01")):
            stamp = now
            amount = {"data": {"biz_code": 0, "biz_data": {"series": [
                {"model": "m", "buckets": [{"time": stamp, "usage": {"REQUEST": {"value": "1"}}}]}]}}}
            cost = {"data": {"biz_code": 0, "biz_data": {"data": []}}}
            parsed = daemon.parse_deepseek(amount, cost, now=now, offset=offset)
            self.assertEqual(parsed["daily"][0]["date"], expected)
            self.assertEqual(parsed["todayTokens"], 0)
            self.assertEqual(parsed["requestCount"], 1)

    def test_deepseek_nested_auth_code_never_triggers_month_fallback(self):
        old = daemon.request_json
        calls = []
        try:
            def fake(url, *_args, **_kwargs):
                calls.append(url.rsplit("/", 1)[-1])
                return {"code": 0, "data": {"biz_code": 40003, "biz_data": {}}}
            daemon.request_json = fake
            with self.assertRaisesRegex(daemon.SessionError, "expired or rejected"):
                daemon.deepseek("token", now=1704067200)
            self.assertEqual(calls, ["amount"])
        finally:
            daemon.request_json = old

    def test_monthly_deepseek_malformed_shapes_and_boolean_scalars_fail_closed(self):
        with self.assertRaises(daemon.SessionError):
            daemon.parse_deepseek_month({"data": {"biz_code": 0, "biz_data": {"total": {}, "days": []}}},
                                        {"data": {"biz_code": 0, "biz_data": []}}, 1704067200)
        self.assertIsNone(daemon.scalar(True))

    def test_rejects_bad_auth_envelope_and_bad_data(self):
        for body in ({"code": 40002}, {"code": 0, "data": {"biz_code": 40003}},
                     {"code": 0, "data": None}):
            old = daemon.request_json
            try:
                daemon.request_json = lambda *args, **kwargs: body
                with self.assertRaises(daemon.SessionError):
                    daemon.deepseek_call("not-logged", "usage/amount", {})
            finally:
                daemon.request_json = old

    def test_http_auth_errors_and_redirects_never_expose_or_forward_credentials(self):
        old = daemon.HTTP
        class Unauthorized:
            def open(self, *_args, **_kwargs):
                raise __import__("urllib.error").error.HTTPError("https://platform.deepseek.com", 401,
                                                                  "unauthorized", {}, io.BytesIO(b"secret body"))
        try:
            daemon.HTTP = Unauthorized()
            with self.assertRaisesRegex(daemon.SessionError, "expired or rejected") as raised:
                daemon.request_json("https://platform.deepseek.com", "credential-secret")
            self.assertNotIn("secret body", str(raised.exception))
            handler = daemon.NoRedirect()
            with self.assertRaisesRegex(daemon.SessionError, "redirect rejected"):
                handler.redirect_request(None, None, 302, "redirect", {}, "https://attacker.example")
        finally:
            daemon.HTTP = old

    def test_flaresolverr_validation_and_rendered_session_protocol(self):
        self.assertEqual(daemon.validate_flaresolverr_url("http://127.0.0.1:8191"), "http://127.0.0.1:8191/v1")
        self.assertEqual(daemon.validate_flaresolverr_url("https://solver.example/v1"), "https://solver.example/v1")
        for value in ("ftp://solver.example", "http://user:pass@solver.example", "http://solver.example/?x=1",
                      "http://solver.example/#frag", "http://solver.example/other"):
            with self.assertRaises(Exception):
                daemon.validate_flaresolverr_url(value)
        old = daemon.HTTP
        class Solver:
            def open(self, req, timeout):
                body = json.loads(req.data)
                assert "Authorization" not in req.headers
                assert body["cmd"] == "request.get"
                assert body["maxTimeout"] == 60000
                assert body["cookies"][0]["value"] == "cookie-secret"
                assert timeout == 65
                payload = {"status": "ok", "solution": {"status": 200,
                    "url": "https://chatgpt.com/api/auth/session", "cookies": [
                         {"name": "cf_clearance", "value": "clearance", "domain": ".chatgpt.com", "path": "/"},
                         {"name": "session", "value": "wrong-domain", "domain": ".example.com"},
                         {"name": "unrelated", "value": "ignored"}],
                     "userAgent": "Solver browser",
                    "response": "<html><pre>{&quot;user&quot;:{&quot;email&quot;:&quot;a@example.com&quot;}}</pre></html>"}}
                return io.BytesIO(json.dumps(payload).encode())
        try:
            daemon.HTTP = Solver()
            result, cookies, user_agent = daemon.flaresolverr_json("http://127.0.0.1:8191/v1",
                "https://chatgpt.com/api/auth/session", {"session": "cookie-secret"})
            self.assertEqual(result["user"]["email"], "a@example.com")
            self.assertEqual(cookies, {"session": "cookie-secret", "cf_clearance": "clearance"})
            self.assertEqual(user_agent, "Solver browser")
        finally:
            daemon.HTTP = old

    def test_flaresolverr_rejects_redirect_status_wrong_url_and_challenge_html(self):
        old = daemon.HTTP
        class Solver:
            def __init__(self, status, url, response): self.result = {"status": "ok", "solution": {
                "status": status, "url": url, "response": response, "userAgent": "Solver browser"}}
            def open(self, *_args, **_kwargs): return io.BytesIO(json.dumps(self.result).encode())
        try:
            for status, url, response in ((302, "https://chatgpt.com/api/auth/session", "{}"),
                    (200, "https://chatgpt.com/login", "{}"),
                    (200, "https://chatgpt.com/api/auth/session", "<html>challenge</html>")):
                daemon.HTTP = Solver(status, url, response)
                with self.assertRaises(daemon.SessionError):
                    daemon.flaresolverr_json("http://127.0.0.1:8191/v1",
                        "https://chatgpt.com/api/auth/session", {})
        finally:
            daemon.HTTP = old

    def test_codex_challenge_only_falls_back_when_configured(self):
        old_request, old_solver = daemon.request_json, daemon.flaresolverr_json
        calls = []
        def request(url, *_args, **_kwargs):
            if url.endswith("wham/usage"):
                raise daemon.SessionError("Cloudflare challenge", status=403)
            return {"user": {"email": "a@example.com"}}
        try:
            daemon.request_json = request
            daemon.flaresolverr_json = lambda *args: (calls.append(args) or ({"user": {"email": "a@example.com"}, "accessToken": "test-bearer"}, {}, "Solver browser"))
            with self.assertRaises(daemon.SessionError): daemon.codex({"session": "cookie"})
            self.assertEqual(calls, [])
            attempts = []
            def retry_request(url, *_args, **_kwargs):
                if "profiles/me" in url or "credit-usage-events" in url:
                    return {}
                if url.endswith("wham/usage"):
                    attempts.append(url)
                    if len(attempts) == 1:
                        raise daemon.SessionError("Cloudflare challenge", status=403)
                    self.assertEqual(_args, ("test-bearer",))
                    self.assertEqual(_kwargs["headers"]["User-Agent"], "Solver browser")
                    return {"rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 60}}}
                return {"user": {"email": "a@example.com"}}
            daemon.request_json = retry_request
            daemon.codex({"session": "cookie"}, flaresolverr_url="http://127.0.0.1:8191/v1")
            self.assertEqual(len(calls), 1)
            attempts.clear()
            with self.assertRaises(daemon.SessionError):
                daemon.codex({"session": "cookie"}, expected_email="other@example.com",
                             flaresolverr_url="http://127.0.0.1:8191/v1")
            self.assertEqual(len(attempts), 1)
            def rejected(*args, **kwargs):
                raise daemon.SessionError("browser session expired or rejected", status=403)
            daemon.request_json = rejected
            calls.clear()
            with self.assertRaises(daemon.SessionError):
                daemon.codex({"session": "cookie"}, flaresolverr_url="http://127.0.0.1:8191/v1")
            self.assertEqual(calls, [])
        finally:
            daemon.request_json, daemon.flaresolverr_json = old_request, old_solver

    def test_codex_unauthorized_then_session_challenge_uses_solver(self):
        usage = {"rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 60}}}
        session = {"accessToken": "test-bearer", "user": {"email": "a@example.com"}}
        def request_side_effect(url, *_args, **_kwargs):
            if url.endswith("/api/auth/session"):
                raise daemon.SessionError("Cloudflare challenge", status=403)
            if url.endswith("wham/usage"):
                if not getattr(request_side_effect, "failed_usage", False):
                    request_side_effect.failed_usage = True
                    raise daemon.SessionError("unauthorized", status=401)
                return usage
            return {}
        with patch.object(daemon, "request_json", side_effect=request_side_effect) as request, \
                patch.object(daemon, "flaresolverr_json", return_value=(session, {"cf_clearance": "test"}, "Solver browser")) as solver:
            daemon.codex({"session": "cookie"}, flaresolverr_url="http://127.0.0.1:8191/v1")
            self.assertEqual(solver.call_count, 1)
            retried = next(call for call in request.call_args_list if call.args[0].endswith("wham/usage") and isinstance(call.args[1], str))
            self.assertEqual(retried.args[1], "test-bearer")
            self.assertEqual(retried.kwargs["headers"]["User-Agent"], "Solver browser")

    def test_opencode_console_normalizes_meter_and_optional_balance(self):
        old = daemon.request_json
        responses = [
            [{"id": "org_private"}],
            {"access": {"endsAt": "2030-01-01T00:00:00Z", "meters": {
                "fiveHour": {"usedMicroCents": "25000000", "limitMicroCents": "100000000", "resetsAt": "2030-01-01T00:00:00Z"},
                "week": {"usedMicroCents": 50000000, "limitMicroCents": 200000000}, "month": None}}},
            {"mode": "pay-as-you-go", "balanceMicroCents": "-25000000"},
        ]
        try:
            daemon.request_json = lambda *args, **kwargs: responses.pop(0) if "usage/" not in args[0] else (_ for _ in ()).throw(daemon.SessionError("optional unavailable"))
            result = daemon.opencode({"__Host-console_session": "secret"})
            self.assertEqual([w["usedPercent"] for w in result["windows"]], [25, 25])
            self.assertEqual(result["balanceUSD"], -0.25)
            self.assertNotIn("org_private", json.dumps(result))
            self.assertNotIn("secret", json.dumps(result))
            self.assertEqual(result["consoleUsageError"], "Usage history unavailable")
        finally:
            daemon.request_json = old

    def test_opencode_legacy_server_function_normalizes_verified_meters(self):
        text = json.dumps({"data": {"rollingUsage": {"usagePercent": 12, "resetInSec": 3600},
                                     "weeklyUsage": {"usagePercent": 44, "resetInSec": 86400}}})
        result = daemon.parse_opencode_legacy(text)
        self.assertEqual([window["usedPercent"] for window in result["windows"]], [12, 44])
        self.assertEqual(result["windows"][0]["label"], "5 hours")
        with self.assertRaises(daemon.SessionError):
            daemon.parse_opencode_legacy('{"rollingUsage":{"usagePercent":12,"resetInSec":10}}')

    def test_opencode_legacy_requires_unique_workspace_and_falls_back_to_post(self):
        old = daemon.opencode_server_text
        calls = []
        payload = 'const x = { rollingUsage: { usagePercent: 10, resetInSec: 20 }, weeklyUsage: { usagePercent: 30, resetInSec: 40 } };'
        try:
            def fake(_cookies, server_id, *, args=None, referer="https://opencode.ai", method="GET"):
                calls.append((server_id, args, referer, method))
                if len(calls) == 1:
                    return '[{"id":"wrk_test123"}]'
                return payload if method == "POST" else "unsupported response"
            daemon.opencode_server_text = fake
            result = daemon.opencode_legacy({"auth": "session"})
            self.assertTrue(result["legacy"])
            self.assertEqual([call[3] for call in calls], ["GET", "GET", "POST"])
            self.assertEqual(calls[1][1], ["wrk_test123"])
            self.assertEqual(calls[2][2], "https://opencode.ai/workspace/wrk_test123/go")
            daemon.opencode_server_text = lambda *_args, **_kwargs: '[{"id":"wrk_one"},{"id":"wrk_two"}]'
            with self.assertRaisesRegex(daemon.SessionError, "exactly one workspace"):
                daemon.opencode_legacy({"auth": "session"})
        finally:
            daemon.opencode_server_text = old

    def test_codex_web_api_parses_only_known_quota_fields_and_rejects_email_mismatch(self):
        old = daemon.request_json
        usage = {"plan_type": "pro", "rate_limit": {
            "primary_window": {"used_percent": 20, "limit_window_seconds": 18000, "reset_at": 1800000000},
            "secondary_window": {"used_percent": 30, "limit_window_seconds": 604800, "reset_at": 1801000000}},
            "additional_rate_limits": [{"limit_name": "Codex Spark", "rate_limit": {
                "primary_window": {"used_percent": 5, "limit_window_seconds": 18000, "reset_at": 1800000000}}}],
            "credits": {"has_credits": True, "unlimited": False, "balance": 12.5},
            "unknown_private_field": "never persisted"}
        try:
            daemon.request_json = lambda url, *_args, **_kwargs: ({"user": {"email": "owner@example.com"},
                                                                   "accessToken": "access-secret"}
                                                                  if url.endswith("/api/auth/session") else usage)
            result = daemon.codex({"session": "secret"}, "owner@example.com")
            self.assertEqual(result["extraWindows"][0]["label"], "Codex Spark")
            self.assertEqual(result["credits"], 12.5)
            self.assertEqual(result["emailHash"], daemon.email_fingerprint("owner@example.com"))
            self.assertNotIn("owner@example.com", json.dumps(result))
            self.assertNotIn("unknown_private_field", json.dumps(result))
            with self.assertRaisesRegex(daemon.SessionError, "does not match"):
                daemon.codex({"session": "secret"}, "other@example.com")
        finally:
            daemon.request_json = old

    def test_codex_usage_401_fetches_session_bearer_then_retries(self):
        old = daemon.request_json
        calls = []
        usage = {"rate_limit": {"primary_window": {"used_percent": 1, "limit_window_seconds": 300, "reset_at": 1800000000}}}
        def fake(url, auth, **kwargs):
            calls.append((url, auth, kwargs))
            if url.endswith("wham/usage") and auth == {"__Secure-next-auth.session-token": "cookie"}:
                raise daemon.SessionError("browser session expired or rejected", status=401)
            if url.endswith("/api/auth/session"):
                return {"user": {"email": "owner@example.com"}, "accessToken": "bearer-secret"}
            if url.endswith("wham/usage") and auth == "bearer-secret":
                return usage
            if "profiles/me" in url or "credit-usage-events" in url:
                return {}
            raise AssertionError("unexpected Codex request")
        try:
            daemon.request_json = fake
            result = daemon.codex({"__Secure-next-auth.session-token": "cookie"}, "owner@example.com")
            self.assertEqual([url.rsplit("/", 1)[-1] for url, _, _ in calls], ["usage", "session", "usage", "me", "credit-usage-events"])
            self.assertEqual(calls[-1][2]["headers"]["Cookie"], "__Secure-next-auth.session-token=cookie")
            self.assertEqual(result["emailHash"], daemon.email_fingerprint("owner@example.com"))
            self.assertNotIn("bearer-secret", json.dumps(result))
        finally:
            daemon.request_json = old

    def test_codex_authjs_cookie_variant_is_preserved_for_session_api(self):
        self.assertEqual(daemon.codex_cookie_header({"__Secure-authjs.session-token": "authjs-token",
                                                      "_account": "account-id", "oai-did": "device-id"}),
                         {"__Secure-authjs.session-token": "authjs-token", "_account": "account-id",
                          "oai-did": "device-id"})

    def test_codex_malformed_extra_windows_are_ignored_without_crash(self):
        old = daemon.request_json
        usage = {"rate_limit": {"primary_window": {"used_percent": 2, "limit_window_seconds": 60}},
                 "additional_rate_limits": [{"rate_limit": []}, None, {"limit_name": "ok", "rate_limit": {
                     "primary_window": {"used_percent": True, "limit_window_seconds": 1}}}]}
        try:
            daemon.request_json = lambda *_args, **_kwargs: usage
            result = daemon.codex({})
            self.assertEqual(result["extraWindows"], [])
        finally:
            daemon.request_json = old

    def test_multiple_profiles_require_explicit_selection(self):
        old = daemon.matching_sessions
        try:
            daemon.matching_sessions = lambda provider, selected=None: [
                item for item in [("firefox:one", Path("/1"), "a"), ("chromium:two", Path("/2"), "b")]
                if selected is None or item[0] == selected]
            with self.assertRaisesRegex(daemon.SessionError, "multiple matching profiles"):
                daemon.find_sessions("deepseek")
            self.assertEqual(daemon.find_sessions("deepseek", "firefox:one")[0], "firefox:one")
            with self.assertRaisesRegex(daemon.SessionError, "selected browser profile"):
                daemon.find_sessions("deepseek", "other")
        finally:
            daemon.matching_sessions = old

    def test_refresh_publishes_only_sanitized_data_with_private_permissions(self):
        old_cache, old_find, old_deepseek = daemon.CACHE_DIR, daemon.find_sessions, daemon.deepseek
        try:
            with tempfile.TemporaryDirectory() as temp:
                daemon.CACHE_DIR = Path(temp)
                daemon.find_sessions = lambda *_: ("firefox:test", Path(temp), "never-write-token")
                daemon.deepseek = lambda token: {"provider": "deepseek", "updatedAt": "2026-10-08T00:00:00+00:00",
                                                  "todayTokens": 5}
                daemon.refresh("deepseek", "firefox:test")
                target = daemon.cache_path("deepseek")
                raw = target.read_text()
                self.assertIn('"source":"firefox:test"', raw)
                self.assertNotIn("never-write-token", raw)
                self.assertEqual(target.stat().st_mode & 0o777, 0o600)
                daemon.publish({"provider": "codex", "updatedAt": "2026-10-08T00:00:00+00:00"})
                self.assertNotEqual(daemon.cache_path("codex"), target)
                self.assertTrue(target.exists())
        finally:
            daemon.CACHE_DIR, daemon.find_sessions, daemon.deepseek = old_cache, old_find, old_deepseek

    def test_disabled_and_once_failure_exit_nonzero(self):
        script = str(Path(__file__).with_name("daemon.py"))
        disabled = subprocess.run([sys.executable, script, "--once"], capture_output=True, text=True)
        self.assertNotEqual(disabled.returncode, 0)
        self.assertIn("disabled by default", disabled.stderr)
        with tempfile.TemporaryDirectory() as home:
            env = dict(os.environ, HOME=home, XDG_CACHE_HOME=str(Path(home) / ".cache"))
            no_session = subprocess.run([sys.executable, script, "--once", "--enable", "--provider", "deepseek"],
                                        capture_output=True, text=True, env=env)
            self.assertNotEqual(no_session.returncode, 0)

    def test_once_success_exits_cleanly_without_starting_poll_loop(self):
        runtime = types.ModuleType("runtime")
        runtime.load_settings = lambda: {"enabled": True, "profile": "firefox:chosen", "interval": 900,
                                        "codex_email": None, "flaresolverr_url": None}
        with patch.object(sys, "argv", ["daemon.py", "--enable", "--once", "--provider", "deepseek"]), \
             patch.dict(sys.modules, runtime=runtime), \
             patch.object(daemon, "refresh_provider", return_value=True) as refresh:
            self.assertEqual(daemon.main(), 0)
            refresh.assert_called_once_with("deepseek", "firefox:chosen", None, None)

    def test_once_all_providers_attempts_independently_and_reports_partial_failure(self):
        calls = []
        runtime = types.ModuleType("runtime")
        runtime.load_settings = lambda: {"enabled": True, "profile": "chosen", "interval": 900,
                                        "codex_email": None, "flaresolverr_url": None}
        def refresh(provider, *_args):
            calls.append(provider)
            return provider != "opencodego"
        with patch.object(sys, "argv", ["daemon.py", "--enable", "--once"]), \
             patch.dict(sys.modules, runtime=runtime), \
             patch.object(daemon, "refresh_provider", side_effect=refresh):
            self.assertEqual(daemon.main(), 1)
        self.assertEqual(calls, ["deepseek", "opencodego", "codex"])

    def test_settings_changes_disable_reads_and_force_immediate_refresh(self):
        first = {"enabled": True, "profile": "first", "interval": 240, "codex_email": None, "flaresolverr_url": None}
        disabled = {**first, "enabled": False}
        second = {**first, "profile": "second"}
        settings = [first, first, first, disabled, second, second]
        runtime = types.ModuleType("runtime")
        runtime.load_settings = lambda: settings.pop(0)
        now = [0]
        calls = []
        def sleep(seconds):
            now[0] += seconds
            if len(calls) == 2:
                raise KeyboardInterrupt
        with patch.object(sys, "argv", ["daemon.py", "--enable", "--provider", "deepseek"]), \
             patch.dict(sys.modules, runtime=runtime), \
             patch.object(daemon.time, "monotonic", side_effect=lambda: now[0]), \
             patch.object(daemon.time, "sleep", side_effect=sleep), \
             patch.object(daemon, "refresh_provider", side_effect=lambda *args: calls.append(args) or True):
            self.assertEqual(daemon.main(), 0)
        self.assertEqual(calls, [("deepseek", "first", None, None), ("deepseek", "second", None, None)])

    def test_once_rechecks_consent_between_providers(self):
        enabled = {"enabled": True, "profile": "chosen", "interval": 900,
                   "codex_email": None, "flaresolverr_url": None}
        disabled = {**enabled, "enabled": False}
        settings = [enabled, enabled, disabled]
        runtime = types.ModuleType("runtime")
        runtime.load_settings = lambda: settings.pop(0)
        calls = []
        with patch.object(sys, "argv", ["daemon.py", "--enable", "--once"]), \
             patch.dict(sys.modules, runtime=runtime), \
             patch.object(daemon, "refresh_provider", side_effect=lambda *args: calls.append(args) or True):
            self.assertEqual(daemon.main(), 1)
        self.assertEqual(calls, [("deepseek", "chosen", None, None)])

    def test_once_disabled_empty_profile_and_invalid_solver_fail_before_refresh(self):
        runtime = types.ModuleType("runtime")
        base = {"enabled": True, "profile": "chosen", "interval": 60, "codex_email": None,
                "flaresolverr_url": None}
        with patch.object(sys, "argv", ["daemon.py", "--enable", "--once"]), patch.dict(sys.modules, runtime=runtime), \
             patch.object(daemon, "refresh_provider") as refresh:
            for values in ({**base, "enabled": False}, {**base, "profile": "  "},
                           {**base, "flaresolverr_url": "file:///etc/passwd"}):
                runtime.load_settings = lambda values=values: values
                self.assertEqual(daemon.main(), 1)
            refresh.assert_not_called()

    def test_registered_provider_flows_through_discovery_refresh_and_cli(self):
        profile = Path("/never-read")
        provider = daemon.Provider("test-provider", "test", discover_profiles=lambda: [("fake:profile", profile)],
                                   read_session=lambda _profile: "opaque-test-session",
                                   fetch=lambda session, _options: {"provider": "test-provider", "seen": session})
        daemon.register_provider(provider)
        try:
            self.assertEqual(daemon.find_sessions("test-provider")[2], "opaque-test-session")
            with tempfile.TemporaryDirectory() as temp, patch.object(daemon, "CACHE_DIR", Path(temp)):
                daemon.refresh("test-provider", None)
                self.assertEqual(json.loads(daemon.cache_path("test-provider").read_text())["seen"],
                                 "opaque-test-session")
            with patch.object(sys, "argv", ["daemon.py", "--enable", "--list-profiles"]), \
                 patch.object(daemon, "request_json", side_effect=AssertionError("network called")), \
                 patch.object(daemon, "publish", side_effect=AssertionError("publish called")), \
                 contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(daemon.main(), 0)
                self.assertIn("test-provider: fake:profile", output.getvalue())
                self.assertNotIn("opaque-test-session", output.getvalue())
        finally:
            del daemon.PROVIDERS["test-provider"]

    def test_list_profiles_requires_consent_before_any_local_reads_and_skips_bad_profiles(self):
        profiles = [("blank", Path("/blank")), ("bad", Path("/bad")), ("valid", Path("/valid"))]
        def read(profile):
            if profile.name == "bad":
                raise daemon.SessionError("private credential detail")
            return None if profile.name == "blank" else "private-token"
        provider = daemon.Provider("listing-test", "custom", discover_profiles=lambda: profiles,
                                   read_session=read, fetch=lambda *_: {})
        daemon.register_provider(provider)
        try:
            with patch.object(sys, "argv", ["daemon.py", "--list-profiles"]), \
                 patch.object(daemon, "matching_sessions", side_effect=AssertionError("scanned before consent")):
                with self.assertRaises(SystemExit):
                    daemon.main()
            output, errors = io.StringIO(), io.StringIO()
            with patch.object(sys, "argv", ["daemon.py", "--enable", "--list-profiles"]), \
                 patch.object(daemon, "request_json", side_effect=AssertionError("network called")), \
                 patch.object(daemon, "publish", side_effect=AssertionError("publish called")), \
                 contextlib.redirect_stdout(output), contextlib.redirect_stderr(errors):
                self.assertEqual(daemon.main(), 0)
            self.assertIn("listing-test: valid", output.getvalue())
            self.assertNotIn("blank", output.getvalue())
            self.assertNotIn("bad", output.getvalue())
            self.assertNotIn("private-token", output.getvalue() + errors.getvalue())
            self.assertNotIn("private credential detail", output.getvalue() + errors.getvalue())
            self.assertIn("Server validity is not checked", errors.getvalue())
        finally:
            del daemon.PROVIDERS["listing-test"]

    def test_json_profiles_group_labels_and_reject_controls_without_network_or_cache(self):
        profiles = [("shared", Path("/one")), ("bad\nlabel", Path("/bad")), ("shared", Path("/two"))]
        daemon.register_provider(daemon.Provider("json-test", "custom", discover_profiles=lambda: profiles,
                                                  read_session=lambda _profile: "secret",
                                                  fetch=lambda *_: {}))
        daemon.register_provider(daemon.Provider("json-test-two", "custom", discover_profiles=lambda: profiles[:1],
                                                  read_session=lambda _profile: "secret",
                                                  fetch=lambda *_: {}))
        try:
            output = io.StringIO()
            with patch.object(sys, "argv", ["daemon.py", "--enable", "--list-profiles", "--json"]), \
                    patch.object(daemon, "request_json", side_effect=AssertionError("network called")), \
                    patch.object(daemon, "publish", side_effect=AssertionError("cache write called")), \
                    contextlib.redirect_stdout(output):
                self.assertEqual(daemon.main(), 0)
            self.assertEqual(json.loads(output.getvalue())["profiles"][0],
                             {"label": "shared", "providers": ["json-test", "json-test-two"]})
            self.assertNotIn("bad", output.getvalue())
            self.assertNotIn("secret", output.getvalue())
            with patch.object(sys, "argv", ["daemon.py", "--json"]):
                with self.assertRaises(SystemExit):
                    daemon.main()
        finally:
            del daemon.PROVIDERS["json-test"]
            del daemon.PROVIDERS["json-test-two"]

    def test_provider_registration_rejects_unsafe_ids_and_incomplete_adapters(self):
        for provider in (
                daemon.Provider("../escape", "custom", discover_profiles=lambda: [],
                                read_session=lambda _profile: None, fetch=lambda *_: {}),
                daemon.Provider("missing-adapter", "custom"),
                daemon.Provider("cookie-scope", "cookies", discover_profiles=lambda: [],
                                read_session=lambda _profile: None, fetch=lambda *_: {},
                                domains=("example.com",), cookie_names=("session",))):
            with self.assertRaises(ValueError):
                daemon.register_provider(provider)


if __name__ == "__main__":
    unittest.main()
