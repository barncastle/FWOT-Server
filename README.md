# FWOT server

A tapservice server for Futurama: Worlds of Tomorrow **1.5.7**.
Requires Node 22+ to run the server and Python 3.9+ (standard library only)
for the installer and client patcher; the patcher also needs a JDK to sign the apk.

> [!NOTE]
> The config set is rebuilt from the only known revisions the publisher's CDN still
> serves, with a few gaps reconstructed. If you have newer configs, or a rooted device
> with the game still installed, please open an issue listing the revision names
> you find (`<Name>-<md5>`). The names are all that is needed.

## Purpose

An interoperability server. The game was officially terminated in 2023, when
its API service was taken offline; the publisher's CDNs still serve its files.
This server stands in for that API so the 1.5.7 client keeps working. You need
your own copy of the client: this repository never provides or distributes the
client or a patched client, and `tools/patch_client.py` only modifies a copy you
supply, on your own machine. The game's configuration is fetched from the
publisher's CDN and decoded on your own machine by the installer, solely so this
server can serve it back to that client.

## Disclaimer

This is an independent, unofficial project. It is not affiliated with or
endorsed by TinyCo, the game's publisher, or by the owners of Futurama. All
trademarks belong to their respective owners. This repository distributes no
game assets and no game configuration files.

## Install

```sh
npm install
npm run build
python tools/install.py     # Python 3.9+, stdlib only
```

## Game data

No game data is in this repo. `tools/install.py` fetches it from the
publisher's config CDN, which still serves every revision, and rebuilds
`data/configs` (128 files) and `data/events.json`.

Two integrity checks run on the way, and neither is skippable:

- `tools/config_revisions.tsv` lists all 956 revision names with the md5 of the
  **ciphertext** as served. A download that does not match it aborts the run, as
  does a name that no longer returns 200. Only network failures are
  retried.
- each name embeds the md5 of its **plaintext**, which the installer verifies
  per file.

The build itself is the recipe the project verified: `pick_configs.py` merges
every revision of every config into one set, then the `SpaceChapter`,
`displayEnemies` and `LocalDataRecovered` passes fill the three holes the
available configs never had.

`data/saves/default_save.pb` is the exception, the one piece of `data/` in this
repo. It is an unofficial new player save and is project-authored, not TinyCo's.
`install.py` only checks it against the manifest. The server re-reads it
whenever it changes on disk, so it can be edited or replaced.

| Flag | Effect |
| --- | --- |
| `--jobs N` | parallel downloads (default 8) |
| `--offline` | build from what is already in `data/build/raw` |
| `--verify-only` | re-check the installed `data/` against the manifest |
| `--clean` | drop `data/build` first |

`data/local-cdn` and `data/cdn-cache` are optional folders that store custom
and cached cdn data respectively.

The server requires about 500 MB of space. 176 MB of configs are downloaded and
after install total 420 MB under `data/`, most of it lives in `data/build/`.
The server never reads it, so once the install is complete you can delete
`data/build/` to get the space back.

## Configure

```sh
cp config.example.json config.json
```

| Key | Meaning |
| --- | --- |
| `host`, `port` | listen address |
| `publicUrl` | the URL the client will use - feeds `content-url` and `ConfigURL` |
| `tls` | `null` for plain HTTP, or `{"cert": "...", "key": "..."}` |
| `cdn.servers` | upstreams tried in order before the local CDN |
| `cdn.cache` | store upstream hits to `data/cdn-cache` |
| `logging.verbose` | one log line per request |
| `scaling` | plain multipliers for `buildTime` (construction, skins, rent, land), `actionTime` (jobs and crafting), `reward`, `cost`; `1.0` is genuine, `0.5` is half, `2.0` is double |

Unknown or missing keys are rejected at startup. Every scaling factor must be
finite and greater than zero.

## Run

```sh
npm start        # built
npm run dev      # from source
npm test
```

## Patching the client

The client has the publisher's addresses built in, so each player patches their
own copy with `tools/patch_client.py` to point it at your server. See
[PATCHING.md](PATCHING.md).

## LAN setup

Use plain HTTP. Set `publicUrl` to `http://<lan-ip>:<port>` and patch the client
with that same address.

TLS is only worth it on an internet host with a **publicly trusted**
certificate. On the internet, either give the server a certificate for the
hostname patched into the APK -- Let's Encrypt is trusted from Android 7.1.1 --
or put a TLS-terminating reverse proxy in front of it.

With `tls` set, the process serves HTTPS and only HTTPS: there is no redirect
listener and no second port.

## Limits

`POST /tapservice/api/` is capped and rate limited. Asset and config GETs are
neither: a first launch pulls thousands of files.

| Limit | Value | Over it |
| --- | --- | --- |
| Request body | 1 MiB (a real save is ~2 KB) | 413 |
| Requests per IP | 120/min, burst 20 | 429 with `Retry-After: 1` |

Both are hardcoded and both log when they fire. The numbers are loose on
purpose: a cold boot is a handful of POSTs and then a save every 60 s, so a
genuine player never approaches them.

Behind a reverse proxy every request arrives from the proxy's address, so all
players share one bucket and a busy server will hit the limit.

## Config set

`data/configs` is served as the `config` reply: the files on disk plus the
season-align promo shift, the event states in `data/events.json`, the patches in
`patches/` and the scaling factors.

The client fetches `config` only at a cold launch, so patches, events and new
scaling factors will only apply when the game is restarted.

The reply is about 21 MB, gzipped to about 2.3 MB per request. That is ~0.4s of
CPU on each cold boot, which only matters if many clients boot at once.

## Events

The season's timed events -- Halloween, Thanksgiving, Christmas and the rest --
are `TimedPromo` windows in the configs. At startup the server moves every event
forward so each keeps its original calendar dates and order relative to the
current year. See [EVENTS.md](EVENTS.md) for the full calendar.

On every `config` request the server checks which event is open and serves its
characters with their event rows. Players see an event open or close at their
next launch.

NOTE: The year offset is only worked out at startup. Once the season's last
event has ended, restart the server to roll the season on to the next year.

## Assets

`GET /static/*` serves what the client downloads from `content-url`. A name is
resolved in order and the first hit wins:

1. `data/cdn-cache`, when `cdn.cache` is on;
2. each `cdn.servers` entry, in array order -- only a 200 counts, and an upstream
   hit is written to the cache;
3. `data/local-cdn`;
4. `404`.

With `cdn.servers` empty only the local directory answers, so a mirrored copy of
the assets in `data/local-cdn` is a complete offline setup. Nothing is mirrored
by the server itself, and a miss is never cached.

Assets go out uncompressed even when the request asks for gzip -- they are
already compressed, and the client checks the ETag against the bytes it
received.

## License

[MIT](LICENSE). The licence covers this project's own work; it grants nothing
over the game, its data or its trademarks.
