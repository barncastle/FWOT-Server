#!/usr/bin/env python3
"""Merge every revision of every config into one set the client can load.

The recovered dump holds 956 config files -- 127 distinct configs, most with
several revisions, named `<Name>-<md5 of plaintext>`. Nothing in a name says
which was live when: the md5 is of the content, the dump's timestamps are
identical within a config, and only 17 configs embed a usable date.

Serving one revision per config is therefore a guess, and a costly one --
configs reference each other constantly (a Goal names a Reward, a Reward names
a Currency and a Material) and this engine treats a dangling reference as fatal.
So take the union instead: every revision of a config merged into one document,
highest-ranked revision winning a collision. Extra entries nobody asks for are
inert; a missing one is not.

`restore_bribe_rows` then repairs the ten rows the merge ranks wrongly, each
taken whole from a genuine revision.

Usage:
    python pick_configs.py -o data/build/season
"""

import argparse
import collections
import io
import json
import os
import re

SRC = "data/build/revisions"

# Fields whose value is an entry id, keyed by the config section that owns it.
ID_FIELDS = ("id", "goal-id", "objective-id", "rewardID", "reward-id",
             "currencyId", "stepId", "groundId", "playspaceId", "mapId",
             "fallbackAction", "furnitureID", "rarity")

def load(path):
    with io.open(path, encoding="utf-8") as fh:
        return json.load(fh)


def entries(section):
    if isinstance(section, dict):
        return list(section.items())
    if isinstance(section, list):
        out = []
        for item in section:
            if not isinstance(item, dict):
                continue
            for field in ID_FIELDS:
                if field in item and isinstance(item[field], str):
                    out.append((item[field], item))
                    break
            else:
                # Sections like FUSounds' Playlist key their entries on their
                # own `*Id` field rather than a plain `id`.
                for field, value in item.items():
                    if (isinstance(value, str)
                            and re.search(r"[a-z](Id|ID)$", field)):
                        out.append((value, item))
                        break
        return out
    return []


def defines(doc):
    """-> set of ids this config defines."""
    out = set()
    if not isinstance(doc, dict):
        return out
    for section in doc.values():
        for key, _value in entries(section):
            out.add(key)
    return out


# Fields that HAND a material to the player, and the one field that DEMANDS
# one. Deliberately narrow: `requiredMaterialId` is the only demand of this
# shape in the corpus, on the 12 district rows.
GRANT_FIELDS = ("materialId", "outputMaterialId")
NEED_FIELDS = ("requiredMaterialId",)


def field_values(doc, fields):
    """-> set of string values stored under any of `fields`, at any depth."""
    out = set()

    def take(value):
        if isinstance(value, str):
            out.add(value)
        elif isinstance(value, list):
            for sub in value:
                take(sub)

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key in fields:
                    take(value)
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    walk(doc)
    return out


def unobtainable(doc, obtainable):
    """How many things this revision demands that nothing anywhere grants.

    Defined is not the same as obtainable: `artifact_D7F` has a full
    `Materials` row but no `Reward` grants it, which leaves the district that
    asks for it permanently shut.
    """
    return sum(1 for need in field_values(doc, NEED_FIELDS)
               if need not in obtainable)


def rank(rev, obtainable):
    """Sort key for merge order; the LAST revision wins a collision.

    Primary key is how many ids the revision defines -- coverage first. Ties
    are the problem: both `Districts` revisions define exactly 8 ids, `sorted`
    is stable, so the winner fell through to filename order, which is md5
    order, which picked the broken one. Break the tie on obtainability instead,
    preferring the revision that demands fewer things nothing can grant.
    Negated because the last revision in the order wins.
    """
    return (len(rev["defines"]), -unobtainable(rev["doc"], obtainable))


BRIBE_FIELDS = ("briberyId", "eventBribeId")


def restore_bribe_rows(docs, catalogue, obtainable=frozenset()):
    """Give every orphaned district bribe goal back the Character row that uses it.

    merge() settles a Character collision by revision rank, and rank is
    coverage first. Coverage cannot see what a ROW is for: a revision that
    defines one more id outranks the one where a district is released, and
    overwrites that character with his pre-release row. The merged Goals still
    ship the bribe, with no Character pointing at it, and the character is left
    unreachable behind a predicate nothing can satisfy.

    The rule: a district bribe goal (isBribe, districtId a real district) that
    the merged set defines and no merged Character references is a merge fault.
    If some revision of the same config holds a row for that character that DOES
    reference it, that row wins -- taken whole, so the served row is still
    byte-identical to a genuine one. Among several such rows the highest-ranked
    revision's wins, as in merge(). Nothing else moves.

    Event packs are included: their bribe goals carry district ids too, and
    eight of them are orphaned the same way.

    -> (swaps, still_orphaned)
    """
    districts, goals, referenced = set(), {}, set()
    for doc in docs.values():
        if not isinstance(doc, dict):
            continue
        districts.update(key for key, _ in entries(doc.get("Districts")))
        for gid, row in entries(doc.get("Goals")):
            if isinstance(row, dict) and row.get("isBribe"):
                goals.setdefault(gid, row.get("districtId"))
        for _cid, row in entries(doc.get("Character")):
            if isinstance(row, dict):
                referenced.update(row[f] for f in BRIBE_FIELDS if row.get(f))
    orphans = {g for g, d in goals.items() if d in districts and g not in referenced}
    swaps = []
    for name in sorted(docs):
        merged = docs[name].get("Character") if isinstance(docs[name], dict) else None
        if not isinstance(merged, dict) or not orphans:
            continue
        winner = {}
        for rev in sorted(catalogue[name].values(), key=lambda r: rank(r, obtainable)):
            rows = rev["doc"].get("Character") if isinstance(rev["doc"], dict) else None
            for cid, row in (rows.items() if isinstance(rows, dict) else ()):
                if cid in merged and isinstance(row, dict):
                    hit = {row.get(f) for f in BRIBE_FIELDS} & orphans
                    if hit:
                        winner[cid] = (row, rev["file"], hit)
        for cid, (row, source, hit) in sorted(winner.items()):
            if merged[cid] != row:
                merged[cid] = row
                swaps.append((name, cid, source, sorted(hit)))
            orphans -= hit
    return swaps, orphans


def merge(revisions, obtainable=frozenset()):
    """Union every revision of one config into a single document.

    Revisions of the same config DIVERGE rather than accumulate: the 47-entry
    `CharacterSkins` revisions dropped `hubert-nude`, which only the 46-entry
    ones define, while adding entries of their own. No single revision is a
    superset, so picking one always leaves some lookup unsatisfiable -- and the
    engine treats an unsatisfied lookup as fatal ("Config empty for id X in Y").

    The client only ever looks ids up, and an entry nothing asks for is inert,
    so the union is strictly safer to serve than any one revision. Smaller
    revisions are merged first so that richer definitions of the same id win.

    This is deliberately NOT historical fidelity: a merged config never
    shipped. It is the difference between a set that runs and a set that is
    authentic, and we want the former.
    """
    order = sorted(revisions.values(), key=lambda r: rank(r, obtainable))
    # A few configs (ContentPack, AnalyticEvents) are a bare JSON array rather
    # than an object of sections. There is nothing to key those on, so take the
    # richest revision whole.
    if any(isinstance(r["doc"], list) for r in order):
        return max(order, key=lambda r: len(json.dumps(r["doc"])))["doc"]
    # `id` is not always unique inside a section: CombatStatLevels has one row
    # per (id, outfitLevel), and keying on id alone would collapse 6 outfits x
    # 60 levels into 6 rows. Decide per section, from the data.
    unique = {}
    for rev in order:
        if not isinstance(rev["doc"], dict):
            continue
        for section, value in rev["doc"].items():
            if not isinstance(value, list):
                continue
            keys = [next((item[f] for f in ID_FIELDS
                          if isinstance(item.get(f), str)), None)
                    for item in value if isinstance(item, dict)]
            named = [k for k in keys if k is not None]
            ok = bool(named) and len(set(named)) == len(keys)
            unique[section] = unique.get(section, True) and ok

    out = {}
    for rev in order:
        for section, value in rev["doc"].items():
            if isinstance(value, dict):
                out.setdefault(section, {})
                if isinstance(out[section], dict):
                    out[section].update(value)
            elif isinstance(value, list):
                bucket = out.setdefault(section, {})
                if not isinstance(bucket, dict):
                    continue
                # A section with no id field is POSITIONAL, and two rows may
                # be byte-identical -- CrewSlot opens two slots with the same
                # {"slotPredicate": "true"}. Keying on contents would collapse
                # the pair and silently lose a slot, so count occurrences.
                repeats = collections.Counter()
                for item in value:
                    key = None
                    if isinstance(item, dict) and unique.get(section):
                        key = next((item[f] for f in ID_FIELDS
                                    if isinstance(item.get(f), str)), None)
                    if key is None:
                        text = json.dumps(item, sort_keys=True)
                        repeats[text] += 1
                        key = f"{text}#{repeats[text]}"
                    bucket[key] = item
            else:
                out[section] = value
    # Restore each section to the container shape the client expects: whichever
    # the revisions themselves used.
    shaped = {}
    for section, bucket in out.items():
        was_list = any(isinstance(r["doc"].get(section), list)
                       for r in revisions.values())
        shaped[section] = list(bucket.values()) if (was_list and isinstance(bucket, dict)) else bucket
    return shaped


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=SRC)
    ap.add_argument("-o", "--out", required=True,
                    help="write the merged set here")
    args = ap.parse_args()

    catalogue = collections.defaultdict(dict)
    for filename in sorted(os.listdir(args.src)):
        if not filename.endswith(".json"):
            continue
        stem, _, md5 = filename[:-5].rpartition("-")
        doc = load(os.path.join(args.src, filename))
        catalogue[stem][md5] = {"file": filename, "doc": doc,
                                "defines": defines(doc)}
    names = sorted(catalogue)
    multi = [n for n in names if len(catalogue[n]) > 1]
    print("%d configs, %d with more than one revision, %d files"
          % (len(names), len(multi),
             sum(len(v) for v in catalogue.values())))

    os.makedirs(args.out, exist_ok=True)
    # Obtainability is judged against the set we actually SERVE, which is the
    # union of every revision -- a material granted by any of them is grantable
    # in the merged set.
    obtainable = set()
    for name in names:
        for rev in catalogue[name].values():
            obtainable |= field_values(rev["doc"], GRANT_FIELDS)
    docs = {name: merge(catalogue[name], obtainable) for name in names}
    for name in names:
        revs = catalogue[name]
        if len(revs) < 2:
            continue
        scores = {unobtainable(r["doc"], obtainable) for r in revs.values()}
        if len(scores) > 1:
            print("  %s: revisions differ on obtainability %s -- "
                  "tie-break applied" % (name, sorted(scores)))

    swaps, orphans = restore_bribe_rows(docs, catalogue, obtainable)
    for name, cid, source, hit in swaps:
        print("  %s: %s row taken from %s (it references %s, which nothing "
              "else does)" % (name, cid, source, ", ".join(hit)))
    if orphans:
        print("  district bribe goal(s) no revision's Character row "
              "references: %s" % ", ".join(sorted(orphans)))

    for name, doc in docs.items():
        with io.open(os.path.join(args.out, name), "w",
                     encoding="utf-8") as fh:
            json.dump(doc, fh, indent=1)
    print("merged %d config(s) into %s, %d ids defined"
          % (len(names), args.out, sum(len(defines(d)) for d in docs.values())))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
