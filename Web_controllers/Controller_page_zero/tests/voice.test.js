import { expect, test } from "bun:test";
import { VoiceController } from "../voice.js";
function fixture() {
  const sent = [],
    statuses = [];
  let allowed = true;
  const track = {
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
  const stream = { getTracks: () => [track] };
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor(s) {
      this.stream = s;
      this.mimeType = "audio/webm;codecs=opus";
      this.state = "inactive";
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({
        data: new Blob(["test recorded audio"], { type: this.mimeType }),
      });
      this.onstop?.();
    }
  }
  globalThis.window = { MediaRecorder: Recorder };
  Object.defineProperty(globalThis, "navigator", {
    value: { mediaDevices: { getUserMedia: async () => stream } },
    configurable: true,
  });
  const voice = new VoiceController({
    canControl: () => allowed,
    getEpoch: () => "epoch-1",
    sendAudio: async (p) => sent.push(p),
    onStatus: (text, state) => statuses.push({ text, state }),
  });
  return {
    voice,
    sent,
    track,
    statuses,
    revoke: () => {
      allowed = false;
    },
  };
}
test("recorded voice audio keeps the existing server payload fields", async () => {
  const f = fixture();
  await f.voice.start();
  await f.voice.finish();
  expect(f.sent).toHaveLength(1);
  const audio = f.sent[0];
  expect(audio.audio_data).toBe(btoa("test recorded audio"));
  expect(audio.audio_format).toBe("audio/webm");
  expect(audio.sample_rate).toBe(16000);
  expect(audio.channels).toBe(1);
  expect(f.track.stopped).toBe(true);
});
test("recording is discarded when control is revoked before release", async () => {
  const f = fixture();
  await f.voice.start();
  f.revoke();
  await f.voice.finish();
  expect(f.sent).toHaveLength(0);
  expect(f.track.stopped).toBe(true);
});
