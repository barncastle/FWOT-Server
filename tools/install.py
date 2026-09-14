#!/usr/bin/env python3
"""Rebuild data/ from the publisher's config CDN.

No game data is committed to this repo. The configs are still served at
config-fut-tc.akamaized.net, so this fetches all 956 revisions, decrypts them,
runs the build and installs the result only when every md5 matches
season_manifest.txt.
The one file it does not build is `data/saves/default_save.pb`, which is
project-authored and committed, so it is only checked against the manifest.

Two independent integrity checks: the etag column is the md5 of the ciphertext as
served, and the md5 in each name is the md5 of the plaintext, which the
decrypt step verifies per file. Decryption exists only as that step: there is
no standalone decryptor.

Usage:
    python tools/install.py
    python tools/install.py --offline        # build from data/build/raw
    python tools/install.py --verify-only    # check the installed data/
    python tools/install.py --clean          # drop data/build first
"""

import argparse
import concurrent.futures
import hashlib
import io
import os
import shutil
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request

CDN = "https://config-fut-tc.akamaized.net/"
USER_AGENT = "fwot-server-installer/0.1"      # says what it is; the CDN serves it
ATTEMPTS = 3
TIMEOUT = 60

TOOLS = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(TOOLS)
DATA = os.path.join(ROOT, "data")
BUILD = os.path.join(DATA, "build")
RAW = os.path.join(BUILD, "raw")
REVISIONS = os.path.join(BUILD, "revisions")
SEASON = os.path.join(BUILD, "season")
SEASON_BAK = os.path.join(BUILD, "season_bak")
SAVE_PATH = "saves/default_save.pb"   # committed, not built

# Directories the server reads at runtime. Empty is a valid state for both -- a
# miss, not an error -- but they are made here so the layout is visible.
RUNTIME_DIRS = ("local-cdn", "cdn-cache")

# Most configs are served encrypted:
#
#   * Byte 0 carries bit 7 forced on, which is how the loader tells ciphertext
#     from a plain `{` or `[`. Decryption masks it off again.
#   * The key is the file's own name md5, which is the md5 of the PLAINTEXT. Its
#     two 64-bit halves fold into the seed of a 64-bit LCG:
#         seed  = ((hi ^ lo) * M + C) mod 2**64
#         state = state * M + C
#   * Each step yields two keystream words, the state's high and low halves,
#     each bswap32'd. The payload is XORed one 32-bit little-endian word at a
#     time, high half first; trailing 1-3 bytes take the next word's low bytes.
#
# Every decryption self-verifies, because the key is the md5 of its own result.
M = 0x995128D618026A71
C = 0xBD1885BDA5346F45
MASK = (1 << 64) - 1


def md5_file(path):
    digest = hashlib.md5()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_revisions():
    """-> [(name, etag, length)] from the committed list."""
    rows = []
    with io.open(os.path.join(TOOLS, "config_revisions.tsv"),
                 encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#") or line.startswith("name\t"):
                continue
            name, etag, length = line.split("\t")
            rows.append((name, etag, int(length)))
    return rows


def read_manifest():
    """-> {data-relative path: md5} from the committed manifest."""
    wanted = {}
    with io.open(os.path.join(TOOLS, "season_manifest.txt"),
                 encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            digest, path = line.split("  ", 1)
            wanted[path] = digest
    return wanted


def compare(wanted, root):
    """-> (ok count, [(path, want, got)]) for one manifest against a tree."""
    bad = []
    ok = 0
    for path, want in sorted(wanted.items()):
        full = os.path.join(root, path.replace("/", os.sep))
        got = md5_file(full) if os.path.isfile(full) else None
        if got == want:
            ok += 1
        else:
            bad.append((path, want, got or "MISSING"))
    return ok, bad


def fetch_one(name, etag):
    """Download one revision unless it is already on disk and verifies."""
    dest = os.path.join(RAW, name)
    if os.path.exists(dest) and md5_file(dest) == etag:
        return "skipped"
    request = urllib.request.Request(CDN + name,
                                     headers={"User-Agent": USER_AGENT})
    for attempt in range(ATTEMPTS):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT) as reply:
                body = reply.read()
            break
        except urllib.error.HTTPError as error:
            error.close()
            return "HTTP %d" % error.code
        except Exception as error:                               # noqa: BLE001
            if attempt == ATTEMPTS - 1:
                return str(error)
            time.sleep(2 ** attempt)
    got = hashlib.md5(body).hexdigest()
    if got != etag:
        return "etag %s, got %s" % (etag, got)
    tmp = dest + ".part"
    with open(tmp, "wb") as fh:
        fh.write(body)
    os.replace(tmp, dest)
    return "fetched"


def fetch(rows, jobs):
    os.makedirs(RAW, exist_ok=True)
    counts = {"fetched": 0, "skipped": 0}
    failed = []
    done = 0
    with concurrent.futures.ThreadPoolExecutor(jobs) as pool:
        futures = {pool.submit(fetch_one, name, etag): name
                   for name, etag, _length in rows}
        for future in concurrent.futures.as_completed(futures):
            result = future.result()
            done += 1
            if result in counts:
                counts[result] += 1
            else:
                failed.append((futures[future], result))
            if done % 50 == 0 or done == len(rows):
                print("  %d/%d" % (done, len(rows)), flush=True)
    print("  %d fetched, %d already present" % (counts["fetched"],
                                                counts["skipped"]))
    if failed:
        for name, why in sorted(failed):
            print("  !! %s: %s" % (name, why))
        raise SystemExit("%d revision(s) could not be fetched. A missing "
                         "revision changes the build, so this is fatal."
                         % len(failed))


def _bswap32(value):
    return int.from_bytes((value & 0xFFFFFFFF).to_bytes(4, "little"), "big")


def _decrypt_bytes(data, md5hex):
    """-> plaintext bytes. md5hex is the 32 hex chars from the file's name."""
    high = int(md5hex[:16], 16)
    low = int(md5hex[16:], 16)
    state = ((high ^ low) * M + C) & MASK

    out = bytearray(data)
    words = len(data) // 4
    pair = ()
    for i in range(words):
        if i % 2 == 0:
            pair = (_bswap32(state >> 32), _bswap32(state))
            state = (state * M + C) & MASK
        word = struct.unpack_from("<I", data, i * 4)[0] ^ pair[i % 2]
        struct.pack_into("<I", out, i * 4, word)

    rest = len(data) - 4 * words
    if rest:
        if words % 2 == 0:
            pair = (_bswap32(state >> 32), _bswap32(state))
            state = (state * M + C) & MASK
        key = pair[words % 2].to_bytes(4, "little")
        for j in range(rest):
            out[4 * words + j] ^= key[j]

    if out:
        out[0] &= 0x7F          # undo the "this file is encrypted" marker
    return bytes(out)


def _plaintext(path, md5hex):
    """-> (plaintext, verified) for one downloaded revision."""
    with open(path, "rb") as fh:
        data = fh.read()
    if data[:1] not in (b"{", b"["):
        data = _decrypt_bytes(data, md5hex)
    return data, hashlib.md5(data).hexdigest() == md5hex


def decrypt(rows):
    """Decrypt data/build/raw into data/build/revisions, verifying each file."""
    os.makedirs(REVISIONS, exist_ok=True)
    verified = kept = 0
    failed = []
    for name, _etag, _length in rows:
        stem, _, want = name.rpartition("-")
        dest = os.path.join(REVISIONS, name + ".json")
        if os.path.exists(dest) and md5_file(dest) == want:
            kept += 1
            continue
        try:
            body, ok = _plaintext(os.path.join(RAW, name), want)
        except OSError as error:
            # Mostly --offline on a tree that was never fetched: report it the
            # same way as a bad decrypt rather than dying on a traceback.
            failed.append((name, error.strerror or str(error)))
            continue
        if not ok:
            failed.append((name, "plaintext md5 mismatch"))
            continue
        with open(dest, "wb") as fh:
            fh.write(body)
        verified += 1
    print("  %d decrypted, %d already present, %d failed"
          % (verified, kept, len(failed)))
    if failed:
        for name, why in failed:
            print("  !! %s: %s" % (name, why))
        raise SystemExit("%d file(s) could not be decrypted." % len(failed))


def run(*command):
    print("  $ python " + " ".join(command), flush=True)
    subprocess.run([sys.executable, os.path.join(TOOLS, command[0])]
                   + list(command[1:]), cwd=ROOT, check=True)


def build():
    """Merge the revisions, then fill the three holes the dump never had."""
    for stale in (SEASON, SEASON_BAK):
        shutil.rmtree(stale, ignore_errors=True)
    run("pick_configs.py",
        "--src", "data/build/revisions", "-o", "data/build/season")
    run("make_space_chapters.py", "data/build/season/SpaceMap")
    run("make_display_enemies.py", "data/build/season")
    run("make_recovered_strings.py",
        "--tsv", "tools/recovered_strings.tsv",
        "--out", "data/build/season/LocalDataRecovered")
    os.makedirs(SEASON_BAK, exist_ok=True)
    for name in sorted(os.listdir(SEASON)):
        if name.endswith(".bak"):
            os.replace(os.path.join(SEASON, name),
                       os.path.join(SEASON_BAK, name))
    print("  %d config file(s) built" % len(os.listdir(SEASON)))


def overlay():
    run("make_event_states.py", "-c", "data/build/season",
        "--real", "data/build/revisions", "-o", "data/build/events.json")


def verify(wanted, root, label):
    ok, bad = compare(wanted, root)
    print("  %d/%d match" % (ok, len(wanted)))
    if bad:
        for path, want, got in bad:
            print("  !! %s\n       want %s\n       got  %s" % (path, want, got))
        raise SystemExit("%s does not match season_manifest.txt. Nothing "
                         "installed." % label)


def install_dir(staged, target):
    """Swap a prepared directory in, keeping the old one until it lands."""
    backup = target + ".old"
    shutil.rmtree(backup, ignore_errors=True)
    if os.path.exists(target):
        os.rename(target, backup)
    os.rename(staged, target)
    shutil.rmtree(backup, ignore_errors=True)


def install():
    for name in RUNTIME_DIRS:
        os.makedirs(os.path.join(DATA, name), exist_ok=True)
    staged = os.path.join(DATA, "configs.new")
    shutil.rmtree(staged, ignore_errors=True)
    shutil.copytree(SEASON, staged)
    install_dir(staged, os.path.join(DATA, "configs"))
    target = os.path.join(DATA, "events.json")
    shutil.copyfile(os.path.join(BUILD, "events.json"), target + ".new")
    os.replace(target + ".new", target)
    print("  installed data/configs and data/events.json")


def step(number, title):
    print("\n[%d/6] %s" % (number, title), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--jobs", type=int, default=8,
                    help="parallel downloads (default 8)")
    ap.add_argument("--clean", action="store_true",
                    help="drop data/build before starting")
    ap.add_argument("--offline", action="store_true",
                    help="build from what is already in data/build/raw")
    ap.add_argument("--verify-only", action="store_true",
                    help="check the installed data/ against the manifest")
    args = ap.parse_args()

    rows = read_revisions()
    wanted = read_manifest()
    configs = {path: digest for path, digest in wanted.items()
               if path.startswith("configs/")}

    if args.verify_only:
        print("verifying data/ against season_manifest.txt")
        verify(wanted, DATA, "data/")
        return 0

    if args.clean:
        shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD, exist_ok=True)
    started = time.time()

    step(1, "fetch %d revisions (%.1f MB)"
         % (len(rows), sum(length for _n, _e, length in rows) / 1e6))
    if args.offline:
        print("  --offline: using data/build/raw as it stands")
    else:
        fetch(rows, args.jobs)

    step(2, "decrypt and verify")
    decrypt(rows)

    step(3, "build the season set")
    build()

    step(4, "verify against season_manifest.txt")
    verify({path[len("configs/"):]: digest for path, digest in configs.items()},
           SEASON, "the built set")

    step(5, "build the event overlay")
    overlay()
    verify({"events.json": wanted["events.json"]}, BUILD, "events.json")

    step(6, "install")
    verify({SAVE_PATH: wanted[SAVE_PATH]}, DATA, "data/" + SAVE_PATH)
    install()

    print("\ndone in %.0fs. data/build/ kept -- re-runs resume from it, "
          "--clean drops it." % (time.time() - started))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
