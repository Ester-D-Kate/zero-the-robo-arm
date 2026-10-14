import mqttPacket from "mqtt-packet";
// Test-only broker: actual MQTT.js/WebSocket traffic, isolated from the robot.
export function createTestBroker() {
  const clients = new Set(),
    retained = new Map(),
    packets = [],
    connections = [];
  let stateDelay = 0;
  const blocked = new Set();
  const send = (socket, packet) => socket.send(mqttPacket.generate(packet));
  function broadcast(topic, payload, retain = false) {
    const body =
      typeof payload === "string" ? payload : JSON.stringify(payload);
    if (retain) retained.set(topic, body);
    for (const socket of clients)
      if (socket.data.topics.has(topic)) {
        const packet = {
          cmd: "publish",
          topic,
          payload: body,
          qos: 0,
          retain: false,
        };
        if (stateDelay && topic.endsWith("/web/state"))
          setTimeout(() => {
            if (clients.has(socket)) send(socket, packet);
          }, stateDelay);
        else send(socket, packet);
      }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { data: { topics: new Set() } })) return;
      return new Response("MQTT WebSocket test fixture");
    },
    websocket: {
      open(socket) {
        clients.add(socket);
        const parser = mqttPacket.parser();
        socket.data.parser = parser;
        parser.on("packet", (packet) => {
          if (packet.cmd === "connect") {
            connections.push(packet.clientId);
            socket.data.clientId = packet.clientId;
            if (blocked.has(packet.clientId)) {
              send(socket, {
                cmd: "connack",
                returnCode: 3,
                sessionPresent: false,
              });
              socket.close();
              return;
            }
            for (const other of clients)
              if (other !== socket && other.data.clientId === packet.clientId)
                other.close();
            send(socket, {
              cmd: "connack",
              returnCode: 0,
              sessionPresent: false,
            });
          } else if (packet.cmd === "subscribe") {
            for (const subscription of packet.subscriptions)
              socket.data.topics.add(subscription.topic);
            send(socket, {
              cmd: "suback",
              messageId: packet.messageId,
              granted: packet.subscriptions.map(() => 0),
            });
            for (const subscription of packet.subscriptions) {
              const value = retained.get(subscription.topic);
              if (value)
                send(socket, {
                  cmd: "publish",
                  topic: subscription.topic,
                  payload: value,
                  qos: 0,
                  retain: true,
                });
            }
          } else if (packet.cmd === "publish") {
            const text = packet.payload.toString();
            if (packet.topic.endsWith("/web/state"))
              socket.data.coordinator = true;
            let payload;
            try {
              payload = JSON.parse(text);
            } catch {
              payload = text;
            }
            packets.push({
              topic: packet.topic,
              payload,
              retain: packet.retain,
            });
            if (packet.qos === 1)
              send(socket, { cmd: "puback", messageId: packet.messageId });
            broadcast(packet.topic, text, packet.retain);
            if (packet.topic === "alice/zero/voice/audio")
              setTimeout(
                () =>
                  broadcast("alice/zero/voice/response/" + payload.device_id, {
                    device_id: payload.device_id,
                    success: true,
                    transcription: "forward",
                  }),
                50,
              );
          } else if (packet.cmd === "pingreq")
            send(socket, { cmd: "pingresp" });
          else if (packet.cmd === "unsubscribe") {
            for (const topic of packet.unsubscriptions)
              socket.data.topics.delete(topic);
            send(socket, { cmd: "unsuback", messageId: packet.messageId });
          } else if (packet.cmd === "disconnect") socket.close();
        });
      },
      message(socket, bytes) {
        socket.data.parser.parse(Buffer.from(bytes));
      },
      close(socket) {
        clients.delete(socket);
      },
    },
  });
  return {
    url: "ws://127.0.0.1:" + server.port + "/mqtt",
    packets,
    connections,
    broadcast,
    dropCoordinator(permanent = false) {
      for (const socket of clients)
        if (socket.data.coordinator) {
          if (permanent) blocked.add(socket.data.clientId);
          socket.close();
        }
    },
    dropGuests() {
      for (const socket of clients)
        if (!socket.data.coordinator) socket.close();
    },
    delayState(ms) {
      stateDelay = ms;
    },
    close() {
      for (const socket of clients) socket.close();
      server.stop(true);
    },
  };
}
