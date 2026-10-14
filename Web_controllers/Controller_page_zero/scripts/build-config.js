import {
  pbkdf2Sync,
  generateKeyPairSync,
  createCipheriv,
  randomBytes,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import { PBKDF2_ITERATIONS } from "../protocol.js";

const CONFIG_KEYS = [
  "HAS_ROBOTIC_ARM",
  "ADMIN_PASSWORD",
  "MQTT_TOPIC_PREFIX",
  "MQTT_WEBSOCKET_URL",
  "MQTT_USERNAME",
  "MQTT_PASSWORD",
  "QUEUE_MODE",
  "VOICE_SECURITY_TOKEN",
];

export function mergeBuildEnvironment(localEnv, buildEnv) {
  const result = {};
  for (const key of CONFIG_KEYS) {
    const value = buildEnv[key] ?? localEnv[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export function parseEnv(source) {
  const result = {};
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) throw new Error("Invalid .env line");
    let value = match[2];
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) {
      if (!value.endsWith("'")) throw new Error("Unclosed .env value");
      value = value.slice(1, -1);
    }
    result[match[1]] = value;
  }
  return result;
}
export function readConfig(
  env,
  salt = randomBytes(16).toString("hex"),
  existingAuth,
) {
  const flag = env.HAS_ROBOTIC_ARM ?? "false";
  if (!["true", "false"].includes(flag))
    throw new Error("HAS_ROBOTIC_ARM must be true or false");
  if (
    !env.ADMIN_PASSWORD ||
    env.ADMIN_PASSWORD.length < 16 ||
    env.ADMIN_PASSWORD === "replace-with-a-long-unique-password" ||
    /change.?me|your.?password/i.test(env.ADMIN_PASSWORD)
  )
    throw new Error(
      "ADMIN_PASSWORD must be a unique password of at least 16 characters",
    );
  const prefix = env.MQTT_TOPIC_PREFIX;
  if (
    !prefix ||
    !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix) ||
    prefix.length > 80
  )
    throw new Error("Invalid MQTT_TOPIC_PREFIX");
  const mqttUrl = new URL(
    env.MQTT_WEBSOCKET_URL ?? "wss://broker.emqx.io:8084/mqtt",
  );
  if (
    !["ws:", "wss:"].includes(mqttUrl.protocol) ||
    mqttUrl.username ||
    mqttUrl.password
  )
    throw new Error("Invalid MQTT_WEBSOCKET_URL");
  const mode = env.QUEUE_MODE ?? "automatic";
  if (!["automatic", "manual"].includes(mode))
    throw new Error("QUEUE_MODE must be automatic or manual");
  if (!/^[a-f0-9]{32}$/.test(salt)) throw new Error("Invalid admin salt");
  let adminAuth;
  if (existingAuth) {
    try {
      if (
        !/^[0-9a-f]{32}$/.test(existingAuth.salt) ||
        !/^[0-9a-f]{24}$/.test(existingAuth.iv) ||
        !/^04[0-9a-f]{128}$/.test(existingAuth.publicKey) ||
        !/^(?:[0-9a-f]{2})+$/.test(existingAuth.ciphertext)
      )
        throw new Error("Invalid cached admin identity");
      const encrypted = Buffer.from(existingAuth.ciphertext, "hex");
      const key = pbkdf2Sync(
        env.ADMIN_PASSWORD,
        Buffer.from(existingAuth.salt, "hex"),
        PBKDF2_ITERATIONS,
        32,
        "sha256",
      );
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(existingAuth.iv, "hex"),
      );
      decipher.setAuthTag(encrypted.subarray(-16));
      const pkcs8 = Buffer.concat([
        decipher.update(encrypted.subarray(0, -16)),
        decipher.final(),
      ]);
      const privateKey = createPrivateKey({
        key: pkcs8,
        format: "der",
        type: "pkcs8",
      });
      const jwk = createPublicKey(privateKey).export({ format: "jwk" });
      const publicKey = Buffer.concat([
        Buffer.from([4]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]).toString("hex");
      if (publicKey !== existingAuth.publicKey)
        throw new Error("Admin identity mismatch");
      adminAuth = existingAuth;
    } catch {
      /* Password changes intentionally rotate the signing identity. */
    }
  }
  if (!adminAuth) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    });
    const jwk = publicKey.export({ format: "jwk" });
    const rawPublicKey = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x, "base64url"),
      Buffer.from(jwk.y, "base64url"),
    ]).toString("hex");
    const derivedKey = pbkdf2Sync(
      env.ADMIN_PASSWORD,
      Buffer.from(salt, "hex"),
      PBKDF2_ITERATIONS,
      32,
      "sha256",
    );
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", derivedKey, iv);
    const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
    const ciphertext = Buffer.concat([
      cipher.update(pkcs8),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    adminAuth = {
      salt,
      iv: iv.toString("hex"),
      ciphertext: ciphertext.toString("hex"),
      publicKey: rawPublicKey,
    };
  }
  return {
    public: {
      hasRoboticArm: flag === "true",
      mqttUrl: mqttUrl.href,
      topicPrefix: prefix,
      mqttUsername: env.MQTT_USERNAME ?? "",
      mqttPassword: env.MQTT_PASSWORD ?? "",
      queueMode: mode,
      voiceSecurityToken: env.VOICE_SECURITY_TOKEN ?? "ALICE_ZERO_2024_SECURE",
      adminAuth,
    },
  };
}
