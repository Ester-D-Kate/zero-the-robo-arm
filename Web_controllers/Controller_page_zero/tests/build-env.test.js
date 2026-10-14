import { afterEach, expect, test } from "bun:test";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdminIdentity } from "../protocol.js";

const source = path.resolve(import.meta.dir, "..");
const temporaryRoots = [];
const configKeys = [
  "HAS_ROBOTIC_ARM",
  "ADMIN_PASSWORD",
  "MQTT_TOPIC_PREFIX",
  "MQTT_WEBSOCKET_URL",
  "MQTT_USERNAME",
  "MQTT_PASSWORD",
  "QUEUE_MODE",
  "VOICE_SECURITY_TOKEN",
];
const deployment = {
  HAS_ROBOTIC_ARM: "false",
  ADMIN_PASSWORD: "fixture cloud admin password",
  MQTT_TOPIC_PREFIX: "zero/cloud-fixture",
  MQTT_WEBSOCKET_URL: "wss://broker.example/mqtt",
  MQTT_USERNAME: "",
  MQTT_PASSWORD: "",
  QUEUE_MODE: "manual",
  VOICE_SECURITY_TOKEN: "fixture-voice-token",
  NETLIFY_BUILD_TOKEN: "fixture-secret-that-must-not-be-published",
};

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function build(localEnv) {
  const root = await mkdtemp(path.join(os.tmpdir(), "zero-build-test-"));
  temporaryRoots.push(root);
  const directory = path.join(root, "Web_controllers/Controller_page_zero");
  await mkdir(path.join(directory, "scripts"), { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isFile() && /\.(js|html|css)$/.test(entry.name))
      await copyFile(
        path.join(source, entry.name),
        path.join(directory, entry.name),
      );
  }
  for (const file of ["build.js", "build-config.js"])
    await copyFile(
      path.join(source, "scripts", file),
      path.join(directory, "scripts", file),
    );
  await symlink(
    path.join(source, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  if (localEnv !== undefined)
    await writeFile(path.join(root, ".env"), localEnv);
  const env = { ...process.env };
  for (const key of [...configKeys, "ZERO_ENV_FILE"]) delete env[key];
  const child = Bun.spawn([process.execPath, "scripts/build.js"], {
    cwd: directory,
    env: { ...env, ...deployment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const configText = await readFile(
    path.join(directory, "dist/config.js"),
    "utf8",
  );
  const config = JSON.parse(
    configText
      .slice(configText.indexOf("=") + 1)
      .trim()
      .replace(/;$/, ""),
  );
  const assets = await Promise.all(
    [
      "config.js",
      "controller.js",
      "index.html",
      "admin/index.html",
      "style.css",
    ].map((file) => readFile(path.join(directory, "dist", file), "utf8")),
  );
  const output = assets.join("\n") + stdout + stderr;
  expect(output).not.toContain(deployment.ADMIN_PASSWORD);
  expect(output).not.toContain(deployment.NETLIFY_BUILD_TOKEN);
  await expect(
    createAdminIdentity(deployment.ADMIN_PASSWORD, config.adminAuth),
  ).resolves.toBeDefined();
  return config;
}

test("Netlify environment variables build the static controller without a local .env file", async () => {
  const config = await build();
  expect(config).toMatchObject({
    hasRoboticArm: false,
    mqttUrl: "wss://broker.example/mqtt",
    topicPrefix: "zero/cloud-fixture",
    mqttUsername: "",
    mqttPassword: "",
    queueMode: "manual",
    voiceSecurityToken: "fixture-voice-token",
  });
});

test("Netlify values override local .env, including intentionally blank MQTT credentials", async () => {
  const config = await build(
    [
      "HAS_ROBOTIC_ARM=true",
      "ADMIN_PASSWORD=fixture different local password",
      "MQTT_TOPIC_PREFIX=zero/local-fixture",
      "MQTT_WEBSOCKET_URL=wss://local.example/mqtt",
      "MQTT_USERNAME=local-user",
      "MQTT_PASSWORD=local-password",
      "QUEUE_MODE=automatic",
      "VOICE_SECURITY_TOKEN=local-token",
    ].join("\n"),
  );
  expect(config).toMatchObject({
    hasRoboticArm: false,
    mqttUrl: "wss://broker.example/mqtt",
    topicPrefix: "zero/cloud-fixture",
    mqttUsername: "",
    mqttPassword: "",
    queueMode: "manual",
    voiceSecurityToken: "fixture-voice-token",
  });
});
