#!/usr/bin/env python3
"""Build a localization overlay from strings recovered off genuine footage.

213 keys our layouts bind with `local:text` are defined by no config revision
that survives. A missing key makes the client draw the node's NAME instead,
which is why the space screens read `labelEnemies` and `labelMissionDifficulty`.

Where genuine footage shows the real text it goes in `recovered_strings.tsv`
with the frame it came from, and this writes it to `LocalDataRecovered`, a
config of its own. Keeping it separate leaves the genuine configs byte-identical
to what `pick_configs.py` produced, so the overlay survives a rebuild.

RECONSTRUCTED data, not server-sourced.

Usage:
    python make_recovered_strings.py
"""

import argparse
import io
import json
import os

TSV = os.path.join("tools", "recovered_strings.tsv")
OUT = os.path.join("data", "build", "season", "LocalDataRecovered")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tsv", default=TSV)
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    rows = {}
    for line in io.open(args.tsv, encoding="utf-8"):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 2:
            raise SystemExit(f"malformed row: {line!r}")
        key, value = parts[0], parts[1]
        if key in rows:
            raise SystemExit(f"duplicate key: {key!r}")
        source = parts[2] if len(parts) > 2 else ""
        rows[key] = (value, source)

    print(f"  {len(rows)} recovered string(s)")
    for key, (value, source) in sorted(rows.items()):
        print(f"    {key:34s} {value!r}   {os.path.basename(source)}")

    doc = {"LocalData": {k: {"en_US": v} for k, (v, _) in rows.items()}}
    with open(args.out, "w", encoding="utf-8") as out:
        json.dump(doc, out, indent=1)
    print(f"  wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
