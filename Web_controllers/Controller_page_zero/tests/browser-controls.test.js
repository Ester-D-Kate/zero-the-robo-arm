import { expect, test } from "bun:test";
import { validateCameraUrl } from "../camera.js";
test("HTTPS controllers accept local HTTP cameras and preserve explicit ports", () => {
  expect(validateCameraUrl("http://192.168.1.42:81/stream", "http:")).toBe(
    "http://192.168.1.42:81/stream",
  );
  expect(validateCameraUrl("http://192.168.1.42:81/stream", "https:")).toBe(
    "http://192.168.1.42:81/stream",
  );
  expect(validateCameraUrl("http://esp32.local/stream", "https:")).toBe(
    "http://esp32.local:81/stream",
  );
  expect(() => validateCameraUrl("javascript:alert(1)", "http:")).toThrow();
  expect(() =>
    validateCameraUrl("http://admin:secret@192.168.1.42/stream", "http:"),
  ).toThrow();
});

test("local HTTP camera exceptions do not accept public hosts or embedded credentials", () => {
  for (const value of [
    "http://camera.example/stream",
    "http://192.168.1.42.example/stream",
    "http://8.8.8.8/stream",
    "http://[::123]/stream",
  ]) {
    expect(() => validateCameraUrl(value, "https:")).toThrow();
  }
  for (const host of [
    "10.0.0.4",
    "172.16.0.4",
    "172.31.255.4",
    "169.254.1.4",
    "127.0.0.1",
    "localhost",
    "[::1]",
    "[fd00::1]",
    "[fe80::1]",
  ]) {
    expect(validateCameraUrl(`http://${host}:81/stream`, "https:")).toBe(
      `http://${host}:81/stream`,
    );
  }
  expect(() =>
    validateCameraUrl("http://172.32.0.4/stream", "https:"),
  ).toThrow();
});
test("camera base addresses use the sibling ESP-CAM port 81 MJPEG endpoint", () => {
  expect(validateCameraUrl("http://192.168.1.42", "http:")).toBe(
    "http://192.168.1.42:81/stream",
  );
  expect(validateCameraUrl("http://192.168.1.42:81/", "http:")).toBe(
    "http://192.168.1.42:81/stream",
  );
  expect(validateCameraUrl("https://camera.example/stream", "https:")).toBe(
    "https://camera.example/stream",
  );
});
