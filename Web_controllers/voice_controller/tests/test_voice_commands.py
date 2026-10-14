"""Exercise the real voice pipeline without contacting Groq, MQTT, or a robot."""

import asyncio
import base64
import importlib
import json
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
with patch.dict(os.environ, {"GROQ_API_KEY": "fixture-not-a-real-api-key"}), patch(
    "dotenv.load_dotenv", return_value=False
):
    voice = importlib.import_module("voiceController")


class RecordingPublisher:
    def __init__(self, rc=0):
        self.rc = rc
        self.packets = []

    def publish(self, topic, payload):
        self.packets.append((topic, json.loads(payload)))
        return SimpleNamespace(rc=self.rc)


class VoiceCommandTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.publisher = RecordingPublisher()
        self.publisher_patch = patch.object(voice, "mqtt_client", self.publisher)
        self.publisher_patch.start()
        self.addCleanup(self.publisher_patch.stop)
        self.chat_patch = patch.object(
            voice.groq_client.chat.completions,
            "create",
            side_effect=RuntimeError("Fixture interpretation provider unavailable"),
        )
        self.chat = self.chat_patch.start()
        self.addCleanup(self.chat_patch.stop)
        self.sleep_patch = patch.object(voice.asyncio, "sleep", new=AsyncMock())
        self.sleep_patch.start()
        self.addCleanup(self.sleep_patch.stop)

    def test_explicit_controls_do_not_depend_on_ai_interpretation(self):
        for phrase, field, code in [
            ("zero, move forward", "car_command", "F"),
            ("Zero, move backward.", "car_command", "B"),
            ("zero please move backwards", "car_command", "B"),
            ("Alice, turn left please", "car_command", "L"),
            ("zero turn right", "car_command", "R"),
            ("zero, raise the arm", "arm_command", "U"),
            ("zero, lower the arm", "arm_command", "D"),
            ("zero, open the claw", "arm_command", "O"),
            ("zero, close the claw", "arm_command", "C"),
        ]:
            with self.subTest(phrase=phrase):
                result = voice.ai_command_interpreter(phrase)
                self.assertEqual(result["command_type"], "simple")
                self.assertEqual(result[field], code)
        self.chat.assert_not_called()

    async def test_unclear_or_negated_speech_does_not_move_or_claim_success(self):
        for phrase in ["thank you", "done", "hello", "don't move forward", "move forward and backward", "what is a dance?"]:
            with self.subTest(phrase=phrase):
                self.publisher.packets.clear()
                commands = voice.ai_command_interpreter(phrase)
                self.assertFalse(await voice.execute_commands(commands))
                self.assertEqual(self.publisher.packets, [])

    async def test_recorded_audio_publishes_the_requested_legacy_car_command(self):
        for phrase, code in [("Zero, move forward", "F"), ("Zero, move backward", "B")]:
            with self.subTest(phrase=phrase):
                self.publisher.packets.clear()
                with patch.object(voice.groq_client.audio.transcriptions, "create", return_value=SimpleNamespace(text=phrase)):
                    await voice.process_mqtt_audio({
                        "device_id": "WebControl_fixture",
                        "audio_data": base64.b64encode(b"fixture audio").decode(),
                        "audio_format": "audio/webm",
                        "duration": 1.0,
                    })
                car_packets = [payload for topic, payload in self.publisher.packets if topic == "alice/zero/car/command"]
                self.assertEqual([packet["cmd"] for packet in car_packets], [code, "S"])
                self.assertEqual(car_packets[0]["speed"], 50)
                self.assertEqual(set(car_packets[0]), {"cmd", "speed", "id", "timestamp"})
                self.assertFalse(any(topic == "alice/zero/arm/command" for topic, _ in self.publisher.packets))
                response = self.publisher.packets[-1]
                self.assertEqual(response[0], "alice/zero/voice/response/WebControl_fixture")
                self.assertTrue(response[1]["success"])
                self.assertEqual(response[1]["commands"]["car_command"], code)

    async def test_stop_is_immediate_and_stops_both_targets(self):
        commands = voice.ai_command_interpreter("zero, stop")
        self.assertTrue(await voice.execute_commands(commands))
        self.assertEqual([(topic, payload["cmd"]) for topic, payload in self.publisher.packets], [
            ("alice/zero/car/command", "S"), ("alice/zero/arm/command", "S"),
        ])

    async def test_missing_or_invalid_simple_commands_never_report_done(self):
        for command in [{"command_type": "simple"}, {"command_type": "simple", "car_command": "forward"}, {"command_type": "unrecognized"}]:
            with self.subTest(command=command):
                self.publisher.packets.clear()
                self.assertFalse(await voice.execute_commands(command))
                self.assertEqual(self.publisher.packets, [])

    async def test_publish_failure_is_reported_by_mqtt_and_http_responses(self):
        self.publisher.rc = 4
        with patch.object(voice.groq_client.audio.transcriptions, "create", return_value=SimpleNamespace(text="zero move forward")):
            await voice.process_mqtt_audio({"device_id": "WebControl_fixture", "audio_data": "YQ=="})
        self.assertFalse(self.publisher.packets[-1][1]["success"])
        self.assertIn("error", self.publisher.packets[-1][1])
        response = await voice.process_text_command("zero move forward")
        self.assertFalse(response["success"])
        self.assertFalse(response["executed"])

    async def test_empty_sequence_and_failed_sequence_publish_are_not_successful(self):
        self.assertFalse(await voice.execute_sequence([]))
        self.publisher.rc = 4
        self.assertFalse(await voice.execute_sequence([{"car_command": "F", "speed": 50, "duration": 0}]))

    async def test_invalid_sequence_is_rejected_before_any_movement(self):
        self.assertFalse(await voice.execute_sequence([
            {"car_command": "F", "speed": 50, "duration": 0},
            {"car_command": "forward", "speed": 50, "duration": 0},
        ]))
        self.assertEqual(self.publisher.packets, [])

    async def test_a_partial_sequence_publish_failure_stops_its_started_car(self):
        def publish(topic, payload):
            self.publisher.packets.append((topic, json.loads(payload)))
            return SimpleNamespace(rc=4 if topic == voice.ARM_TOPIC else 0)
        with patch.object(self.publisher, "publish", side_effect=publish):
            self.assertFalse(await voice.execute_sequence([{"car_command": "F", "arm_command": "U", "duration": 0}]))
        self.assertEqual([payload["cmd"] for topic, payload in self.publisher.packets if topic == voice.CAR_TOPIC], ["F", "S"])

    async def test_failed_car_stop_does_not_skip_stopping_the_arm(self):
        def publish(topic, payload):
            packet = json.loads(payload)
            self.publisher.packets.append((topic, packet))
            return SimpleNamespace(rc=4 if topic == voice.CAR_TOPIC and packet["cmd"] == "S" else 0)
        with patch.object(self.publisher, "publish", side_effect=publish):
            self.assertFalse(await voice.execute_sequence([
                {"car_command": "F", "arm_command": "U", "duration": 0},
                {"car_command": "S", "arm_command": "S", "duration": 0},
            ]))
        self.assertEqual([payload["cmd"] for topic, payload in self.publisher.packets if topic == voice.ARM_TOPIC], ["U", "S"])

    async def test_stop_interrupts_an_existing_voice_performance(self):
        entered, release = asyncio.Event(), asyncio.Event()
        async def controlled_sleep(seconds):
            entered.set()
            await release.wait()
        with patch.object(voice.asyncio, "sleep", new=controlled_sleep):
            sequence = asyncio.create_task(voice.execute_sequence([
                {"car_command": "F", "duration": 1},
                {"car_command": "R", "duration": 0},
            ]))
            await entered.wait()
            self.assertTrue(await voice.execute_commands(voice.ai_command_interpreter("zero stop")))
            release.set()
            self.assertFalse(await sequence)
        self.assertEqual([payload["cmd"] for topic, payload in self.publisher.packets if topic == voice.CAR_TOPIC], ["F", "S"])

    async def test_failed_ai_sequence_generation_never_uses_random_movements(self):
        self.assertFalse(await voice.execute_commands({"command_type": "ai_sequence", "intent": "dance"}))
        self.assertEqual(self.publisher.packets, [])

    async def test_an_older_auto_stop_cannot_override_a_newer_car_command(self):
        entered = asyncio.Event()
        release = asyncio.Event()
        async def controlled_sleep(seconds):
            entered.set()
            await release.wait()
        with patch.object(voice.asyncio, "sleep", new=controlled_sleep):
            first = asyncio.create_task(voice.execute_commands(voice.ai_command_interpreter("zero move forward")))
            await entered.wait()
            self.assertTrue(voice.send_command(voice.CAR_TOPIC, "B", 50))
            release.set()
            await first
        self.assertEqual([payload["cmd"] for topic, payload in self.publisher.packets if topic == voice.CAR_TOPIC], ["F", "B"])

    def test_existing_audio_security_still_rejects_missing_or_wrong_tokens(self):
        payload = {"device_id": "WebControl_fixture", "audio_data": "YQ=="}
        self.assertFalse(voice.validate_security(payload))
        self.assertFalse(voice.validate_security({**payload, "security_token": "incorrect-fixture-token"}))
        self.assertTrue(voice.validate_security({**payload, "security_token": "ALICE_ZERO_2024_SECURE"}))

    def test_fallback_never_turns_a_direction_into_a_performance(self):
        result = voice.create_intelligent_fallback("zero please move backward")
        self.assertEqual(result["command_type"], "simple")
        self.assertEqual(result["car_command"], "B")

    def test_explicit_dance_still_uses_ai(self):
        self.chat.side_effect = None
        self.chat.return_value = SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content=json.dumps({"command_type": "ai_sequence", "intent": "dance", "style": "playful"})))])
        result = voice.ai_command_interpreter("zero dance for me")
        self.assertEqual(result["command_type"], "ai_sequence")
        self.chat.assert_called_once()


if __name__ == "__main__":
    unittest.main()
