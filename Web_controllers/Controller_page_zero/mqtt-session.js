import mqtt from "mqtt";
import {
  createGuestIdentity,
  createAdminIdentity,
  randomSession,
  signMessage,
  verifyMessage,
} from "./protocol.js";
import { AccessQueue } from "./access-queue.js";
import { BrowserStateStore } from "./browser-state.js";
export const LEGACY_TOPICS = Object.freeze({
  car: "alice/zero/car/command",
  arm: "alice/zero/arm/command",
  position: "alice/zero/arm/position",
  audio: "alice/zero/voice/audio",
  response: "alice/zero/voice/response",
});
export const COORDINATOR_TIMEOUT_MS = 15000;
export function validState(state) {
  return !!(
    state &&
    state.status === "online" &&
    /^[0-9a-f]{32}$/.test(state.boot) &&
    Number.isSafeInteger(state.epoch) &&
    state.epoch > 0 &&
    typeof state.current === "string" &&
    typeof state.master === "boolean" &&
    /^[0-9a-f]{32}$/.test(state.admin_session) &&
    ["automatic", "manual"].includes(state.queue_mode) &&
    Array.isArray(state.queue) &&
    state.queue.length <= 16 &&
    state.queue.every(
      (user) =>
        typeof user.name === "string" &&
        /^[A-Za-z0-9_-]{2,24}$/.test(user.name) &&
        /^[0-9a-f]{32}$/.test(user.session),
    )
  );
}
export class RobotSession {
  constructor(config, onChange, onError, { adminPage = false } = {}) {
    Object.assign(this, { config, onChange, onError, adminPage });
    this.intent = null;
    this.retiredBoots = new Set();
    this.storageChain = Promise.resolve();
    this.connected = false;
    this.state = null;
    this.identity = null;
    this.seq = 0;
    this.commandId = 0;
    this.lastSeen = 0;
    this.pending = new Map();
    this.motionVersions = { car: 0, arm: 0 };
    this.inbound = Promise.resolve();
    this.stateChain = Promise.resolve();
    this.requestChain = Promise.resolve();
  }
  get online() {
    return this.connected;
  }
  get queueOnline() {
    return (
      this.connected &&
      this.state?.status === "online" &&
      !this.closing &&
      Date.now() - this.lastSeen < COORDINATOR_TIMEOUT_MS
    );
  }
  get joined() {
    return !!(
      !!this.intent &&
      this.state?.queue.some((user) => user.session === this.identity?.session)
    );
  }
  get adminAuthenticated() {
    return !!(
      this.coordinator &&
      this.identity?.role === "admin" &&
      !this.closing
    );
  }
  get isAdmin() {
    return !!(
      this.queueOnline &&
      this.adminAuthenticated &&
      !this.coordinatorPaused &&
      this.state.admin_session === this.identity.session
    );
  }
  get canControl() {
    return !!(
      this.queueOnline &&
      this.state.current === this.identity?.session &&
      (this.identity?.role === "admin"
        ? this.isAdmin && this.state.master
        : this.joined && !this.state.master)
    );
  }
  get stateTopic() {
    return this.config.topicPrefix + "/web/state";
  }
  get requestTopic() {
    return this.config.topicPrefix + "/web/request";
  }
  get replyTopic() {
    return this.config.topicPrefix + "/web/reply/" + this.identity.session;
  }
  async connect() {
    let saved;
    try {
      this.store = new BrowserStateStore(this.config, this.adminPage);
      await this.store.open();
      saved = await this.store.selectGuest();
    } catch {
      this.store?.close();
      this.store = null;
      this.onError(
        "Browser storage is unavailable. Refresh recovery will be limited in this browser.",
      );
    }
    if (
      saved?.identity?.role === "guest" &&
      /^[0-9a-f]{32}$/.test(saved.identity.session) &&
      /^04[0-9a-f]{128}$/.test(saved.identity.publicKey) &&
      saved.identity.key?.type === "private" &&
      saved.identity.key.extractable === false &&
      Number.isSafeInteger(saved.seq) &&
      saved.seq >= 0
    ) {
      const proof = await signMessage(saved.identity, {
        boot: randomSession(),
        seq: 1,
        action: "storage-check",
        data: {},
      });
      if (await verifyMessage(saved.identity.publicKey, proof)) {
        this.identity = saved.identity;
        this.seq = saved.seq;
        if (/^[A-Za-z0-9_-]{2,24}$/.test(saved.intent?.name))
          this.intent = saved.intent;
        this.pendingLeave = !!saved.pendingLeave;
        for (const boot of saved.retiredBoots ?? [])
          if (/^[0-9a-f]{32}$/.test(boot)) this.retiredBoots.add(boot);
        while (this.retiredBoots.size > 64)
          this.retiredBoots.delete(this.retiredBoots.values().next().value);
        if (
          saved.statePacket?.action === "state" &&
          saved.statePacket.role === "admin" &&
          (await verifyMessage(
            this.config.adminAuth.publicKey,
            saved.statePacket,
          ))
        ) {
          const data = JSON.parse(saved.statePacket.data);
          if (
            validState(data) ||
            (data.status === "offline" && Array.isArray(data.queue))
          ) {
            this.state = data;
            this.statePacket = saved.statePacket;
            this.lastStateSeq = saved.statePacket.seq;
          }
        }
      }
    }
    this.identity ??= await createGuestIdentity();
    this.guestIdentity = this.identity;
    this.guestSequence = this.seq;
    await this.saveGuest();
    this.onChange();
    this.deviceId = "WebControl_" + this.identity.session;
    this.voiceReplyTopic = LEGACY_TOPICS.response + "/" + this.deviceId;
    this.client = mqtt.connect(this.config.mqttUrl, {
      username: this.config.mqttUsername,
      password: this.config.mqttPassword,
      // Connections are unique even when a browser identity is restored.
      clientId: "ZeroWeb_" + randomSession(),
      clean: true,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      keepalive: 20,
      queueQoSZero: false,
    });
    this.client.on("connect", () => {
      this.lastSeen = 0;
      this.lastPresenceSent = 0;
      this.client.subscribe(
        [
          this.stateTopic,
          this.requestTopic,
          this.replyTopic,
          this.voiceReplyTopic,
        ],
        { qos: 0 },
        (error) => {
          this.connected = !error;
          if (error) this.onError(error.message);
          this.onChange();
          if (!error) {
            clearTimeout(this.recoveryTimer);
            if (this.coordinator)
              this.recoveryTimer = setTimeout(
                () =>
                  this.recoverCoordinator().catch((error) =>
                    this.onError(error.message),
                  ),
                250,
              );
            else this.reconcile();
          }
        },
      );
    });
    this.client.on("message", (topic, bytes) => {
      if (bytes.length > 16000) return;
      this.inbound = this.inbound
        .then(() => this.receive(topic, JSON.parse(bytes.toString())))
        .catch((error) => {
          if (!(error instanceof SyntaxError)) this.onError(error.message);
        });
    });
    for (const event of ["offline", "close"])
      this.client.on(event, () => {
        this.connected = false;
        this.lastSeen = 0;
        this.coordinatorPaused = !!this.coordinator;
        this.yieldToForeign = !!this.coordinator;
        clearTimeout(this.recoveryTimer);
        this.rejectPending("MQTT connection lost");
        this.onChange();
      });
    this.client.on("error", (error) => this.onError(error.message));
    this.timer = setInterval(() => this.refreshPresence(), 2000);
  }
  saveGuest() {
    if (!this.store || !this.guestIdentity) return Promise.resolve();
    const record = {
      identity: this.guestIdentity,
      seq: this.identity?.role === "guest" ? this.seq : this.guestSequence,
      intent: this.intent,
      pendingLeave: !!this.pendingLeave,
      statePacket: this.statePacket,
      retiredBoots: [...this.retiredBoots],
    };
    const operation = () => this.persist(() => this.store.saveGuest(record));
    const result = this.storageChain.then(operation);
    this.storageChain = result;
    return result;
  }
  async persist(operation) {
    try {
      await operation();
    } catch {
      if (!this.storageWarningShown) {
        this.storageWarningShown = true;
        this.onError(
          "Browser storage could not save this session. It can continue, but refresh recovery is limited until saving succeeds.",
        );
      }
    }
  }
  refreshPresence() {
    if (this.closing) return;
    if (this.coordinator && this.connected && !this.coordinatorPaused) {
      const owner = this.coordinator.current;
      this.coordinator.expire();
      if (owner !== this.coordinator.current)
        this.publishStop().catch((error) => this.onError(error.message));
      this.publishState().catch((error) => this.onError(error.message));
    } else this.reconcile();
    this.onChange();
  }
  async recoverCoordinator() {
    if (!this.coordinator || !this.connected || this.closing) return;
    this.coordinatorPaused = false;
    await this.publishStop();
    await this.publishState();
  }
  reconcile() {
    if (
      this.adminAuthenticated ||
      this.closing ||
      !this.queueOnline ||
      this.reconciling
    )
      return;
    const member = this.state.queue.find(
      (user) => user.session === this.identity?.session,
    );
    if (!this.intent && !this.pendingLeave) return;
    if (this.pendingLeave && !member) {
      this.pendingLeave = false;
      this.saveGuest().catch(() => {});
      return;
    }
    if (Date.now() - (this.lastPresenceSent ?? 0) < 2000) return;
    this.lastPresenceSent = Date.now();
    this.reconciling = true;
    const action = this.pendingLeave ? "leave" : member ? "heartbeat" : "join";
    const data = {
      key: this.identity.publicKey,
      ...(action === "join" ? { name: this.intent.name, recover: true } : {}),
    };
    this.request(action, data, true)
      .then(() => {
        if (action === "leave") this.pendingLeave = false;
      })
      .catch((error) => {
        if (error.rejected && action === "join") {
          this.intent = null;
          this.onError(error.message);
        }
      })
      .finally(() => {
        this.reconciling = false;
        this.saveGuest().catch(() => {});
        this.onChange();
      });
  }
  async receive(topic, message) {
    if (topic === this.voiceReplyTopic) {
      this.onVoiceResponse?.(message);
      return;
    }
    if (topic === this.requestTopic) {
      if (this.coordinator) await this.handleRequest(message);
      return;
    }
    if (
      topic !== this.stateTopic &&
      !topic.startsWith(this.config.topicPrefix + "/web/reply/")
    )
      return;
    if (
      message.role !== "admin" ||
      !(await verifyMessage(this.config.adminAuth.publicKey, message))
    )
      return;
    const data = JSON.parse(message.data),
      now = Date.now();
    if (
      !Number.isFinite(data.timestamp) ||
      now - data.timestamp > COORDINATOR_TIMEOUT_MS ||
      data.timestamp - now > 2000
    )
      return;
    if (topic === this.stateTopic && message.action === "state") {
      if (message.boot !== data.boot || message.session !== data.admin_session)
        return;
      if (this.retiredBoots.has(message.boot)) return;
      const generation = data.generation ?? 1;
      if (!Number.isSafeInteger(generation) || generation < 1) return;
      if (
        this.state?.admin_session === message.session &&
        generation < (this.state.generation ?? 1)
      )
        return;
      if (
        this.coordinator &&
        message.session === this.identity.session &&
        (generation < this.coordinator.generation ||
          (message.boot !== this.coordinator.boot &&
            generation === this.coordinator.generation))
      )
        return;
      if (this.coordinator && message.boot !== this.coordinator.boot) {
        if (data.recovering && !this.yieldToForeign) return;
        if (
          !(this.yieldToForeign && !data.recovering) &&
          message.session > this.identity.session
        )
          return;
        this.coordinator = null;
        this.coordinatorPaused = false;
        this.store?.releaseAdmin();
        this.onError("Another admin tab is managing the queue.");
      } else if (
        this.queueOnline &&
        this.state.admin_session !== message.session
      ) {
        if (data.recovering && !this.state.recovering) return;
        if (
          !(this.state.recovering && !data.recovering) &&
          message.session > this.state.admin_session
        )
          return;
      }
      if (
        message.boot === this.state?.boot &&
        message.seq <= (this.lastStateSeq ?? 0)
      )
        return;
      if (data.status !== "offline" && !validState(data)) return;
      if (this.state && message.boot !== this.state.boot) {
        this.retiredBoots.add(this.state.boot);
        while (this.retiredBoots.size > 64)
          this.retiredBoots.delete(this.retiredBoots.values().next().value);
        this.lastPresenceSent = 0;
        this.rejectPending("Queue restarted. Restoring your saved session.");
      }
      if (
        data.revoked?.includes(this.identity.session) &&
        this.intent &&
        !this.explicitJoinPending
      ) {
        this.intent = null;
        this.pendingLeave = false;
        this.onError("Admin ended your turn. Request access again when ready.");
      }
      this.lastStateSeq = message.seq;
      this.state = data;
      this.statePacket = message;
      this.lastSeen =
        data.status === "offline" ? 0 : Math.min(now, data.timestamp);
      await this.saveGuest();
      this.onChange();
      this.reconcile();
    } else if (
      message.action === "reply" &&
      message.boot === this.state?.boot &&
      data.recipient === this.identity.session
    ) {
      const pending = this.pending.get(data.requestSeq);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(data.requestSeq);
        if (data.ok) pending.resolve(data);
        else {
          const error = new Error(data.error);
          error.rejected = true;
          pending.reject(error);
        }
      }
    }
  }
  publish(topic, payload, options = { qos: 0, retain: false }) {
    if (!this.connected)
      return Promise.reject(new Error("MQTT is disconnected."));
    return new Promise((resolve, reject) =>
      this.client.publish(topic, JSON.stringify(payload), options, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  }
  publishState(offline = false) {
    const coordinator = this.coordinator,
      identity = this.identity;
    if (!coordinator || identity.role !== "admin") return Promise.resolve();
    const operation = async () => {
      if (this.coordinator !== coordinator || !this.connected) return;
      const data = {
        ...coordinator.snapshot(),
        recovering: !!this.yieldToForeign,
        timestamp: Date.now(),
      };
      if (offline) {
        data.status = "offline";
        data.current = "";
        // Offline state pauses grants while preserving the queue for recovery.
      }
      const packet = await signMessage(identity, {
        boot: coordinator.boot,
        seq: ++this.seq,
        action: "state",
        data,
      });
      if (this.coordinator !== coordinator) return;
      if (this.store) {
        const checkpoint = await signMessage(identity, {
          boot: coordinator.boot,
          seq: packet.seq,
          action: "checkpoint",
          data: { version: 1, queue: coordinator.serialize() },
        });
        await this.persist(() => this.store.saveCheckpoint(checkpoint));
      }
      if (this.coordinator !== coordinator || !this.connected) return;
      await this.publish(this.stateTopic, packet, { qos: 0, retain: true });
      this.state = data;
      this.statePacket = packet;
      this.lastStateSeq = packet.seq;
      this.lastSeen = offline ? 0 : Date.now();
      this.onChange();
    };
    const result = this.stateChain.then(operation);
    this.stateChain = result.catch(() => {});
    return result;
  }
  async handleRequest(message) {
    const coordinator = this.coordinator;
    if (
      message.role !== "guest" ||
      message.boot !== coordinator.boot ||
      message.session === this.identity.session ||
      message.data?.length > 2000
    )
      return;
    const data = JSON.parse(message.data);
    if (
      !Number.isFinite(data.timestamp) ||
      Math.abs(Date.now() - data.timestamp) > 10000
    )
      return;
    for (const [session, record] of this.requests) {
      if (
        Date.now() - record.lastSeen > 10000 &&
        !coordinator.users.some((user) => user.session === session)
      )
        this.requests.delete(session);
    }
    const previous = this.requests.get(message.session);
    const publicKey =
      previous?.key ??
      coordinator.users.find((user) => user.session === message.session)?.key ??
      data.key;
    if (
      previous &&
      (message.seq <= previous.seq || (data.key && previous.key !== data.key))
    )
      return;
    if (
      !(await verifyMessage(publicKey, message)) ||
      this.coordinator !== coordinator
    )
      return;
    if (!previous && this.requests.size >= 256) {
      await this.reply(
        message,
        "The access queue is busy. Please try again shortly.",
      );
      return;
    }
    this.requests.set(message.session, {
      key: publicKey,
      seq: message.seq,
      // Keep replay history until even future-dated signed requests expire.
      lastSeen: Math.max(Date.now(), data.timestamp),
    });
    const owner = coordinator.current;
    let error = "";
    try {
      if (message.action === "join") {
        if (data.recover && coordinator.revoked.has(message.session))
          throw new Error(
            "Admin ended your turn. Request access again when ready.",
          );
        coordinator.join(message.session, data.name, publicKey);
      } else if (message.action === "leave") coordinator.leave(message.session);
      else if (message.action === "heartbeat")
        coordinator.heartbeat(message.session);
      else throw new Error("Unsupported queue request");
    } catch (failure) {
      error = failure.message;
    }
    if (owner !== coordinator.current) await this.publishStop();
    await this.publishState();
    await this.reply(message, error);
  }
  async reply(message, error = "") {
    const packet = await signMessage(this.identity, {
      boot: this.coordinator.boot,
      seq: ++this.seq,
      action: "reply",
      data: {
        recipient: message.session,
        requestSeq: message.seq,
        ok: !error,
        error,
        timestamp: Date.now(),
      },
    });
    await this.publish(
      this.config.topicPrefix + "/web/reply/" + message.session,
      packet,
    );
  }
  rejectPending(reason) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
  cancelMotion(target) {
    for (const name of target ? [target] : ["car", "arm"])
      this.motionVersions[name]++;
  }
  send(action, data = {}, waitForReply = false) {
    if (["car", "arm", "position", "stop"].includes(action)) {
      if (!this.canControl)
        return Promise.reject(
          new Error("Control state changed. Request access first."),
        );
      if (action === "stop") return this.publishStop();
      if (action !== "car" && !this.config.hasRoboticArm)
        return Promise.reject(new Error("Robotic arm controls are disabled."));
      if (action === "position") {
        const positions = Object.fromEntries(
          Object.entries(data).filter(
            ([key, value]) =>
              /^A[1-5]$/.test(key) &&
              Number.isInteger(value) &&
              value >= 0 &&
              value <= 180,
          ),
        );
        if (!Object.keys(positions).length)
          return Promise.reject(new Error("Invalid arm positions"));
        return this.publish(LEGACY_TOPICS.position, {
          ...positions,
          timestamp: Date.now(),
          id: ++this.commandId,
        });
      }
      const allowed =
        action === "car"
          ? ["F", "B", "L", "R", "S"]
          : ["U", "D", "C", "O", "1", "2", "3", "4", "S"];
      if (!allowed.includes(data.cmd))
        return Promise.reject(new Error("Invalid movement command"));
      const payload = {
        cmd: data.cmd,
        timestamp: Date.now(),
        id: ++this.commandId,
      };
      if (action === "car")
        payload.speed = Math.max(
          0,
          Math.min(100, Number(data.speed ?? 50) || 0),
        );
      return this.publish(LEGACY_TOPICS[action], payload);
    }
    if (action === "leave" && this.identity?.role === "guest")
      return this.leave();
    if (this.adminAuthenticated && action === "logout")
      return this.adminAction(action, data);
    if (this.isAdmin) return this.adminAction(action, data);
    return this.request(action, data, waitForReply);
  }
  request(action, data, waitForReply) {
    if (!this.queueOnline)
      return Promise.reject(
        new Error(
          "An admin must sign in at /admin and keep that tab open to manage access.",
        ),
      );
    const identity = this.identity,
      boot = this.state.boot;
    const assertCurrent = () => {
      if (
        this.identity !== identity ||
        !this.queueOnline ||
        this.state.boot !== boot
      )
        throw new Error("Control state changed. Try again.");
    };
    const operation = async () => {
      assertCurrent();
      const seq = ++this.seq;
      this.guestSequence = this.seq;
      await this.saveGuest();
      assertCurrent();
      const packet = await signMessage(identity, {
        boot,
        seq,
        action,
        data: { ...data, timestamp: Date.now() },
      });
      assertCurrent();
      let reply;
      if (waitForReply) {
        reply = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(seq);
            reject(new Error("Admin did not confirm the request. Try again."));
          }, 5000);
          this.pending.set(seq, { resolve, reject, timer });
        });
        reply.catch(() => {});
      }
      try {
        await this.publish(this.requestTopic, packet);
      } catch (error) {
        this.rejectPending(error.message);
        throw error;
      }
      return { reply };
    };
    const result = this.requestChain.then(operation);
    this.requestChain = result.catch(() => {});
    return result.then(({ reply }) => reply);
  }
  async join(name) {
    name = name.trim();
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(name))
      throw new Error(
        "Use 2–24 letters, digits, underscores or hyphens for your name.",
      );
    this.intent = { name };
    this.pendingLeave = false;
    this.lastPresenceSent = Date.now();
    await this.saveGuest();
    this.explicitJoinPending = true;
    try {
      await this.request("join", { name, key: this.identity.publicKey }, true);
    } catch (error) {
      if (error.rejected) {
        this.intent = null;
        await this.saveGuest();
      }
      throw error;
    } finally {
      this.explicitJoinPending = false;
      this.onChange();
    }
  }
  async leave() {
    this.intent = null;
    this.pendingLeave = true;
    this.lastPresenceSent = Date.now();
    await this.saveGuest();
    this.onChange();
    if (!this.queueOnline) return;
    await this.request("leave", {}, true);
    this.pendingLeave = false;
    await this.saveGuest();
    this.onChange();
  }
  async login(password) {
    if (!this.connected)
      throw new Error("Wait for MQTT to connect before signing in.");
    const identity = await createAdminIdentity(password, this.config.adminAuth);
    let checkpoint;
    if (this.store) {
      const cached = await this.store.readCheckpoint();
      if (
        cached?.role === "admin" &&
        cached.action === "checkpoint" &&
        (await verifyMessage(this.config.adminAuth.publicKey, cached))
      )
        checkpoint = cached;
      if (!(await this.store.claimAdmin()))
        throw new Error(
          "Another admin tab is managing the queue. Use that tab.",
        );
    }
    try {
      if (checkpoint) identity.session = checkpoint.session;
      if (
        this.queueOnline &&
        !this.isAdmin &&
        this.state.admin_session !== checkpoint?.session
      )
        throw new Error(
          "Another admin is signed in. Use that tab, or wait until it disconnects.",
        );
      if (!this.connected) throw new Error("MQTT connection lost");
      let coordinator;
      if (checkpoint) {
        const data = JSON.parse(checkpoint.data);
        if (data.version !== 1)
          throw new Error("Saved queue version is unsupported");
        coordinator = AccessQueue.restore(
          data.queue,
          identity.session,
          randomSession(),
        );
      } else
        coordinator = new AccessQueue(
          this.config.queueMode ?? "automatic",
          identity.session,
          randomSession(),
        );
      this.rejectPending("Session changed");
      this.identity = identity;
      this.seq = 0;
      this.requests = new Map();
      this.coordinator = coordinator;
      this.coordinatorPaused = false;
      this.yieldToForeign = false;
      if (checkpoint) this.retiredBoots.add(checkpoint.boot);
      this.lastSeen = 0;
      this.lastStateSeq = 0;
      await this.publishStop();
      await this.publishState();
    } catch (error) {
      if (!this.coordinator) this.store?.releaseAdmin();
      throw error;
    }
  }
  async adminAction(action, data) {
    const coordinator = this.coordinator,
      owner = coordinator.current;
    if (action === "master") coordinator.setMaster(!!data.enabled);
    else if (action === "grant") coordinator.grant(data.session);
    else if (action === "revoke") coordinator.revoke();
    else if (action === "mode") coordinator.setMode(!!data.automatic);
    else if (action === "logout") {
      this.coordinatorPaused = true;
      try {
        if (this.connected) {
          await this.publishStop();
          await this.publishState(true);
        }
      } finally {
        this.coordinator = null;
        this.identity = this.guestIdentity;
        this.seq = this.guestSequence ?? 0;
        this.lastSeen = 0;
        clearTimeout(this.recoveryTimer);
        if (this.state) this.state = { ...this.state, status: "offline" };
        this.store?.releaseAdmin();
        this.onChange();
      }
      return;
    } else throw new Error("Unsupported admin action");
    if (owner !== coordinator.current) await this.publishStop();
    await this.publishState();
  }
  publishStop() {
    const commands = [
      this.publish(LEGACY_TOPICS.car, {
        cmd: "S",
        speed: 0,
        timestamp: Date.now(),
        id: ++this.commandId,
      }),
    ];
    if (this.config.hasRoboticArm)
      commands.push(
        this.publish(LEGACY_TOPICS.arm, {
          cmd: "S",
          timestamp: Date.now(),
          id: ++this.commandId,
        }),
      );
    return Promise.all(commands);
  }
  sendAudio(payload) {
    if (!this.canControl)
      return Promise.reject(
        new Error("Request control access before using voice."),
      );
    return this.publish(
      LEGACY_TOPICS.audio,
      {
        ...payload,
        security_token:
          this.config.voiceSecurityToken ?? "ALICE_ZERO_2024_SECURE",
        device_id: this.deviceId,
      },
      { qos: 1, retain: false },
    );
  }
  stop() {
    this.cancelMotion();
    return this.canControl
      ? this.publishStop().catch(() => {})
      : Promise.resolve();
  }
  close() {
    // Reload/navigation is not an explicit leave or admin sign-out.
    this.stop();
    this.closing = true;
    clearInterval(this.timer);
    clearTimeout(this.recoveryTimer);
    this.rejectPending("Page closed");
    this.store?.close();
    this.client?.end(true);
  }
}
