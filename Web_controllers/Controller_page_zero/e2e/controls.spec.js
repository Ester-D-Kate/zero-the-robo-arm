import { test, expect } from "@playwright/test";
import path from "node:path";
import { readConfig } from "../scripts/build-config.js";
import { createTestBroker } from "./mqtt-broker.js";
let broker, config;
const password = "correct horse battery staple";
test.beforeEach(() => {
  broker = createTestBroker();
  config = readConfig({
    ADMIN_PASSWORD: password,
    MQTT_TOPIC_PREFIX: "zero/test",
    MQTT_WEBSOCKET_URL: broker.url,
    HAS_ROBOTIC_ARM: "false",
    QUEUE_MODE: "automatic",
  }).public;
});
test.afterEach(() => broker.close());
async function open(
  page,
  { admin = false, arm = false, mode = "automatic" } = {},
) {
  await page.route("**/config.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body:
        "window.ZERO_CONFIG=" +
        JSON.stringify({ ...config, hasRoboticArm: arm, queueMode: mode }),
    }),
  );
  await page.goto(admin ? "/admin/" : "/");
  await expect(page.locator("#connectionStatus")).toHaveText("MQTT connected");
}
async function admin(page, options = {}) {
  await open(page, { admin: true, ...options });
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#adminPanel")).toBeVisible();
}
async function join(page, name) {
  await expect(page.locator("#joinButton")).toBeEnabled();
  await page.getByLabel("Username").fill(name);
  await page
    .getByRole("button", { name: "Request access", exact: true })
    .click();
  await expect(page.locator("#leaveButton")).toBeVisible();
}
async function hold(page, label) {
  await page.getByRole("button", { name: label, exact: true }).hover();
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
}

function latestQueue() {
  const packet = broker.packets
    .filter((p) => p.topic === "zero/test/web/state")
    .at(-1);
  return packet ? JSON.parse(packet.payload.data) : null;
}

test("storage write failures keep MQTT usable and still apply admin takeover", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("Fixture storage is full", "QuotaExceededError");
    };
  });
  await open(page);
  await expect(page.locator("#notice")).toContainText("recovery");
  const board = await context.newPage();
  await admin(board);
  await join(page, "Kate");
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeEnabled();
  await board
    .getByRole("button", { name: "Take master control", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#accessStatus")).toContainText("Admin");
});

test("refresh preserves a guest's identity, username and queue position", async ({
  page,
  context,
}) => {
  const board = await context.newPage(),
    sam = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await open(sam);
  await join(sam, "Sam");
  const before = latestQueue();
  await sam.reload();
  await expect(sam.locator("#leaveButton")).toBeVisible();
  await expect(sam.locator("#accessStatus")).toContainText("#1");
  expect(latestQueue().queue.map((user) => user.session)).toEqual(
    before.queue.map((user) => user.session),
  );
  expect(latestQueue().current).toBe(before.current);
});

test("admin MQTT reconnect preserves the coordinator and queue", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  const before = latestQueue(),
    connections = broker.connections.length;
  broker.dropCoordinator();
  await expect
    .poll(() => broker.connections.length)
    .toBeGreaterThan(connections);
  await expect(board.locator("#adminPanel")).toBeVisible();
  await expect(page.locator("#accessStatus")).toContainText("Your turn");
  expect(latestQueue().queue.map((user) => user.session)).toEqual(
    before.queue.map((user) => user.session),
  );
});

test("admin refresh and password sign-in restore queue order and mode", async ({
  page,
  context,
}) => {
  const board = await context.newPage(),
    sam = await context.newPage();
  await admin(board, { mode: "manual" });
  await open(page);
  await join(page, "Kate");
  await open(sam);
  await join(sam, "Sam");
  const before = latestQueue();
  await board.reload();
  await expect(board.locator("#adminLoginButton")).toBeEnabled();
  await board.getByLabel("Admin password").fill(password);
  await board.locator("#adminLoginButton").click();
  await expect(board.locator("#adminPanel")).toBeVisible();
  await expect
    .poll(() => latestQueue().queue.map((user) => user.name))
    .toEqual(["Kate", "Sam"]);
  expect(latestQueue().queue.map((user) => user.session)).toEqual(
    before.queue.map((user) => user.session),
  );
  expect(latestQueue().queue_mode).toBe("manual");
});

test("no robot status is required; legacy car commands work after an admin-managed turn", async ({
  page,
  context,
}) => {
  await open(page);
  await expect(page.locator("#armControls")).toBeHidden();
  await expect(page.locator("#voiceButton")).toBeVisible();
  await expect(page.locator("#accessStatus")).toContainText("Open /admin");
  const board = await context.newPage();
  await open(board, { admin: true });
  await board.getByLabel("Admin password").fill("incorrect password");
  await board.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(board.locator("#notice")).toContainText(
    "Incorrect admin password",
  );
  await board.getByLabel("Admin password").fill(password);
  await board.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(board.locator("#adminPanel")).toBeVisible();
  await join(page, "Kate");
  await expect(page.locator("#accessStatus")).toContainText("Your turn");
  await hold(page, "Forward");
  const movement = broker.packets.find(
    (packet) =>
      packet.topic === "alice/zero/car/command" && packet.payload.cmd === "F",
  );
  expect(movement.payload.speed).toBe(50);
  expect(movement.payload.timestamp).toBeGreaterThan(0);
  expect(movement.payload.signature).toBeUndefined();
  expect(movement.retain).toBe(false);
  expect(
    broker.packets.some((packet) => packet.topic === "alice/zero/robot/status"),
  ).toBe(false);
});

test("unique names, FIFO handoff and signed admin master takeover coordinate multiple browsers", async ({
  page,
  context,
}) => {
  const board = await context.newPage(),
    sam = await context.newPage(),
    duplicate = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await open(sam);
  await join(sam, "Sam");
  await expect(sam.locator("#accessStatus")).toContainText("#1");
  await open(duplicate);
  await duplicate.getByLabel("Username").fill("kate");
  await duplicate.locator("#joinButton").click();
  await expect(duplicate.locator("#notice")).toContainText("already in use");
  await page.locator("#leaveButton").click();
  await expect(sam.locator("#accessStatus")).toContainText("Your turn");
  const previous = broker.packets
    .filter((packet) => packet.topic === "zero/test/web/state")
    .at(-1).payload;
  await board.locator("#masterButton").click();
  await expect(board.locator("#accessStatus")).toContainText(
    "You have master control",
  );
  await expect(
    sam.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  broker.broadcast("zero/test/web/state", previous);
  await expect(sam.locator("#accessStatus")).toContainText(
    "Admin has master control",
  );
  await hold(board, "Forward");
  await board.locator("#masterButton").click();
  await expect(sam.locator("#accessStatus")).toContainText("Your turn");
});

test("manual grants work without telemetry and signing out pauses guest controls", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board, { mode: "manual" });
  await open(page);
  await join(page, "Kate");
  await expect(page.locator("#accessStatus")).toContainText(
    "Waiting for admin",
  );
  await board.locator("#queueDetails > summary").click();
  await board.getByRole("button", { name: "Grant control to Kate" }).click();
  await expect(page.locator("#accessStatus")).toContainText("Your turn");
  await board.locator("#adminLogout").click();
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  await expect(page.locator("#accessStatus")).toContainText(
    "Queue position saved",
  );
});

test("arm mode sends the original arm format and recorded voice reaches the original security server topic", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    class Recorder {
      static isTypeSupported() {
        return true;
      }
      constructor(stream) {
        this.stream = stream;
        this.mimeType = "audio/webm;codecs=opus";
        this.state = "inactive";
      }
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({
          data: new Blob(["test microphone audio"], { type: this.mimeType }),
        });
        this.onstop?.();
      }
    }
    window.MediaRecorder = Recorder;
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }),
      },
      configurable: true,
    });
  });
  const board = await context.newPage();
  await admin(board, { arm: true });
  await open(page, { arm: true });
  await join(page, "VoiceDriver");
  await expect(page.locator("#armControls")).toBeVisible();
  await hold(page, "Open claw");
  expect(
    broker.packets.some(
      (packet) =>
        packet.topic === "alice/zero/arm/command" && packet.payload.cmd === "O",
    ),
  ).toBe(true);
  await hold(page, "Hold to speak");
  await expect(page.locator("#voiceStatus")).toContainText(
    "Voice server processed",
  );
  const audio = broker.packets.find(
    (packet) => packet.topic === "alice/zero/voice/audio",
  ).payload;
  expect(audio.security_token).toBe("ALICE_ZERO_2024_SECURE");
  expect(audio.device_id).toMatch(/^WebControl_/);
  expect(audio.audio_data).toBe(
    Buffer.from("test microphone audio").toString("base64"),
  );
  expect(audio.audio_format).toBe("audio/webm");
});

test("revoking control while microphone permission is pending discards recording", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    window.MediaRecorder = class {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        throw new Error("revoked microphone must not start");
      }
    };
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () =>
          new Promise((resolve) => {
            window.releaseMic = () =>
              resolve({
                getTracks: () => [
                  {
                    stop() {
                      window.trackStopped = true;
                    },
                  },
                ],
              });
          }),
      },
      configurable: true,
    });
  });
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await page.locator("#voiceButton").hover();
  await page.mouse.down();
  await expect
    .poll(() => page.evaluate(() => typeof window.releaseMic))
    .toBe("function");
  await board.locator("#masterButton").click();
  await expect(page.locator("#voiceButton")).toBeDisabled();
  await page.evaluate(() => window.releaseMic());
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.trackStopped)).toBe(true);
  expect(
    broker.packets.some((packet) => packet.topic === "alice/zero/voice/audio"),
  ).toBe(false);
});

test("mobile MJPEG POV overlays controls and releases the camera socket on admin takeover", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "POVDriver");
  const jpeg = Buffer.from(
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 600;
      canvas.height = 800;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#253c36";
      ctx.fillRect(0, 0, 600, 800);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    }),
    "base64",
  );
  let released = false;
  const camera = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      let timer;
      return new Response(
        new ReadableStream({
          start(controller) {
            const frame = () => {
              controller.enqueue(
                new TextEncoder().encode(
                  "--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " +
                    jpeg.length +
                    "\r\n\r\n",
                ),
              );
              controller.enqueue(jpeg);
              controller.enqueue(new TextEncoder().encode("\r\n"));
            };
            frame();
            timer = setInterval(frame, 100);
          },
          cancel() {
            clearInterval(timer);
            released = true;
          },
        }),
        {
          headers: {
            "Content-Type": "multipart/x-mixed-replace;boundary=frame",
            "Cache-Control": "no-store",
          },
        },
      );
    },
  });
  try {
    await page
      .locator("#cameraSettings")
      .evaluate((element) => (element.open = true));
    await page
      .getByLabel("Camera stream URL")
      .fill("http://127.0.0.1:" + camera.port + "/stream");
    await page
      .getByRole("button", { name: "Connect camera", exact: true })
      .click();
    await expect(page.locator("body")).toHaveClass(/pov/);
    expect(
      await page.locator("#cameraFeed").evaluate((image) => image.naturalWidth),
    ).toBe(600);
    await expect(page.locator("#joystick")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: path.resolve("../../.cache/controller-mobile-pov.png"),
      fullPage: true,
    });
    await board.locator("#masterButton").click();
    await expect(page.locator("body")).not.toHaveClass(/pov/);
    await expect.poll(() => released).toBe(true);
  } finally {
    camera.stop(true);
  }
});

test("a revoked driver stops the unchanged firmware after its last in-flight refresh", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await page.getByRole("button", { name: "Forward", exact: true }).hover();
  await page.mouse.down();
  await expect
    .poll(
      () =>
        broker.packets.filter(
          (p) => p.topic === "alice/zero/car/command" && p.payload.cmd === "F",
        ).length,
    )
    .toBeGreaterThan(0);
  broker.delayState(400);
  await board.locator("#masterButton").click();
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  expect(
    broker.packets.filter((p) => p.topic === "alice/zero/car/command").at(-1)
      .payload.cmd,
  ).toBe("S");
  await page.mouse.up();
});

test("an expired admin connection stops the driver while its MQTT connection remains usable", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await page.getByRole("button", { name: "Forward", exact: true }).hover();
  await page.mouse.down();
  await expect
    .poll(
      () =>
        broker.packets.filter(
          (p) => p.topic === "alice/zero/car/command" && p.payload.cmd === "F",
        ).length,
    )
    .toBeGreaterThan(0);
  broker.dropCoordinator(true);
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled({ timeout: 20000 });
  await expect(page.locator("#connectionStatus")).toHaveText("MQTT connected");
  await expect
    .poll(
      () =>
        broker.packets
          .filter((p) => p.topic === "alice/zero/car/command")
          .at(-1).payload.cmd,
    )
    .toBe("S");
  await page.mouse.up();
  const members = latestQueue().queue.map((user) => user.session);
  await page.reload();
  await expect(page.locator("#leaveButton")).toBeVisible();
  await expect(page.locator("#accessStatus")).toContainText(
    "Queue position saved",
  );
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  expect(latestQueue().queue.map((user) => user.session)).toEqual(members);
});

test("explicit admin revocation clears saved intent instead of silently rejoining", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await board.locator("#revokeButton").click();
  await expect(page.locator("#joinButton")).toBeVisible();
  await page.waitForTimeout(2500);
  expect(latestQueue().queue).toHaveLength(0);
  await page.reload();
  await expect(page.locator("#joinButton")).toBeVisible();
  expect(latestQueue().queue).toHaveLength(0);
  await join(page, "Kate");
  await expect(page.locator("#accessStatus")).toContainText("Your turn");
});

test("a guest MQTT reconnect restores the same request and identity", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  const before = latestQueue(),
    connections = broker.connections.length;
  broker.dropGuests();
  await expect
    .poll(() => broker.connections.length)
    .toBeGreaterThan(connections);
  await expect(page.locator("#accessStatus")).toContainText("Your turn");
  expect(latestQueue().current).toBe(before.current);
  expect(latestQueue().queue.map((user) => user.session)).toEqual(
    before.queue.map((user) => user.session),
  );
});
test("closing and reopening a guest tab recovers its queue place", async ({
  page,
  context,
}) => {
  const board = await context.newPage(),
    sam = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  await open(sam);
  await join(sam, "Sam");
  const before = latestQueue();
  await sam.close();
  const reopened = await context.newPage();
  await open(reopened);
  await expect(reopened.locator("#leaveButton")).toBeVisible();
  await expect(reopened.locator("#accessStatus")).toContainText("#1");
  expect(latestQueue().queue.map((user) => user.session)).toEqual(
    before.queue.map((user) => user.session),
  );
});
test("a copied tab cannot steal the original session or disconnect its MQTT client", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  const original = latestQueue().current,
    storage = await page.evaluate(() => Object.entries(sessionStorage));
  const copy = await context.newPage();
  await copy.addInitScript((entries) => {
    for (const [key, value] of entries) sessionStorage.setItem(key, value);
  }, storage);
  await open(copy);
  await expect(copy.locator("#joinForm")).toBeVisible();
  await expect(page.locator("#accessStatus")).toContainText("Your turn");
  expect(latestQueue().current).toBe(original);
});
test("admin restoration rejects pre-refresh grants and never saves an unlocked admin key", async ({
  page,
  context,
}) => {
  const board = await context.newPage();
  await admin(board);
  await open(page);
  await join(page, "Kate");
  const old = broker.packets
    .filter((p) => p.topic === "zero/test/web/state")
    .at(-1).payload;
  await board.reload();
  await expect(board.locator("#adminLoginButton")).toBeEnabled();
  await board.getByLabel("Admin password").fill(password);
  await board.locator("#adminLoginButton").click();
  await expect(board.locator("#adminPanel")).toBeVisible();
  await board.locator("#masterButton").click();
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  broker.broadcast("zero/test/web/state", old);
  await expect(board.locator("#adminPanel")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Forward", exact: true }),
  ).toBeDisabled();
  const saved = await board.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("zero-controller-state", 1);
        request.onsuccess = () => {
          const db = request.result,
            transaction = db.transaction("records"),
            all = transaction.objectStore("records").getAll();
          all.onsuccess = () =>
            resolve(
              all.result.map((record) => ({
                text: JSON.stringify(record),
                role: record.identity?.role,
                extractable: record.identity?.key?.extractable,
              })),
            );
          transaction.oncomplete = () => db.close();
        };
        request.onerror = () => reject(request.error);
      }),
  );
  expect(
    saved.some(
      (record) => record.role === "guest" && record.extractable === false,
    ),
  ).toBe(true);
  expect(saved.some((record) => record.role === "admin")).toBe(false);
  expect(saved.some((record) => record.text.includes(password))).toBe(false);
});
