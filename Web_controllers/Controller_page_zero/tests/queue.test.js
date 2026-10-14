import { expect, test } from "bun:test";
import { AccessQueue } from "../access-queue.js";
const queue = (mode = "automatic") => new AccessQueue(mode, "admin", "boot");
test("automatic queue reserves unique names and hands over on leave", () => {
  const q = queue();
  q.join("a", "Kate", "key-a", 100);
  q.join("b", "Sam", "key-b", 100);
  expect(q.current).toBe("a");
  expect(() => q.join("c", "kate", "key-c", 100)).toThrow("already");
  q.leave("a");
  expect(q.current).toBe("b");
  expect(q.snapshot().queue).toEqual([
    { name: "Sam", session: "b", online: true },
  ]);
});
test("manual grants and admin master suspend and resume the queue", () => {
  const q = queue("manual");
  q.join("a", "Kate", "key", 100);
  expect(q.current).toBe("");
  q.grant("a");
  const epoch = q.epoch;
  q.setMaster(true);
  expect(q.current).toBe("admin");
  expect(q.epoch).toBeGreaterThan(epoch);
  expect(() => q.grant("a")).toThrow("Release");
  q.setMaster(false);
  expect(q.current).toBe("");
  q.setMode(true);
  expect(q.current).toBe("a");
});
test("temporary absence preserves a queue place while releasing an inactive driver", () => {
  const q = queue();
  q.join("a", "Kate", "key", 0);
  q.join("b", "Sam", "key", 110000);
  q.expire(120000);
  expect(q.current).toBe("b");
  expect(q.users).toHaveLength(2);
  expect(q.users[0].online).toBe(false);
  q.heartbeat("a", 120001);
  expect(q.users[0].online).toBe(true);
  expect(q.current).toBe("b");
  q.leave("b");
  expect(q.current).toBe("a");
});
test("abandoned reservations expire after ten minutes rather than a short interruption", () => {
  const q = queue();
  q.join("a", "Kate", "key", 0);
  q.join("b", "Sam", "key", 590000);
  q.expire(600000);
  expect(q.users.map((user) => user.name)).toEqual(["Sam"]);
  expect(q.current).toBe("b");
});
