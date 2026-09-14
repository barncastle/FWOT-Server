#!/usr/bin/env python3
"""Synthesise the SpaceChapter config section from SpaceMap missions.

The planet select screen does not enumerate SpacePlanet. It walks every
SpaceChapter row, skips the ones whose `hidePredicate` is true, and builds one
cell per distinct `planetId`. No revision of any config publishes the section,
so without this the screen is an empty starfield -- no log line, no asset
request.

Reconstructed here as one chapter per planet, holding that planet's missions in
mapId order, with the planet's own name, description and predicates.

RECONSTRUCTED data, not server-sourced.

Usage:
    python make_space_chapters.py data/build/season/SpaceMap
"""

import argparse
import collections
import re
import json
import os
import shutil

# A hidePredicate of the constant `true` retires a row: it can never be shown.
RETIRED = "true"

# The two event gates. A promo-gated row belongs to that event's own config.
EVENT = "isTimedPromoActive("
EVENT_ACTIVE = "isInEvent("

# The Daily Planet rotates at the CHAPTER, not by rewriting one chapter's
# missionIds daily: one chapter per weekday, selected by its own hidePredicate.
ROTATION = "dayOfWeekIs("

# An event's missions sit on EXISTING planets, gated by a MISSION
# hidePredicate that the client never evaluates -- so folding them into the
# planet's own chapter would show them all year. Replacing that chapter, as
# ROTATION does, would leave the planet with no chapter out of season, which
# asserts. They get a SUPPLEMENTARY chapter instead, carrying the event's own
# predicate, and the planet keeps its ordinary chapter unconditionally.
#
# These name that chapter from the event's authored string, or from the
# planet's own name for packs that gate on a promo with no Event row.
EVENT_ID = re.compile(r'isInEvent\(\s*"([^"]+)"')
PROMO_ID = re.compile(r'isTimedPromoActive\(\s*"([^"]+)"')


def sections(path):
    """Merge the Space* sections the way the client does: across EVERY config.

    `SpaceMap` is not one file's section -- DailyMissions publishes 27 more
    rows into it -- so building from the SpaceMap file alone leaves a planet
    with no chapter, which asserts the moment it is opened.
    """
    merged = {"SpaceMap": {}, "SpacePlanet": {}, "Event": {}}
    directory = os.path.dirname(os.path.abspath(path))
    for name in sorted(os.listdir(directory)):
        full = os.path.join(directory, name)
        if not os.path.isfile(full) or name.endswith(".bak"):
            continue
        try:
            doc = json.load(open(full, encoding="utf-8"))
        except Exception:                                        # noqa: BLE001
            continue
        if not isinstance(doc, dict):
            continue
        for key in merged:
            for row_id, row in (doc.get(key) or {}).items():
                # first publisher wins, as in the client's merge
                merged[key].setdefault(row_id, row)
    return merged


def chapter(chapter_id, planet, order, missions, planet_config, hide,
            name=None):
    return {
        "chapterId": chapter_id,
        "planetId": planet,
        "displayOrder": order,
        "missionIds": sorted(missions),
        # The cell reads "1. Mars Story Missions": the client supplies the
        # number, this key the rest. make_recovered_strings.py defines them.
        "name": name or f"FUT_CHAPTER_NAME_{planet}",
        "description": planet_config.get("description", ""),
        "lockedDescription": planet_config.get("lockedDescription", ""),
        "icon": planet_config.get("icon", ""),
        "lockPredicate": planet_config.get("lockPredicate", ""),
        "hidePredicate": hide,
        "permanent": True,
    }


def build(config):
    """-> {chapterId: chapter}, doing the filtering the client will not."""
    maps = config.get("SpaceMap", {})
    planets = config.get("SpacePlanet", {})

    base = collections.defaultdict(list)          # planet -> always-listed rows
    rotation = collections.defaultdict(lambda: collections.defaultdict(list))
    supplement = collections.defaultdict(lambda: collections.defaultdict(list))
    dropped = []
    for entry in maps.values():
        planet = entry.get("planetId")
        if planet is None:
            continue
        hide = entry.get("hidePredicate") or ""
        if hide == RETIRED:
            dropped.append((planet, entry["mapId"], entry.get("name", "")))
        elif EVENT_ACTIVE in hide or EVENT in hide:
            supplement[planet][hide].append(entry["mapId"])
        elif ROTATION in hide:
            rotation[planet][hide].append(entry["mapId"])
        else:
            base[planet].append(entry["mapId"])
    for planet, map_id, name in sorted(dropped):
        print(f"    dropped retired: planet {planet:>2}  {map_id}  {name}")

    # eventId -> the event's display-name key, for naming its chapter
    event_names = {}
    for row in (config.get("Event") or {}).values():
        if isinstance(row, dict) and row.get("eventId"):
            name = row.get("local:name")
            event_names[row["eventId"]] = name
            # ...and by the promo that drives it, for the packs gated directly
            if row.get("timedPromoId"):
                event_names[row["timedPromoId"]] = name

    chapters = {}
    order = 0
    for planet in sorted(set(base) | set(rotation)):
        planet_config = planets.get(str(planet), {})
        days = rotation.get(planet, {})
        if not days:
            order += 1
            # chapterId shares the planet's numbering so the two stay legible
            chapters[str(planet * 100 + 1)] = chapter(
                planet * 100 + 1, planet, order, base[planet], planet_config,
                planet_config.get("hidePredicate", ""))
            continue
        # One chapter per weekday, holding that day's rows plus the planet's
        # always-on ones. Exactly one is ever visible, so it still reads "1.".
        for index, (hide, ids) in enumerate(sorted(days.items()), start=1):
            order += 1
            chapter_id = planet * 100 + index
            chapters[str(chapter_id)] = chapter(
                chapter_id, planet, order, base[planet] + ids, planet_config, hide)

    # Supplementary chapters last, so they sort after the planet's own.
    for planet in sorted(supplement):
        planet_config = planets.get(str(planet), {})
        for index, (hide, ids) in enumerate(sorted(supplement[planet].items()),
                                            start=1):
            order += 1
            chapter_id = planet * 100 + 50 + index
            # Name it from the event, else the planet's own authored name.
            # If neither resolves, chapter() falls back to
            # FUT_CHAPTER_NAME_<planet>, which only the base planets define --
            # an event planet would draw that raw key on screen. Every pack
            # resolves today.
            match = EVENT_ID.search(hide) or PROMO_ID.search(hide)
            name = ((event_names.get(match.group(1)) if match else None)
                    or planet_config.get("name"))
            chapters[str(chapter_id)] = chapter(
                chapter_id, planet, order, ids, planet_config, hide, name)
    return chapters


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config")
    args = ap.parse_args()

    config = json.load(open(args.config, encoding="utf-8"))
    merged = sections(args.config)
    chapters = build(merged)

    print(f"  {len(chapters)} chapter(s) from {len(merged.get('SpaceMap', {}))} "
          f"mission(s) across every config")
    for key in sorted(chapters, key=int):
        entry = chapters[key]
        print(f"    {key:>5}  planet {entry['planetId']:>2}  "
              f"{entry['name']:24s} missions {entry['missionIds']}"
              f"{'  hide=' + entry['hidePredicate'] if entry['hidePredicate'] else ''}")

    existing = config.get("SpaceChapter")
    if existing:
        print(f"  replacing an existing SpaceChapter section ({len(existing)} entries)")
    shutil.copy2(args.config, args.config + ".bak")
    config["SpaceChapter"] = chapters
    with open(args.config, "w", encoding="utf-8") as out:
        json.dump(config, out, indent=1)
    print(f"  wrote {args.config}  (backup at {args.config}.bak)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
