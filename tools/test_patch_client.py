#!/usr/bin/env python3
"""Tests for patch_client.py. Run: python tools/test_patch_client.py

Every apk here is synthetic: a stand-in libclient.so holding the three base
URLs, so no part of the real client is needed. Signing needs a JDK and is not
covered; the tests run with --no-sign.
"""

import os
import shutil
import struct
import sys
import tempfile
import unittest
import unittest.mock
import zipfile

import patch_client as pc

LIB = "lib/armeabi-v7a/libclient.so"
INTRO = b"https://static-fut-tc.akamaized.net/intro_movie_low.mp4"


def library():
    """Each URL NUL-terminated, as in .rodata, with filler around them."""
    return b"\x7fELF" + b"\0".join(
        [b"x" * 9, pc.API, pc.CDNS[0], pc.CDNS[1], INTRO, b"y" * 7]) + b"\0"


def strings(blob):
    return [s for s in blob.split(b"\0") if s]


class PatchTest(unittest.TestCase):
    def test_server_base(self):
        self.assertEqual(pc.server_base("http://10.0.0.2:8090/"), "http://10.0.0.2:8090")
        self.assertEqual(pc.server_base("https://play.example.com"), "https://play.example.com")
        for bad in ("play.example.com", "ftp://h", "http://h/tapservice/", "http://h/?a=1"):
            with self.assertRaises(SystemExit, msg=bad):
                pc.server_base(bad)

    def test_only_the_named_targets_change(self):
        blob = library()
        out, done = pc.patch_strings(blob, "http://10.0.0.2:8090", (pc.API,))

        self.assertEqual(len(out), len(blob))
        self.assertIn(b"http://10.0.0.2:8090/tapservice/", strings(out))
        self.assertNotIn(pc.API, out)
        self.assertIn(pc.CDNS[0], strings(out))
        self.assertIn(INTRO, strings(out))
        self.assertEqual(done, [(pc.API, b"http://10.0.0.2:8090/tapservice/")])

    def test_cdns_keep_a_filename_tail(self):
        out, _ = pc.patch_strings(library(), "http://h:1", (pc.API,) + pc.CDNS)

        self.assertIn(b"http://h:1/config/", strings(out))
        self.assertIn(b"http://h:1/static/", strings(out))
        self.assertIn(b"http://h:1/static/intro_movie_low.mp4", strings(out))
        self.assertNotIn(b"akamaized", out)

    def test_a_host_that_does_not_fit_is_refused(self):
        with self.assertRaises(SystemExit) as raised:
            pc.patch_strings(library(), "https://a-very-long-host-name.example.org", (pc.API,))
        self.assertIn("only 44 fit", str(raised.exception))

    def test_the_cdn_slots_set_the_limit(self):
        fits, too_long = "https://" + "h" * 20, "https://" + "h" * 21
        pc.patch_strings(library(), fits, (pc.API,) + pc.CDNS)
        with self.assertRaises(SystemExit) as raised:
            pc.patch_strings(library(), too_long, (pc.API,) + pc.CDNS)
        self.assertIn("only 36 fit", str(raised.exception))

    def test_a_client_without_the_url_is_refused(self):
        with self.assertRaises(SystemExit):
            pc.patch_strings(b"\x7fELF\0nothing here\0", "http://h", (pc.API,))


class ApkTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.src = os.path.join(self.dir, "client.apk")
        with zipfile.ZipFile(self.src, "w") as z:
            z.writestr("AndroidManifest.xml", b"manifest")
            z.writestr(zipfile.ZipInfo("classes.dex"), b"dex" * 50, zipfile.ZIP_DEFLATED)
            z.writestr("META-INF/MANIFEST.MF", b"old")
            z.writestr("META-INF/CERT.SF", b"old")
            z.writestr("META-INF/CERT.RSA", b"old")
            z.writestr("META-INF/services/kept", b"kept")
            z.writestr(LIB, library())                   # stored, so it must align
        self.out = os.path.join(self.dir, "patched.apk")

    def run_main(self):
        argv = ["patch_client.py", self.src, "--server", "http://10.0.0.2:8090",
                "-o", self.out, "--no-sign"]
        with unittest.mock.patch.object(sys, "argv", argv), \
                unittest.mock.patch("builtins.print"):
            return pc.main()

    def test_end_to_end_unsigned(self):
        self.assertEqual(self.run_main(), 0)

        with zipfile.ZipFile(self.out) as z:
            names = z.namelist()
            patched = strings(z.read(LIB))
            self.assertIn(b"http://10.0.0.2:8090/tapservice/", patched)
            self.assertIn(b"http://10.0.0.2:8090/static/intro_movie_low.mp4", patched)
            self.assertNotIn(b"akamaized", z.read(LIB))
            self.assertEqual(z.read("META-INF/services/kept"), b"kept")
            self.assertEqual(z.read("classes.dex"), b"dex" * 50)
        for gone in ("META-INF/MANIFEST.MF", "META-INF/CERT.SF", "META-INF/CERT.RSA"):
            self.assertNotIn(gone, names)
        with zipfile.ZipFile(self.src) as z:                  # the input is untouched
            self.assertIn(pc.API, z.read(LIB))

    def test_stored_entries_are_aligned(self):
        self.run_main()

        with open(self.out, "rb") as fh, zipfile.ZipFile(self.out) as z:
            for info in z.infolist():
                if info.compress_type != zipfile.ZIP_STORED:
                    continue
                fh.seek(info.header_offset)
                name_len, extra_len = struct.unpack("<HH", fh.read(30)[26:30])
                start = info.header_offset + 30 + name_len + extra_len
                want = 4096 if info.filename == LIB else 4
                self.assertEqual(start % want, 0, info.filename)

    def test_the_input_is_never_the_output(self):
        self.out = self.src
        with self.assertRaises(SystemExit):
            self.run_main()


if __name__ == "__main__":
    unittest.main(verbosity=2)
