#!/usr/bin/env python3
"""Tests for install.py. Run: python tools/test_install.py

The real run is a 168 MB download, so it is not covered here. These cover the
parts that could fail quietly: manifest comparison, download resume, a revision
that has stopped being served, and the install swap.
"""

import hashlib
import http.server
import os
import shutil
import tempfile
import threading
import unittest
import unittest.mock

import install


def md5(body):
    return hashlib.md5(body).hexdigest()


def read(path):
    with open(path, "rb") as fh:
        return fh.read()


def write(path, body):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as fh:
        fh.write(body)


class StubCDN(object):
    """Serves a name -> bytes map; 404s anything else. Records every hit."""

    def __init__(self, files):
        self.files = files
        self.hits = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):                                    # noqa: N802
                name = self.path.lstrip("/")
                outer.hits.append(name)
                body = outer.files.get(name)
                self.send_response(200 if body else 404)
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def log_message(self, *args):
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/" % self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ManifestTest(unittest.TestCase):
    def test_committed_lists_parse(self):
        rows = install.read_revisions()
        self.assertEqual(len(rows), 956)
        self.assertTrue(all(len(etag) == 32 for _n, etag, _l in rows))
        wanted = install.read_manifest()
        self.assertEqual(len(wanted), 130)
        self.assertIn("events.json", wanted)
        self.assertIn(install.SAVE_PATH, wanted)
        self.assertEqual(sum(1 for p in wanted if p.startswith("configs/")), 128)

    def test_mismatch_is_named(self):
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        write(os.path.join(root, "configs", "Good"), b"good")
        write(os.path.join(root, "configs", "Bad"), b"drifted")
        wanted = {"configs/Good": md5(b"good"),
                  "configs/Bad": md5(b"expected"),
                  "configs/Gone": md5(b"gone")}

        ok, bad = install.compare(wanted, root)

        self.assertEqual(ok, 1)
        self.assertEqual(bad, [("configs/Bad", md5(b"expected"),
                                md5(b"drifted")),
                               ("configs/Gone", md5(b"gone"), "MISSING")])


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.body = b'{"a": 1}'
        self.name = "Thing-" + md5(b"plaintext")
        self.etag = md5(self.body)
        self.cdn = StubCDN({self.name: self.body})
        self.addCleanup(self.cdn.close)
        self.raw = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.raw, True)
        for attribute, value in (("CDN", self.cdn.url), ("RAW", self.raw)):
            patch = unittest.mock.patch.object(install, attribute, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_present_and_matching_is_not_refetched(self):
        write(os.path.join(self.raw, self.name), self.body)

        self.assertEqual(install.fetch_one(self.name, self.etag), "skipped")
        self.assertEqual(self.cdn.hits, [])

    def test_corrupted_is_refetched(self):
        path = os.path.join(self.raw, self.name)
        write(path, b"truncated")

        self.assertEqual(install.fetch_one(self.name, self.etag), "fetched")
        self.assertEqual(self.cdn.hits, [self.name])
        self.assertEqual(read(path), self.body)

    def test_missing_revision_aborts_with_the_name(self):
        rows = [(self.name, self.etag, len(self.body)),
                ("Gone-" + "0" * 32, md5(b"nothing"), 4)]

        with self.assertRaises(SystemExit) as raised:
            install.fetch(rows, jobs=2)

        self.assertIn("1 revision(s)", str(raised.exception))


class InstallTest(unittest.TestCase):
    def setUp(self):
        self.data = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.data, True)
        self.season = os.path.join(self.data, "build", "season")
        write(os.path.join(self.season, "AppConfig"), b"new")
        write(os.path.join(self.data, "build", "events.json"), b"{}")
        self.configs = os.path.join(self.data, "configs")
        write(os.path.join(self.configs, "AppConfig"), b"old")
        for attribute, value in (("DATA", self.data), ("SEASON", self.season),
                                 ("BUILD", os.path.join(self.data, "build"))):
            patch = unittest.mock.patch.object(install, attribute, value)
            patch.start()
            self.addCleanup(patch.stop)

    def test_install_replaces_the_set(self):
        install.install()

        self.assertEqual(read(os.path.join(self.configs, "AppConfig")), b"new")
        self.assertFalse(os.path.exists(self.configs + ".old"))
        self.assertEqual(read(os.path.join(self.data, "events.json")), b"{}")

    def test_a_failed_stage_leaves_the_old_set_intact(self):
        with unittest.mock.patch.object(shutil, "copytree",
                                        side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                install.install()

        self.assertEqual(read(os.path.join(self.configs, "AppConfig")), b"old")

    def lock_swap(self, times):
        """Deny the staged -> configs rename `times` times, as a scanner would."""
        real = os.rename
        denied = []

        def rename(src, dst):
            if dst == self.configs and src.endswith("configs.new") and len(denied) < times:
                denied.append(src)
                raise PermissionError(5, "Access is denied", src)
            real(src, dst)

        for patch in (unittest.mock.patch.object(os, "rename", rename),
                      unittest.mock.patch.object(install.time, "sleep")):
            patch.start()
            self.addCleanup(patch.stop)
        return denied

    def test_a_briefly_locked_swap_is_retried(self):
        denied = self.lock_swap(times=1)

        install.install()

        self.assertEqual(len(denied), 1)
        self.assertEqual(read(os.path.join(self.configs, "AppConfig")), b"new")
        self.assertFalse(os.path.exists(self.configs + ".old"))

    def test_a_swap_that_stays_locked_restores_the_old_set(self):
        self.lock_swap(times=1000)

        with self.assertRaises(PermissionError):
            install.install()

        self.assertEqual(read(os.path.join(self.configs, "AppConfig")), b"old")
        self.assertFalse(os.path.exists(self.configs + ".old"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
