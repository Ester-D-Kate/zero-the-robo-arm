export const USER_TIMEOUT_MS = 120000;
export const USER_RESERVATION_MS = 600000;
export class AccessQueue {
  constructor(mode, adminSession, boot) {
    this.mode = mode;
    this.adminSession = adminSession;
    this.boot = boot;
    this.users = [];
    this.current = "";
    this.master = false;
    this.epoch = 1;
    this.generation = 1;
    this.revoked = new Set();
  }
  changeOwner(owner) {
    if (this.current !== owner) {
      this.current = owner;
      this.epoch++;
    }
  }
  advance() {
    if (!this.master && !this.current && this.mode === "automatic")
      this.changeOwner(
        this.users.find((user) => user.online !== false)?.session ?? "",
      );
  }
  join(session, name, key, now = Date.now()) {
    name = name.trim();
    if (!/^[A-Za-z0-9_-]{2,24}$/.test(name))
      throw new Error(
        "Use 2–24 letters, digits, underscores or hyphens for your name.",
      );
    this.revoked.delete(session);
    const user = this.users.find((user) => user.session === session);
    if (user) {
      user.lastSeen = now;
      user.online = true;
      this.advance();
      return;
    }
    if (
      this.users.some((user) => user.name.toLowerCase() === name.toLowerCase())
    )
      throw new Error("That username is already in use.");
    if (this.users.length >= 16)
      throw new Error("The queue is full. Please try later.");
    this.users.push({ session, name, key, lastSeen: now, online: true });
    this.advance();
  }
  heartbeat(session, now = Date.now()) {
    const user = this.users.find((user) => user.session === session);
    if (!user) throw new Error("Request access again.");
    user.lastSeen = now;
    user.online = true;
    this.advance();
  }
  leave(session) {
    this.users = this.users.filter((user) => user.session !== session);
    if (this.current === session) this.changeOwner("");
    this.advance();
  }
  expire(now = Date.now()) {
    let changed = false;
    for (const user of [...this.users]) {
      if (now - user.lastSeen >= USER_RESERVATION_MS) {
        this.leave(user.session);
        changed = true;
      } else if (
        now - user.lastSeen >= USER_TIMEOUT_MS &&
        user.online !== false
      ) {
        user.online = false;
        changed = true;
        if (this.current === user.session) this.changeOwner("");
      }
    }
    this.advance();
    return changed;
  }
  serialize() {
    return {
      mode: this.mode,
      current: this.current,
      master: this.master,
      epoch: this.epoch,
      generation: this.generation,
      revoked: [...this.revoked],
      users: this.users.map((user) => ({ ...user })),
    };
  }
  static restore(saved, adminSession, boot) {
    if (
      !saved ||
      !["automatic", "manual"].includes(saved.mode) ||
      !Number.isSafeInteger(saved.epoch) ||
      saved.epoch < 1 ||
      typeof saved.master !== "boolean" ||
      !Array.isArray(saved.users) ||
      saved.users.length > 16 ||
      typeof saved.current !== "string"
    )
      throw new Error("Saved queue is invalid");
    if (
      !Number.isSafeInteger(saved.generation ?? 1) ||
      (saved.generation ?? 1) < 1 ||
      !Array.isArray(saved.revoked ?? []) ||
      (saved.revoked ?? []).length > 256 ||
      (saved.revoked ?? []).some((session) => !/^[0-9a-f]{32}$/.test(session))
    )
      throw new Error("Saved queue is invalid");
    const sessions = new Set(),
      names = new Set();
    for (const user of saved.users) {
      if (
        !/^[0-9a-f]{32}$/.test(user.session) ||
        !/^[A-Za-z0-9_-]{2,24}$/.test(user.name) ||
        !/^04[0-9a-f]{128}$/.test(user.key) ||
        !Number.isFinite(user.lastSeen) ||
        typeof user.online !== "boolean" ||
        sessions.has(user.session) ||
        names.has(user.name.toLowerCase())
      )
        throw new Error("Saved queue is invalid");
      sessions.add(user.session);
      names.add(user.name.toLowerCase());
    }
    const queue = new AccessQueue(saved.mode, adminSession, boot);
    queue.generation = (saved.generation ?? 1) + 1;
    queue.revoked = new Set(saved.revoked ?? []);
    queue.users = saved.users.map((user) => ({ ...user }));
    queue.master = saved.master;
    queue.epoch = saved.epoch + 1;
    queue.current = saved.master
      ? adminSession
      : sessions.has(saved.current)
        ? saved.current
        : "";
    queue.expire();
    return queue;
  }
  grant(session) {
    if (this.master)
      throw new Error("Release master control before granting a turn.");
    if (
      !this.users.some(
        (user) => user.session === session && user.online !== false,
      )
    )
      throw new Error("That user has left the queue.");
    this.changeOwner(session);
  }
  revoke() {
    if (!this.master && this.current) {
      this.revoked.add(this.current);
      if (this.revoked.size > 256)
        this.revoked.delete(this.revoked.values().next().value);
      this.leave(this.current);
    }
  }
  setMaster(enabled) {
    if (this.master === enabled) return;
    this.master = enabled;
    this.epoch++;
    this.changeOwner(enabled ? this.adminSession : "");
    this.advance();
  }
  setMode(automatic) {
    this.mode = automatic ? "automatic" : "manual";
    this.advance();
  }
  snapshot() {
    return {
      status: "online",
      boot: this.boot,
      epoch: this.epoch,
      generation: this.generation,
      revoked: [...this.revoked],
      current: this.current,
      master: this.master,
      queue_mode: this.mode,
      admin_session: this.adminSession,
      queue: this.users.map(({ session, name, online }) => ({
        session,
        name,
        online,
      })),
    };
  }
}
