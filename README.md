# OpenMuse

Pretty open-source desktop + mobile-ready UI for Muse Code.

Instead of reimplementing the agent, OpenMuse talks to the **real
`muse` binary on your machine** over its MSP session protocol
(`muse serve` over stdio) and renders it like Codex / Claude Desktop:
streaming transcript, tool activity, one-click approvals, session history.

Your Muse login stays yours — OpenMuse shells out to your local install,
so there is no extra API bill and no key to paste.

## Stack (phone-ready)

- `web/` — Vite + React + TypeScript, responsive + PWA manifest.
  Runs in any desktop browser now; later it can be wrapped with
  Capacitor/Tauri or installed as a PWA on a phone.
- `server/` — dependency-light Node bridge. Spawns `muse serve`,
  speaks JSON-RPC, exposes `GET /api/events` (SSE) + REST to the UI.

Phone path: the UI is responsive already. Run the server on your
desktop bound to LAN with `HOST=0.0.0.0 npm start`, open the phone
browser at `http://<desktop-ip>:3101`, and you get the same app.
Native wrappers come later without touching the UI.

## Quick start

Requirements: Node 20+, and `muse` on PATH (logged in).

```sh
cd openmuse
npm run install:all
npm run build
npm start
```

Then open http://localhost:3101 in a browser.

Dev mode (hot reload):

```sh
# terminal 1
npm run dev:server
# terminal 2
npm run dev:web
```

Then open http://localhost:5174 in a browser.

The composer accepts pasted (`Cmd+V`), dropped, or picked images (sent as
model image parts, up to 8 per turn) and text files (inlined into the
prompt); the footer collapses folder, model, effort, and approval into one
settings popover.

The **Browser** button (top right) docks a live browser pane on the right
side: enter any URL (`localhost:3000`, a dev server, or a live site),
navigate with back/forward/reload, zoom, and inspect. **Screenshot** captures
the page — attach it straight into the chat as an image, or download the PNG.
Full navigation/screenshots work in the desktop app; in a plain browser tab
pages render in an iframe (some sites block framing) and screenshots are
disabled.

## Desktop app (Electron)

The same UI + server wrapped as a real Mac app. It boots its own
bundled server on first launch (or reuses one already on port 3101).

```sh
npm run dist
```

Installers land in `electron/dist/` (`-arm64.dmg` for Apple Silicon,
`.dmg` for Intel). Unsigned build: on first launch, right-click the
app → Open to bypass Gatekeeper.

Desktop dev (hot reload via Vite) and smoke check:

```sh
npm run dev:server
npm run dev:web
npm --prefix electron run dev   # OPENMUSE_DEV=1 → loads http://localhost:5174/
npm --prefix electron run smoke # boots bundled server, prints SMOKE health, exits
```

`OPENMUSE_PORT` overrides the desktop port (default `3101`); it is
forwarded to the bundled server as `PORT`. If a server is already
listening on that port (e.g. `npm start`), the app reuses it.

Demo mode (no model calls, fake streaming transcript):

```sh
OPENMUSE_MOCK=1 npm start
```

## Config

| env | default | meaning |
| --- | ------- | ------- |
| `PORT` | `3101` | HTTP port |
| `HOST` | `127.0.0.1` | bind address (`0.0.0.0` for LAN/phone access) |
| `MUSE_BIN` | `muse` | muse binary |
| `OPENMUSE_WORKSPACE` | server cwd | workspace root for sessions |
| `OPENMUSE_MOCK` | off | `1` = fake host for UI demo |
| `MUSE_EXTRA_ARGS` | empty | extra args appended to `muse serve` |

## License

MIT — see [LICENSE](LICENSE).
