# Passive Perception

[![CI](https://github.com/Nuno-lxm/passive-perception/actions/workflows/ci.yml/badge.svg)](https://github.com/Nuno-lxm/passive-perception/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Nuno-lxm/passive-perception?label=release)](https://github.com/Nuno-lxm/passive-perception/releases)
[![Docker image](https://img.shields.io/badge/docker-ghcr.io%2Fnuno--lxm%2Fpassive--perception-2496ED?logo=docker&logoColor=white)](https://github.com/Nuno-lxm/passive-perception/pkgs/container/passive-perception)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Pass secret notes to players at the table, from the DM's phone to theirs. No app, no accounts.**

When only some players pass a Perception check or any other situation where only some of the people at the table should learn some information, the DM taps their names and they read it on their phone,
instead of the DM getting up to whisper or passing paper notes. That's all it does: no chat, no dice, no maps.

**Try it:** https://passive-perception.smokelab.workers.dev · English and Português

<!-- Demo GIF: DM taps a player, their phone glows, pinch-zoom on a map, the other phone shows nothing. -->

## How it works

1. **Prepare cards.** Clues, handouts, maps, with images. Paste them in from your prep notes if you like.
2. **Players join.** They scan a code on the DM's screen and pick their name. Nothing to install, no account.
3. **Tap and reveal.** Pick who gets it. Only their phones receive it.

For the DM: quick whispers typed at the table, cards that already know who they're usually for, groups and a
"to reveal" filter, read receipts (delivered, seen, 👍), a phone, tablet and three-column desktop layout with
keyboard shortcuts, campaign export/import, and four themes.

## Secrets stay secret

A player's phone only ever receives what was revealed to that player. The server filters per player before
anything is sent, so there's nothing hidden in the page, the network tab or the WebSocket frames for a curious
player to find. The tests check this by searching everything a player's connection received for other players'
cards ([`test/secrets.test.js`](test/secrets.test.js)), and the same check runs against a live server
([`test/smoke.js`](test/smoke.js)).

Other bits: DM and seat links are 128-bit random keys stored only as hashes; images are shrunk on the DM's device
(which strips GPS data) and served only to players who can see their card; a strict Content Security Policy;
no cookies. See the [privacy page](public/privacy.html).

## Run your own

### 1. Docker

```bash
docker run -d --name passive-perception -p 8080:8080 -v perception-data:/data \
  -e PUBLIC_URL=http://192.168.1.23:8080 --restart unless-stopped \
  ghcr.io/nuno-lxm/passive-perception
```

Open `http://localhost:8080`. Players' phones must be on the same Wi-Fi; the join QR code uses `PUBLIC_URL`
(your computer's address on the network). No internet needed during the game.

Notes for a laptop at the table:
- Plain `http://` on a home network can't keep players' screens on ("Keep screen on" needs HTTPS). For that, put it
  behind a reverse proxy with a certificate, e.g. Caddy: `perception.example.org { reverse_proxy localhost:8080 }`.
- Guest Wi-Fi and game-store networks often block phones from reaching each other: use your laptop's hotspot.
- Don't let the laptop sleep during the session.

Or with compose: `PUBLIC_URL=http://192.168.1.23:8080 docker compose up -d`.

### 2. Node, without Docker

Node 22.13 or newer (Node 24 recommended) and [pnpm](https://pnpm.io/installation) (`npm install -g pnpm`):

```bash
git clone https://github.com/Nuno-lxm/passive-perception.git
cd passive-perception
pnpm install --prod
PUBLIC_URL=http://192.168.1.23:8080 pnpm start
```

To update later: `git pull && pnpm install --prod`, then restart it. Your rooms are in the `data` folder and are kept.

### 3. Your own copy on Cloudflare's free plan

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nuno-lxm/passive-perception)

No credit card needed. Running it for other people? Point `repoUrl` in [`public/site.js`](public/site.js) at your fork,
and set an `ADMIN_TOKEN` so people can send reports.

### Settings

| Where | Setting | Default | What it does |
|---|---|---|---|
| Node / Docker | `PORT` | `8080` | Port to listen on |
| Node / Docker | `DATA_DIR` | `./data` (`/data` in Docker) | One SQLite file per room, plus `admin.sqlite` |
| Node / Docker | `PUBLIC_URL` | your network addresses | The address players use (shown in the join QR) |
| both | `ROOM_EXPIRY_DAYS` | `60` | Delete rooms unused this long; `0` keeps them forever |
| both | `ADMIN_TOKEN` | not set | Turns on content reports and the `/admin` page (stats, reports). Use a long random token or a passphrase of 5+ random words; 10 wrong tries in an hour lock `/admin` for up to an hour. On Cloudflare, set it with `wrangler secret put ADMIN_TOKEN` |

Backups on Node/Docker: copy the data folder. From the app: Room → Export campaign (works between all versions).

## Development

No build step: the browser runs the files in `public/` as they are, and `wrangler` bundles the Worker.

```bash
pnpm install
pnpm test          # 80+ tests, node --test, no test libraries
pnpm start         # the Node host on http://localhost:8080
pnpm dev:cf        # the Cloudflare host locally on http://localhost:8787 (put ADMIN_TOKEN in .dev.vars)
```

```
public/       the browser app (plain ES modules, // @ts-check + JSDoc), served unchanged by both hosts
src/core/     everything about rooms: seats, cards, reveals, the per-player filter, export, reports
src/cloudflare/  thin host: a Worker plus one Durable Object (with SQLite) per room
src/node/     thin host: node:http + node:sqlite + ws, one SQLite file per room
test/         node --test, running the real core on node:sqlite
```

The one rule: `src/core/` never touches Cloudflare or Node APIs, so both hosts share it and the tests cover both.

### Translations

All text is in [`public/js/locales/`](public/js/locales/). To add a language, copy `en.js`, translate the text on
the right, add it to `LANGUAGES` in `public/js/i18n.js`, and run `pnpm test` (it checks every key is there).

### How changes ship

All in GitHub Actions ([`.github/workflows/`](.github/workflows/)):

- **Every push and pull request:** the tests, a trial Cloudflare build and a Docker build. `main` only takes
  changes through pull requests that pass.
- **Merge to `main`:** deploys the staging copy, then runs the end-to-end secrecy check against it.
- **Publish a release:** after an approval, deploys the public site (with the same check) and publishes the Docker
  image for amd64 and arm64.
- **Rollback:** a manual workflow puts the previous version back live in a minute.
- **Dependabot:** weekly pull requests for the Actions, npm packages and the Docker base image.

Each deploy writes a summary on its run page: URL, Worker version and smoke-test result.

## License

[MIT](LICENSE). Fonts: Alegreya and Alegreya Sans, [SIL Open Font License](public/fonts/OFL.txt).
QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
