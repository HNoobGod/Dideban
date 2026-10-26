<div dir="ltr">

# Dideban

**Dideban** ("lookout") is a live companion map for **Arma 3** that runs **outside** the game, in any browser on your PC, phone or tablet. A small mod collects what your own side can see in game; a local Python server relays it to the browser in real time.

It shows friendly players, AI and vehicles moving live, every map marker you can see, a deep status page for any friendly unit or vehicle (gauges, weapons and ammunition, damage, crew, inventory), a customisable dashboard workspace and an artillery fire calculator. You can place and delete markers from the app and they appear in game instantly. The interface is bilingual: **English** and **Persian (فارسی, right-to-left)**.

> Persian readers: the full user guide in Persian follows the English part, further down this page.

---

## Contents
1. [Features](#features)
2. [Requirements](#requirements)
3. [Install (once)](#install)
4. [Run and open the app](#run)
5. [Connect from a phone or tablet](#phone)
6. [Get a map (satellite and topographic)](#getmap)
7. [Using the app](#usage)
8. [Settings and configuration](#settings)
9. [Troubleshooting](#troubleshooting)
10. [How it works (architecture and data flow)](#how)
11. [Project structure](#structure)
12. [Development and testing](#dev)
13. [Limitations](#limitations)

---

## <a name="features"></a>1. Features

- **Live map**: friendly players, AI, manned vehicles and (optionally) empty friendly vehicles, with smooth interpolated motion at up to 20 position updates per second. Side colours, facing arrows and view cones, health bars, "needs a medic" marks, group names.
- **Markers**: every marker you can see in game. Place icon markers, text and lines from the app (right-click or long-press), delete the ones you placed; they appear in game immediately.
- **Map styles**: satellite (read from the game's own map files), topographic (heights, contours, roads, buildings, place names) or a hybrid of both, with brightness per style. 2D or **3D** terrain view.
- **Map controls**: compass with heading and grid readout (drag to move, tap to switch north-up / heading-up), live cursor grid reference and ground height, **Follow** (keeps a unit centred until you pan) and **Center on me** (one-off jump), map picker for any map you have extracted.
- **Detail pages** for any friendly unit or vehicle, shown beside the map or popped out into their own window (whole page or one tab):
  - *Overview*: speed, altitude, artificial horizon, heading, fuel and health instruments that follow the live position stream; gun turret direction.
  - *Weapons*: every weapon with loaded rounds and spare magazines, aircraft pylon loadout, laser and countermeasures; for soldiers, the itemised kit.
  - *Damage* (vehicles) and *Health* (soldiers, ACE medical aware).
  - *Crew*: seat map, who sits where, their health and personal weapons.
  - *Inventory / Cargo*.
  - A freshness chip (Live, late, stale, offline) so old data never passes for live.
- **Workspace**: a dashboard of panels over the map or on a solid background. Preset layouts (Pilot, Tank gunner, Commander, Infantry loadout, Vehicle diagnostics, Minimal overview), panels you can move, resize, dock, float, maximise and customise part by part, named layouts you can save, duplicate, rename, export and import, and optional automatic layout switching by the vehicle you are in. Layouts are stored in the browser.
- **Artillery calculator** ("Fire calc"): firing solutions for the gun you are in, a friendly gun or a manually chosen weapon, using the weapon data read from the game.
- **Combat log**: kills, deaths and friendly fire are written to `logs/dideban-YYYYMMDD.log`; fallen friendlies stay on the roster (in red) until they respawn.
- **Connection recovery**: the app reconnects by itself after the server or the game restarts, re-subscribes its detail pages after a mission restart, and marks frozen data (a "Game disconnected: last known positions" badge) instead of showing it as live.
- **Responsive UI**: a desktop layout with a resizable side panel, and a dedicated phone layout with a compact top bar, a bottom sheet for units/markers/settings, a bottom drawing-tools strip and large touch targets. Works in portrait and landscape.
- **Optional, experimental camera features** (off by default; *under development, not recommended yet*): a first-person view built from map data, the live game picture and another unit's helmet cam.

---

## <a name="requirements"></a>2. Requirements

- **Windows** 10 or 11 with **Arma 3**.
- **Python 3** (3.10 or newer). `install.bat` installs it with winget if it is missing.
- **Pillow** (installed by `install.bat`): needed to build satellite map images.
- **mss** (optional): only for the live game picture / helmet cam (`python -m pip install --user mss`).
- A modern browser (Chrome, Edge, Firefox, Safari) on the PC, phone or tablet.

The server uses only the Python standard library apart from Pillow and the optional mss. There is no Node.js build step: the web app is plain JavaScript served as-is.

---

## <a name="install"></a>3. Install (once)

1. **Subscribe** to Dideban on the Steam Workshop. The item's folder is the mod itself and already contains the built, signed mod files. Find it at either of these (the drive depends on your Steam library):
   ```
   <SteamLibrary>\steamapps\common\Arma 3\!Workshop\@Dideban
   <SteamLibrary>\steamapps\workshop\content\107410\3824497242
   ```
   The `!Workshop\@Dideban` shortcut is made by the Arma 3 Launcher and is sometimes missing; the second path always exists. In Steam: right-click **Arma 3 → Manage → Browse local files**, go up two folders to `steamapps`, then open `workshop\content\107410\3824497242`.
2. Run **`install.bat`** from that folder. It checks Python, installs Pillow and puts a **Dideban** shortcut to `start_server.bat` on your desktop.
3. In the **Arma 3 Launcher**, enable **Dideban** and start the game. No other mod is needed.
   *(Optional: add `-noPause` under Parameters so the live game picture keeps running when the game window is in the background.)*
4. Join a **mission** (Editor, single player or multiplayer). Until you are in a mission the app receives no data.

---

## <a name="run"></a>4. Run and open the app

1. Double-click the **Dideban** desktop shortcut (or run `start_server.bat`). A console window opens and prints the addresses:
   ```
   This PC:        http://localhost:8080
   Phone / tablet: http://192.168.x.x:8080
   ```
2. Open **`http://localhost:8080`** in a browser on this PC.
3. The status dot in the top bar:
   - **Red** = the server is offline (`start_server.bat` is not running).
   - **Yellow** = waiting for the game (mod not enabled, or not in a mission yet).
   - **Green** = the game is connected.

Keep the console window open while you use the app; `Ctrl+C` or closing it stops the server.

Server options (`start_server.bat` passes them on, e.g. `start_server.bat --http-port 8090`):

| Option | Default | Meaning |
|---|---|---|
| `--host` | `0.0.0.0` | HTTP bind address; `0.0.0.0` makes it reachable from phones on your network, `127.0.0.1` keeps it on this PC |
| `--http-port` | `8080` | Port of the web app |
| `--game-port` | `28901` | Local TCP port the game extension connects to (must stay 28901 for the shipped extension) |
| `--arma-dir` | from the registry / settings | Arma 3 folder, used to read satellite images from the map files |
| `-v`, `--verbose` | off | Debug logging |

---

## <a name="phone"></a>5. Connect from a phone or tablet

1. The phone and the PC must be on the **same network** (Wi-Fi).
2. Open the `http://192.168.x.x:8080` address the server window printed.
3. If it does not load, the **Windows Firewall** is usually blocking it: allow Python on private networks.

On a phone, the **☰** button opens the units / markers / settings sheet (tap the handle or the button again to close it); drawing tools sit along the bottom; Follow and Center on me are the round buttons at the bottom-right.

---

## <a name="getmap"></a>6. Get a map (satellite and topographic)

The first time you connect on a new map, a banner offers three buttons:

| Button | What you get | Time |
|---|---|---|
| **Satellite + topo map** | both of the below (recommended) | — |
| **Satellite only** | the map's original satellite image, read from the game files on this PC | seconds to minutes |
| **Topo map only** | heights, roads, buildings, contour lines, place names; enables 3D | 1–5 min (the game stutters a little) |

Results are cached in the `cache` folder and load instantly next time. Both buttons are also in **Settings** ("Satellite image" and "Topographic map").

---

## <a name="usage"></a>7. Using the app

**Top bar** (left to right): side panel toggle, connection status and mission, map picker (*Auto* follows the game), view controls (2D/3D, map style, north-up / heading-up, collapse arrow), **Fire calc**, **Workspace** menu, fullscreen, hide top bar. On narrow screens text labels collapse to icons.

**Side panel** (desktop: left, drag its edge to resize; phone: bottom sheet):
- **Units**: groups and units with health, players, vehicles and the fallen. Click a unit to centre on it and select it.
- **Markers**: all visible markers; × deletes a marker you placed.
- **Settings**: language, map style and brightness, update rate, grid precision (6 or 8 digits), calculator settings, ammunition warning thresholds, satellite/topo extraction, game folder setup (only from the PC running the server), layers, interface toggles, keep-screen-awake, movable menus.

**Map**:
- Drag to pan, wheel or pinch to zoom. In 3D: drag rotates, right-drag or Shift+drag pans.
- Click (tap) a unit, vehicle or marker for its info card: **Follow**, **Details** (opens the detail page) and, for your own markers, **Delete**.
- Right-click or long-press: new marker. The left (desktop) / bottom (phone) tools switch between select, marker, line and text; a line is finished with *Done*, a right-click or a double-click.
- **Follow** (arrow button) keeps the followed unit centred and turns off as soon as you pan; **Center on me** (target button) jumps once.

**Detail page**: tabs across the top; ⤢ makes it fill the screen, ↗ opens it in its own window, the small icon on a tab pops just that tab out, and the slider icon sends that tab to the workspace for customising.

**Workspace** (the *Workspace* button): pick a layout, *Customize layout* to edit (move, resize, dock, float, add panels from the library, edit a panel's parts), *Save* / *Save as…*, export/import a layout file, *Fullscreen workspace* or *Open workspace in a new window*. Esc restores a maximised panel or closes the menu. On a phone the workspace is one scrolling column shown instead of the map.

---

## <a name="settings"></a>8. Settings and configuration

- **Per-browser settings** (language, layers, map style, brightness, grid, panel widths, workspace layouts, etc.) are kept in the browser's local storage (`a3map.*` keys). Clearing the site data resets them.
- **Server settings** are in `config.json` next to `start_server.bat` (created on first change; `config.sample.json` shows the keys):

| Key | Meaning |
|---|---|
| `arma_dir` | Arma 3 folder (empty = detect from the registry); set from *Settings → Game & mod setup* on the PC |
| `mods_dir` | reserved by the installer |
| `pos_interval` | seconds between position updates sent by the game (0.05 = 20/s); set from *Settings → Position update rate* |
| `all_sides` | stored server option; leave it as it is |

No credentials or API keys are used. The server only accepts the game connection on `127.0.0.1`, and the folder setup endpoints only accept requests from the PC itself.

---

## <a name="troubleshooting"></a>9. Troubleshooting

| Problem | Cause / fix |
|---|---|
| **"Server offline"** (red dot) | Start `start_server.bat`. If the window closes immediately, run it from a command prompt to read the error (usually Python missing: run `install.bat`). |
| **"Waiting for the game…"** (yellow dot) | Enable Dideban in the launcher and join a mission; the main menu is not enough. |
| **"Game disconnected: last known positions"** | The game left (mission ended, game closed, extension reconnecting). Units are frozen until it is back; the app resumes by itself. |
| **Detail page says *stale* or *offline*** | No fresh detail data: the game is paused/disconnected, or the unit is gone. After a mission restart the page looks the unit up again; if it cannot, pick it again on the map. |
| **Phone will not connect** | Same Wi-Fi; allow Python through the Windows Firewall; use the `192.168.x.x` address from the server window. |
| **Port 8080 already in use** | Start with another port: `start_server.bat --http-port 8090`. |
| **Satellite "files not found"** | The map does not use a standard image layout, or it is an encrypted **EBO** map, which cannot be read. Check the Arma 3 folder in *Settings → Game & mod setup*. |
| **"Pillow is not installed"** in the console | `python -m pip install --user pillow` (or run `install.bat` again). |
| **Live picture is black** | Run the game *Windowed* or *Borderless*, and install `mss`. |
| **Old image / old code after an update** | Restart the server and press `Ctrl+F5` in the browser. |
| **Layout looks wrong after resizing / rotating** | It re-flows on its own; if a moved menu ended up off-screen, use *Settings → Menu position → Reset positions*. Workspace: *Restore default arrangement*. |
| **Workspace layouts lost** | They live in this browser only; use *Export to a file…* to keep a copy or move them to another device. |

The server console shows connection events and errors (`-v` for more). Combat log files are in `logs/`.

---

## <a name="how"></a>10. How it works (architecture and data flow)

```
Arma 3 ── @dideban mod (SQF) ── dideban_x64.dll ──TCP 127.0.0.1:28901──▶ server/main.py (Python)
                                                                               │
                                                     HTTP :8080 (static app + JSON API) + Server-Sent Events
                                                                               ▼
                                                                browser (PC / phone / tablet)
```

1. **In game** (`addons/dideban.pbo`, SQF): `fn_init` runs a loop that sends the full **state** once per second (`fn_collectState`: groups, units, vehicles, markers, empty vehicles, fallen) and, every frame it is due, **positions** (`fn_collectPositions`, default 20/s) and **detail** for the entities the app watches (`fn_collectDetail`, about 10/s). Only sides friendly to the player are collected. Commands from the server (markers, terrain export, update rate, detail subscriptions, calculator queries) are read by `fn_handleCommand` with `parseSimpleArray`, so no code is ever executed from outside.
2. **The extension** `dideban_x64.dll` forwards each line over local TCP. Lines are SQF array literals (`server/sqf.py` converts them).
3. **The server** (`server/main.py`) converts messages to JSON and fans them out to every browser over **Server-Sent Events** (`GET /events`): `status`, `meta`, `state`, `state_reset`, `pos`, `detail`, `progress`, `maps`, `settings`, `terrain`, `logevent` and the calculator's `arty_db` / `arty_state`. A newly connected browser first gets a snapshot. Each mission run has a session id, so ids from a previous run are never mixed with the new one.
4. **The browser** (`web/`) draws the map on a canvas (WebGL for 3D), interpolates positions between updates, and sends commands with `POST /api/command` (e.g. `marker_create`, `marker_delete`, `terrain_export`, `sat_export`, `pos_interval`, `detail_watch`). Detail pages send a `detail_watch` heartbeat every 2 s; the server drops entities nobody has watched for 6 s, so the game stops collecting them.

Other endpoints: `GET /api/status`, `/api/maps`, `/api/terrain/<world>` (gzip JSON), `/api/sat/<map>/info|dem|<level>/<x>_<y>.jpg`, `/api/arty/db`, `/api/stream/game.mjpg` and `helmet.mjpg` (needs mss), `GET/POST /api/setup` (local PC only).

---

## <a name="structure"></a>11. Project structure

| Path | Contents |
|---|---|
| `start_server.bat`, `install.bat` | Start the server; one-time setup (Python, Pillow, desktop shortcut) |
| `mod.cpp`, `addons/dideban.pbo`, `keys/`, `dideban_x64.dll`, `Image/` | The Arma 3 mod: SQF functions (packed), signing key, extension DLL, logos |
| `config.sample.json` | Example server settings (`config.json` is created next to it) |
| `server/main.py` | Entry point: game link (TCP), HTTP server, SSE hub, commands, message conversion |
| `server/sqf.py` | SQF array literal parser / writer |
| `server/terrain.py` | Assembles and caches the topographic export (`cache/<map>.json.gz`) |
| `server/satellite.py`, `server/satextract.py` | Satellite tile pyramid; reading PAA images straight from the map PBOs |
| `server/arty.py` | Artillery weapon database per mod set and terrain/conditions queries |
| `server/capture.py`, `server/installer.py` | Live screen capture (mss); settings and Arma folder detection |
| `web/index.html` | The page and its static markup |
| `web/app.js` | Main app: map rendering and controls, units/markers lists, info card, detail pages and gauges, SSE connection, settings |
| `web/workspace.js` | The customisable workspace (layouts, panels, components, editor, storage) |
| `web/artillery.js`, `web/ballistics.js` | Fire calculator UI and its ballistics solver |
| `web/view3d.js` | WebGL 3D terrain, buildings and vehicles |
| `web/i18n.js` | English and Persian strings, `t()` and static translation |
| `web/style.css` | All styles: design tokens (`:root`), layout, phone (`max-width: 760px`) and tablet breakpoints, detail and workspace components |
| `tests/` | `ballistics.test.js` (Node), `test_arty.py` (Python unittest) |
| `tools/fake_game.py` | Simulated game client for development (see below) |
| `cache/`, `logs/` | Generated: map caches and combat log files |
| `backup-before-*/` | Copies of files from before earlier updates (safe to delete once you are happy) |

---

## <a name="dev"></a>12. Development and testing

There is no build step and no package manager: edit the files, restart the server (Python changes) and reload the page with `Ctrl+F5` (web changes).

**Run the tests** (from the mod folder):
```
python -m unittest discover tests
node --test tests/ballistics.test.js
```
(`node --test tests/` with a folder argument does not work on recent Node versions; name the file or use a glob such as `node --test "tests/*.test.js"`.)

**Run without the game**: start the server, then the simulated game client, then open the app:
```
python server\main.py
python tools\fake_game.py server
```
It streams a moving player, a helicopter with crew, wounded soldiers, markers and a fallen friendly, and answers detail subscriptions, so the map, lists, detail pages, workspace and reconnect behaviour can be exercised in any browser. Stopping and restarting it looks like the game reconnecting; passing a new session name (`python tools\fake_game.py server 28901 RUN-2`) looks like a mission restart.

**Notes for extending the app**
- Strings go into `web/i18n.js` for both languages; use `t('key')` and `data-i18n*` attributes. Layout must work in RTL: prefer logical CSS properties (`inset-inline-start`, `margin-inline-end`).
- Add design values as tokens in `:root` in `style.css` and reuse the shared control styles (`.btn`, `.icon-btn`, `.seg`, `.map-btn`).
- New detail sections should render from the detail payload only (`S.details[id]`), never collect data on their own; workspace components reuse those renderers.
- New fields in game messages must be optional on the server and in the app (older mod versions do not send them).
- **Repacking the mod**: the SQF sources are packed into `addons/dideban.pbo` (prefix `dideban`). A repacked PBO no longer matches `dideban.pbo.HNoobGod_Dideban.bisign`; servers that verify signatures need it re-signed with the author's key (`tools\release.py` in the source repository, not included in the Workshop folder).

---

## <a name="limitations"></a>13. Limitations

- Only sides friendly to the player are collected; enemies are never shown.
- One game at a time: the newest game connection replaces the previous one.
- Encrypted (EBO) maps cannot be extracted; the topographic export makes the game stutter briefly.
- Workspace layouts and per-browser settings are not synced between devices (use export / import).
- The camera features are experimental and off by default.
- The current `addons/dideban.pbo` has been repacked since it was signed (see *Repacking the mod*); multiplayer servers that verify signatures will reject it until it is re-signed.
- On a phone, the browser may stop the live stream while the screen is off or the tab is in the background; it reconnects when you return.

---
</div>

<div dir="rtl">

# دیده‌بان (Dideban) — راهنمای کامل

نقشه‌ی زنده‌ی Arma 3 بیرون از بازی، روی **مرورگر، گوشی یا تبلت**. یگان‌های خودی (بازیکن‌ها، هوش مصنوعی، خودروها) و همه‌ی مارکرهایی که خودت در بازی می‌بینی، به‌صورتِ زنده روی نقشه نشان داده می‌شوند. از داخلِ برنامه هم می‌توانی مارکر بگذاری یا پاک کنی و همان لحظه در بازی ظاهر می‌شود.

---

## فهرست
1. [پیش‌نیازها](#پیشنیازها)
2. [نصب (یک‌بار)](#نصب-یکبار)
3. [اجرا و باز کردنِ برنامه](#اجرا)
4. [اتصال از گوشی / تبلت](#اتصال-از-گوشی)
5. [گرفتنِ نقشه‌ی یک مپ (ماهواره و توپوگرافی)](#گرفتن-نقشه)
6. [قابلیت‌ها](#قابلیتها)
7. [تنظیمات](#تنظیمات)
8. [عیب‌یابی](#عیبیابی)
9. [این برنامه چطور کار می‌کند](#چطور-کار-میکند)
10. [نکات فنی و پیشرفته](#نکات-فنی)

---

## <a name="پیشنیازها"></a>۱. پیش‌نیازها

- **ویندوز** (۱۰ یا ۱۱).
- **Arma 3** نصب‌شده.
- **Python 3** (نصبِ Python و کتابخانه‌اش را خودِ `install.bat` انجام می‌دهد؛ اگر نبود با winget نصب می‌کند).
- کتابخانه‌ی **Pillow** (توسطِ installer نصب می‌شود) — برای ساختِ تصویر نقشه لازم است.
- کتابخانه‌ی **mss** (اختیاری) — فقط برای «تصویر زنده‌ی بازی / دوربین کلاه» لازم است. برای نقشه و مارکر لازم نیست.

---

## <a name="نصب-یکبار"></a>۲. نصب (یک‌بار)

۱. در Steam Workshop مودِ Dideban را **Subscribe** کن. پوشه‌ی آیتم خودِ مود است و فایل‌های ساخته‌شده و امضاشده‌ی مود را از قبل دارد؛ روی کامپیوترِ تو چیزی ساخته نمی‌شود. آن را در یکی از این دو مسیر پیدا می‌کنی (درایو به محلِ کتابخانه‌ی Steamِ تو بستگی دارد):
   <div dir="ltr">

   ```
   <SteamLibrary>\steamapps\common\Arma 3\!Workshop\@Dideban
   <SteamLibrary>\steamapps\workshop\content\107410\3824497242
   ```
   </div>

   میان‌برِ `!Workshop\@Dideban` را لانچرِ Arma 3 می‌سازد و گاهی ساخته نمی‌شود؛ ولی مسیرِ دوم که با شناسه‌ی آیتم (`3824497242`) نام‌گذاری شده همیشه وجود دارد. راهِ رسیدن به آن: در Steam روی **Arma 3** راست‌کلیک کن ← **Manage ← Browse local files**، دو پوشه بالا برو تا به `steamapps` برسی، بعد `workshop\content\107410\3824497242` را باز کن.

۲. فایلِ **`install.bat`** را از همان پوشه اجرا کن. Python و `Pillow` را برای سرور بررسی/نصب می‌کند و یک میان‌برِ **Dideban** برای `start_server.bat` روی دسکتاپ می‌گذارد تا دیگر لازم نباشد پوشه را پیدا کنی.

۳. در **لانچرِ Arma 3**، مودِ **Dideban** را تیک بزن و بازی را اجرا کن. مودِ دیگری لازم نیست.
   - *(اختیاری: در Parameters گزینه‌ی `‑noPause` را اضافه کن تا تصویرِ زنده‌ی بازی و دوربینِ کلاه وقتی پنجره در پس‌زمینه است هم کار کند.)*

۴. واردِ یک **ماموریت** شو (ادیتور، تک‌نفره یا مولتی). تا وقتی توی ماموریت نباشی، برنامه داده‌ای دریافت نمی‌کند.

---

## <a name="اجرا"></a>۳. اجرا و باز کردنِ برنامه

۱. روی میان‌برِ **Dideban** روی دسکتاپ دوبار کلیک کن (یا **`start_server.bat`** را در پوشه‌ی آیتم اجرا کن). یک پنجره‌ی مشکی باز می‌شود و آدرس‌ها را نشان می‌دهد:
   ```
   This PC:        http://localhost:8080
   Phone / tablet: http://192.168.x.x:8080
   ```
۲. روی همان کامپیوتر، مرورگر را باز کن و برو به **`http://localhost:8080`**.
۳. بالای صفحه چراغِ وضعیت را می‌بینی:
   - **قرمز/خاموش** = سرور قطع است (یعنی `start_server.bat` اجرا نیست).
   - **زرد** = منتظرِ بازی (مود فعال نیست یا هنوز وارد ماموریت نشده‌ای).
   - **سبز** = بازی وصل است. ✅

> پنجره‌ی مشکیِ سرور را باز نگه دار؛ تا وقتی باز است برنامه کار می‌کند. برای توقف `Ctrl+C` بزن یا پنجره را ببند.

---

## <a name="اتصال-از-گوشی"></a>۴. اتصال از گوشی / تبلت

۱. گوشی و کامپیوتر باید روی **یک شبکه‌ی Wi-Fi** باشند.
۲. در مرورگرِ گوشی، همان آدرسِ **`http://192.168.x.x:8080`** (که پنجره‌ی سرور نشان داده) را باز کن.
۳. اگر باز نشد، معمولاً **فایروالِ ویندوز** جلوی اتصال را گرفته — به Python اجازه‌ی دسترسی به شبکه‌ی خصوصی را بده.

---

## <a name="گرفتن-نقشه"></a>۵. گرفتنِ نقشه‌ی یک مپ

برای هر نقشه، دو نوع داده وجود دارد که با دکمه گرفته می‌شوند. **بارِ اول که روی یک نقشه‌ی جدید وصل می‌شوی، بنرِ وسطِ صفحه سه دکمه نشان می‌دهد:**

| دکمه | چه می‌دهد | مدت |
|---|---|---|
| **ماهواره + توپوگرافی (هر دو)** | هر دوی زیر با یک کلیک (پیشنهادی) | — |
| **فقط ماهواره** | تصویرِ ماهواره‌ایِ اصلیِ نقشه (از فایل‌های بازی) | چند ثانیه تا چند دقیقه |
| **فقط توپوگرافی** | ارتفاعات، جاده‌ها، ساختمان‌ها، خطوطِ تراز، نامِ مناطق، و فعال‌شدنِ حالتِ سه‌بعدی | ۱ تا ۵ دقیقه (بازی کمی لگ می‌زند) |

- **ماهواره:** سرور مستقیم از فایل‌های نقشه‌ی بازی روی همین کامپیوتر می‌خواند — بدونِ هیچ مودِ اضافه و بدونِ اسکرین‌شات. نوارِ پیشرفت در برنامه و در پنجره‌ی سرور نشان داده می‌شود. نتیجه در پوشه‌ی `cache` ذخیره می‌شود و دفعه‌ی بعد فوری بالا می‌آید.
- **توپوگرافی:** داخلِ بازی (مود) ارتفاعات/جاده‌ها/ساختمان‌ها را جمع می‌کند و می‌فرستد. برای **حالتِ سه‌بعدی و ارتفاعات** همین لازم است.

> این دکمه‌ها بعداً هم در تبِ **تنظیمات** (بخش‌های «تصویر ماهواره‌ای» و «نقشه‌ی توپوگرافی») در دسترس‌اند.

---

## <a name="قابلیتها"></a>۶. قابلیت‌ها

### یگان‌ها و خودروها
- بازیکن‌ها، هوش مصنوعیِ خودی و خودروها به‌صورتِ زنده و با حرکتِ نرم نشان داده می‌شوند.
- رنگِ آیکون بر اساسِ جناح؛ فلشِ جهت و مخروطِ دید؛ نشانگرِ سلامتی و «نیاز به مدیک».
- پنلِ **یگان‌ها** (سمتِ چپ): فهرستِ گروه‌ها و یگان‌ها؛ با کلیک روی هرکدام، نقشه رویشان متمرکز می‌شود.

### مارکرها
- **گذاشتنِ مارکر:** راست‌کلیک (کامپیوتر) یا لمسِ طولانی (گوشی) روی نقشه.
- ابزارهای رسم (نوارِ ابزار): **انتخاب / مارکر / خط / نوشته**.
- مارکرهایی که خودت گذاشته‌ای از پنلِ **مارکرها** یا از پنجره‌ی اطلاعات قابلِ **حذف**‌اند. مارکرها همان لحظه در بازی هم ظاهر/حذف می‌شوند.

### حالتِ سه‌بعدی (3D)
- با دکمه‌ی **2D/3D** بالای صفحه. برای کارکرد به **ارتفاعات** نیاز دارد (پس اول «توپوگرافی» را بگیر).
- چرخش با کشیدن، جابه‌جایی با راست‌کلیک/Shift+کشیدن، زوم با چرخِ ماوس یا دو انگشت.

### دوربین (اختیاری — پیش‌فرض خاموش)
**از این ویژگی استفاده نکنید هنوز در حال توسعه هستش**<br>
در تبِ تنظیمات، بخشِ **دوربین** را روشن کن تا این‌ها ظاهر شوند:
- **دید دوربین:** دیدِ اول‌شخصِ یک یگان، ساخته‌شده از داده‌های نقشه (زمین/ساختمان/خودرو).
- **تصویر زنده‌ی بازی:** تصویرِ واقعیِ صفحه‌ی بازی (نیاز به `mss` و حالتِ Windowed/Borderless).
- **دوربین کلاه:** دیدِ یک یگانِ دیگر به‌صورتِ تصویر‌در‌تصویر (نیاز به PiP در تنظیماتِ تصویرِ بازی).

### پیگیری و جهت
- **دنبال کردن** یک یگان، **مرکز روی من**، **تمام‌صفحه**، **مخفی‌کردنِ نوارِ بالا**.
- جهتِ نقشه: **شمال بالا** یا **جهتِ حرکت بالا** (با زدن روی قطب‌نما هم عوض می‌شود).
- **دنبال کردن** نقشه را روی یگان نگه می‌دارد تا وقتی نقشه را جابه‌جا کنی؛ **مرکز روی من** فقط یک‌بار نقشه را رویت می‌برد.

### صفحه‌ی جزئیات
- روی هر یگان یا خودروی خودی بزن و **جزئیات** را انتخاب کن: سرعت، ارتفاع، افق مصنوعی، جهت، سوخت و سلامتی به‌صورتِ زنده؛ سلاح‌ها و مهمات، آسیب، خدمه و موجودی.
- با ↗ صفحه در پنجره‌ی جدا باز می‌شود (برای مانیتورِ دوم یا گوشی). نشانِ «زنده / کهنه / قطع» تازگیِ داده را نشان می‌دهد.

### فضای کار
- دکمه‌ی **فضای کار**: چیدمان‌های آماده (خلبان، توپچی تانک، فرمانده، تجهیزات پیاده، عیب‌یابی خودرو)، جابه‌جا کردن و تغییر اندازه‌ی پنل‌ها، ذخیره و بارگذاری چیدمان‌ها و خروجی/ورودی فایل. چیدمان‌ها در همین مرورگر ذخیره می‌شوند.

### محاسبه‌گر توپخانه
- دکمه‌ی **محاسبه آتش** (محاسبه‌گر توپخانه) برای توپ‌خانه و خمپاره: سمت، زاویه، خرج و زمانِ پرواز.

> راهنمای فنی (ساختار پروژه، اجرای تست‌ها و اجرای بدون بازی) در بخشِ انگلیسیِ همین فایل است.

---

## <a name="تنظیمات"></a>۷. تنظیمات

در تبِ **تنظیمات**:
- **زبان:** فارسی / English.
- **نوع نمایش:** توپوگرافی / ماهواره / ترکیبی + **روشناییِ نقشه**.
- **جهتِ نقشه**، **سرعتِ به‌روزرسانیِ موقعیت**، **دقتِ مختصات** (۶ یا ۸ رقمی).
- **اندازه‌ی آیکون‌ها و قطب‌نما**.
- **لایه‌ها:** روشن/خاموش کردنِ شبکه، نام‌ها، جاده‌ها، ساختمان‌ها، مارکرها، یگان‌ها، گروه‌ها، غیرنظامی‌ها، خطوطِ تراز، و… .
- **راه‌اندازیِ بازی و مود** (فقط از روی همان کامپیوتر): تنظیمِ پوشه‌ها و نصبِ مجددِ مود از داخلِ مرورگر.

---

## <a name="عیبیابی"></a>۸. عیب‌یابی

| مشکل | علت / راه‌حل |
|---|---|
| **«سرور قطع است»** | `start_server.bat` را اجرا کن. |
| **«منتظر بازی…»** | در لانچر `@dideban` را فعال کن و واردِ یک ماموریت شو (منوی اصلی کافی نیست). |
| **ماهواره «فایل‌های نقشه پیدا نشد»** | نقشه ساختارِ استانداردِ تصویر ندارد، یا فایلش **EBO (رمزنگاری‌شده)** است. نقشه‌های EBO را هیچ ابزاری نمی‌تواند بخواند. |
| **گوشی وصل نمی‌شود** | یک Wi-Fi مشترک؛ فایروالِ ویندوز به Python اجازه بده؛ آدرسِ `192.168.x.x` را از پنجره‌ی سرور بردار. |
| **تصویرِ زنده سیاه است** | بازی باید **Windowed یا Borderless** باشد (نه Fullscreenِ انحصاری)؛ و `mss` نصب باشد: `python -m pip install --user mss`. |
| **تصویرِ قدیمی/خراب نشان می‌دهد** | نقشه را **دوباره استخراج** کن و در مرورگر `Ctrl+F5` بزن (کشِ مرورگر پاک می‌شود). |
| **بعد از آپدیتِ کد تغییری نمی‌بینم** | سرور را ری‌استارت کن و `Ctrl+F5` بزن. |

---

## <a name="چطور-کار-میکند"></a>۹. این برنامه چطور کار می‌کند

```
Arma 3 ── مودِ @dideban (SQF) ── dideban_x64.dll ──TCP 127.0.0.1:28901──▶ server/main.py (Python)
                                                                                │
                                                                   HTTP :8080 + SSE
                                                                                ▼
                                                      مرورگر (کامپیوتر / گوشی / تبلت)
```

- **مودِ `@dideban`** داخلِ بازی، وضعیتِ یگان‌ها/مارکرها را جمع می‌کند و از طریقِ یک افزونه‌ی سبک (`dideban_x64.dll`) روی TCP محلی می‌فرستد.
- **سرورِ Python** داده را می‌گیرد و روی HTTP + Server-Sent-Events به مرورگرها پخش می‌کند.
- **تصویرِ ماهواره‌ای** مستقیم از فایل‌های نقشه‌ی بازی خوانده می‌شود: سرور PBOی نقشه را پیدا می‌کند (از روی مسیرِ WRP که مود از کانفیگ می‌فرستد)، کاشی‌های `s_*_lco.paa` یا فایلِ `s_satout_co.paa` را درمی‌آورد، فرمتِ PAA/DXT1/LZO را دیکد و کاشی‌ها را بهم می‌دوزد.
- **توپوگرافی** (ارتفاعات/جاده/ساختمان) را خودِ مود داخلِ بازی جمع می‌کند.

---

## <a name="نکات-فنی"></a>۱۰. نکات فنی و پیشرفته

- **پوشه‌ی `cache`** کنارِ سرور، همه‌ی نقشه‌های ساخته‌شده را نگه می‌دارد. برای شروعِ تمیز می‌توانی پوشه‌ی `cache\sat` را پاک کنی.
- **نقشه‌های EBO** (بعضی DLCها یا نقشه‌های محافظت‌شده) قابلِ استخراج نیستند.
- **ساختنِ نسخه‌ی Workshop** (فقط برای توسعه‌دهنده): `python tools\release.py` مود را داخلِ `release\@dideban` بسته‌بندی و امضا می‌کند (Arma 3 Tools لازم است)؛ همان پوشه را با Arma 3 Publisher منتشر کن. این اسکریپت همان `extension\dideban_x64.prebuilt.dll` را می‌فرستد تا hashِ آن در وایت‌لیستِ BattlEye ثابت بماند؛ `--compile` آن را با zig دوباره می‌سازد (`pip install ziglang`) و hash عوض می‌شود. کلیدِ امضا در `%USERPROFILE%\.dideban\keys` است: از آن نسخه‌ی پشتیبان بگیر و `.biprivatekey` را هرگز آپلود نکن.
- **توسعه‌ی محلی**: `python tools\build.py` مود را داخلِ همین پوشه می‌سازد تا بشود آن را به‌عنوانِ local mod اضافه کرد.
</div>

---
