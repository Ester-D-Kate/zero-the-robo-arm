const encoder = new TextEncoder();
export const PBKDF2_ITERATIONS = 200000;
export function toHex(bytes) {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function fromHex(value) {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value))
    throw new Error("Invalid hexadecimal value");
  return Uint8Array.from(value.match(/../g), (byte) => parseInt(byte, 16));
}
export const randomSession = () =>
  toHex(crypto.getRandomValues(new Uint8Array(16)));
export function canonicalMessage(message) {
  return [
    message.role,
    message.boot,
    message.session,
    message.seq,
    message.action,
    message.data,
  ].join("\n");
}
export async function createGuestIdentity() {
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  return {
    role: "guest",
    session: randomSession(),
    key: keys.privateKey,
    publicKey: toHex(await crypto.subtle.exportKey("raw", keys.publicKey)),
  };
}
export async function createAdminIdentity(password, auth) {
  try {
    const material = await crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const wrappingKey = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: fromHex(auth.salt),
        iterations: PBKDF2_ITERATIONS,
        hash: "SHA-256",
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );
    const pkcs8 = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(auth.iv) },
      wrappingKey,
      fromHex(auth.ciphertext),
    );
    const key = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    return {
      role: "admin",
      session: randomSession(),
      key,
      publicKey: auth.publicKey,
    };
  } catch {
    throw new Error("Incorrect admin password");
  }
}
export async function signMessage(identity, { boot, seq, action, data }) {
  if (!Number.isSafeInteger(seq) || seq < 1)
    throw new Error("Invalid message sequence");
  const message = {
    v: 1,
    role: identity.role,
    boot,
    session: identity.session,
    seq,
    action,
    data: JSON.stringify(data),
  };
  message.signature = toHex(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.key,
      encoder.encode(canonicalMessage(message)),
    ),
  );
  return message;
}
export async function verifyMessage(publicKey, message) {
  try {
    if (
      message.v !== 1 ||
      !["guest", "admin"].includes(message.role) ||
      !Number.isSafeInteger(message.seq) ||
      message.seq < 1 ||
      typeof message.data !== "string" ||
      !/^[0-9a-f]{32}$/.test(message.session) ||
      !/^[0-9a-f]{32}$/.test(message.boot)
    )
      return false;
    const key = await crypto.subtle.importKey(
      "raw",
      fromHex(publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromHex(message.signature),
      encoder.encode(canonicalMessage(message)),
    );
  } catch {
    return false;
  }
}
