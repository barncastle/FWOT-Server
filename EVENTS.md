# Event calendar

The 2017-18 event season replayed on the real calendar. At startup the server
shifts every `TimedPromo` window by one shared offset of a whole number of
years, the fewest that keep the season's last window (22 February 2018) from
being in the past. Each event keeps its authored month, day and order:
Halloween in October, Christmas over Christmas.

**All times UTC.** The game checks these against the clock the server sends, not
the device's, so UTC is the authoritative form.

Dates shown are for the 2026-27 season; each later season falls on the same
dates a year on.

| event | name | opens (UTC) | closes (UTC) | days | promos |
|---|---|---|---|---|---|
| `WeekendEvents` |  | Sun 28 Jun 2026 10:00 | Sat 01 Aug 2026 22:00 | 34 | 7 |
| `FeaturedModal` |  | Tue 30 Jun 2026 07:00 | Mon 20 Jul 2026 22:00 | 20 | 5 |
| `invasion_event` | Episode 1: Lrrr Strikes Back | Sun 02 Aug 2026 18:26 | Mon 31 Aug 2026 22:00 | 29 | 4 |
| `AMC_Event` |  | Mon 31 Aug 2026 22:00 | Mon 07 Sep 2026 22:00 | 7 | 1 |
| `bk_event` |  | Mon 07 Sep 2026 22:00 | Mon 14 Sep 2026 22:00 | 7 | 8 |
| `pod_event` |  | Sun 13 Sep 2026 22:00 | Sun 20 Sep 2026 22:00 | 7 | 1 |
| `sh2_event` |  | Sun 20 Sep 2026 22:00 | Sun 27 Sep 2026 22:00 | 7 | 1 |
| `hw_event` | ROBOT HELL | Sun 04 Oct 2026 22:00 | Sun 08 Nov 2026 22:00 | 35 | 9 |
| `slurm` |  | Sun 08 Nov 2026 22:00 | Sun 15 Nov 2026 22:00 | 7 | 1 |
| `thanksgiving_event` |  | Sun 15 Nov 2026 23:00 | Sun 29 Nov 2026 23:00 | 14 | 4 |
| `LMB_Event` |  | Tue 01 Dec 2026 22:00 | Sun 06 Dec 2026 22:00 | 5 | 1 |
| `xmas_event` | AN XMAS XAROL | Sun 06 Dec 2026 22:00 | Tue 12 Jan 2027 23:00 | 37 | 10 |
| `PVP` |  | Mon 14 Dec 2026 22:00 | Sun 07 Feb 2027 23:00 | 55 | 8 |
| `bo17_event` |  | Fri 08 Jan 2027 22:00 | Tue 26 Jan 2027 23:00 | 18 | 2 |
| `ic_event` |  | Sun 24 Jan 2027 22:00 | Tue 09 Feb 2027 23:00 | 16 | 3 |
| `vday_event` |  | Sun 07 Feb 2027 22:00 | Mon 15 Feb 2027 23:00 | 8 | 2 |
| `mon_event` |  | Mon 15 Feb 2027 22:00 | Mon 22 Feb 2027 23:00 | 7 | 1 |

## Notes

* The season is anchored on the earliest window in the set, 28 June 2017, the
  soft launch. Whatever has already passed this year stays passed.
* The clock is checked against the windows on every `config` request, so events
  open and close on their own, and a player sees the change at their next cold
  launch. The year offset is only worked out at startup: once `mon_event` has
  closed, restart the server to roll the season on to the next year.
* While an event is open its characters get their event rows; once it closes
  they get their genuine off-season rows, without the bribe, where the configs
  have one. `data/events.json` holds both sides.
* Events are gated by their promo `predicate` as well as by time. Parts of
  `hw_event` and `xmas_event`, and all of `invasion_event`, require
  `blockUnlocked("d03_block03")`; most of the rest require the `fry-robot` skin,
  `characterUnlocked("bender")` or an unlocked district.
* Multi-act events open their acts in stages against a common close.
  `hw_event` runs five acts plus an offerwall over Halloween itself;
  `xmas_event` runs five acts, offerwalls before Christmas and New Year, a shop
  extension and a last-day promo.
