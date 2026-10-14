const MAX_AUDIO_BYTES = 500 * 1024;
const MAX_RECORDING_MS = 15000;
export class VoiceController {
  constructor({ canControl, getEpoch, sendAudio, onStatus }) {
    Object.assign(this, { canControl, getEpoch, sendAudio, onStatus });
  }
  get supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }
  current(operation) {
    return (
      this.operation === operation &&
      !operation.cancelled &&
      this.canControl() &&
      this.getEpoch() === operation.epoch
    );
  }
  async start() {
    if (!this.canControl() || this.operation || this.pendingReply) return;
    if (!this.supported) {
      this.onStatus("Audio recording is unavailable in this browser.", "error");
      return;
    }
    const operation = {
      epoch: this.getEpoch(),
      chunks: [],
      size: 0,
      cancelled: false,
    };
    operation.completion = new Promise((resolve) => {
      operation.resolve = resolve;
    });
    this.operation = operation;
    this.onStatus("Allow microphone access, then hold to record.", "listening");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      operation.stream = stream;
      if (!this.current(operation)) {
        stream.getTracks().forEach((track) => track.stop());
        operation.resolve();
        return;
      }
      const Recorder = window.MediaRecorder;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/mp4",
      ].find((type) => Recorder.isTypeSupported(type));
      const recorder = new Recorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 12000,
      });
      operation.recorder = recorder;
      operation.started = Date.now();
      recorder.ondataavailable = (event) => {
        if (!this.current(operation) || !event.data.size) return;
        operation.chunks.push(event.data);
        operation.size += event.data.size;
        if (operation.size > MAX_AUDIO_BYTES) {
          this.cancel();
          this.onStatus(
            "Recording exceeded the 500 KB limit. Try a shorter command.",
            "error",
          );
        }
      };
      recorder.onerror = () => {
        this.cancel();
        this.onStatus("Microphone recording failed.", "error");
      };
      recorder.onstop = async () => {
        clearTimeout(operation.timer);
        stream.getTracks().forEach((track) => track.stop());
        try {
          if (!this.current(operation) || !operation.chunks.length) return;
          const blob = new Blob(operation.chunks, {
            type: recorder.mimeType || "audio/webm",
          });
          if (blob.size > MAX_AUDIO_BYTES)
            throw new Error("Audio recording is too large.");
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 32768)
            binary += String.fromCharCode(
              ...bytes.subarray(offset, offset + 32768),
            );
          if (!this.current(operation)) return;
          this.onStatus(
            "Sending recorded audio to the voice server…",
            "processing",
          );
          await this.sendAudio({
            audio_data: btoa(binary),
            audio_format: blob.type.split(";")[0],
            duration: (Date.now() - operation.started) / 1000,
            sample_rate: 16000,
            channels: 1,
            timestamp: Date.now(),
            size_bytes: blob.size,
            message_id: "audio_" + crypto.randomUUID(),
          });
          if (this.current(operation)) {
            this.pendingReply = operation.epoch;
            this.replyTimer = setTimeout(() => {
              this.pendingReply = null;
              this.onStatus(
                "The voice server has not replied. Check its MQTT connection.",
                "error",
              );
            }, 60000);
            this.onStatus(
              "Audio sent · waiting for the voice server",
              "processing",
            );
          }
        } catch (error) {
          if (this.current(operation)) this.onStatus(error.message, "error");
        } finally {
          if (this.operation === operation) this.operation = null;
          operation.resolve();
        }
      };
      recorder.start(500);
      operation.timer = setTimeout(() => this.finish(), MAX_RECORDING_MS);
      this.onStatus(
        "Recording… release to send to the voice server.",
        "listening",
      );
    } catch (error) {
      this.cancel();
      this.onStatus(
        error.name === "NotAllowedError"
          ? "Microphone permission was denied."
          : error.message,
        "error",
      );
    }
  }
  finish() {
    const operation = this.operation;
    if (!operation) return Promise.resolve();
    if (!operation.recorder) {
      this.cancel();
      return operation.completion;
    }
    if (operation.recorder.state === "recording") operation.recorder.stop();
    return operation.completion;
  }
  receive(response) {
    if (
      !this.pendingReply ||
      !this.canControl() ||
      this.pendingReply !== this.getEpoch()
    )
      return;
    clearTimeout(this.replyTimer);
    this.pendingReply = null;
    this.onStatus(
      response.success
        ? "Voice server processed: “" + (response.transcription ?? "") + "”"
        : (response.error ?? "Voice server could not process the audio."),
      response.success ? "success" : "error",
    );
  }
  cancel() {
    const operation = this.operation;
    this.operation = null;
    this.pendingReply = null;
    clearTimeout(this.replyTimer);
    if (!operation) return;
    operation.cancelled = true;
    clearTimeout(operation.timer);
    if (operation.recorder?.state === "recording") operation.recorder.stop();
    operation.stream?.getTracks().forEach((track) => track.stop());
    operation.resolve();
  }
}
