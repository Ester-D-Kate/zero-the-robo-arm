import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mergeBuildEnvironment, parseEnv, readConfig } from "./build-config.js";
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = path.resolve(source, "../..");
const envPath = process.env.ZERO_ENV_FILE ?? path.join(root, ".env");
const dist = path.join(source, "dist");
const cache = path.join(root, ".cache");
const authPath = path.join(cache, "admin-auth.json");
let localEnv = {};
try {
  localEnv = parseEnv(await readFile(envPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT" || process.env.ZERO_ENV_FILE) throw error;
}
let existingAuth;
try {
  existingAuth = JSON.parse(await readFile(authPath, "utf8"));
} catch {
  try {
    const previous = await readFile(path.join(dist, "config.js"), "utf8");
    existingAuth = JSON.parse(
      previous
        .slice(previous.indexOf("=") + 1)
        .trim()
        .replace(/;$/, ""),
    ).adminAuth;
  } catch {}
}
const config = readConfig(
  mergeBuildEnvironment(localEnv, process.env),
  undefined,
  existingAuth,
);
await mkdir(cache, { recursive: true });
await writeFile(authPath, JSON.stringify(config.public.adminAuth) + "\n", {
  mode: 0o600,
});
const result = await Bun.build({
  entrypoints: [path.join(source, "controller.js")],
  target: "browser",
  minify: true,
  write: false,
});
if (!result.success)
  throw new AggregateError(result.logs, "Browser build failed");
await rm(dist, { recursive: true, force: true });
await mkdir(path.join(dist, "admin"), { recursive: true });
for (const output of result.outputs)
  await writeFile(
    path.join(dist, path.basename(output.path)),
    await output.text(),
  );
const html = await readFile(path.join(source, "index.html"), "utf8");
await writeFile(path.join(dist, "index.html"), html);
await writeFile(
  path.join(dist, "admin/index.html"),
  html
    .replace('data-admin="false"', 'data-admin="true"')
    .replaceAll('href="./', 'href="../')
    .replaceAll('src="./', 'src="../')
    .replace(
      "<title>Zero Robot Controller</title>",
      "<title>Zero Admin Controller</title>",
    ),
);
await copyFile(path.join(source, "style.css"), path.join(dist, "style.css"));
await writeFile(
  path.join(dist, "config.js"),
  "window.ZERO_CONFIG = " + JSON.stringify(config.public) + ";\n",
);
console.log(
  "Static website: " +
    dist +
    "\nController mode: " +
    (config.public.hasRoboticArm ? "car + robotic arm" : "car only") +
    "\nFirmware and voice server are unchanged.",
);
