# FWOT server

A tapservice server for Futurama: Worlds of Tomorrow **1.5.7**. Node 22+, Hono,
no other runtime dependencies.

## Purpose

An interoperability server. The game was officially terminated in 2023, when
its API service was taken offline; the publisher's CDNs still serve its files.
This server stands in for that API so the 1.5.7 client keeps working. You need
your own copy of the client: this repository does not provide or distribute the
client, a patched client, or any tool to patch it. The game's configuration is
fetched from the publisher's CDN and decoded on your own machine by the
installer, solely so this server can serve it back to that client.

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
  does a name that no longer returns 200 — a changed or missing revision would
  change the build, so neither may pass quietly. Only network failures are
  retried.
- each name embeds the md5 of its **plaintext**, which the installer verifies
  per file.

The build itself is the recipe the project verified: `pick_configs.py` merges
every revision of every config into one set, then the `SpaceChapter`,
`displayEnemies` and `LocalDataRecovered` passes fill the three holes the dump
never had. Every output is checked against
`tools/season_manifest.txt` and **nothing is installed unless all 130 md5s
match**, so a host ends up with the exact set this project tested or with an
error naming the files that drifted.

`data/saves/default_save.pb` is the exception, and the one piece of `data/`
in this repo. It is the blob `getGameStatePB` hands a player with nothing
saved. It is project-authored -- this project's own work, not TinyCo's -- so
it is committed (451 bytes) where the server reads it, beside the per-player
save directories.
`install.py` only checks it against the manifest. The server re-reads it
whenever it changes on disk, so a host can edit or replace it.

| Flag | Effect |
| --- | --- |
| `--jobs N` | parallel downloads (default 8) |
| `--offline` | build from what is already in `data/build/raw` |
| `--verify-only` | re-check the installed `data/` against the manifest |
| `--clean` | drop `data/build` first |

`data/local-cdn` and `data/cdn-cache` are in the repo as empty directories
with a `.gitkeep`, because empty is a valid state for both -- a miss, not an
error. `install.py` makes them too, and makes `data/configs`, which is never
legitimately empty.

It downloads 176 MB and leaves about 420 MB under `data/`, most of it the
intermediates in `data/build/`. That directory is kept so a re-run resumes: a
raw file that still matches its etag is not downloaded again, and `--clean`
drops it once the install is good. Test the installer itself with
`python tools/test_install.py`.

## Configure

```sh
cp config.example.json config.json
```

| Key | Meaning |
| --- | --- |
| `host`, `port` | listen address |
| `publicUrl` | the URL the client will use — feeds `content-url` and `ConfigURL` |
| `tls` | `null` for plain HTTP, or `{"cert": "...", "key": "..."}` |
| `cdn.servers` | upstreams tried in order before the local CDN |
| `cdn.cache` | write upstream hits to `data/cdn-cache` |
| `logging.verbose` | one log line per request |
| `scaling` | plain multipliers for `buildTime`, `reward`, `cost`; `1.0` is genuine |

Unknown or missing keys are rejected at startup. Every scaling factor must be
finite and greater than zero.

## Run

```sh
npm start        # built
npm run dev      # from source
npm test
```

## LAN setup

Use plain HTTP. Set `publicUrl` to `http://<lan-ip>:<port>` and point the
patched client at the same host and scheme.

TLS is only worth it on an internet host with a **publicly trusted**
certificate: the client verifies certificates against the system store, does no
pinning, and ignores user-installed CAs, so a self-signed or private-CA cert
fails the handshake. A self-signed certificate is therefore good for a local
test of this server and nothing else. On the internet, either give the server a
certificate for the hostname patched into the APK -- Let's Encrypt is trusted
from Android 7.1.1 -- or put a TLS-terminating reverse proxy in front of it.

With `tls` set the process serves HTTPS and only HTTPS: there is no redirect
listener and no second port. `publicUrl` must use the same scheme, because it
feeds `content-url`; an `http://` publicUrl under TLS is warned about at
startup. The reverse -- no `tls` with an `https://` publicUrl -- is the
reverse-proxy setup and is not warned about.

## Limits

`POST /tapservice/api/` is capped and rate limited. Asset and config GETs are
neither: a first launch pulls thousands of files.

| Limit | Value | Over it |
| --- | --- | --- |
| Request body | 1 MiB (a real save is ~2 KB) | 413 |
| Requests per IP | 120/min, burst 20 | 429 with `Retry-After: 1` |

Both are hardcoded and both log when they fire. The numbers are loose on
purpose: a cold boot is a handful of POSTs and then a save every 60 s, so a
player never approaches them.

Behind a reverse proxy every request arrives from the proxy's address, so all
players share one bucket and a busy server will hit the limit. `X-Forwarded-For`
is deliberately not read -- it is spoofable by anyone who can reach the server
directly. Rate limit at the proxy instead.

## Config set

`data/configs` is served as the `config` reply: the files on disk plus the
season-align promo shift, the event states in `data/events.json`, the patches in
`patches/` and the scaling factors. A file nothing rewrites goes out as its
bytes on disk.

Edit a patch and the next `config` request rebuilds, but the client fetches
`config` only at a cold launch, so a change lands when the game is next started
from scratch -- as does a new scaling factor, including for a timer already
running on the device.

The reply is about 21 MB, gzipped to about 2.3 MB per request. That is ~0.4 s of
CPU on each cold boot, which only matters if many clients boot at once.

## Assets

`GET /static/*` serves what the client downloads from `content-url`. A name is
resolved in order and the first hit wins:

1. `data/cdn-cache`, when `cdn.cache` is on;
2. each `cdn.servers` entry, in array order -- only a 200 counts, and an upstream
   hit is written to the cache;
3. `data/local-cdn`;
4. 404.

With `cdn.servers` empty only the local directory answers, so a mirrored copy of
the assets in `data/local-cdn` is a complete offline setup. Nothing is mirrored
by the server itself, and a miss is never cached: a name that 403s today may be
served tomorrow.

A `.compressed` name is logical, not a file. The client normally resolves it
itself; as a safety net the server rewrites the suffix to `.astc.ccz` on Android
or `.pvr.ccz` on iOS, chosen from the User-Agent and defaulting to Android.
There is no transcoding and no density (`@2x`, `@4x`) is ever added.

Assets go out uncompressed even when the request asks for gzip -- they are
already compressed, and the client checks the ETag against the bytes it
received. `Range` headers are ignored and the whole file is returned: nothing on
this path needs them, since the intro movie is a hardcoded URL that still points
at the real CDN.

## Status

Done: transport, actions, storage, the config pipeline, the asset CDN, the
request limits, TLS and the data installer. Not yet done: a full boot of the
1.5.7 client against this server, ban enforcement and save rollback tooling.

## License

[MIT](LICENSE). The licence covers this project's own work; it grants nothing
over the game, its data or its trademarks.
