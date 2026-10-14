import { expect, test } from "bun:test";
import { readConfig, parseEnv } from "../scripts/build-config.js";
import {
  createAdminIdentity,
  createGuestIdentity,
  signMessage,
  verifyMessage,
} from "../protocol.js";
const env = {
  ADMIN_PASSWORD: "correct horse battery staple",
  MQTT_TOPIC_PREFIX: "zero/test",
  HAS_ROBOTIC_ARM: "false",
};
test("static admin login rejects wrong passwords and produces verifiable state signatures", async () => {
  const config = readConfig(env).public;
  await expect(
    createAdminIdentity("incorrect password", config.adminAuth),
  ).rejects.toThrow("Incorrect admin password");
  const identity = await createAdminIdentity(
    env.ADMIN_PASSWORD,
    config.adminAuth,
  );
  const message = await signMessage(identity, {
    boot: "1234567890abcdef1234567890abcdef",
    seq: 1,
    action: "state",
    data: { current: "Kate" },
  });
  expect(await verifyMessage(config.adminAuth.publicKey, message)).toBe(true);
  message.data = '{"current":"attacker"}';
  expect(await verifyMessage(config.adminAuth.publicKey, message)).toBe(false);
  expect(JSON.stringify(config)).not.toContain(env.ADMIN_PASSWORD);
  expect(identity.key.extractable).toBe(false);
});
test("a guest signature cannot impersonate the admin coordinator", async () => {
  const guest = await createGuestIdentity(),
    config = readConfig(env).public;
  const message = await signMessage(guest, {
    boot: "1234567890abcdef1234567890abcdef",
    seq: 1,
    action: "state",
    data: {},
  });
  expect(await verifyMessage(guest.publicKey, message)).toBe(true);
  message.role = "admin";
  expect(await verifyMessage(config.adminAuth.publicKey, message)).toBe(false);
});
test("layout and broker configuration stay independent of firmware", () => {
  expect(
    readConfig({ ...env, HAS_ROBOTIC_ARM: "true" }).public.hasRoboticArm,
  ).toBe(true);
  expect(() => readConfig({ ...env, HAS_ROBOTIC_ARM: "yes" })).toThrow();
  expect(() =>
    readConfig({
      ...env,
      ADMIN_PASSWORD: "replace-with-a-long-unique-password",
    }),
  ).toThrow();
  expect(
    parseEnv('HAS_ROBOTIC_ARM=false\n# comment\nMQTT_TOPIC_PREFIX="zero/test"'),
  ).toEqual({ HAS_ROBOTIC_ARM: "false", MQTT_TOPIC_PREFIX: "zero/test" });
});

test("rebuilds with the same password retain signed-state compatibility while password changes rotate it", async () => {
  const first = readConfig(env).public,
    identity = await createAdminIdentity(env.ADMIN_PASSWORD, first.adminAuth);
  const packet = await signMessage(identity, {
    boot: "1234567890abcdef1234567890abcdef",
    seq: 1,
    action: "state",
    data: {},
  });
  const rebuilt = readConfig(env, undefined, first.adminAuth).public;
  expect(await verifyMessage(rebuilt.adminAuth.publicKey, packet)).toBe(true);
  const rotated = readConfig(
    { ...env, ADMIN_PASSWORD: "a different long random password" },
    undefined,
    first.adminAuth,
  ).public;
  expect(await verifyMessage(rotated.adminAuth.publicKey, packet)).toBe(false);
  await expect(
    createAdminIdentity(env.ADMIN_PASSWORD, rotated.adminAuth),
  ).rejects.toThrow();
});
