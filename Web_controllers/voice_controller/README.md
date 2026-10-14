# Existing voice server

This is the existing Python service, not a new service. The webpage sends audio on `alice/zero/voice/audio`; Groq transcribes it, and this script publishes the original robot MQTT commands.

## Apply the voice fix

Copy the updated `voiceController.py` onto the machine where you already run it. Stop the old Python process, then start the updated script in the same Python environment with the same `GROQ_API_KEY`. For an existing environment, the launch command remains:

```sh
python voiceController.py
```

Use Python 3.10 or newer with the existing dependencies from `requirements.txt`. The fix adds no runtime dependency or environment variable. Run only one copy of the voice server: multiple copies subscribed to the same audio topic can execute the same recording more than once. Netlify serves the webpage and does not run or update this Python process.

## Command behavior

- `Zero, move forward` / `move backward` publish `F` / `B` to `alice/zero/car/command`, at speed 50, for two seconds, followed by `S` on that same topic. Car requests do not produce arm gestures.
- `turn left`, `turn right`, `raise the arm`, `lower the arm`, `open the claw`, `close the claw`, and neck directions map directly to their original command codes. Wake words `Zero` and `Alice`, punctuation, and leading/trailing `please` are accepted.
- `Zero, stop` immediately publishes `S` to both car and arm topics. Older server stop timers cannot override a newer server command, and a stop interrupts remaining steps of an existing server performance.
- Basic controls bypass AI interpretation and sequence generation. Groq speech transcription is still required. An unavailable or failed transcription sends no movement.
- Unclear, negated, or unsupported commands—including plain `thank you` or `done`—send no movement and return an error. They cannot fall back to random choreography.
- Specifically requested performances such as `dance for me` can still use AI. Failed interpretation or sequence generation sends no invented movement. Invalid sequences are rejected before execution; cleanup attempts to stop still-owned movements after a failure.
- MQTT and HTTP responses report failure when no executable command exists or publishing fails. A successful response means the server accepted the MQTT publications, not verified physical motion; the firmware supplies no required acknowledgment.

The existing audio security token and device validation remain unchanged. Omitting `VOICE_SECURITY_TOKEN` from webpage configuration supplies its original default; it does not remove validation.

## Verify without moving hardware

The tests import the actual server module and replace only external Groq and MQTT calls with local fixtures. They do not start the server, send recordings to Groq, or publish to the real broker. In an environment with the existing dependencies, run:

```sh
uv run --no-project python -m unittest discover -s tests -v
```

Tests cover forward/backward recorded-audio payloads, direct arm commands, unknown/negated speech, immediate stop, failed/empty execution, stale auto-stop timers, interrupted performances, partial MQTT failures, and existing token validation.
