import { expect, test, spyOn } from "bun:test";
import { RobotSession } from "../mqtt-session.js";
import {
  createGuestIdentity,
  createAdminIdentity,
  signMessage,
} from "../protocol.js";
import { readConfig } from "../scripts/build-config.js";
import { AccessQueue } from "../access-queue.js";
async function fixture() {
  const sent = [];
  const session = new RobotSession(
    { topicPrefix: "zero/test", hasRoboticArm: true },
    () => {},
    () => {},
  );
  session.identity = await createGuestIdentity();
  session.intent = { name: "Kate" };
  session.connected = true;
  session.lastSeen = Date.now();
  session.state = {
    status: "online",
    boot: "1234567890abcdef1234567890abcdef",
    epoch: 1,
    current: session.identity.session,
    master: false,
    queue_mode: "automatic",
    admin_session: "",
    queue: [{ session: session.identity.session, name: "Kate" }],
  };
  session.client = {
    publish(topic, text, options, callback) {
      sent.push({ topic, payload: JSON.parse(text), options });
      callback?.();
    },
  };
  return { session, sent };
}
test("MQTT connection is usable without any robot status messages", async () => {
  const { session } = await fixture();
  session.state = null;
  session.lastSeen = 0;
  expect(session.online).toBe(true);
  expect(session.canControl).toBe(false);
});
test("drive commands retain the unchanged firmware MQTT topic and JSON format", async () => {
  const { session, sent } = await fixture();
  await session.send("car", { cmd: "F", speed: 65 });
  expect(sent[0].topic).toBe("alice/zero/car/command");
  expect(sent[0].payload.cmd).toBe("F");
  expect(sent[0].payload.speed).toBe(65);
  expect(sent[0].payload.signature).toBeUndefined();
  expect(sent[0].options.retain).toBe(false);
});
test("arm commands retain the unchanged firmware command topic", async () => {
  const { session, sent } = await fixture();
  await session.send("arm", { cmd: "O", speed: 50 });
  expect(sent[0].topic).toBe("alice/zero/arm/command");
  expect(sent[0].payload.cmd).toBe("O");
});
test("a browser without control ownership cannot publish movement", async () => {
  const { session, sent } = await fixture();
  session.state.current = "";
  await expect(session.send("car", { cmd: "F", speed: 50 })).rejects.toThrow();
  expect(sent).toHaveLength(0);
});

for (const failedPublish of ["stop", "offline state"]) {
  test(`signing out clears admin authority when publishing ${failedPublish} fails`, async () => {
    const { session, sent } = await fixture();
    session.guestIdentity = session.identity;
    session.guestSequence = 7;
    const password = "fixture signout admin password";
    session.config = readConfig({
      ADMIN_PASSWORD: password,
      MQTT_TOPIC_PREFIX: "zero/test",
    }).public;
    session.identity = await createAdminIdentity(
      password,
      session.config.adminAuth,
    );
    session.coordinator = new AccessQueue(
      "automatic",
      session.identity.session,
      session.state.boot,
    );
    session.coordinator.setMaster(true);
    session.state = session.coordinator.snapshot();
    let released = false;
    session.store = {
      releaseAdmin() {
        released = true;
      },
      async saveCheckpoint() {},
    };
    session.client.publish = (topic, text, options, callback) => {
      const isState = topic === "zero/test/web/state";
      if (isState === (failedPublish === "offline state"))
        callback(new Error("MQTT connection lost"));
      else callback();
    };
    await expect(session.send("logout", {})).rejects.toThrow(
      "MQTT connection lost",
    );
    expect(session.adminAuthenticated).toBe(false);
    expect(session.canControl).toBe(false);
    expect(session.coordinator).toBeNull();
    expect(session.identity).toBe(session.guestIdentity);
    expect(session.seq).toBe(7);
    expect(released).toBe(true);
    session.connected = true;
    await session.recoverCoordinator();
    expect(session.adminAuthenticated).toBe(false);
    expect(sent).toHaveLength(0);
  });
}

test("a failed browser write does not block receiving fresh control revocations", async () => {
  const { session } = await fixture();
  session.guestIdentity = session.identity;
  session.guestSequence = 0;
  session.config = readConfig({
    ADMIN_PASSWORD: "fixture storage admin password",
    MQTT_TOPIC_PREFIX: "zero/test",
  }).public;
  const admin = await createAdminIdentity(
    "fixture storage admin password",
    session.config.adminAuth,
  );
  session.state.admin_session = admin.session;
  const notices = [];
  let renders = 0;
  session.onError = (message) => notices.push(message);
  session.onChange = () => renders++;
  session.store = {
    async saveGuest() {
      throw new Error("QuotaExceededError");
    },
  };
  await expect(session.saveGuest()).resolves.toBeUndefined();
  const packet = await signMessage(admin, {
    boot: session.state.boot,
    seq: 1,
    action: "state",
    data: {
      ...session.state,
      admin_session: admin.session,
      current: admin.session,
      master: true,
      timestamp: Date.now(),
    },
  });
  await session.receive(session.stateTopic, packet);
  expect(session.canControl).toBe(false);
  expect(renders).toBeGreaterThan(0);
  expect(notices).toHaveLength(1);
  expect(notices[0]).toContain("recovery");
});

test("queue request signing and publication preserve order while acknowledgments are pending", async () => {
  const { session, sent } = await fixture();
  let firstCallback;
  session.client.publish = (topic, text, options, callback) => {
    sent.push({ topic, payload: JSON.parse(text) });
    if (sent.length === 1) firstCallback = callback;
    else callback();
  };
  const first = session.request("heartbeat", {}, false),
    second = session.request("leave", {}, false);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(sent).toHaveLength(1);
  firstCallback();
  await first;
  await second;
  expect(sent.map((p) => p.payload.action)).toEqual(["heartbeat", "leave"]);
});

test("expired inactive signing records do not permanently fill the access queue", async () => {
  const { session } = await fixture();
  const password = "correct horse battery staple";
  session.config = readConfig({
    ADMIN_PASSWORD: password,
    MQTT_TOPIC_PREFIX: "zero/test",
  }).public;
  session.identity = await createAdminIdentity(
    password,
    session.config.adminAuth,
  );
  session.coordinator = new AccessQueue(
    "automatic",
    session.identity.session,
    "1234567890abcdef1234567890abcdef",
  );
  session.requests = new Map(
    Array.from({ length: 256 }, (_, i) => [
      "old-" + i,
      { key: "old", seq: 1, lastSeen: Date.now() - 11000 },
    ]),
  );
  const guest = await createGuestIdentity();
  const packet = await signMessage(guest, {
    boot: session.coordinator.boot,
    seq: 1,
    action: "join",
    data: { key: guest.publicKey, name: "NewUser", timestamp: Date.now() },
  });
  await session.handleRequest(packet);
  expect(session.coordinator.current).toBe(guest.session);
});

test("waiting for an admin reply does not block later heartbeat publication", async () => {
  const { session, sent } = await fixture();
  let settled = false;
  const first = session
    .request("join", { name: "Kate", key: session.identity.publicKey }, true)
    .finally(() => {
      settled = true;
    });
  first.catch(() => {});
  await session.request("heartbeat", {}, false);
  expect(sent).toHaveLength(2);
  expect(settled).toBe(false);
  session.rejectPending("Test finished");
  await expect(first).rejects.toThrow("Test finished");
});

test("a future-dated join cannot replay after leaving and history cleanup", async () => {
  const { session } = await fixture();
  const password = "correct horse battery staple";
  session.config = readConfig({
    ADMIN_PASSWORD: password,
    MQTT_TOPIC_PREFIX: "zero/test",
  }).public;
  session.identity = await createAdminIdentity(
    password,
    session.config.adminAuth,
  );
  session.coordinator = new AccessQueue(
    "automatic",
    session.identity.session,
    "1234567890abcdef1234567890abcdef",
  );
  session.requests = new Map();
  const guest = await createGuestIdentity();
  let now = Date.now();
  const timestamp = now + 8000;
  const joinPacket = await signMessage(guest, {
    boot: session.coordinator.boot,
    seq: 1,
    action: "join",
    data: { key: guest.publicKey, name: "Kate", timestamp },
  });
  const leavePacket = await signMessage(guest, {
    boot: session.coordinator.boot,
    seq: 2,
    action: "leave",
    data: { timestamp },
  });
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    await session.handleRequest(joinPacket);
    await session.handleRequest(leavePacket);
    expect(session.coordinator.users).toHaveLength(0);
    now += 11000;
    await session.handleRequest(joinPacket);
    expect(session.coordinator.users).toHaveLength(0);
  } finally {
    clock.mockRestore();
  }
});

test("a pre-refresh signed state cannot replace a restored admin generation", async () => {
  const { session } = await fixture();
  session.config = readConfig({
    ADMIN_PASSWORD: "correct horse battery staple",
    MQTT_TOPIC_PREFIX: "zero/test",
  }).public;
  session.identity = await createAdminIdentity(
    "correct horse battery staple",
    session.config.adminAuth,
  );
  session.coordinator = new AccessQueue(
    "automatic",
    session.identity.session,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  session.coordinator.generation = 2;
  session.state = { ...session.coordinator.snapshot(), generation: 2 };
  session.lastSeen = Date.now();
  const old = await signMessage(session.identity, {
    boot: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    seq: 50,
    action: "state",
    data: {
      ...session.state,
      boot: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      generation: 1,
      timestamp: Date.now() - 1000,
    },
  });
  await session.receive(session.stateTopic, old);
  expect(session.coordinator?.boot).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  expect(session.state.boot).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
});
test("a resumed admin yields to a newer live leader even after reconnect recovery", async () => {
  const { session } = await fixture();
  session.config = readConfig({
    ADMIN_PASSWORD: "correct horse battery staple",
    MQTT_TOPIC_PREFIX: "zero/test",
  }).public;
  session.identity = await createAdminIdentity(
    "correct horse battery staple",
    session.config.adminAuth,
  );
  session.identity.session = "11111111111111111111111111111111";
  session.coordinator = new AccessQueue(
    "automatic",
    session.identity.session,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  session.requests = new Map();
  session.coordinatorPaused = true;
  session.yieldToForeign = true;
  await session.recoverCoordinator();
  const foreign = await createAdminIdentity(
    "correct horse battery staple",
    session.config.adminAuth,
  );
  foreign.session = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const q = new AccessQueue(
    "manual",
    foreign.session,
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  );
  const packet = await signMessage(foreign, {
    boot: q.boot,
    seq: 1,
    action: "state",
    data: {
      ...q.snapshot(),
      generation: 1,
      recovering: false,
      timestamp: Date.now(),
    },
  });
  await session.receive(session.stateTopic, packet);
  expect(session.coordinator).toBeNull();
  expect(session.state.queue_mode).toBe("manual");
});
test("receiving a delayed signed beacon cannot extend its original control lease", async () => {
  const { session } = await fixture();
  session.intent = null;
  session.state = null;
  session.lastSeen = 0;
  session.config = readConfig({
    ADMIN_PASSWORD: "correct horse battery staple",
    MQTT_TOPIC_PREFIX: "zero/test",
  }).public;
  const admin = await createAdminIdentity(
    "correct horse battery staple",
    session.config.adminAuth,
  );
  const q = new AccessQueue(
    "automatic",
    admin.session,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  let now = Date.now();
  const issued = now;
  const packet = await signMessage(admin, {
    boot: q.boot,
    seq: 1,
    action: "state",
    data: { ...q.snapshot(), timestamp: issued },
  });
  const time = spyOn(Date, "now").mockImplementation(() => now);
  try {
    now = issued + 14000;
    await session.receive(session.stateTopic, packet);
    expect(session.state.boot).toBe(q.boot);
    expect(session.queueOnline).toBe(true);
    now = issued + 16000;
    expect(session.queueOnline).toBe(false);
  } finally {
    time.mockRestore();
  }
});
