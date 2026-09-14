#!/usr/bin/env python3
"""Build the event-state overlay for a served config set.

An event character's bribe goal carries a failurePredicate -- isInEvent(...),
isTimedPromoActive(...) -- that is false once his event is over. The served set
carries the event-ON row, with briberyId, all year, so a mystery-box copy of
him used after the event spawns in bribe mode, fails the bribe within ten
seconds and departs.

Most of these rows also exist in an event-OFF state: genuine revisions of the
same pack where the row is identical except that it lacks briberyId, and for
AMC / bk / pod / sh2 buildingId too, their buildings then carrying no
characterId. The server serves ON while the character's event window is open
and OFF while it is closed. Nothing is authored -- both sides are genuine rows,
and each entry records the revision it came from.

What goes in:

    bribe characters  every TownCharacter whose briberyId names a goal with a
                      single-gate failurePredicate. EVERY served file defining
                      the row gets an entry: the client deep-merges rows across
                      files and appends absent keys, so a bribe left in one
                      file would survive.
    their placeables  when OFF drops buildingId B, B's row with and without
                      characterId.
    SPECIAL           three rows whose two sides differ by more than the bribe
                      fields, listed explicitly below.

Characters with no genuine OFF row are excluded and reported, never authored.

Gates are promo ids; isInEvent("E") resolves through Event[E].timedPromoId. The
server matches them against its own shifted TimedPromo windows, and cannot
evaluate a promo's player-side predicate.

Usage:
    python make_event_states.py                       # season set
    python make_event_states.py -c data/build/season -o data/build/events.json
"""

import argparse
import glob
import json
import os
import re
import sys

PLACE_SECTIONS = ("RentBuilding", "Decoration", "EventRentBuilding")
GATE_RE = re.compile(r'^\s*(isInEvent|isTimedPromoActive)\("([^"]+)"\)\s*$')
OFF_FIELDS = ("briberyId", "buildingId")        # the only keys OFF may lack

# Rows whose two sides differ by more than the bribe fields, so the rule below
# will not pair them. One side is named here, the other is the served row.
# Nothing gets in by rule; promo None means the character's own bribe gate.
SPECIAL = {
    "slurms": {"promo": "slurm_promo", "rows": [
        ("Characters", "Character", "slurms", "on", "Characters-f4ec6790")]},
    "pazuzu": {"promo": None, "rows": [
        ("hw_characters", "Character", "pazuzu", "off", "hw_characters-1c17eb5c")]},
    "monique": {"promo": None, "rows": [
        ("AMC_Event", "Character", "monique", "off", "AMC_Event-5003c14e"),
        ("AMC_Event", "RentBuilding", "amc_genericPyramid", "off",
         "AMC_Event-5003c14e")]},
}


def load_dir(directory):
    docs = {}
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path):
            continue
        try:
            doc = json.load(open(path, encoding="utf-8"))
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(doc, dict):
            docs[name] = doc
    return docs


def revisions(real, name):
    """-> [(revision name, doc)] of one config in the dump, sorted."""
    out = []
    for path in sorted(glob.glob(os.path.join(real, name + "-*.json"))):
        stem = os.path.basename(path)[:-5]
        if stem.rpartition("-")[0] != name:
            continue
        try:
            out.append((stem, json.load(open(path, encoding="utf-8"))))
        except (ValueError, UnicodeDecodeError):
            pass
    return out


def rows(doc, section):
    value = doc.get(section) if isinstance(doc, dict) else None
    return value if isinstance(value, dict) else {}


def promo_ids(docs):
    ids = set()
    for doc in docs.values():
        value = doc.get("TimedPromo")
        items = value.values() if isinstance(value, dict) else (value or [])
        for row in items:
            if isinstance(row, dict) and row.get("id"):
                ids.add(row["id"])
        if isinstance(value, dict):
            ids.update(value.keys())
    return ids


def resolve_gate(pred, docs, promos):
    m = GATE_RE.match(pred or "")
    if not m:
        return None, f"failurePredicate not a single gate: {pred!r}"
    kind, arg = m.groups()
    if kind == "isTimedPromoActive":
        promo = arg
    else:
        promo = None
        for doc in docs.values():
            for row in rows(doc, "Event").values():
                if isinstance(row, dict) and row.get("eventId") == arg:
                    promo = row.get("timedPromoId")
        if not promo:
            return None, f"isInEvent({arg!r}): no Event row with a timedPromoId"
    if promo not in promos:
        return None, f"promo {promo!r} is not published by the set"
    return promo, None


def off_candidate(on, real_revs, section, rid):
    """-> (row, revision, dropped keys) or (None, None, reason)."""
    found = {}
    for rev, doc in real_revs:
        row = rows(doc, section).get(rid)
        if not isinstance(row, dict) or row.get("briberyId"):
            continue
        dropped = tuple(sorted(k for k in on if k not in row))
        if not dropped or not set(dropped) <= set(OFF_FIELDS):
            continue
        if row != {k: v for k, v in on.items() if k not in dropped}:
            continue
        key = json.dumps(row, sort_keys=True)
        if key in found:
            found[key][1].append(rev)
        else:
            found[key] = (row, [rev], dropped)
    if not found:
        return None, None, "no genuine revision lacks only " + "/".join(OFF_FIELDS)
    if len(found) > 1:
        return None, None, "several different clean OFF rows"
    row, revs, dropped = next(iter(found.values()))
    return row, short(revs), dropped


def short(revs):
    """'pod_event-a09bb79d...' x2 -> 'pod_event-a09bb79d,eb45aa26'."""
    name = revs[0].rpartition("-")[0]
    return name + "-" + ",".join(r.rpartition("-")[2][:8] for r in revs)


def placeable_states(served, real, bid, cid):
    """-> [entry] giving B's row with (ON) and without (OFF) characterId."""
    out, problems = [], []
    for name, doc in served.items():
        for section in PLACE_SECTIONS:
            row = rows(doc, section).get(bid)
            if not isinstance(row, dict):
                continue
            base = {k: v for k, v in row.items() if k != "characterId"}
            on_revs, off_revs = [], []
            revs = dict(revisions(real, name))
            for rev, rdoc in revs.items():
                g = rows(rdoc, section).get(bid)
                if not isinstance(g, dict):
                    continue
                if g.get("characterId") == cid and \
                        {k: v for k, v in g.items() if k != "characterId"} == base:
                    on_revs.append(rev)
                if g == base:
                    off_revs.append(rev)
            # both rows must exist verbatim in the dump -- the served one too
            if not on_revs or not off_revs:
                problems.append(f"{bid} in {name}: no genuine "
                                f"{'ON' if not on_revs else 'OFF'} row "
                                f"differing only by characterId")
                continue
            # the genuine rows themselves, key order and all
            on = rows(revs[on_revs[0]], section)[bid]
            off = rows(revs[off_revs[0]], section)[bid]
            out.append({"file": name, "section": section, "id": bid,
                        "on": on, "off": off,
                        "on_source": short(on_revs), "off_source": short(off_revs),
                        "served": "on" if row.get("characterId") == cid else "off"})
    return out, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-c", "--configs", default="data/build/season")
    ap.add_argument("--real", default="data/build/revisions")
    ap.add_argument("-o", "--out", default=None)
    args = ap.parse_args()
    out_path = args.out or args.configs.rstrip("/\\") + ".events.json"

    served = load_dir(args.configs)
    promos = promo_ids(served)
    goals = {}
    for doc in served.values():
        for gid, g in rows(doc, "Goals").items():
            goals.setdefault(gid, g)

    # every served file that defines each TownCharacter row
    defined = {}
    for name, doc in served.items():
        for cid, row in rows(doc, "Character").items():
            if isinstance(row, dict):
                defined.setdefault(cid, []).append(name)
    town = {cid for cid, names in defined.items()
            if any(rows(served[n], "Character")[cid].get("class")
                   == "TownCharacter" for n in names)}

    entries, excluded, gates, not_event = [], [], {}, []
    for cid in sorted(town):
        bribes = {rows(served[n], "Character")[cid].get("briberyId")
                  for n in defined[cid]} - {None}
        if cid in SPECIAL or not bribes:
            continue
        if len(bribes) > 1:
            excluded.append({"character": cid, "reason": f"briberyIds {sorted(bribes)}"})
            continue
        bribe = bribes.pop()
        goal = goals.get(bribe)
        if not isinstance(goal, dict):
            excluded.append({"character": cid, "reason": f"{bribe} not served"})
            continue
        if not goal.get("failurePredicate"):
            not_event.append(cid)             # a base bribe; no event gates it
            continue
        promo, err = resolve_gate(goal.get("failurePredicate"), served, promos)
        if err:
            excluded.append({"character": cid, "reason": f"{bribe}: {err}"})
            continue
        mine, dropped_all, why = [], set(), None
        for name in defined[cid]:
            on = rows(served[name], "Character")[cid]
            if not any(k in on for k in OFF_FIELDS):
                continue                      # this file carries no bribe state
            real_revs = revisions(args.real, name)
            off, rev, dropped = off_candidate(on, real_revs, "Character", cid)
            if off is None:
                why = f"{name}: {dropped}"
                break
            same = [r for r, d in real_revs if rows(d, "Character").get(cid) == on]
            if not same:
                why = f"{name}: the served row is in no genuine revision"
                break
            dropped_all |= set(dropped)
            mine.append({"file": name, "section": "Character", "id": cid,
                         "on": on, "off": off, "on_source": short(same),
                         "off_source": rev, "served": "on"})
        if why:
            excluded.append({"character": cid, "reason": why})
            continue
        if "buildingId" in dropped_all:
            bids = {e["on"].get("buildingId") for e in mine} - {None}
            for bid in sorted(bids):
                places, problems = placeable_states(served, args.real, bid, cid)
                if problems:
                    why = "; ".join(problems)
                mine += places
        if why:
            excluded.append({"character": cid, "reason": why})
            continue
        for e in mine:
            e.update(gate=promo, character=cid)
        entries += mine
        gates.setdefault(promo, {"predicate": goal.get("failurePredicate"),
                                 "characters": []})["characters"].append(cid)

    for cid, spec in SPECIAL.items():
        promo, pred = spec["promo"], "SPECIAL"
        if promo is None:
            bribe = next((rows(served[n], "Character")[cid].get("briberyId")
                          for n in defined.get(cid, ())), None)
            pred = (goals.get(bribe) or {}).get("failurePredicate")
            promo, err = resolve_gate(pred, served, promos)
            if err:
                excluded.append({"character": cid, "reason": f"SPECIAL: {err}"})
                continue
        elif promo not in promos:
            excluded.append({"character": cid, "reason": f"promo {promo} not published"})
            continue
        mine, why = [], None
        for name, section, rid, side, revision in spec["rows"]:
            served_row = rows(served[name], section).get(rid)
            real_revs = revisions(args.real, name)
            named = [d for r, d in real_revs if r.startswith(revision)]
            named_row = rows(named[0], section).get(rid) if named else None
            if not isinstance(served_row, dict) or not isinstance(named_row, dict):
                why = f"SPECIAL {name}/{section}/{rid}: row not found"
                break
            same = [r for r, d in real_revs if rows(d, section).get(rid) == served_row]
            if not same:
                why = f"SPECIAL {name}/{section}/{rid}: served row is in no genuine revision"
                break
            other = "off" if side == "on" else "on"
            mine.append({"gate": promo, "character": cid, "file": name,
                         "section": section, "id": rid,
                         side: named_row, other: served_row,
                         side + "_source": revision,
                         other + "_source": short(same), "served": other})
        if why:
            excluded.append({"character": cid, "reason": why})
            continue
        entries += mine
        gates.setdefault(promo, {"predicate": pred, "characters": []}
                         )["characters"].append(cid)

    # no id may be claimed by two gates
    seen = {}
    for e in entries:
        key = (e["file"], e["section"], e["id"])
        if key in seen and seen[key] != e["gate"]:
            raise SystemExit(f"{key} claimed by {seen[key]} and {e['gate']}")
        seen[key] = e["gate"]

    overlay = {"base": os.path.basename(os.path.normpath(args.configs)),
               "source": os.path.basename(os.path.normpath(args.real)),
               "gates": gates, "entries": entries, "excluded": excluded}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(overlay, fh, indent=1, ensure_ascii=False)
        fh.write("\n")

    print(f"{out_path}: {len(entries)} row(s), {len(gates)} gate(s)")
    for promo, g in sorted(gates.items()):
        print(f"  {promo:32s} {', '.join(sorted(g['characters']))}")
    for e in entries:
        diff = sorted(k for k in set(e["on"]) | set(e["off"])
                      if e["on"].get(k) != e["off"].get(k))
        print(f"    {e['file']:20s} {e['section']:12s} {e['id']:30s} "
              f"on={e['on_source']:30s} off={e['off_source']:30s} {','.join(diff)}")
    print(f"not event-gated (base bribes, no failurePredicate): {len(not_event)}")
    print(f"excluded: {len(excluded)}")
    for x in excluded:
        print(f"  {x['character']:20s} {x['reason']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
