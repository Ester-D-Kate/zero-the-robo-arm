import { randomSession } from "./protocol.js";
// CryptoKeys are structured-cloned by IndexedDB; no private key is exported.
export class BrowserStateStore {
  constructor(config, adminPage = false) {
    this.scope = [
      "zero-v1",
      config.mqttUrl,
      config.topicPrefix,
      config.adminAuth.publicKey,
    ].join("|");
    this.guestPrefix =
      this.scope + "/session/" + (adminPage ? "admin/" : "guest/");
    this.adminPage = adminPage;
    this.releases = [];
  }
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("zero-controller-state", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("records");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    this.db.onversionchange = () => this.db.close();
  }
  transaction(mode, action) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("records", mode);
      let result;
      const request = action(transaction.objectStore("records"));
      request.onsuccess = () => {
        result = request.result;
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () =>
        reject(
          transaction.error ?? new Error("Browser storage transaction aborted"),
        );
    });
  }
  read(key) {
    return this.transaction("readonly", (store) => store.get(key));
  }
  write(key, value) {
    return this.transaction("readwrite", (store) => store.put(value, key));
  }
  async lock(name) {
    if (!navigator.locks) return () => {};
    return new Promise((resolve, reject) => {
      navigator.locks
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            resolve(null);
            return;
          }
          return new Promise((release) => {
            resolve(release);
          });
        })
        .catch(reject);
    });
  }
  async selectGuest() {
    const slotKey = this.guestPrefix + "tab";
    let slot = sessionStorage.getItem(slotKey),
      release;
    if (slot) release = await this.lock(this.guestPrefix + slot);
    if (!slot && !this.adminPage && navigator.locks) {
      const keys = await this.transaction("readonly", (store) =>
        store.getAllKeys(),
      );
      const candidates = await Promise.all(
        keys
          .filter(
            (key) =>
              typeof key === "string" && key.startsWith(this.guestPrefix),
          )
          .map(async (key) => ({ key, record: await this.read(key) })),
      );
      candidates.sort(
        (a, b) => (b.record?.updatedAt ?? 0) - (a.record?.updatedAt ?? 0),
      );
      for (const candidate of candidates) {
        if (!candidate.record?.intent?.name) continue;
        release = await this.lock(candidate.key);
        if (release) {
          slot = candidate.key.slice(this.guestPrefix.length);
          break;
        }
      }
    }
    if (!release) {
      slot = randomSession();
      release = await this.lock(this.guestPrefix + slot);
    }
    if (!release) throw new Error("Could not reserve a browser session");
    this.releases.push(release);
    this.guestKey = this.guestPrefix + slot;
    sessionStorage.setItem(slotKey, slot);
    return this.read(this.guestKey);
  }
  saveGuest(record) {
    return this.write(this.guestKey, { ...record, updatedAt: Date.now() });
  }
  readCheckpoint() {
    return this.read(this.scope + "/queue");
  }
  saveCheckpoint(packet) {
    return this.write(this.scope + "/queue", packet);
  }
  async claimAdmin() {
    if (this.adminRelease) return true;
    this.adminRelease = await this.lock(this.scope + "/coordinator");
    return !!this.adminRelease;
  }
  releaseAdmin() {
    this.adminRelease?.();
    this.adminRelease = null;
  }
  close() {
    this.releaseAdmin();
    for (const release of this.releases) release();
    this.releases = [];
    this.db?.close();
  }
}
