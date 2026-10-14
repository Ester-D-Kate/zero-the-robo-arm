# Zero webpage controller

The firmware and existing Python/Groq voice/security server are unchanged. Build and deploy the static webpage only. No robot status message is required.

## Run locally

Use Bun from the project root:

```sh
bun install --cwd Web_controllers/Controller_page_zero
bun run build
bun run preview
```

Open http://127.0.0.1:4173/ for users and http://127.0.0.1:4173/admin/ for the admin. The local preview serves files only; it is not a queue or API service. Deploy `Web_controllers/Controller_page_zero/dist/` to static hosting, preserving its `admin/index.html` route. Use HTTPS or localhost for browser cryptography and microphone access.

## Configuration

For local setup, copy `.env.example` to the private root `.env`, fill in the admin password and unique queue topic prefix, then build. Keep existing values when updating an installation. Never commit `.env` or include it in the deployed website. Build environment variables take precedence over values in the local `.env`, including intentionally empty MQTT credentials.

| Variable | Purpose |
| --- | --- |
| `HAS_ROBOTIC_ARM` | `false`: car controls; `true`: car and arm controls. This is a webpage layout flag only. |
| `ADMIN_PASSWORD` | Password for `/admin`, at least 16 characters. |
| `MQTT_WEBSOCKET_URL` | Existing broker WebSocket URL; default `wss://broker.emqx.io:8084/mqtt`. |
| `MQTT_TOPIC_PREFIX` | Unique namespace for browser queue messages only. It does not change robot command topics. |
| `MQTT_USERNAME`, `MQTT_PASSWORD` | Optional broker credentials. These are necessarily included in the static browser build. |
| `QUEUE_MODE` | Initial `automatic` FIFO or `manual` grants. Admin can change it while signed in. |
| `VOICE_SECURITY_TOKEN` | Must match the existing voice/security server; defaults to the existing `ALICE_ZERO_2024_SECURE` token. This legacy token is included in the webpage as before. |

The build encrypts a generated admin signing key with a password-derived AES-GCM key. The static page contains the public signing key and encrypted private key, not the plaintext admin password or unlocked signing key. Correct password entry unlocks the key in the browser; guest pages verify signed queue messages. The encrypted signing identity is reused from the ignored `.cache/admin-auth.json` while the password stays the same, so ordinary local rebuilds preserve browser state compatibility. Keep this cache in a build environment that needs consistent signing identity between deployments. A password change, a different topic/broker, or a cold build without this cache or previous `dist/config.js` changes the identity and requires users to request access again. Refresh controller/admin tabs after deploying new code.

## Deploy on Netlify

The root `netlify.toml` configures Bun, installs the locked webpage dependencies, builds the static website, and publishes only `Web_controllers/Controller_page_zero/dist`. The base directory is the repository root. The built `admin/index.html` supplies `/admin/` without a function or API service.

1. In the site's **Project configuration > Environment variables**, select **Add a variable > Import from a .env file**.
2. Paste the contents of your local root `.env`. Choose a scope that includes **Builds** and the **Production** deploy context (plus any trusted contexts you want to use). Import the variables. If scope selection is unavailable, the default all-scopes setting includes builds.
3. Keep `MQTT_USERNAME` and `MQTT_PASSWORD` empty for the existing anonymous broker. If Netlify skips empty values, leaving these variables unset also defaults to empty. `ADMIN_PASSWORD` and `MQTT_TOPIC_PREFIX` must contain your actual configured values, not the example placeholders.
4. Trigger a new deploy after adding or changing variables. The build reads Netlify's `process.env` directly; a `.env` file in the Git checkout is not required. There is no `VITE_` or other variable-name prefix.

These are build-time settings: the browser loads the generated `config.js` and cannot read Netlify environment variables at runtime. The build selects only the eight controller settings above. It uses `ADMIN_PASSWORD` to encrypt the admin signing identity and does not put that plaintext password in website assets or build output. MQTT credentials and the existing voice token are browser configuration and will be visible in deployed assets if provided; do not use privileged broker credentials here. Unrelated Netlify variables are not included.

A fresh Netlify build without the ignored signing cache or previous build output generates a new signing identity. Do not commit that cache to preserve it. After such a deploy, refresh all controller tabs, sign in again on `/admin/`, and request guest access again. Changing only Netlify variables still requires a new build and deploy.

See Netlify's [environment variable import instructions](https://docs.netlify.com/build/environment-variables/get-started/) and [build environment variable documentation](https://docs.netlify.com/build/configure-builds/environment-variables/).

## Queue and master control

1. Open `/admin`, enter the `.env` password, and **keep this tab open**. That browser manages the queue through MQTT. Only one admin tab should manage a deployment at a time.
2. Users open `/`, choose a unique name, and request access. Names are case-insensitive and use 2–24 letters, digits, underscores or hyphens.
3. Automatic mode grants the first user and advances when they leave. Manual mode lets the admin grant a named user. The queue holds up to 16 users. After two minutes without a heartbeat, a user is marked as reconnecting and releases an active turn; their name and queue position remain reserved for ten minutes. Explicit **Leave queue** removes the request immediately.
4. **Take master control** pauses guest controls, stops current movement, and enables the admin's board. Users remain queued. **Release master control** resumes FIFO in automatic mode; manual mode waits for a grant.
5. Signing out pauses user controls and preserves the queue. A temporary MQTT disconnect reconnects the admin coordinator automatically. Refreshing or reopening the admin page requires password sign-in again, then restores its signed queue snapshot, order, mode and master lock. Closing or suspending the admin tab pauses controls once its signed lease expires (within fifteen seconds); it no longer deletes the queue.

Guest sessions, nonextractable guest signing keys, request counters, usernames, leave intent and verified queue snapshots are saved in IndexedDB. Refreshing, temporarily losing MQTT, or reopening a closed guest tab in the same browser restores the existing request rather than creating a new user. Separate or copied tabs reserve separate sessions and use distinct MQTT connection IDs, preventing one tab from disconnecting another. An admin's explicit revoke clears that user's saved intent; the user can request a new turn manually.

The admin password and unlocked admin signing key are never saved in browser storage. The persisted queue checkpoint is signed and verified before restoration. Cached queue data alone cannot grant driving access: a fresh signed admin update is still required, and held movement is never resumed automatically. Browser/site-data clearing, a different browser/device, or a changed origin (including port) removes or separates local recovery state. Browsers may suspend background pages; keep the admin page open and active while operating.

If browser storage cannot save data, the page shows a recovery notice and continues the current MQTT session. Failed saves cannot prevent applying a fresh signed takeover or revocation. Later saves are retried, but refresh recovery is limited while storage remains unavailable; tab identity locks stay held for the current session.

The page displays **MQTT connected** for broker connectivity. Admin queue availability is shown separately. Neither label claims that the physical robot is online, and neither requires firmware telemetry.

## Existing protocol compatibility

| Topic | Preserved payload |
| --- | --- |
| `alice/zero/car/command` | `{cmd, speed, timestamp, id}`; `F`, `B`, `L`, `R`, `S`. |
| `alice/zero/arm/command` | `{cmd, timestamp, id}`; `U`, `D`, `C`, `O`, `1`, `2`, `3`, `4`, `S`. |
| `alice/zero/arm/position` | `{A1...A5, timestamp, id}` for supported position operations. |
| `alice/zero/voice/audio` | Recorded base64 audio, existing security token and `WebControl_` device ID, format/duration/sample-rate/channel/size/timestamp/message fields. |
| `alice/zero/voice/response/<device_id>` | Existing server's success/error/transcription reply. |

Voice records with MediaRecorder, then sends audio to the existing MQTT voice/security server. It does not use browser speech recognition or introduce a new voice service. The server must already be running and connected to the same broker. Recordings are limited to 15 seconds and 500 KB. Permission denied, lost access, or canceled recording discards the audio. The arm flag controls the webpage layout; the unchanged AI voice server can still interpret arm commands.

## ESP32-CAM MJPEG POV

The sibling `esp-cam` project serves native MJPEG at `http://<camera-ip>:81/stream`, with `multipart/x-mixed-replace;boundary=frame` JPEG parts. Paste a camera address or complete stream URL. A base HTTP address is normalized to port 81 `/stream`.

Only the current controller opens the camera. The image fills the viewport with the full field of view preserved and translucent controls on top. Losing access or disconnecting releases the image connection; this matters because the camera allows one preview client. Native image loading does not require CORS headers. HTTPS webpages cannot display a plain HTTP stream in browsers that block mixed content; the page explains this restriction. The browser must have network access to the camera address.

## Limits with unchanged firmware and voice server

The queue governs cooperating webpage clients. The unchanged firmware still accepts its original command topics, and the existing voice server executes commands itself. A separate MQTT client can bypass the webpage queue. Password-protected, signed admin queue state prevents normal guest pages from forging admin grants, but it does not turn the existing public broker/firmware into an enforced robot access boundary.

The page blocks new voice recordings/submissions after takeover and sends stop commands on reachable ownership loss. It cannot recall audio already submitted to the unchanged server or cancel that server's AI sequences and delayed stops. Total MQTT/network loss cannot guarantee that the unchanged robot stops. Enforcing these boundaries against other publishers or in-flight server jobs would require broker ACLs, server changes, or firmware changes, which are outside this requested webpage-only update.

## Verification

```sh
bun run test
bun run test:browser
```

Browser tests use an isolated local MQTT WebSocket fixture and simulated microphone/voice replies. They exercise actual MQTT.js traffic and WebCrypto signing without publishing to the real robot. Tests cover no telemetry, original command/audio formats, admin password rejection, unique names, automatic/manual grants, master takeover, request ordering, session-history cleanup, microphone permission revocation, guest/admin refresh, MQTT reconnect, reopening/copying tabs, explicit revoke persistence, retired coordinator generations, password-safe local storage, stable build identity and actual multipart MJPEG/socket release. Hardware movement and the live Groq service are not claimed as verified.
