#!/usr/bin/env python3
"""Point your own copy of the 1.5.7 client at a server, into a NEW apk.

The apk you supply is opened read-only and never modified; everything is
written to a separate output file. Nothing from the game is downloaded or
distributed by this tool.

The client's base URLs live as plain NUL-terminated strings in libclient.so.
Each is overwritten in place and NUL-padded to its original length, so no
offset moves and nothing else in the binary changes:

    https://futurama.prod.tinyco.com/tapservice/   44 bytes  the API
    https://config-fut-tc.akamaized.net/           36 bytes  config CDN
    https://static-fut-tc.akamaized.net/           36 bytes  asset CDN

All three point at the server. The config address has to: the server's merged
config files exist nowhere else. It answers /static/ from its cache, then the
upstream CDNs in `cdn.servers`, then data/local-cdn, so hard-coded asset URLs
such as the intro movie still resolve. The 36-byte CDN slots set the limit on
--server: 20 characters after `https://`, or 21 after `http://`.

The API path keeps its `tapservice/` segment, because the client appends `api/`
to it and posts to /tapservice/api/.

Repacking invalidates the signature, so the old signature files are dropped and
the result is signed with a throwaway key made for this run. That needs
`keytool` and `jarsigner` from any JDK, found on PATH or under JAVA_HOME. The
client targets an API level below 30, so Android accepts this v1 signature, and
below 28, so plain HTTP is allowed.

Usage:
    python tools/patch_client.py fwot-1.5.7.apk --server http://192.0.2.10:8090
    python tools/patch_client.py fwot-1.5.7.apk --server https://play.example.com
"""

import argparse
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import zipfile

LIBRARY = "libclient.so"
API = b"https://futurama.prod.tinyco.com/tapservice/"
CDNS = (b"https://config-fut-tc.akamaized.net/",
        b"https://static-fut-tc.akamaized.net/")
SUFFIX = {API: "/tapservice/", CDNS[0]: "/config/", CDNS[1]: "/static/"}
SIGNATURE = re.compile(r"^META-INF/([^/]+\.(SF|RSA|DSA|EC)|MANIFEST\.MF)$", re.I)

LIB_ALIGN = 4096      # a stored .so is mmapped straight out of the apk
DEFAULT_ALIGN = 4     # every other stored entry


def server_base(url):
    """-> 'scheme://host[:port]', or exit naming what is wrong with `url`."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.netloc:
        raise SystemExit("--server must look like http://host[:port] or https://host")
    if parts.path.strip("/") or parts.query or parts.fragment:
        raise SystemExit("--server takes no path: the client adds /tapservice/ itself")
    return "%s://%s" % (parts.scheme, parts.netloc)


def patch_strings(blob, base, targets):
    """-> (patched blob, [(original, replacement)]), each overwritten in place."""
    out = bytearray(blob)
    done = []
    for original in targets:
        hits = [m.start() for m in re.finditer(re.escape(original), out)]
        if not hits:
            raise SystemExit("%s not found in %s: is this the 1.5.7 client?"
                             % (original.decode(), LIBRARY))
        prefix = (base + SUFFIX[original]).encode()
        for off in hits:
            # A base URL is not always a whole string: the intro movie is one
            # string, base URL plus filename. Swap the prefix, keep the tail and
            # pad once, or the filename is cut off behind the padding.
            end = out.index(b"\0", off)
            replacement = prefix + bytes(out[off + len(original):end])
            if len(replacement) > end - off:
                raise SystemExit(
                    "'%s' is %d bytes but only %d fit. Use a shorter host name."
                    % (replacement.decode(), len(replacement), end - off))
            out[off:end] = replacement.ljust(end - off, b"\0")
            done.append((original, replacement))
    return bytes(out), done


def repack(src, dst, base, targets):
    """Copy the apk with libclient.so patched and the old signature dropped."""
    with zipfile.ZipFile(src) as zin:
        names = [n for n in zin.namelist()
                 if n.startswith("lib/") and n.endswith("/" + LIBRARY)]
        if not names:
            raise SystemExit("no %s in %s: is this the 1.5.7 client?" % (LIBRARY, src))
        patched = {}
        for name in names:
            patched[name], done = patch_strings(zin.read(name), base, targets)
            for original, replacement in done:
                print("  %s: %s -> %s" % (name, original.decode(), replacement.decode()))
        with zipfile.ZipFile(dst, "w") as zout:
            for info in zin.infolist():
                if SIGNATURE.match(info.filename):
                    continue
                out = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                out.compress_type = info.compress_type
                out.external_attr = info.external_attr
                zout.writestr(out, patched.get(info.filename) or zin.read(info.filename))


def align(src, dst):
    """What `zipalign -p 4` does: pad each stored entry's local header so its
    data starts on the boundary the loader expects. A v1 signature covers file
    contents, not layout, so this is safe after signing."""
    with zipfile.ZipFile(src) as zin, open(dst, "wb") as raw:
        with zipfile.ZipFile(raw, "w") as zout:
            for info in zin.infolist():
                out = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                out.compress_type = info.compress_type
                out.external_attr = info.external_attr
                if info.compress_type == zipfile.ZIP_STORED:
                    want = (LIB_ALIGN if info.filename.startswith("lib/")
                            and info.filename.endswith(".so") else DEFAULT_ALIGN)
                    # the local header is 30 bytes plus the name plus the extra
                    offset = raw.tell() + 30 + len(out.filename.encode())
                    out.extra = b"\0" * (-offset % want)
                zout.writestr(out, zin.read(info.filename))


def find_tool(name):
    exe = name + (".exe" if os.name == "nt" else "")
    java_home = os.environ.get("JAVA_HOME")
    if java_home and os.path.isfile(os.path.join(java_home, "bin", exe)):
        return os.path.join(java_home, "bin", exe)
    return shutil.which(name)


def sign(apk, workdir):
    """Sign with a keystore and password made for this run, then thrown away."""
    keytool, jarsigner = find_tool("keytool"), find_tool("jarsigner")
    if not (keytool and jarsigner):
        raise SystemExit("keytool and jarsigner not found. Install a JDK and put its "
                         "bin/ on PATH or set JAVA_HOME, or pass --no-sign.")
    keystore = os.path.join(workdir, "throwaway.keystore")
    # Hex, not urlsafe: a password starting with "-" is read as an option.
    password = secrets.token_hex(24)
    for command in (
            [keytool, "-genkeypair", "-keystore", keystore, "-alias", "fwot",
             "-storepass", password, "-keypass", password, "-keyalg", "RSA",
             "-keysize", "2048", "-validity", "10000",
             "-dname", "CN=fwot-server patched client"],
            [jarsigner, "-keystore", keystore, "-storepass", password,
             "-keypass", password, "-sigalg", "SHA256withRSA",
             "-digestalg", "SHA-256", apk, "fwot"]):
        done = subprocess.run(command, capture_output=True, text=True)
        if done.returncode != 0:
            raise SystemExit("%s failed:\n%s%s" % (
                os.path.basename(command[0]), done.stdout, done.stderr))


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("apk", help="your own copy of the 1.5.7 client (never modified)")
    ap.add_argument("--server", required=True,
                    help="the server's public URL, e.g. http://192.0.2.10:8090")
    ap.add_argument("-o", "--out", default="fwot-patched.apk")
    ap.add_argument("--no-sign", action="store_true",
                    help="leave the output unsigned, to sign it yourself")
    args = ap.parse_args()

    if os.path.abspath(args.apk) == os.path.abspath(args.out):
        raise SystemExit("refusing to overwrite the apk you supplied")
    base = server_base(args.server)
    targets = (API,) + CDNS

    workdir = tempfile.mkdtemp(prefix="fwot-patch-")
    try:
        unsigned = os.path.join(workdir, "unsigned.apk")
        print("patching %s for %s" % (args.apk, base))
        repack(args.apk, unsigned, base, targets)
        if args.no_sign:
            print("not signing (--no-sign)")
        else:
            print("signing with a throwaway key")
            sign(unsigned, workdir)
        align(unsigned, args.out)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)

    print("wrote %s (%s bytes); %s untouched" % (
        args.out, format(os.path.getsize(args.out), ","), args.apk))
    print("to install it, see 'Patching the client' in README.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
