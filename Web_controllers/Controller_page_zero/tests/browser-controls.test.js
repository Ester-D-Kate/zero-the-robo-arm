import { expect, test } from "bun:test";
import { validateCameraUrl } from "../camera.js";
test("IP camera URLs preserve the port and HTTPS pages reject blocked HTTP streams", () => {
  expect(validateCameraUrl("http://192.168.1.42:81/stream", "http:")).toBe(
    "http://192.168.1.42:81/stream",
  );
  expect(() =>
    validateCameraUrl("http://192.168.1.42:81/stream", "https:"),
  ).toThrow("HTTPS");
  expect(() => validateCameraUrl("javascript:alert(1)", "http:")).toThrow();
  expect(() =>
    validateCameraUrl("http://admin:secret@192.168.1.42/stream", "http:"),
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
