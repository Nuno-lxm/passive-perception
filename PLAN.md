# Tabletop Whisperer — plan

**Pass secret notes to players at the table, from the DM's phone to theirs. No app, no accounts.**

When only some players pass a Perception or Insight check, the DM taps their names and they read it on their phone.
It replaces getting up to whisper or passing paper notes, and nothing else: no chat, dice, maps or character sheets.

- **Name:** *Tabletop Whisperer* in full (landing page, README, search). *Whisperer* is the short form, used for the home-screen icon and the app header. Repo: `tabletop-whisperer`.
- **Two ways to run it, from one codebase:**
  1. **Hosted:** free, no setup, on Cloudflare's free tier, for anyone.
  2. **Self-hosted:** Docker or plain Node on the DM's laptop (players join over Wi-Fi) or on a home server.
     No internet needed, no limits, and the data never leaves the room.
- **Languages:** English by default, Portuguese (pt-PT) built in from day one. More languages are just more locale files.
- **License:** MIT, unless you'd rather use AGPL-3.0 ([open decisions](#open-decisions)).
- **Git:** commits never add Claude as a co-author.

---

## 1. Decisions so far

| Topic | Decision |
|---|---|
| What a room is | **A campaign.** The room, cards and seats carry over between sessions. The player feed is grouped by session. |
| Room expiry | Deleted after **60 days without use**. The DM can delete a room at any time. |
| Player identity | **Claim a seat or use a personal link.** The first claim of a seat is free. If the seat is already linked to another device, the DM taps *Approve*. A personal link or QR code works without approval. |
| Where the device remembers who it is | **localStorage only, no cookies.** iPhone Safari can wipe it after ~7 days of Safari use without visiting the site; the player then re-claims with one tap from the DM. |
| Sleeping phones | Optional **keep screen on** (Wake Lock), **vibration on Android**, a quiet **visual flash** everywhere, and **live online/asleep status** on the DM's screen. No Web Push in v1. |
| Editing a revealed card | **Updates live**, with an *edited* tag. Revealing to more players later adds them to the same card. |
| "Seen" receipts | **Automatic** ✓ delivered and ✓✓ seen, **plus an optional 👍 "Got it"** the player can tap. |
| Data store | **One SQLite database per room** (a Durable Object on Cloudflare, a file in self-hosted mode). **No D1.** |
| Images | **Stored in the room's SQLite database**, max ~1.5 MB each after the phone resizes them. **No R2.** |
| Frontend | **Same as Shift Earnings:** plain static files, no build step, vanilla ES modules, `// @ts-check` + JSDoc, `node --test`, libraries saved into `public/vendor/`. |
| Hosts | **Shared core + two thin hosts** (Cloudflare Worker/DO and a small Node server), **both in v1**. |
| Domain | **`*.workers.dev`** for now. Buy a domain later only if people adopt it. |
| Over the free-tier limits | **Stay on the free tier**, show a friendly "busy today" message, and point people to self-hosting. Maybe a Ko-fi link later. |
| Content reports | **Report button → private admin page.** No email. |
| Analytics | Cloudflare Web Analytics (no cookies), **on the landing and privacy pages only**. |

---

## 2. User flows

### DM: prep (desktop or tablet, before the session)

1. **Create a room** on the landing page: campaign name and player seats. Tip on screen: *use character names, not real names*.
2. The app shows the **DM link** once, in big type: *"This link is your key. Save it, because there is no account to recover it."*
   It offers Copy, an "email it to myself" `mailto:` link, and a checkbox, *"I saved it"*, before the DM can continue.
   The link is also stored on this device.
3. **Cards tab:** add cards with a title, text and up to 4 images (pick, drag in, or paste; the phone camera works too).
   An optional **group** label (e.g. "Session 12", "The Manor") makes the list filterable. Cards are searchable.
4. Optionally **send personal links** to each player ahead of time, e.g. privately on WhatsApp. Each seat has *Copy link* and *Show QR*.

### DM: during the session (phone or tablet behind the DM screen)

1. Open the room. The **Table** screen shows:
   - a **seat bar**: one chip per player with a status dot (🟢 open, 🌙 asleep or in the background, ⚪ not joined)
   - a **quick whisper** box: text and an optional photo, then chips, then *Send*
   - **recent reveals**, with per-player receipts (✓ / ✓✓ / 👍)
2. **Join QR:** a big "Players join here" QR code with the room code (`K7Q-F2M`) for the table to scan.
3. **Reveal a card:** in **Cards**, tap a card. A bottom sheet shows chips for each player plus **Everyone**, and **Reveal to 2**.
   - The chip selection clears after each reveal, so the next reveal doesn't reuse the last one's players by accident.
   - An **Undo** bar shows for 6 s. Undo means un-reveal, so a player may have glimpsed it.
4. **Fix a mistake:** open the card and edit it (players see it update, tagged *edited*). **Un-reveal** works per player or for everyone.
   Tapping more chips adds players to the same card.
5. **Seat problems:** *"Ana wants to join on a new device — Approve / Deny"*. Approving signs out Ana's old device.
   The seat menu has *Release seat*, *New personal link* (the old one stops working) and *Rename*.
6. **Lock joining** (optional): once everyone is in, any new claim needs approval.

### Player: join → feed

1. Scan the DM's QR code, open a personal link, or type the address and then the room code.
2. **Pick your name** from the seat list.
   - If the seat is free, you're in. The device keeps a secret seat token.
   - If it's already taken: *"Ask your DM to approve"*. The DM approves and the page logs in by itself.
   - With a personal link you skip this step.
3. **Feed:** everything revealed to you, newest first, grouped by session ("Session 12 · 21 Oct"). Public handouts are labelled *shared with the table*.
   - A new item slides in at the top with a soft glow and one short vibration (Android only, never a sound).
   - **Tap the text** to open a full-screen reader with A− / A+ (the size is remembered). **Tap an image** for full-screen pinch-zoom and pan;
     double-tap zooms and swiping down closes it.
   - Each item has **👍 Got it** and a **⋯** menu with *Report*.
4. **Coming back:** after the phone sleeps or the page reloads, the app reconnects by itself and catches up on anything missed.
   Items that arrived while away get a "new" badge and one glow, not a burst of vibrations.
5. **Settings** (a small gear): *Keep screen on*, *Vibrate*, text size, language, *Leave room*.

---

## 3. Architecture

```
          phones/tablets (same static client for both hosts)
                     │  HTTPS + WebSocket
     ┌───────────────┴──────────────────┐
     │ Hosted: Cloudflare               │  Self-hosted: Node (Docker or plain)
     │  Static assets (free, unlimited) │   node:http serves public/
     │  Worker  /api/* router           │   same /api/* router
     │  RoomDO  (1 per room, SQLite)    │   Room per room (data/rooms/<code>.sqlite)
     │  AdminDO (1, SQLite)             │   Admin (data/admin.sqlite)
     └───────────────┬──────────────────┘
                     │ both call the same platform-free core
              src/core/room.js · admin.js · feed.js · protocol.js · validate.js
```

**Why no D1 or R2:**
- Each room's database holds all of its cards, seats, reveals and images. The filtering that keeps secrets happens in one place, and nothing has to be kept in sync.
- Deleting a room is one call (`deleteAll()` on Cloudflare, deleting the file in Node), with no orphaned images left in another store.
- R2 needs a payment method on file even for the free tier, which would put self-hosters off the "Deploy to Cloudflare" button.
- The cost is 5 GB of storage for everything, instead of R2's 10 GB. Caps and expiry handle that ([§11](#11-free-tier-limits-and-risks)).

**The one rule (as in Shift Earnings): `src/core/` never touches platform APIs.** No `env`, `ctx`, `node:` imports or DOM.
The core is a `Room` class that receives a small adapter object from the host:

```js
// The adapter each host gives the core
{
  sql(query, ...bindings) → rows[],     // DO: ctx.storage.sql.exec(...).toArray()   Node: db.prepare(q).all(...b)
  tx(fn),                               // DO: ctx.storage.transactionSync(fn)       Node: BEGIN … COMMIT
  sockets() → [{ send(obj), close(code, reason), meta, setMeta(m) }],   // DO: getWebSockets + attachments; Node: a Map
  setAlarm(ms), now(), random(n)
}
```

Both SQLite engines are real SQLite, so **the tests run the actual core, SQL included, on Node's built-in `node:sqlite`**.
That means the security tests cover both hosts.

### Files

```
.
├── PLAN.md  README.md  LICENSE  PRIVACY.md (source text for the privacy page)
├── package.json            # deps: ws (Node host only) · devDeps: wrangler · scripts: test, dev, dev:cf, deploy
├── wrangler.jsonc          # Cloudflare host (+ env.staging)
├── Dockerfile  compose.yaml
├── public/                 # the static client, served unchanged by both hosts
│   ├── index.html          # landing: one sentence, demo GIF, Create a room / Join a room
│   ├── play.html  dm.html  privacy.html  admin.html
│   ├── config.js           # {mode:'cloud'}; the Node host serves its own version with LAN URLs
│   ├── css/  img/  manifest.webmanifest  _headers
│   ├── js/
│   │   ├── i18n.js  locales/en.js  locales/pt-PT.js
│   │   ├── net.js          # api(), socket with reconnect, error → friendly message
│   │   ├── play.js  dm.js  admin.js
│   │   ├── viewer.js       # full-screen image zoom with pointer events (~150 lines, no library)
│   │   └── image-prep.js   # resize and re-encode before upload
│   └── vendor/qrcode.js    # qrcode-generator (MIT, no dependencies), saved once
├── src/
│   ├── core/               # platform-free (see the rule above)
│   │   ├── room.js         # Room: HTTP + WebSocket handlers, permissions, broadcasts
│   │   ├── admin.js        # room registry, global storage tally, rate limits, reports
│   │   ├── feed.js         # feedFor(seat), toPlayerItem(card), the security-critical code
│   │   ├── schema.js       # SQL migrations, numbered
│   │   ├── protocol.js     # message types, shared with the client
│   │   ├── validate.js     # lengths, image magic bytes and dimensions
│   │   └── ids.js          # room codes, ids, tokens, SHA-256 hashing
│   ├── cloudflare/  worker.js  room-do.js  admin-do.js
│   └── node/        server.js  static.js  adapter.js
└── test/            # node --test; runs src/core on node:sqlite
```

---

## 4. Data model (one SQLite database per room)

```sql
CREATE TABLE meta     (key TEXT PRIMARY KEY, value TEXT);
  -- code, name, created_at, last_active_at, admin_hash, join_locked, frozen, schema_version
CREATE TABLE seats    (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER,
                       token_hash TEXT, link_hash TEXT, claimed_at INTEGER, last_seen_at INTEGER);
CREATE TABLE claims   (id TEXT PRIMARY KEY, seat_id TEXT NOT NULL, created_at INTEGER); -- pending approvals, 10 min TTL
CREATE TABLE cards    (id TEXT PRIMARY KEY, title TEXT, body TEXT, grp TEXT, sort REAL,
                       public_at INTEGER, public_session INTEGER,
                       created_at INTEGER, updated_at INTEGER, content_at INTEGER);
CREATE TABLE images   (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, sort INTEGER, mime TEXT,
                       w INTEGER, h INTEGER, bytes INTEGER, data BLOB, thumb BLOB, created_at INTEGER);
CREATE TABLE grants   (card_id TEXT, seat_id TEXT, revealed_at INTEGER, session INTEGER,
                       PRIMARY KEY (card_id, seat_id));
CREATE TABLE receipts (card_id TEXT, seat_id TEXT, delivered_at INTEGER, seen_at INTEGER, ack_at INTEGER,
                       PRIMARY KEY (card_id, seat_id));
CREATE TABLE sessions (n INTEGER PRIMARY KEY, started_at INTEGER);
```

- **IDs are random** (10 base32 characters), never sequential. A player who sees `card 37` must not be able to tell that the DM has 36 other cards.
- **Secrets are stored hashed.** The DM key, seat tokens and personal-link secrets are 128-bit random values, stored as SHA-256 hashes.
  Their randomness makes a slow password hash unnecessary, and a dump of the database contains no usable keys.
- **"Everyone"** is `public_at` on the card. It includes players who join later.
- **Sessions number themselves.** The first reveal after 6 or more hours without one starts session *n+1*. There's no manual button (dropped: the rule covers real play).
- **`content_at`** changes only when what players see changes (title, body, images). Their feed shows *edited* when `content_at` is later than the time it was revealed to them.
- **An image row** holds the full image (≤ 1.5 MB) and a thumbnail (≤ 150 KB), under the 2 MB SQLite row limit.
  Image ids never change, so clients can cache images forever.
- **Admin database:** the room registry (code, created, last active, bytes), a daily salt, IP-hash rate-limit counters (deleted after 24 h),
  reports, and daily aggregate counters (rooms created, reveals). No personal data.

---

## 5. How secrets stay secret (server-side filtering)

**A player's device only ever receives what was revealed to that seat.**

1. **One function builds what players see.** `feedFor(seatId)` selects only cards with a grant for that seat, or with `public_at` set.
   `toPlayerItem(card, grant)` builds a **new object from an allowlist of fields**:
   `{id, title, body, images:[{id,w,h}], revealedAt, edited, public, session}`.
   Fields added later (e.g. private DM notes) can't leak by accident.
2. **The same path covers every player-facing output:** the WebSocket `welcome` snapshot, live `item` pushes and the image endpoint.
   An image is served only if its card is currently visible to the requesting seat, checked on every request.
3. **Players never learn about other players' reveals.** No recipient lists, no counts, no other seats' receipts.
   A player only knows whether an item is private to them or shared with the table.
4. **Un-reveal deletes the grant.** The server pushes `remove`, the client deletes the item and its cached image, and the image endpoint returns 404 from then on.
   Nobody can un-see something already read, and the DM UI says so.
5. **Unrevealed cards never leave the room's database** on a player connection. The player page's source code contains no card data at all.
6. **Tests that fail the build:** two seats; reveal card X to A only. B's snapshot, B's live messages and B's image requests contain nothing of X,
   checked by searching the raw output for X's title and id. Then reveal X to B and un-reveal it from A, and test that the other way round.
   The same assertions run against the live hosts (`test/smoke.mjs`, see [§13](#13-testing)).

---

## 6. Real-time design

**Transport:** one WebSocket per open page: `GET /api/rooms/:code/ws`.
- **Cloudflare:** the WebSocket Hibernation API, so a room using no CPU between events isn't billed for run time.
  Never use `setTimeout`/`setInterval` in the DO; use alarms.
- **Node:** `ws`, with the same messages.

Browsers can't send headers on a WebSocket, so **the first message is the login**: `hello` with the token.
The server closes the socket if no valid `hello` arrives within 5 s.

### Messages

| Direction | Message | Meaning |
|---|---|---|
| player → | `hello {token \| pendingClaim, v}` | Log in (or wait for the DM's approval). `v` = protocol version. |
| player → | `got {ids}` / `seen {ids}` / `ack {id}` | Delivered, seen (≥ 50% on screen for 1 s with the page visible), 👍. Sent in batches every ~2 s. |
| player → | `state {visible}` | Sent on `visibilitychange`, so the DM sees 🌙 right away. |
| player → | `"ping"` every 25 s | Answered with `"pong"` by `setWebSocketAutoResponse`, **without waking the DO** (the Node host does the same). |
| → player | `welcome {seat, room, feed[], serverTime}` | **The full snapshot on every (re)connect.** Feeds are small, and this is the simplest correct way to catch up. |
| → player | `item {item, fresh}` | Added or edited. `fresh` triggers the vibration and glow; edits don't. |
| → player | `remove {id}` | Un-revealed. |
| → player | `approved {token}` / `signedOut {reason}` | Claim approved / seat moved to another device, seat released, or room deleted. |
| DM → | `hello {adminKey}`, `"ping"` | DM changes go over HTTP (below). The DM's socket receives updates only. |
| → DM | `welcome {room, seats, cards, receipts, claims}` | Full DM state. |
| → DM | `presence {seatId, status}` · `receipt {...}` · `claim {...}` · `changed {...}` | `changed` keeps the DM's other devices in sync. |

**Presence:** 🟢 means the socket is open and the page visible.
🌙 means the page reported itself hidden, or there has been no ping for 45 s (Cloudflare reads this from `getWebSocketAutoResponseTimestamp`).
⚪ means never joined.

**Reconnecting (client):**
- Retry after 0.5 s → 1 → 2 → 5 → 10 s, with some randomness.
- Also retry **at once** on `visibilitychange → visible`, `online` and `pageshow`.
- A socket with no `pong` for 10 s counts as dead.
- The last feed is kept in localStorage, so the page shows it instantly while reconnecting.
- "Reconnecting…" appears only after 3 s.

**Joining mid-session:** reveals are grants on seats, not messages sent to devices. Whatever was revealed to a seat (or to everyone)
before its player joined is in the first `welcome` snapshot. The DM can reveal to a seat that hasn't joined yet.

**DM changes go over HTTP** (`POST/PUT/DELETE /api/rooms/:code/...`, `Authorization: Bearer <adminKey>`).
Each change gets a clear yes or no and is easy to test with curl. The room applies the change and pushes it to the affected sockets.
A DM uses roughly 50–150 requests per session, which fits easily in the budget.

**Seat claims:**
- `POST /claim {seatId}` returns `{token}` if the seat was never claimed (or was released) and joining isn't locked.
- Otherwise it returns `{pendingClaim}`. The page then opens a socket with `hello {pendingClaim}` and waits for `approved {token}`, with no polling.
- Approving a claim **creates a new token**, and the old device gets `signedOut`.
- A personal link (`/play#r=K7QF2M&s=<secret>`) gets a new token without approval.

---

## 7. Images

- **Resized on the DM's device before upload** (`image-prep.js`):
  - `createImageBitmap(file, {imageOrientation:'from-image'})`, then a canvas with a long edge of ≤ 2048 px, saved as JPEG q≈0.85.
    If that's still over 1.5 MB, try q 0.75, then 1600 px.
  - PNGs with transparency stay PNG if they fit; otherwise they're flattened onto the card background.
  - A **480 px thumbnail** is made too (≤ 150 KB).
  - **Re-encoding removes EXIF metadata, including GPS location.** A privacy win worth saying on the privacy page.
  - iPhone HEIC photos usually arrive as JPEG from the file picker. If a desktop browser can't decode one: *"Convert to JPEG first"*.
- **Uploaded with two requests:** `POST /images?card=ID` (raw body) returns `{imageId}`, then `PUT /images/ID/thumb`. No multipart parsing.
- **Checked by the server, which doesn't trust the client:**
  - JPEG, PNG or WebP magic bytes only. **No SVG** (it can carry scripts).
  - Size ≤ 1.5 MB (thumbnail ≤ 150 KB). Dimensions read from the header, ≤ 4096 px.
  - ≤ 4 images per card, ≤ 50 MB of images per room (self-hosted: configurable), 60 uploads per hour per room.
- **Served only to permitted seats:** `GET /api/rooms/:code/images/:id[?thumb]`.
  - `<img>` can't send a token, so the client uses `fetch` with `Authorization: Bearer`, turns the result into a blob URL, and caches it in Cache Storage under its image id.
  - Responses carry the exact `Content-Type`, `X-Content-Type-Options: nosniff` and `Cache-Control: private`.
- **Loading:** the feed loads thumbnails lazily, and the full image only when zoomed. Each device downloads each image about once.
- **Deleting:** removing an image from a card pushes an `item` update, and the endpoint returns 404. Deleting a room removes everything.

---

## 8. Security and privacy

### DM authentication: the DM link

- `https://…/dm#r=K7QF2M&k=<128-bit key>`. **The key is in the `#fragment`, which browsers never send to servers**, so it stays out of logs, analytics and `Referer` headers.
- On load the page saves `{room: key}` in localStorage and **keeps the key in the address bar**, so bookmarks and
  "Add to Home Screen" work (an iPhone home-screen app has its own storage and only knows the address it was saved with).
  Opening the room from "My rooms" puts the key back in the address. If the address holds an outdated key (an old
  bookmark from before *Reset DM link*), the page falls back to the key this device already had.
  (M1 first hid the key from the address bar against over-the-shoulder reading; phones barely show the fragment,
  and it broke bookmarks, so that was dropped.)
- **Any device with the link is a DM device**, e.g. a laptop for prep and a tablet at the table.
  **Reset DM link** creates a new key and signs out every other device.
- **There's no recovery without the link, by design.** That's why the app asks the DM to confirm they saved it at creation time.
  On iPhone, adding the DM page to the home screen also escapes Safari's 7-day storage wipe.
- **Not doing:** passwords. They'd need slow hashing and make this an account system. Reconsider only if people keep losing their links.

### Player identity

- **Seat tokens** live in localStorage, one per room, so a player can be in several campaigns.
- **Spoofing:** typing someone else's name achieves nothing once that seat has been claimed, because re-claiming needs the DM's tap.
  If a prankster grabs an unclaimed seat first, the DM sees it, approves the real player, and the prankster is signed out. *Lock joining* closes the gap completely.
- **Known iPhone quirk:** Safari may wipe localStorage after ~7 days of Safari use without visiting the site.
  Home-screen web apps have their own storage and their own 7-day counter. Either way the fix is one tap by the DM, or the personal link.

### Room codes

- 6 Crockford-base32 characters (`K7Q-F2M`), about 1 billion combinations. Case-insensitive; O/0 and I/L/1 are treated as the same.
- **A room code is not a secret.** It's said aloud at the table. All it gives is the list of seat names and the ability to *ask* for a seat.
- **Brute-force guessing is rate limited** before any room is touched.

### Web hardening (`_headers`, plus the same headers from the Node host)

- **Content-Security-Policy:**
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  The landing and privacy pages also allow the Cloudflare Web Analytics script and endpoint.
- **Other headers:** `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, and a `Permissions-Policy` that allows nothing the app doesn't use.
- **No `innerHTML` with user content, ever.** Text is rendered with `textContent`. Line breaks come from CSS `white-space: pre-wrap`.
- **The API checks the `Origin` header** on POST requests and WebSocket upgrades, so other sites can't use it as a free backend.

### Abuse limits (hosted; the Node host has simple in-memory versions)

| What | Limit |
|---|---|
| Creating rooms | 5 per hour and 20 per day per IP (AdminDO counter, strict). |
| Joining or claiming / looking up room codes | 20 per minute per IP (Workers rate-limit binding, approximate; AdminDO as a fallback). |
| Uploads | 60 per hour per room, 50 MB per room, **global soft cap of 4 GB** (AdminDO tally), then *"storage is full today — self-host?"* |
| Content sizes | 12 seats; 1,000 cards; title 120 characters; body 4,000 characters. |
| WebSocket | Players' messages over 4 KB are dropped; more than ~2 messages per second per socket closes it. |
| Reports | 10 per hour per IP. |

**IPs are never stored.** Rate limiting uses `SHA-256(ip + daily salt)`, deleted after 24 h.

### Reports and the admin page (hosted mode only)

- **Players:** *Report* on an item (reason + optional note). The room checks the seat can see that card, then sends a **snapshot**
  (title, text, image ids, room code, time) to the AdminDO.
- **Anyone else:** a form on the landing page (room code + text), e.g. for someone who was sent an abusive personal link.
- **`/admin`** (protected by `ADMIN_TOKEN`, a wrangler secret):
  - lists reports, and shows the reported item (images fetched with the admin token)
  - **Freeze room** (no further reveals or edits, players see "under review") and **Delete room**
  - aggregate counters and the global storage figure
  - You'll check it yourself now and then. The privacy page explains how reports are handled.
- **Legal (not legal advice):** the EU Digital Services Act expects even small hosting services to have an easy way to report illegal content
  and a point of contact. The report button, the form and the contact email cover that.
- **No CSAM scanning:** Cloudflare's CSAM scanning tool needs a domain on Cloudflare, so it isn't available on workers.dev.
  The mitigations are images visible only inside a room, no public URLs, 60-day expiry, reports and freezing. Revisit if you buy a domain.

### Privacy (EU/GDPR)

- **No accounts. No cookies at all.** localStorage holds only the tokens needed for the service the user asked for, which EU rules allow without a consent banner.
- **What's stored:** seat names (character names encouraged), card text and images, hashed tokens, timestamps and receipts.
  **No emails, no IPs** (only the salted daily hashes above).
- **How long:**
  - Rooms are **deleted 60 days after their last use** (any DM action or player connection).
  - The DM can **Delete room now** at any time.
  - A player can **Leave room**, which deletes their token and the feed cached on their phone.
  - Reports are deleted 90 days after they're closed.
- **Where:** on Cloudflare, rooms will use **EU-restricted Durable Objects** (`env.ROOM.jurisdiction('eu')`), if the free plan allows it (check in M0).
  **Decide this before launch:** IDs are tied to the jurisdiction, so changing it later strands existing rooms.
  Non-EU players get ~100 ms more latency, which this app won't notice.
- **Analytics:** Cloudflare Web Analytics (no cookies) **only on the landing and privacy pages**. Never on room pages, so room URLs and fragments are never collected.
  Usage numbers come from the AdminDO's aggregate counters.
- **Privacy page:** a short EN + PT page (a one-line summary, then who / what / where / how long / why / your rights) covering who runs it (you, plus a contact email), what's stored, why, for how long,
  Cloudflare as processor, how to delete, and how reports work. Self-hosted instances show a note saying the operator is whoever runs the server.

---

## 9. Self-hosted mode (Node / Docker)

- **Requirements:** Node ≥ 22.13 (for `node:sqlite` without a flag; Node 24 LTS recommended) and one dependency, `ws`.
- **Running it:**
  - `node src/node/server.js` serves `public/` and `/api/*` on port 8080, with data in `./data/` (one SQLite file per room, plus `admin.sqlite`).
  - **Docker:** a `node:24-alpine` image (~60 MB), built for amd64 and arm64 (a Raspberry Pi works).
    Published to GitHub Container Registry by a GitHub Action (free for public repos).

  ```bash
  docker run -d --name whisperer -p 8080:8080 -v whisperer-data:/data --restart unless-stopped ghcr.io/<you>/tabletop-whisperer
  ```

- **LAN join:** the server finds its LAN addresses (`os.networkInterfaces()`) and serves them in `/config.js`.
  The DM opens `http://localhost:8080` on the laptop, and the join QR code shows `http://192.168.1.23:8080/play?r=…`.
  If the laptop has several network addresses, the DM picks one.
- **What changes in local mode** (`config.js` → `{mode:'local'}`):
  - no reports, admin page or analytics
  - limits and caps are set through environment variables (e.g. `ROOM_EXPIRY_DAYS=0` turns expiry off)
  - the landing page skips the marketing and opens straight to "Create / open a room"
- **Limits of local mode, written in the README:**
  - **Plain `http://` on a LAN isn't a secure context**, so *Keep screen on* is hidden and *Copy* falls back to selecting the text.
    Vibration still works on Android. The client code avoids secure-context-only APIs (`crypto.getRandomValues`, not `randomUUID`).
    For full features, use a **home server with a domain behind Caddy**, which gets an HTTPS certificate automatically (README snippet).
  - **Router "client isolation"** (game stores, guest Wi-Fi) blocks phones from reaching the laptop. Use the laptop's hotspot instead.
  - **The firewall** must allow port 8080. Windows and macOS ask once.
  - **The laptop must not sleep** during the session.

---

## 10. Mobile UX notes

### Both sides

- **Three themes, picked per device in Settings** (and on the landing page): **Candlelit** (default; dark and warm, umber wood, parchment notes, candle amber, self-hosted Alegreya) and **Light** (plain: grey page, white cards, crimson accent, dark top bar, the device's own sans-serif) and **Dark** (Light's layout in dark greys, close to how Dark Reader renders Light), or *Match device* (Light or Dark from the device setting). `js/theme.js` applies the choice in `<head>` before the page paints. Every colour is a CSS variable, so a theme is one block of values. Body ≥ 17 px, tap targets ≥ 44 px.
- Respects `safe-area-inset-*` and uses `100dvh`. `overscroll-behavior: contain` stops a swipe from reloading the page by accident.
  Pinch-zoom is never disabled.
- Respects `prefers-reduced-motion`.
- **i18n:** `t('key', {vars})`, with `Intl.PluralRules`, `DateTimeFormat` and `RelativeTimeFormat`.
  - Language: the saved choice, then `navigator.languages`, then English. Any `pt-*` gets pt-PT until someone contributes pt-BR.
  - Static HTML uses `data-i18n` attributes. Error codes from the server are neutral codes the client translates.
  - A test checks that every locale has the same keys.

### Player

- One column, no navigation. A small status dot and a gear icon are the only interface around the feed.
- **Vibration: later (M3).** Tried in M1 and dropped for now: iPhones and Firefox (since 129) can't vibrate for web pages, Chrome needs a tap after every load, and WebView browsers (DuckDuckGo) ignore it silently. New whispers glow instead.
- **Quiet by design:** no sound and no vibration; new whispers glow until seen.
- **Keep screen on:** Wake Lock, requested again after `visibilitychange` (the browser releases it when the page is hidden). It warns about battery use.
- Reader and image viewer are full-screen `<dialog>` elements, so the back gesture closes them (handled with `history.pushState`).
- A **"N new ↑" pill** appears when new items arrive while the player is scrolled down.

### DM

- **Phone:** bottom tabs **Table · Cards · Room**. The reveal bar (chips + *Reveal to N*) sticks to the bottom, where a thumb reaches it.
- **Tablet (≥ 800 px):** the Table column (quick whisper + recent reveals) stays on the left; Cards or Room fill the rest.
- **Desktop (≥ 1100 px), during the session too:** three columns: Table · Cards · the open card (chips, Reveal, who has it, receipts).
  Nothing covers the table view. Keyboard: `/` search, `1`–`9` pick players, `E` everyone, `Ctrl/⌘+Enter` reveals or sends
  the quick whisper (never plain Enter), `Esc` closes the card. The card editor opens as a dialog.
- **Avoiding mistakes:** the button says who it goes to ("Reveal to Ana, Bruno"), chips clear after each reveal, *Undo* shows for 6 s, and un-reveal and edit are one tap away.
- The DM's screen also gets *Keep screen on*.
- **Seat chips double as status.** The colours never look like a reveal happened. An undelivered reveal shows as a hollow ✓.

---

## 11. Free-tier limits and risks

Checked in Oct 2026; see the sources at the end. Daily limits reset at **00:00 UTC** (00:00 Lisbon time in winter, 01:00 in summer).

| Resource (Free) | Limit | Rough use per 4 h session (DM + 5 players) | Biggest risk / mitigation |
|---|---|---|---|
| Static assets | **Free and unlimited** | All pages, JS and CSS | The app shell **keeps loading even when everything else is over the limit**, so the error message can always be shown. |
| Worker requests | 100k / day | ~300 (sockets, reconnects, first image loads, DM changes) | ≈ 300 sessions a day. Pings are auto-answered; images are cached on the device. |
| DO requests | 100k / day | ~330 (incoming WebSocket messages count 20:1) | Batched `got`/`seen` messages. |
| DO rows written | 100k / day | ~300–500 | **Probably the first limit hit.** Batch `got`+`seen` into one write, keep indexes few, avoid writes on reads. |
| DO rows read | 5M / day | small | — |
| DO run time | 13,000 GB-s / day | tiny with hibernation | No timers in DOs. |
| DO storage | **5 GB total**, ~1 GB per DO (Free) | images dominate | **The long-term limit.** 50 MB per room, 4 GB soft cap, 60-day expiry. |
| Workers CPU | 10 ms per request | the router only | Hashing and parsing run in the DO (30 s CPU limit). |

**When a limit is hit:**
- The Worker over its daily limit returns 429 / error 1027 on `/api/*`, while static pages keep working.
- A DO over a limit throws, which the Worker turns into `{error:'over_capacity'}`.
- The client turns both into a calm banner: *"Tabletop Whisperer hit today's free limit. It resets at 01:00 (your time). Run your own copy in 2 minutes →"* (links to the self-host section).
- **During a session:** the DM sees *"Live delivery paused"*, so they know to fall back to paper. Nothing is lost; it delivers after the reset.

**Other risks:**
- Cloudflare could change the free tier. The self-host path is the insurance.
- workers.dev links can be distrusted by some filters. A domain fixes that if needed.
- Rate limits can be gamed. Strict counts go in the AdminDO; the rest are approximate.
- Rate limits can't be fully trusted: the binding is approximate and counts per location. Strict limits use the AdminDO.

---

## 12. Milestones

Both hosts are in v1. I don't know the date of your next session; tell me and I'll mark a cut line. Below, ⭐ = needed for the table test, ◇ = can slip to M2.

### M0: skeleton (1 evening)

- `git init`, MIT LICENSE, `package.json`, `wrangler.jsonc` with RoomDO/AdminDO (`new_sqlite_classes`) and `env.staging`, Dockerfile.
- "Hello" deployed to `tabletop-whisperer-staging.<you>.workers.dev` **and** run locally with Node.
  - Check that `jurisdiction('eu')` and the rate-limit binding work on the free plan.
  - Check `node:sqlite` on your Node version.
- `src/core` adapter interface + schema + first `node --test` tests running on `node:sqlite`.

**M0 findings:**
- Local `workerd` doesn't implement DO jurisdictions, so `pnpm dev:cf` clears `DO_JURISDICTION`.
- **Confirmed on the deployed staging Worker (free plan):** EU-restricted Durable Objects work (`jurisdiction: "eu"`, DO ping ok), and the Workers rate-limit binding works. Rooms stay `'eu'` from now on.
- Durable Object SQL refuses some SQLite functions (`sqlite_version()` was refused). The core must stick to plain SQL; the tests on `node:sqlite` won't catch this, so the smoke test against `pnpm dev:cf` matters.
- pnpm only runs install scripts it has been told to trust (`pnpm-workspace.yaml` → `allowBuilds`: esbuild, workerd).

### M1: v1, table test (both hosts)

- ⭐ Create a room (name, seats) → DM link (save-it screen) → DM page on phone and desktop.
- ⭐ Cards: create, edit, delete, search; text + images (resize, thumbnails, upload, server checks).
- ⭐ Reveal to chips / Everyone; quick whisper; un-reveal; live edit with *edited*; undo bar.
- ⭐ Player join: code → seat claim → feed; DM approve for re-claims; *Lock joining*.
- ⭐ Feed: grouped by session, reader view, pinch-zoom viewer, glow + vibration, keep screen on, reconnect + catch-up.
- ⭐ Receipts ✓ / ✓✓ and presence 🟢🌙⚪ on the DM screen.
- ⭐ **Security tests** ([§5](#5-how-secrets-stay-secret-server-side-filtering)) passing against the core **and** both live hosts.
- ⭐ EN + pt-PT for every string; dark theme.
- ⭐ Node host: LAN URL + QR, Docker image builds and runs.
- ◇ Personal links + QR per seat · 👍 Got it · join QR on the DM screen (the room code works without it) · *Reset DM link*.

**Table test checklist:**
1. At home: two browsers + two phones on staging, then on the laptop host.
2. **Use devtools on a player's phone (or Chrome remote debugging) to look for another player's secret** in the page source, network tab and WebSocket frames.
3. At the session: lock a phone for 10 minutes, then wake it; reload; toggle airplane mode; claim the wrong seat; reveal to someone who hasn't joined.

### M1.5: prep tools (done)

Asked for after the first table test, to make reveals quicker mid-game:
- **Pre-picked players + private note.** Each card can say who it's usually for (pre-selected when you open it, so a
  reveal is one tap) and carry a DM-only note ("DC 15 Perception"). Both are filtered out of everything players
  receive, like any other DM-only field (§5, tested).
- **Group bar** (one tap per group/scene) and a **To reveal / Revealed / All** filter, remembered per device.
- **Drag to reorder** within a list (arrow keys on the handle do the same), and **Duplicate** (copies text, note,
  players and images; nothing revealed).
- **Import cards** from pasted notes or a `.txt` / `.md` file: `#` group, `##` card, optional `for:` / `note:` lines
  (also `para:` / `nota:`). Preview with warnings before anything is created; all-or-nothing on the server.
  Up to 200 cards per import. The reader is `public/js/import-text.js`, tested on its own.

### M2: public launch

- ✅ Landing page (one sentence, how it works, why it's different, Create / Join, footer links; demo GIF slot for launch) + privacy page, EN + PT. Who runs the instance (name, contact email, repo link) lives in `public/site.js`. **Before launch: replace its `[PLACEHOLDER]` values.** Self-hosted copies skip the introduction and show a "run by whoever set it up" privacy notice.
- ✅ 60-day expiry (a Durable Object alarm per room; an hourly sweep on the Node host, `ROOM_EXPIRY_DAYS`, 0 = never) + "if nobody uses it, it goes on…" on the Room tab; *Delete room* (type the code to confirm); *Leave room*.
- ✅ **Export / import a campaign** (moved here from M3: once rooms delete themselves, DMs need a way to keep their prep).
  - **Export** (Room → *Export campaign*): one `.json` file with the room name, seat names, cards, groups and images
    (base64), plus the reveal history (who got what, when, which session). Streamed by the room, since it can reach ~70 MB.
    Seat tokens, links and the DM key are never exported.
  - **Import** (landing page → *Create a room* → *From an export file*): makes a new room and asks
    *Keep who has what* (moving hosts or restoring a backup) or *Start fresh* (run the same prep for another group).
    Seats come in unclaimed, so players join again. Same validation as normal input; images are re-checked.
  - The expiry note on the DM screen links to *Export campaign*. Files move between hosted and self-hosted versions.
- ✅ "Report a problem" in the player's Settings (a bug or problem with the app, or a content problem: pick one of your whispers to attach a copy of it, or "something else"; not a button on every whisper: this is played face to face) + public form (`/report`, linked from the landing page and privacy page) + `/admin` (read reports with a snapshot of the card, freeze / unfreeze / delete the room, close / delete reports). Reports live in one `AdminDO` (Node: `data/admin.sqlite`); `/api/admin/*` needs `ADMIN_TOKEN` (a wrangler secret; on Node an env var, which also turns reporting on). Operator routes in a room need both the router's path check and a marker header only the admin router sets. Closed reports are deleted after 90 days. **Stats** on `/admin`: active rooms, rooms, storage used of the free 5 GB, open reports, and 30-day bar charts of reveals, rooms created and players joining (rooms send anonymous events to the admin store).
- All rate limits and caps, global storage tally, over-the-limit banners (tested by forcing errors).
- Web Analytics on the landing and privacy pages.
- GitHub Action building the multi-arch Docker image; *Deploy to Cloudflare* button; README.
- Accessibility pass (labels, focus, contrast, screen reader on the feed) and a review of the pt-PT strings by a native speaker at your table.

### M3+: later, if people want it

- "Add to Home Screen" hint + manifest polish; optional **Web Push** ("New whisper", no content); *Blur until tapped* for nosy neighbours.
- Drag-to-reorder, simple formatting (**bold**/*italic*), private DM notes on cards (never sent to players; the allowlist in §5 already protects them).
- pt-BR and other languages from contributors; Ko-fi link; a custom domain + CSAM scanning if hosting grows.

---

## 13. Testing

- **`node --test`, no test libraries:**
  - **core on `node:sqlite`:** permissions, `feedFor`, receipts, claims, sessions, edits, un-reveal, expiry, caps, image validation (magic bytes and dimensions from sample files)
  - **protocol:** message shapes
  - **i18n:** every locale has the same keys
- **`test/smoke.mjs`:** Node's built-in `WebSocket` + `fetch` against a running host. Run it on `wrangler dev`, the Node server, and staging.
  It creates a room, joins two seats, reveals, then checks what each socket and image request received
  (the [§5](#5-how-secrets-stay-secret-server-side-filtering) checks, end to end).
- **Manual phone checks:** iPhone Safari, Android Chrome, an iPad for the DM, and one small old Android.
- **Staging:** `--env staging`, because Cloudflare preview URLs don't work for Workers with Durable Objects.

---

## 14. Deployment

### Hosted (Cloudflare free tier)

1. `pnpm install`, then `pnpm wrangler login`.
2. `wrangler.jsonc` (outline):

   ```jsonc
   {
     "name": "tabletop-whisperer",
     "main": "src/cloudflare/worker.js",
     "compatibility_date": "2026-10-01",
     "assets": { "directory": "public", "html_handling": "auto-trailing-slash" },  // /api/* has no asset, so it reaches the Worker
     "durable_objects": { "bindings": [ { "name": "ROOM", "class_name": "RoomDO" }, { "name": "ADMIN", "class_name": "AdminDO" } ] },
     "migrations": [ { "tag": "v1", "new_sqlite_classes": ["RoomDO", "AdminDO"] } ],
     "ratelimits": [ { "name": "JOIN_LIMIT", "namespace_id": "1001", "simple": { "limit": 20, "period": 60 } } ],
     "observability": { "enabled": true },   // never log tokens or request bodies
     "env": { "staging": { "name": "tabletop-whisperer-staging" } }   // repeat the DO bindings here
   }
   ```

3. `pnpm wrangler secret put ADMIN_TOKEN` (and again with `--env staging`).
4. `pnpm deploy:staging`. Test on phones, then `pnpm run deploy`.
5. Optional: rename your account's workers.dev subdomain to something nicer. It changes the URL of all your Workers, including Shift Earnings.
6. Web Analytics: add the site in the dashboard and paste the snippet into `index.html` and `privacy.html` only.
7. During launch week, check Workers → Metrics and the `/admin` counters daily.

### Self-hosted

- `docker compose up -d`, or `pnpm install --prod && pnpm start`.
- Home server with HTTPS: a 3-line Caddyfile (`whisperer.example.org { reverse_proxy localhost:8080 }`).
- Backups = copy `data/`.

### Self-hosted on Cloudflare

- A **Deploy to Cloudflare** button in the README creates the Worker and DOs on the DM's own free account.
- No R2 means no payment method is needed. This is the answer to "the public instance is busy".

---

## 15. Launch

- **README** (in this order):
  1. One sentence + demo GIF + "Try it" link.
  2. **Why it's different:** no install (unlike Table Talk, where the GM runs a desktop server), one-way by design, and **secrets filtered on the server**,
     with a short "how we keep secrets secret" section that technical DMs will appreciate.
  3. Three ways to run it: hosted, Docker/laptop, Deploy to Cloudflare.
  4. Privacy summary, languages + how to add one, contributing (translations especially welcome), license.
- **Demo:**
  - A 15–20 s GIF (≤ 5 MB) plus an MP4 for the README.
  - Script: DM phone and player phone side by side; tap Ana, Reveal, Ana's phone glows, pinch-zoom on a map; Bruno's phone shows nothing.
  - Record with two phone-sized browser windows; on Linux, Kooha or Peek.
  - A few screenshots of the player feed and DM screen, in EN and PT.
- **Where to share** (read each community's self-promotion rules first; several only allow it in weekly threads):
  - **RPG:** r/DMAcademy, r/DnD, r/dndnext, r/rpg, r/TTRPG; RPG Discord servers; Mastodon/Bluesky #TTRPG.
  - **Self-hosting:** r/selfhosted and the selfh.st newsletter (the Docker angle is a real hook).
    awesome-selfhosted later (it requires projects to be some months old).
  - **Tech:** Show HN and r/opensource for the "free tier + server-side secrets" story.
  - **Portuguese-speaking:** RPG Discords and Facebook groups, and the game stores where you play. The pt-PT UI is a hook there.
  - An itch.io page as a free "tool" listing.
- **Ready for feedback:** GitHub issue templates (bug, translation, feature), a pinned "roadmap" issue, and Discussions turned on.

---

## Open decisions

1. **License:** MIT (recommended, for adoption) or AGPL-3.0 (anyone hosting a modified public copy must share their changes).
2. **Next session date**, so the ◇ items can be cut or kept.

## Sources

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [DO data location](https://developers.cloudflare.com/durable-objects/reference/data-location/) · [DO WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) · [Rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Preview URLs](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) · [R2 setup guide (payment method)](https://tech-insider.org/au/how-to-set-up-cloudflare-r2-2026/)
- [iOS haptics workaround status](https://rapidtoolset.com/en/tool/ios-haptics-tester) · [Safari 7-day storage cap](https://searchengineland.com/what-safaris-7-day-cap-on-script-writeable-storage-means-for-pwa-developers-332519) · [WebKit bug on home-screen apps](https://bugs.webkit.org/show_bug.cgi?id=237350)
- [Table Talk (itch.io)](https://opgc.itch.io/table-talk)
