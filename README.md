# Tabletop Whisperer

**Pass secret notes to players at the table, from the DM's phone to theirs. No app, no accounts.**

When only some players pass a Perception check, the DM taps their names and they read it on their phone,
instead of the DM getting up to whisper or passing paper notes. That's all it does: no chat, no dice, no maps.

**Try it:** https://tabletop-whisperer.nunolxm-jogos.workers.dev · English and Português

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

Three ways, all free:

### 1. Docker (a laptop at the table, or a home server)

```bash
docker run -d --name whisperer -p 8080:8080 -v whisperer-data:/data \
  -e PUBLIC_URL=http://192.168.1.23:8080 --restart unless-stopped \
  ghcr.io/nuno-lxm/tabletop-whisperer
```

Open `http://localhost:8080`. Players' phones must be on the same Wi-Fi; the join QR code uses `PUBLIC_URL`
(your computer's address on the network). No internet needed during the game.

Notes for a laptop at the table:
- Plain `http://` on a home network can't keep players' screens on ("Keep screen on" needs HTTPS). For that, put it
  behind a reverse proxy with a certificate, e.g. Caddy: `whisperer.example.org { reverse_proxy localhost:8080 }`.
- Guest Wi-Fi and game-store networks often block phones from reaching each other: use your laptop's hotspot.
- Don't let the laptop sleep during the session.

Or with compose: `PUBLIC_URL=http://192.168.1.23:8080 docker compose up -d`.

### 2. Node, without Docker

Node 22.13 or newer (Node 24 recommended):

```bash
pnpm install --prod
pnpm start
```

### 3. Your own copy on Cloudflare's free plan

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Nuno-lxm/tabletop-whisperer)

No credit card needed. Running it for other people? Put your own name and contact in
[`public/site.js`](public/site.js): the privacy page shows them.

### Settings

| Where | Setting | Default | What it does |
|---|---|---|---|
| Node / Docker | `PORT` | `8080` | Port to listen on |
| Node / Docker | `DATA_DIR` | `./data` (`/data` in Docker) | One SQLite file per room, plus `admin.sqlite` |
| Node / Docker | `PUBLIC_URL` | your network addresses | The address players use (shown in the join QR) |
| both | `ROOM_EXPIRY_DAYS` | `60` | Delete rooms unused this long; `0` keeps them forever |
| both | `ADMIN_TOKEN` | not set | Turns on content reports and the `/admin` page (stats, reports). On Cloudflare, set it with `wrangler secret put ADMIN_TOKEN` |

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
[PLAN.md](PLAN.md) has the design and the reasoning behind it.

### Translations

All text is in [`public/js/locales/`](public/js/locales/). To add a language, copy `en.js`, translate the text on
the right, add it to `LANGUAGES` in `public/js/i18n.js`, and run `pnpm test` (it checks every key is there).
Portuguese from Brazil especially welcome.

### Releases

Pushes to `main` that pass the tests deploy to a staging copy. Publishing a GitHub release deploys the public
site and the Docker image (`ghcr.io/nuno-lxm/tabletop-whisperer`).

## License

[MIT](LICENSE). Fonts: Alegreya and Alegreya Sans, [SIL Open Font License](public/fonts/OFL.txt).
QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT).
