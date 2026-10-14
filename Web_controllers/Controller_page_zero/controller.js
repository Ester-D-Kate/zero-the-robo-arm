import { RobotSession } from "./mqtt-session.js";
import { CameraView } from "./camera.js";
import { VoiceController } from "./voice.js";

const $ = (id) => document.getElementById(id);
const config = window.ZERO_CONFIG;
const adminPage = document.body.dataset.admin === "true";
const motions = new Map();
let lastAuthority = "",
  previouslyControlled = false,
  pointerId = null,
  noticeTimer,
  busy = false;
function notice(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("notice").hidden = true), 12000);
}
if (!config || typeof config.hasRoboticArm !== "boolean") {
  notice(
    "Controller configuration is missing. Build and deploy the dist folder.",
  );
} else if (!window.isSecureContext || !crypto.subtle) {
  notice(
    "Open this controller using HTTPS or localhost so admin and queue authentication is available.",
  );
} else {
  document.body.classList.toggle("has-arm", config.hasRoboticArm);
  $("armControls").hidden = !config.hasRoboticArm;
  $("controllerMode").textContent = config.hasRoboticArm
    ? "Car + robotic arm"
    : "Car controller";
  $("adminLink").hidden = adminPage;
  $("controllerLink").hidden = !adminPage;
  const session = new RobotSession(config, render, notice, { adminPage });
  const voice = new VoiceController({
    canControl: () => session.canControl,
    getEpoch: () => session.state?.boot + ":" + session.state?.epoch,
    sendAudio: (payload) => session.sendAudio(payload),
    onStatus: (text, state) => {
      $("voiceStatus").textContent = text;
      $("voiceButton").classList.toggle("listening", state === "listening");
    },
  });
  session.onVoiceResponse = (response) => voice.receive(response);
  const camera = new CameraView(
    $("cameraFeed"),
    (text, state) => {
      $("cameraStatus").textContent = text;
      $("cameraDisconnect").hidden = !["connecting", "connected"].includes(
        state,
      );
      if (state === "connected") $("cameraSettings").open = false;
    },
    () => stopAll(),
  );

  function publishMotion(target, cmd) {
    return session
      .send(target, { cmd, speed: Number($("speedSlider").value) })
      .catch((error) => {
        if (
          error.message === "Movement cancelled" ||
          error.message.startsWith("Control state changed")
        )
          return;
        stopMotion(target, false);
        if (session.canControl) notice(error.message);
      });
  }
  function startMotion(target, cmd, source = "manual") {
    if (!session.canControl || (target === "arm" && !config.hasRoboticArm))
      return;
    if (
      motions.get(target)?.cmd === cmd &&
      motions.get(target)?.source === source
    )
      return;
    stopMotion(target, false);
    const interval = setInterval(() => {
      if (!session.canControl) {
        stopMotion(target, false);
        return;
      }
      publishMotion(target, cmd);
    }, 250);
    motions.set(target, { cmd, interval, source });
    publishMotion(target, cmd);
  }
  function stopMotion(target, send = true) {
    const motion = motions.get(target);
    if (!motion) return;
    clearInterval(motion.interval);
    motions.delete(target);
    session.cancelMotion(target);
    if (send && session.canControl) publishMotion(target, "S");
  }
  function resetJoystick() {
    pointerId = null;
    $("joystickKnob").style.transform = "translate(-50%, -50%)";
  }
  function stopAll(send = true) {
    session.cancelMotion();
    for (const target of [...motions.keys()]) stopMotion(target, false);
    voice.cancel();
    resetJoystick();
    document
      .querySelectorAll(".pressed")
      .forEach((button) => button.classList.remove("pressed"));
    $("voiceButton").classList.remove("listening");
    if (send) session.stop();
  }
  function render() {
    const state = session.state;
    const authority = [
      session.online,
      session.canControl,
      state?.boot,
      state?.epoch,
      state?.current,
    ].join(":");
    if (authority !== lastAuthority) {
      const lostControl = previouslyControlled && !session.canControl;
      stopAll(false);
      if (lostControl && session.connected)
        session.publishStop().catch((error) => notice(error.message));
      camera.disconnect();
      lastAuthority = authority;
    }
    previouslyControlled = session.canControl;
    $("connectionStatus").textContent = session.connected
      ? "MQTT connected"
      : "MQTT disconnected";
    $("connectionDot").classList.toggle("online", session.online);
    document
      .querySelectorAll("[data-target],#speedSlider,#stopButton")
      .forEach((element) => (element.disabled = !session.canControl));
    $("voiceButton").disabled = !session.canControl || !voice.supported;
    $("cameraForm").querySelector("button").disabled = !session.canControl;
    $("joystick").setAttribute("aria-disabled", String(!session.canControl));
    if (!voice.supported)
      $("voiceStatus").textContent =
        "Audio recording is unavailable in this browser.";
    const ownUser = state?.queue.find(
      (user) => user.session === session.identity?.session,
    );
    const current = state?.queue.find((user) => user.session === state.current);
    $("activeName").textContent = !session.queueOnline
      ? "PAUSED"
      : state?.master
        ? "ADMIN"
        : (current?.name ?? "NO DRIVER");
    $("joinForm").hidden = adminPage || session.joined;
    $("leaveButton").hidden = adminPage || !session.joined;
    $("joinButton").disabled = !session.queueOnline || busy;
    $("leaveButton").textContent = session.canControl
      ? "Leave controls"
      : "Leave queue";
    $("adminLoginForm").hidden = !adminPage || session.adminAuthenticated;
    $("adminLoginButton").disabled = !session.online || busy;
    $("adminLogout").hidden = !adminPage || !session.adminAuthenticated;
    $("adminPanel").hidden = !adminPage || !session.adminAuthenticated;
    $("masterButton").disabled = !session.isAdmin || busy;
    $("masterButton").textContent = session.canControl
      ? "Release master control"
      : "Take master control";
    $("revokeButton").disabled =
      !session.isAdmin || !state?.current || state.master || busy;
    $("queueMode").disabled = !session.isAdmin || busy;
    if (state) $("queueMode").value = state.queue_mode;
    if (!$("username").value && session.intent)
      $("username").value = session.intent.name;
    if (!session.connected)
      $("accessStatus").textContent =
        session.joined || session.adminAuthenticated
          ? "Reconnecting to MQTT · queue saved"
          : "Connecting to MQTT…";
    else if (!session.queueOnline)
      $("accessStatus").textContent = session.adminAuthenticated
        ? "Restoring the admin connection · queue saved"
        : session.joined
          ? "Queue position saved · waiting for admin connection"
          : adminPage
            ? "Sign in to restore or manage the queue · keep this tab open"
            : "Open /admin and sign in to start the access queue";
    else if (state?.master)
      $("accessStatus").textContent = session.canControl
        ? "You have master control"
        : "Admin has master control · user controls disconnected";
    else if (session.canControl)
      $("accessStatus").textContent =
        "Your turn · " + (ownUser?.name ?? "Controller");
    else if (session.joined) {
      const waiting = state.queue.filter(
        (user) => user.session !== state.current,
      );
      const position =
        waiting.findIndex((user) => user.session === session.identity.session) +
        1;
      $("accessStatus").textContent =
        (state.queue_mode === "manual"
          ? "Waiting for admin"
          : "Waiting for your turn") +
        " · #" +
        position;
    } else
      $("accessStatus").textContent = adminPage
        ? session.isAdmin
          ? "Admin signed in · take master control to drive"
          : "Sign in to manage access"
        : "Request access to drive Zero";
    renderQueue(state);
  }
  function renderQueue(state) {
    const users = state?.queue ?? [];
    $("queueCount").textContent = String(
      users.filter((user) => user.session !== state?.current).length,
    );
    const list = $("queueList");
    list.replaceChildren();
    if (!users.length) {
      const item = document.createElement("li");
      item.textContent = "No one is waiting.";
      list.append(item);
      return;
    }
    for (const user of users) {
      const item = document.createElement("li");
      item.append(
        document.createTextNode(
          user.name +
            (user.session === state.current
              ? " · driving"
              : user.online === false
                ? " · reconnecting"
                : ""),
        ),
      );
      if (adminPage && session.isAdmin) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Grant";
        button.setAttribute("aria-label", "Grant control to " + user.name);
        button.disabled =
          !session.isAdmin ||
          state.master ||
          user.online === false ||
          user.session === state.current ||
          busy;
        button.addEventListener("click", () =>
          perform(() => session.send("grant", { session: user.session }, true)),
        );
        item.append(button);
      }
      list.append(item);
    }
  }
  async function perform(action) {
    if (busy) return;
    busy = true;
    render();
    try {
      await action();
    } catch (error) {
      notice(error.message);
    } finally {
      busy = false;
      render();
    }
  }
  $("joinForm").addEventListener("submit", (event) => {
    event.preventDefault();
    perform(() => session.join($("username").value));
  });
  $("leaveButton").addEventListener("click", () =>
    perform(async () => {
      stopAll();
      await session.send("leave", {}, true);
    }),
  );
  $("adminLoginForm").addEventListener("submit", (event) => {
    event.preventDefault();
    const password = $("adminPassword").value;
    $("adminPassword").value = "";
    perform(() => session.login(password));
  });
  $("adminLogout").addEventListener("click", () =>
    perform(async () => {
      stopAll();
      await session.send("logout", {}, true);
    }),
  );
  $("masterButton").addEventListener("click", () =>
    perform(() =>
      session.send("master", { enabled: !session.canControl }, true),
    ),
  );
  $("revokeButton").addEventListener("click", () =>
    perform(() => session.send("revoke", {}, true)),
  );
  $("queueMode").addEventListener("change", (event) => {
    const automatic = event.target.value === "automatic";
    perform(() => session.send("mode", { automatic }, true));
  });
  $("stopButton").addEventListener("click", () => stopAll());
  $("speedSlider").addEventListener("input", () => {
    $("speedValue").value = $("speedSlider").value + "%";
  });
  $("themeToggle").addEventListener("click", () => {
    document.body.classList.toggle("light");
    $("themeToggle").textContent = document.body.classList.contains("light")
      ? "Dark theme"
      : "Light theme";
  });
  $("cameraForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (!session.canControl) {
      notice("Request control access before connecting the camera.");
      return;
    }
    try {
      camera.connect($("cameraUrl").value);
    } catch (error) {
      $("cameraStatus").textContent = error.message;
      $("cameraSettings").open = true;
    }
  });
  $("cameraDisconnect").addEventListener("click", () => camera.disconnect());

  function holdButton(button, start, finish) {
    let held = false;
    function release() {
      if (!held) return;
      held = false;
      button.classList.remove("pressed");
      finish();
    }
    button.addEventListener("pointerdown", (event) => {
      if (button.disabled) return;
      event.preventDefault();
      held = true;
      button.classList.add("pressed");
      button.setPointerCapture(event.pointerId);
      start();
    });
    for (const name of [
      "pointerup",
      "pointercancel",
      "lostpointercapture",
      "blur",
    ])
      button.addEventListener(name, release);
    button.addEventListener("keydown", (event) => {
      if (!["Space", "Enter"].includes(event.code) || button.disabled) return;
      event.preventDefault();
      if (!held) {
        held = true;
        button.classList.add("pressed");
        start();
      }
    });
    button.addEventListener("keyup", (event) => {
      if (["Space", "Enter"].includes(event.code)) {
        event.preventDefault();
        release();
      }
    });
  }
  document.querySelectorAll("[data-target]").forEach((button) =>
    holdButton(
      button,
      () => startMotion(button.dataset.target, button.dataset.cmd),
      () => {
        if (motions.get(button.dataset.target)?.cmd === button.dataset.cmd)
          stopMotion(button.dataset.target);
      },
    ),
  );
  holdButton(
    $("voiceButton"),
    () => voice.start(),
    () => voice.finish(),
  );
  const joystick = $("joystick");
  function moveJoystick(event) {
    if (pointerId !== event.pointerId || !session.canControl) return;
    const rect = joystick.getBoundingClientRect();
    let dx = event.clientX - rect.left - rect.width / 2,
      dy = event.clientY - rect.top - rect.height / 2;
    const radius = rect.width / 2 - $("joystickKnob").offsetWidth / 2 - 8;
    const distance = Math.hypot(dx, dy);
    if (distance > radius) {
      dx *= radius / distance;
      dy *= radius / distance;
    }
    $("joystickKnob").style.transform =
      "translate(-50%, -50%) translate(" + dx + "px, " + dy + "px)";
    if (distance < radius * 0.25) {
      stopMotion("car");
      return;
    }
    startMotion(
      "car",
      Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "R" : "L") : dy > 0 ? "B" : "F",
    );
  }
  joystick.addEventListener("pointerdown", (event) => {
    if (!session.canControl || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    joystick.setPointerCapture(event.pointerId);
    moveJoystick(event);
  });
  joystick.addEventListener("pointermove", moveJoystick);
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"])
    joystick.addEventListener(name, (event) => {
      if (pointerId !== event.pointerId) return;
      resetJoystick();
      stopMotion("car");
    });
  const keys = new Map([
    ["ArrowUp", "F"],
    ["KeyW", "F"],
    ["ArrowDown", "B"],
    ["KeyS", "B"],
    ["ArrowLeft", "L"],
    ["KeyA", "L"],
    ["ArrowRight", "R"],
    ["KeyD", "R"],
  ]);
  window.addEventListener("keydown", (event) => {
    if (
      ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(
        event.target.tagName,
      ) ||
      event.repeat
    )
      return;
    if (event.code === "Space") {
      event.preventDefault();
      stopAll();
    } else if (keys.has(event.code) && session.canControl) {
      event.preventDefault();
      startMotion("car", keys.get(event.code));
    }
  });
  window.addEventListener("keyup", (event) => {
    if (
      keys.has(event.code) &&
      motions.get("car")?.cmd === keys.get(event.code)
    )
      stopMotion("car");
  });
  window.addEventListener("blur", () => stopAll());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopAll();
    else session.refreshPresence();
  });
  window.addEventListener("focus", () => session.refreshPresence());
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) window.location.reload();
  });
  window.addEventListener("pagehide", () => {
    stopAll();
    camera.disconnect();
    session.close();
  });
  render();
  session.connect().catch((error) => notice(error.message));
}
