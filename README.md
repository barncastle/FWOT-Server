# FWOT server

A tapservice server for Futurama: Worlds of Tomorrow **1.5.7**. Node 22+, Hono,
no other runtime dependencies.

## Disclaimer

This is an independent, unofficial project. It is not affiliated with or
endorsed by TinyCo, the game's publisher, or by the owners of Futurama. All
trademarks belong to their respective owners. This repository distributes no
game assets and no game configuration files.

## Install

```sh
npm install
npm run build
```

The game data is not in this repo. `tools/install.py` rebuilds it into `data/`
from a hard-coded revision list (not wired up yet).

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
certificate: the client verifies certificates against the system store and
ignores user-installed CAs, so a self-signed or private-CA cert fails the
handshake. On the internet, either give the server a real certificate or put a
TLS-terminating reverse proxy in front of it.

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

Done: transport, actions, storage, the config pipeline and the asset CDN.
Rate limiting and TLS are not built yet.
