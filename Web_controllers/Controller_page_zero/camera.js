export function validateCameraUrl(value, pageProtocol = location.protocol) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(
      "Enter a complete camera URL, such as http://192.168.1.42:81/stream",
    );
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Use an HTTP or HTTPS stream URL without credentials");
  if (pageProtocol === "https:" && url.protocol === "http:")
    throw new Error(
      "This HTTPS page needs an HTTPS camera stream. Use an HTTPS camera relay or open the local HTTP controller.",
    );
  if (url.pathname === "/") {
    url.pathname = "/stream";
    if (url.protocol === "http:" && !url.port) url.port = "81";
  }
  return url.href;
}
export class CameraView {
  constructor(image, onStatus, onLost) {
    this.image = image;
    this.onStatus = onStatus;
    this.onLost = onLost;
    this.generation = 0;
  }
  connect(value) {
    const url = validateCameraUrl(value);
    this.disconnect();
    const generation = ++this.generation;
    this.onStatus("Connecting to camera…", "connecting");
    this.image.hidden = false;
    this.image.onerror = () => {
      if (generation !== this.generation) return;
      this.disconnect();
      this.onStatus(
        "Camera unavailable. Check Wi-Fi and close any other camera preview; this camera allows one viewer.",
        "error",
      );
      this.onLost();
    };
    this.image.src = url;
    const started = Date.now();
    this.timer = setInterval(() => {
      if (generation !== this.generation) return;
      if (this.image.naturalWidth > 0) {
        clearInterval(this.timer);
        this.timer = null;
        document.body.classList.add("pov");
        this.onStatus("Camera connected", "connected");
      } else if (Date.now() - started > 10000) this.image.onerror();
    }, 150);
  }
  disconnect() {
    ++this.generation;
    clearInterval(this.timer);
    this.timer = null;
    this.image.onerror = null;
    this.image.removeAttribute("src");
    this.image.hidden = true;
    document.body.classList.remove("pov");
    this.onStatus("Optional camera", "idle");
  }
}
