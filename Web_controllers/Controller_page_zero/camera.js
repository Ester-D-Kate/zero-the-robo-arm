function isLocalCameraHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    return true;
  if (
    host === "[::1]" ||
    /^\[(?:f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/.test(host)
  )
    return true;
  const octets = host.split(".").map(Number);
  if (
    octets.length !== 4 ||
    !octets.every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    )
  )
    return false;
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254)
  );
}

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
  if (
    pageProtocol === "https:" &&
    url.protocol === "http:" &&
    !isLocalCameraHost(url.hostname)
  )
    throw new Error(
      "For an HTTP camera on this HTTPS page, use its private Wi-Fi IP or .local hostname and allow browser local-network access.",
    );
  url.hostname = url.hostname.replace(/\.$/, "");
  if (url.pathname === "/") {
    url.pathname = "/stream";
  }
  if (url.protocol === "http:" && !url.port && url.pathname === "/stream")
    url.port = "81";
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
    const needsLocalPermission =
      location.protocol === "https:" && url.startsWith("http:");
    this.onStatus(
      needsLocalPermission
        ? "Allow local-network access to connect…"
        : "Connecting to camera…",
      "connecting",
    );
    this.image.hidden = false;
    this.image.onerror = () => {
      if (generation !== this.generation) return;
      this.disconnect();
      this.onStatus(
        needsLocalPermission
          ? "Camera unavailable. Allow local-network access in a current Chrome or Edge browser, check Wi-Fi, and close other camera viewers."
          : "Camera unavailable. Check Wi-Fi and close any other camera preview; this camera allows one viewer.",
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
      } else if (Date.now() - started > (needsLocalPermission ? 60000 : 10000))
        this.image.onerror();
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
