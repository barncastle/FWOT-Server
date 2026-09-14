#!/usr/bin/env python3
"""Reconstruct the `displayEnemies` field on every SpaceMap row.

The mission detail panel sizes its ENEMIES table from a `displayEnemies` vector
of Combatant ids on the SpaceMap row. No revision of any config carries the
field, so the panel draws the header over nothing. It is derived here from what
the mission actually fights:

    SpaceNode(mapId, minigameType == 2).minigameId
      -> Combat.id
      -> Combat.pools[][]                (scenario ids)
      -> CombatScenario.enemies[]        (Combatant ids)

Duplicates are dropped by LOCALISED NAME, not by id: a mission commonly fields
two statted variants of one creature and the panel showed it once. Order is
ascending Combatant id, and the list is capped at four, which is all the table
can draw.

RECONSTRUCTED data, not server-sourced.

Usage:
    python make_display_enemies.py data/build/season
"""

import argparse
import json
import os
import shutil

COMBAT_MINIGAME = 2

SLOTS = 4                       # enemiesTable draws one row of four cells


def load_all(directory):
    """-> {filename: parsed}, skipping backups and anything that is not a dict."""
    docs = {}
    for name in sorted(os.listdir(directory)):
        path = os.path.join(directory, name)
        if not os.path.isfile(path) or name.endswith(".bak"):
            continue
        try:
            doc = json.load(open(path, encoding="utf-8"))
        except Exception:                                        # noqa: BLE001
            continue
        if isinstance(doc, dict):
            docs[name] = doc
    return docs


def merge(docs, section):
    """Merge one section across every config, first publisher winning."""
    out = {}
    for doc in docs.values():
        for row_id, row in (doc.get(section) or {}).items():
            out.setdefault(row_id, row)
    return out


def display_name(combatant, strings):
    """What the player sees, falling back to the raw key then the id."""
    key = combatant.get("name")
    entry = strings.get(key)
    if isinstance(entry, dict):
        for value in entry.values():
            if value:
                return value
    return key or str(combatant.get("id"))


def derive(map_id, nodes, combats, scenarios):
    """-> Combatant ids this mission can field, in first-seen order."""
    found = []
    mission_nodes = [n for n in nodes.values()
                     if n.get("mapId") == map_id
                     and n.get("minigameType") == COMBAT_MINIGAME]
    for node in sorted(mission_nodes, key=lambda n: n["nodeId"]):
        battle = combats.get(str(node["minigameId"]))
        if not battle:
            continue
        for pool in battle.get("pools", []):
            for scenario_id in pool:
                scenario = scenarios.get(str(scenario_id))
                if not scenario:
                    continue
                for enemy in scenario.get("enemies", []):
                    if enemy not in found:
                        found.append(enemy)
    return found


def curate(ids, combatants, strings):
    """Ascending id, one entry per distinct localised name, capped to the row."""
    seen = set()
    out = []
    for enemy in sorted(ids):
        row = combatants.get(str(enemy))
        if not row:
            continue
        name = display_name(row, strings)
        if name in seen:
            continue
        seen.add(name)
        out.append(enemy)
        if len(out) >= SLOTS:
            break
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("config_dir")
    args = ap.parse_args()

    docs = load_all(args.config_dir)
    nodes = merge(docs, "SpaceNode")
    combats = merge(docs, "Combat")
    scenarios = merge(docs, "CombatScenario")
    combatants = merge(docs, "Combatant")
    strings = merge(docs, "LocalData")

    touched = {}
    empty = []
    for filename, doc in docs.items():
        rows = doc.get("SpaceMap")
        if not rows:
            continue
        for map_id, row in rows.items():
            enemies = curate(derive(int(map_id), nodes, combats, scenarios),
                             combatants, strings)
            if not enemies:
                empty.append((filename, map_id, row.get("name", "")))
                continue
            row["displayEnemies"] = enemies
            touched.setdefault(filename, 0)
            touched[filename] += 1

    for filename, count in sorted(touched.items()):
        print(f"  {filename}: {count} SpaceMap row(s) given displayEnemies")
    for filename, map_id, name in empty:
        print(f"  NO COMBAT: {filename} {map_id} {name} -- left without the field")

    for filename in touched:
        path = os.path.join(args.config_dir, filename)
        shutil.copy2(path, path + ".bak")
        with open(path, "w", encoding="utf-8") as out:
            json.dump(docs[filename], out, indent=1)
        print(f"  wrote {path}  (backup at {path}.bak)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
