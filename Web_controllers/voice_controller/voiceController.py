import asyncio
import json
import math
import os
import random
import re
import base64
import hashlib
import threading
from datetime import datetime
from io import BytesIO
from typing import Dict, Optional, List
import concurrent.futures

import uvicorn
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from paho.mqtt.client import Client as MQTTClient

from dotenv import load_dotenv
load_dotenv()

app = FastAPI(title="Zero Secure Audio MQTT Controller", version="6.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# **SECURITY CONFIGURATION**
SECURITY_TOKEN = "ALICE_ZERO_2024_SECURE"  # Must match frontend
ALLOWED_DEVICE_PREFIXES = ["WebControl_", "MobileApp_", "TestDevice_"]
MAX_AUDIO_SIZE_MB = 1  # 1MB max for safety

# Initialize Groq client
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# **MQTT CONFIGURATION - Updated for Audio**
MQTT_BROKER = "broker.emqx.io"
MQTT_PORT = 1883
CAR_TOPIC = "alice/zero/car/command"
ARM_TOPIC = "alice/zero/arm/command"
ARM_POSITION_TOPIC = "alice/zero/arm/position"
STATUS_TOPIC = "alice/zero/robot/status"
AUDIO_TOPIC = "alice/zero/voice/audio"  # New audio topic
RESPONSE_TOPIC = "alice/zero/voice/response"  # Response topic

# Global MQTT client and event loop
mqtt_client = None
command_count = 0
main_loop = None
executor = concurrent.futures.ThreadPoolExecutor(max_workers=3)
CAR_COMMANDS = frozenset({"F", "B", "L", "R", "S"})
ARM_COMMANDS = frozenset({"U", "D", "C", "O", "1", "2", "3", "4", "S"})
publish_lock = threading.RLock()
motion_versions = {CAR_TOPIC: 0, ARM_TOPIC: 0}

def validate_security(payload: Dict) -> bool:
    """Validate security token and device"""
    try:
        # Check security token
        if payload.get("security_token") != SECURITY_TOKEN:
            print(f"❌ Invalid security token: {payload.get('security_token')}")
            return False
        
        # Check device ID format
        device_id = payload.get("device_id", "")
        if not any(device_id.startswith(prefix) for prefix in ALLOWED_DEVICE_PREFIXES):
            print(f"❌ Invalid device ID: {device_id}")
            return False
        
        # Check audio size
        audio_data = payload.get("audio_data", "")
        if len(audio_data) > MAX_AUDIO_SIZE_MB * 1024 * 1024 * 1.4:  # Account for base64
            print(f"❌ Audio too large: {len(audio_data)} bytes")
            return False
        
        print(f"✅ Security validation passed for device: {device_id}")
        return True
        
    except Exception as e:
        print(f"❌ Security validation error: {e}")
        return False

def on_audio_message(client, userdata, message):
    """Handle incoming audio messages from MQTT - FIXED EVENT LOOP"""
    try:
        print(f"🔊 Received audio message on topic: {message.topic}")
        
        # Parse message
        payload = json.loads(message.payload.decode())
        
        # Security validation
        if not validate_security(payload):
            print("❌ Security validation failed - ignoring message")
            return
        
        # Extract audio data
        audio_data = payload.get("audio_data")
        if not audio_data:
            print("❌ No audio data in message")
            return
        
        # **FIXED: Schedule coroutine in the main event loop**
        if main_loop and main_loop.is_running():
            asyncio.run_coroutine_threadsafe(process_mqtt_audio(payload), main_loop)
            print("✅ Audio processing scheduled in main event loop")
        else:
            print("❌ Main event loop not available, using thread executor")
            # Fallback: run in thread executor
            executor.submit(process_audio_sync, payload)
        
    except Exception as e:
        print(f"❌ Error processing audio message: {e}")

def process_audio_sync(payload: Dict):
    """Synchronous wrapper for audio processing"""
    try:
        # Create new event loop for this thread
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        
        # Run the async function
        loop.run_until_complete(process_mqtt_audio(payload))
        
        # Clean up
        loop.close()
        
    except Exception as e:
        print(f"❌ Sync audio processing failed: {e}")

async def process_mqtt_audio(payload: Dict):
    """Process audio received via MQTT - ASYNC FIXED"""
    try:
        device_id = payload.get("device_id", "unknown")
        audio_format = payload.get("audio_format", "audio/webm")
        duration = payload.get("duration", 0)
        
        print(f"🎤 Processing audio from {device_id}: {duration:.1f}s, format: {audio_format}")
        
        # Decode base64 audio
        audio_data = base64.b64decode(payload["audio_data"])
        audio_size_kb = len(audio_data) / 1024
        
        print(f"📊 Audio size: {audio_size_kb:.1f}KB")
        
        # Create audio file for Groq
        audio_file = BytesIO(audio_data)
        audio_file.name = f"voice_command_{device_id}.webm"
        
        # Transcribe with Groq
        print("🔄 Transcribing audio...")
        transcription = groq_client.audio.transcriptions.create(
            file=(audio_file.name, audio_file.getvalue(), audio_format),
            model="whisper-large-v3",
            language="en"
        )
        
        text = transcription.text.strip()
        print(f"📝 Transcribed: '{text}'")
        
        if not text or text == ".":
            print("❌ No clear speech detected")
            send_response_to_device(device_id, {"error": "No clear speech detected"})
            return
        
        # AI command interpretation
        commands = ai_command_interpreter(text)
        print(f"🧠 AI Interpretation: {commands.get('interpretation', 'N/A')}")
        
        # Execute commands
        execution_success = await execute_commands(commands)
        
        print(f"Audio command execution result for {device_id}: {execution_success}")
        
        # Send response back via MQTT
        response_payload = {
            "device_id": device_id,
            "transcription": text,
            "commands": commands,
            "success": execution_success,
            "timestamp": int(datetime.now().timestamp() * 1000)
        }
        if not execution_success:
            response_payload["error"] = commands.get("error", "Robot command could not be published or completed")
        
        send_response_to_device(device_id, response_payload)
        
    except Exception as e:
        print(f"❌ Audio processing failed: {e}")
        send_response_to_device(payload.get("device_id", "unknown"), {"error": str(e)})

def send_response_to_device(device_id: str, response: Dict):
    """Send response back to specific device via MQTT"""
    if mqtt_client:
        try:
            response_topic = f"{RESPONSE_TOPIC}/{device_id}"
            mqtt_client.publish(response_topic, json.dumps(response))
            print(f"📤 Response sent to {device_id}")
        except Exception as e:
            print(f"❌ Failed to send response: {e}")

def connect_mqtt():
    """Connect to MQTT broker with audio support"""
    global mqtt_client
    try:
        mqtt_client = MQTTClient(f"AliceAudioController_{datetime.now().timestamp()}")
        
        # Set up message handler for audio
        mqtt_client.on_message = on_audio_message
        
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
        
        # Subscribe to audio topic
        mqtt_client.subscribe(AUDIO_TOPIC, qos=1)
        print(f"✅ Subscribed to audio topic: {AUDIO_TOPIC}")
        
        # Start MQTT loop in separate thread
        mqtt_client.loop_start()
        
        print(f"✅ Connected to MQTT broker: {MQTT_BROKER}")
        print(f"🔒 Security enabled with token: {SECURITY_TOKEN[:8]}...")
        return True
    except Exception as e:
        print(f"❌ MQTT connection failed: {e}")
        return False

def send_command(topic: str, command: str, speed: Optional[int] = None, positions: Optional[Dict] = None):
    """Send command via MQTT"""
    global command_count, mqtt_client
    
    if not mqtt_client:
        print("❌ MQTT client not connected")
        return False
    if (
        (topic == CAR_TOPIC and command not in CAR_COMMANDS)
        or (topic == ARM_TOPIC and command not in ARM_COMMANDS)
    ):
        print("Invalid robot command; no movement published")
        return False
    with publish_lock:
        command_count += 1
        if topic == ARM_POSITION_TOPIC and positions:
            payload = positions.copy()
        else:
            payload = {"cmd": command}
            if speed is not None and topic == CAR_TOPIC:
                payload["speed"] = speed
        payload["timestamp"] = int(datetime.now().timestamp() * 1000)
        payload["id"] = command_count
        try:
            result = mqtt_client.publish(topic, json.dumps(payload))
            if result.rc != 0:
                print(f"❌ Failed to publish: {result.rc}")
                return False
            target = ARM_TOPIC if topic == ARM_POSITION_TOPIC else topic
            if target in motion_versions:
                motion_versions[target] += 1
            print(f"📤 Sent: {command} to {topic} {f'(speed: {speed}%)' if speed else ''}")
            return True
        except Exception as e:
            print(f"❌ Failed to send command: {e}")
            return False

def normalize_voice_text(text: str) -> str:
    """Remove the wake word and polite wrappers without guessing an action."""
    if not isinstance(text, str):
        return ""
    text = " ".join(re.findall(r"[a-z0-9']+", text.lower().replace("’", "'")))
    text = re.sub(r"^please\s+", "", text)
    text = re.sub(r"^(?:(?:hey|okay|ok)\s+)?(?:zero|alice)\s+", "", text)
    text = re.sub(r"^(?:can|could|would) you\s+", "", text)
    return re.sub(r"^please\s+|\s+please$", "", text).strip()


def parse_direct_command(text: str) -> Optional[Dict]:
    """Resolve explicit controls locally, before any creative AI interpretation."""
    normalized = normalize_voice_text(text)
    patterns = [
        (r"(?:(?:move|go|drive|roll) )?(?:forward|forwards|ahead)", "car_command", "F"),
        (r"(?:(?:move|go|drive|roll) )?(?:back|backward|backwards|reverse)", "car_command", "B"),
        (r"(?:(?:turn|move|go|steer) )?left", "car_command", "L"),
        (r"(?:(?:turn|move|go|steer) )?right", "car_command", "R"),
        (r"(?:raise|lift)(?: the)? arm|(?:move )?(?:the )?arm up", "arm_command", "U"),
        (r"lower(?: the)? arm|(?:move )?(?:the )?arm down", "arm_command", "D"),
        (r"open(?: the)? (?:claw|gripper)", "arm_command", "O"),
        (r"close(?: the)? (?:claw|gripper)", "arm_command", "C"),
        (r"(?:turn |move )?(?:the )?neck left", "arm_command", "1"),
        (r"(?:move )?(?:the )?neck up", "arm_command", "2"),
        (r"(?:move )?(?:the )?neck down", "arm_command", "3"),
        (r"(?:turn |move )?(?:the )?neck right", "arm_command", "4"),
    ]
    if normalized in {"stop", "stop moving", "stop everything", "stop all", "emergency stop", "halt"}:
        return {
            "command_type": "simple",
            "car_command": "S",
            "arm_command": "S",
            "interpretation": "Stop all movement",
        }
    for pattern, field, command in patterns:
        if re.fullmatch(pattern, normalized):
            return {
                "command_type": "simple",
                field: command,
                "interpretation": f"Execute {normalized}",
            }
    return None


def is_performance_request(text: str) -> bool:
    normalized = normalize_voice_text(text)
    if re.search(r"\b(?:don't|dont|not|never|no)\b", normalized):
        return False
    return bool(re.fullmatch(
        r"(?:(?:do|perform|show)(?: me)? )?(?:(?:a|an|energetic|gentle|playful|dramatic|elegant|creative|cultural|folk|classical) )*"
        r"(?:dance|gesture|wave|nod|ringa ringa)(?: for me| for [0-9]+ seconds)?",
        normalized,
    ))


def ai_command_interpreter(text: str) -> Dict:
    """Handle explicit controls directly; reserve AI for requested performances."""
    direct = parse_direct_command(text)
    if direct:
        return direct
    if not is_performance_request(text):
        return create_intelligent_fallback(text)
    
    system_prompt = """You are Zero, a robotic assistant. Interpret only the user's explicit performance request.

RESPONSE MODES:
1. "ai_sequence" - A specifically requested dance or gesture
2. "simple" - Single movement commands
3. "noop" - The request is unclear, unsupported, or must not move the robot

Basic movement commands are handled locally. Do not invent movement, a dance, or an acknowledgment gesture for unclear speech.

AVAILABLE COMMANDS:
Car: F(forward), B(backward), L(left), R(right), S(stop)
Arm: U(up), D(down), C(close claw), O(open claw), 1(neck left), 2(neck up), 3(neck down), 4(neck right), S(stop)

RESPONSE FORMAT (JSON ONLY):
{
    "command_type": "ai_sequence|simple|noop",
    "intent": "clear description of what user wants",
    "style": "energetic|gentle|playful|dramatic|elegant|creative|cultural|normal",
    "duration_preference": "short|medium|long|custom",
    "speed_preference": "slow|medium|fast|custom",
    "cultural_context": "if applicable (e.g., 'Indian classical dance', 'Western pop', etc.)",
    "creativity_level": "low|medium|high|maximum",
    "custom_duration": 15,
    "custom_speed": 80,
    "car_command": "F" OR null,
    "arm_command": "U" OR null,
    "interpretation": "what Zero will do"
}

EXAMPLES:
"dance for me" → ai_sequence, intent: "perform a creative dance", style: "playful", creativity_level: "high"
"Ringa Ringa" → ai_sequence, intent: "perform Ringa Ringa dance", cultural_context: "Indian folk dance", style: "cultural"
"Thank you" → noop
"move forward" → simple, car_command: "F"
"energetic dance for 20 seconds" → ai_sequence, custom_duration: 20, style: "energetic", creativity_level: "high"

Use "noop" when the requested action cannot be determined."""

    try:
        # Use the CORRECT powerful 70B model name
        response = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",  # ✅ CORRECT current 70B model
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": f"Interpret this request for Zero: {text}"}
            ],
            temperature=0.3,
            max_tokens=400
        )
        
        result_text = response.choices[0].message.content.strip()
        
        # Extract JSON
        if result_text.startswith("```json"):
            result_text = result_text[7:-3]
        elif result_text.startswith("```"):
            result_text = result_text[3:-3]
        
        # Find JSON in response
        json_start = result_text.find("{")
        json_end = result_text.rfind("}") + 1
        if json_start != -1 and json_end > json_start:
            result_text = result_text[json_start:json_end]
        
        parsed_result = json.loads(result_text)
        
        # Set defaults
        defaults = {
            "command_type": "noop",
            "intent": text,
            "style": "normal",
            "duration_preference": "medium",
            "speed_preference": "medium", 
            "cultural_context": None,
            "creativity_level": "high",
            "custom_duration": None,
            "custom_speed": None,
            "car_command": None,
            "arm_command": None,
            "interpretation": f"AI interpretation of: {text}"
        }
        
        for key, default_value in defaults.items():
            if key not in parsed_result:
                parsed_result[key] = default_value
        
        return parsed_result
        
    except Exception as e:
        print(f"❌ AI interpretation failed: {e}")
        return create_intelligent_fallback(text)

def create_intelligent_fallback(text: str) -> Dict:
    """A failed interpretation must never invent robot movement."""
    return parse_direct_command(text) or {
        "command_type": "noop",
        "intent": text,
        "interpretation": "No movement: command was not understood",
        "error": "Command not understood. Try 'Zero, move forward', 'move backward', or 'stop'.",
    }

def ai_sequence_generator(commands: Dict) -> List[Dict]:
    """Advanced AI sequence generator with the powerful 70B model"""
    
    intent = commands.get("intent", "be creative")
    style = commands.get("style", "normal")
    creativity = commands.get("creativity_level", "high")
    cultural_context = commands.get("cultural_context", "")
    duration_pref = commands.get("duration_preference", "medium")
    speed_pref = commands.get("speed_preference", "medium")
    custom_duration = commands.get("custom_duration")
    custom_speed = commands.get("custom_speed")
    
    # Determine parameters
    if custom_duration:
        total_duration = custom_duration
    elif duration_pref == "short":
        total_duration = 5
    elif duration_pref == "long": 
        total_duration = 20
    else:
        total_duration = 10
    
    if custom_speed:
        base_speed = custom_speed
    elif speed_pref == "fast":
        base_speed = 85
    elif speed_pref == "slow":
        base_speed = 35
    else:
        base_speed = 60
    
    # Calculate steps
    num_steps = max(4, min(int(total_duration / 1.2), 25))
    
    # Enhanced AI prompt for the powerful 70B model
    enhanced_prompt = f"""You are Alice, a creative robotic performer with advanced choreography skills. Generate an AMAZING movement sequence!

REQUEST: "{intent}"
STYLE: {style}
CULTURAL CONTEXT: {cultural_context or "Universal/Creative"}
CREATIVITY LEVEL: {creativity}
TOTAL DURATION: {total_duration} seconds
BASE SPEED: {base_speed}%
NUMBER OF STEPS: {num_steps}

AVAILABLE MOVEMENTS:
Car Base: F(forward), B(backward), L(left), R(right), S(stop)
Robotic Arm: U(up), D(down), C(close_claw), O(open_claw), 1(neck_left), 2(neck_up), 3(neck_down), 4(neck_right), S(stop)

CREATIVE GUIDELINES:
- For CULTURAL dances like "Ringa Ringa": Create circular movements (L/R alternating) with rhythmic arm gestures
- For ENERGETIC: Fast alternating movements, varied speeds (±20% from base)
- For GENTLE: Slow, flowing movements, graceful arm transitions
- For PLAYFUL: Unexpected combinations, varied timing, fun sequences
- For DRAMATIC: Include pauses, builds, theatrical arm gestures
- Speed can vary ±25% from base for dynamics
- Include rhythm changes and meaningful pauses
- Always end with graceful stop commands
- Make it UNIQUE and EXPRESSIVE!
- If you are not asked to move the arm, like if it's just a movement of the car, just move the car.
  No need to move the arm but yeah when expresiive text is given as input then surely yu should move arm with that
  

RESPOND WITH ONLY JSON ARRAY:
[
  {{"car_command": "L", "arm_command": "U", "speed": {base_speed}, "duration": 1.2, "description": "Graceful left turn with arm rise"}},
  {{"car_command": "R", "arm_command": "1", "speed": {base_speed+10}, "duration": 1.0, "description": "Right turn, neck look left"}},
  {{"car_command": "S", "arm_command": "S", "speed": 0, "duration": 0.5, "description": "Final graceful stop"}}
]

Generate {num_steps} creative, expressive steps for: {intent} ({style} style, {creativity} creativity)"""

    try:
        # Use the POWERFUL 70B model for creative sequence generation
        response = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",  # ✅ CORRECT powerful 70B model
            messages=[
                {"role": "system", "content": "You are a master choreographer and robotics expert. Create AMAZING, unique movement sequences. Respond ONLY with JSON array. Be creative and expressive!"},
                {"role": "user", "content": enhanced_prompt}
            ],
            temperature=0.8,  # Higher temperature for maximum creativity
            max_tokens=1200
        )
        
        result_text = response.choices[0].message.content.strip()
        
        # Extract JSON array
        if result_text.startswith("```json"):
            result_text = result_text[7:-3]
        elif result_text.startswith("```"):
            result_text = result_text[3:-3]
        
        # Find JSON array
        start = result_text.find("[")
        end = result_text.rfind("]") + 1
        if start != -1 and end > start:
            result_text = result_text[start:end]
        
        sequence = json.loads(result_text)
        
        # Validate and enhance sequence
        enhanced_sequence = []
        for i, step in enumerate(sequence):
            enhanced_step = {
                "car_command": step.get("car_command", "S"),
                "arm_command": step.get("arm_command", "S"), 
                "speed": max(20, min(95, step.get("speed", base_speed))),
                "duration": max(0.3, min(8.0, step.get("duration", total_duration / num_steps))),
                "description": step.get("description", f"AI Step {i+1}")
            }
            enhanced_sequence.append(enhanced_step)
        
        print(f"🤖✨ 70B AI generated {len(enhanced_sequence)} step AMAZING sequence for: {intent}")
        print(f"🎨 Style: {style}, Creativity: {creativity}, Duration: {total_duration}s")
        return enhanced_sequence
        
    except Exception as e:
        print(f"AI sequence generation failed; no movement generated: {e}")
        return []

def generate_enhanced_fallback(intent: str, style: str, speed: int, num_steps: int, duration: float) -> List[Dict]:
    """Enhanced fallback with style-aware patterns"""
    print(f"🔄 Using enhanced fallback for: {intent} (style: {style})")
    
    step_duration = duration / num_steps
    sequence = []
    
    # Style-specific patterns
    if style == "cultural" or 'ringa' in intent.lower() or 'inga' in intent.lower():
        # Cultural dance pattern - Ringa Ringa inspired
        patterns = [
            {"car_command": "L", "arm_command": "U", "description": "Circle left, arm up gracefully"},
            {"car_command": "R", "arm_command": "D", "description": "Circle right, arm down flowing"},
            {"car_command": "L", "arm_command": "C", "description": "Turn left, close claw gently"},
            {"car_command": "R", "arm_command": "O", "description": "Turn right, open claw wide"},
            {"car_command": "L", "arm_command": "1", "description": "Left turn, look left traditionally"},
            {"car_command": "R", "arm_command": "4", "description": "Right turn, look right gracefully"},
            {"car_command": "L", "arm_command": "2", "description": "Left circle, look up to sky"},
            {"car_command": "R", "arm_command": "3", "description": "Right circle, look down humbly"}
        ]
        
    elif style == "gentle" or 'thank' in intent.lower():
        # Gentle, grateful movements
        patterns = [
            {"car_command": None, "arm_command": "U", "description": "Gentle grateful arm raise"},
            {"car_command": "L", "arm_command": "D", "description": "Soft left turn, humble bow"},
            {"car_command": "R", "arm_command": "U", "description": "Gentle right turn, acknowledgment"},
            {"car_command": None, "arm_command": "2", "description": "Look up gratefully"},
            {"car_command": "L", "arm_command": "3", "description": "Soft left, humble look down"},
            {"car_command": "R", "arm_command": "D", "description": "Gentle right, arm rest"}
        ]
        speed = max(speed - 15, 30)  # Slower for gentle
        step_duration = step_duration * 1.3
        
    else:
        # Default creative pattern
        patterns = [
            {"car_command": "L", "arm_command": "U", "description": "Creative left, arm up"},
            {"car_command": "R", "arm_command": "D", "description": "Creative right, arm down"},
            {"car_command": "F", "arm_command": "C", "description": "Forward move, claw close"},
            {"car_command": "B", "arm_command": "O", "description": "Back move, claw open"},
            {"car_command": "L", "arm_command": "1", "description": "Left look around"},
            {"car_command": "R", "arm_command": "4", "description": "Right look around"}
        ]
    
    # Generate sequence using patterns
    for i in range(num_steps - 1):
        pattern = patterns[i % len(patterns)]
        sequence.append({
            "car_command": pattern["car_command"],
            "arm_command": pattern["arm_command"],
            "speed": speed,
            "duration": step_duration,
            "description": pattern["description"]
        })
    
    # Always end with graceful stop
    sequence.append({
        "car_command": "S",
        "arm_command": "S", 
        "speed": 0,
        "duration": 0.5,
        "description": "Graceful finish"
    })
    
    return sequence

async def execute_sequence(sequence: List[Dict]) -> bool:
    """Execute any sequence of movements with detailed logging"""
    if not isinstance(sequence, list) or not sequence:
        return False
    for step in sequence:
        if not isinstance(step, dict):
            return False
        car, arm = step.get("car_command"), step.get("arm_command")
        duration, speed = step.get("duration", 0), step.get("speed", 50)
        if (
            (not car and not arm)
            or (car is not None and car not in CAR_COMMANDS)
            or (arm is not None and arm not in ARM_COMMANDS)
            or isinstance(duration, bool)
            or not isinstance(duration, (int, float))
            or not math.isfinite(duration)
            or not 0 <= duration <= 8
            or isinstance(speed, bool)
            or not isinstance(speed, (int, float))
            or not math.isfinite(speed)
            or not 0 <= speed <= 100
        ):
            return False
    print(f"Executing {len(sequence)} voice sequence steps")
    topics = {
        topic for step in sequence
        for topic, field in [(CAR_TOPIC, "car_command"), (ARM_TOPIC, "arm_command")]
        if step.get(field)
    }
    with publish_lock:
        versions = {topic: motion_versions[topic] for topic in topics}
    active = set()
    stopped = True
    try:
        for step in sequence:
            with publish_lock:
                if any(motion_versions[topic] != version for topic, version in versions.items()):
                    return False
                for topic, field in [(CAR_TOPIC, "car_command"), (ARM_TOPIC, "arm_command")]:
                    command = step.get(field)
                    if not command:
                        continue
                    speed = 0 if command == "S" else step.get("speed", 50)
                    if not send_command(topic, command, speed):
                        return False
                    versions[topic] = motion_versions[topic]
                    if command == "S":
                        active.discard(topic)
                    else:
                        active.add(topic)
            if step.get("duration", 0) > 0:
                await asyncio.sleep(step["duration"])
        with publish_lock:
            if any(motion_versions[topic] != version for topic, version in versions.items()):
                return False
    finally:
        with publish_lock:
            for topic in active:
                if motion_versions[topic] == versions[topic]:
                    stopped &= send_command(topic, "S", 0)
    return stopped

async def execute_commands(commands: Dict) -> bool:
    """Execute commands with full AI integration"""
    success = True
    
    try:
        command_type = commands.get("command_type", "noop")
        
        if command_type == "ai_sequence":
            print(f"🤖✨ Generating 70B AI sequence for: {commands.get('intent', 'unknown')}")
            print(f"🎨 Style: {commands.get('style', 'normal')}, Creativity: {commands.get('creativity_level', 'medium')}")
            
            ai_sequence = ai_sequence_generator(commands)
            success = await execute_sequence(ai_sequence)
            
        elif command_type == "simple":
            car = commands.get("car_command")
            arm = commands.get("arm_command")
            if (
                (not car and not arm)
                or (car is not None and car not in CAR_COMMANDS)
                or (arm is not None and arm not in ARM_COMMANDS)
            ):
                return False
            targets = {}
            with publish_lock:
                for topic, command in [(CAR_TOPIC, car), (ARM_TOPIC, arm)]:
                    if not command:
                        continue
                    published = send_command(topic, command, 50 if command != "S" else 0)
                    success &= published
                    if published and command != "S":
                        targets[topic] = motion_versions[topic]
            # Wait for the bounded movement and stop only its target.
            if targets:
                stopped = await send_stop_after_delay(2.0, targets)
                success = success and stopped
            
        else:
            print("No executable voice command; no movement published")
            success = False
    
    except Exception as e:
        print(f"❌ Command execution failed: {e}")
        success = False
    
    return success

async def send_stop_after_delay(delay_seconds: float, targets: Dict[str, int]):
    """Send stop commands after specified delay"""
    success = True
    try:
        await asyncio.sleep(delay_seconds)
    finally:
        with publish_lock:
            for topic, version in targets.items():
                if motion_versions[topic] == version:
                    success &= send_command(topic, "S", 0)
    print(f"⏹️ Auto-stop after {delay_seconds}s")
    return success

@app.on_event("startup")
async def startup_event():
    """Initialize MQTT connection on startup - FIXED EVENT LOOP"""
    global main_loop
    
    print("🚀 Starting Alice Secure Audio MQTT Controller...")
    print("Voice routing 6.2: direct movement commands; unclear speech sends no movement")
    
    # **FIXED: Store reference to main event loop**
    main_loop = asyncio.get_event_loop()
    print(f"✅ Main event loop stored: {main_loop}")
    
    connect_mqtt()
    print("✅ Audio MQTT processing ready!")

@app.post("/voice-command")
async def process_voice_command(audio_file: UploadFile = File(...)):
    """Process voice command with powerful 70B AI (HTTP endpoint)"""
    
    if not audio_file.content_type.startswith('audio/'):
        raise HTTPException(status_code=400, detail="Please upload an audio file")
    
    try:
        # Read and transcribe audio
        audio_data = await audio_file.read()
        
        print("🎤 Transcribing audio (HTTP)...")
        transcription = groq_client.audio.transcriptions.create(
            file=(audio_file.filename, BytesIO(audio_data), audio_file.content_type),
            model="whisper-large-v3",
            language="en"
        )
        
        text = transcription.text.strip()
        print(f"📝 Transcribed: '{text}'")
        
        if not text or text == ".":
            raise HTTPException(status_code=400, detail="No clear speech detected")
        
        # 70B AI command interpretation
        commands = ai_command_interpreter(text)
        
        print(f"🧠✨ 70B AI Interpretation: {commands.get('interpretation', 'N/A')}")
        print(f"🎯 Command Type: {commands['command_type']}")
        print(f"🎭 Intent: {commands.get('intent', 'N/A')}")
        print(f"🎨 Style: {commands.get('style', 'normal')}")
        print(f"🔥 Creativity: {commands.get('creativity_level', 'medium')}")
        
        if commands.get('cultural_context'):
            print(f"🌍 Cultural Context: {commands['cultural_context']}")
        
        # EXECUTE WITH 70B AI POWER
        execution_success = await execute_commands(commands)
        
        # Enhanced response format
        response = {
            "success": execution_success,
            "transcription": text,
            "commands": commands,
            "ai_interpretation": commands,
            "executed": execution_success,
            "ai_powered": True,
            "ai_model": "llama-3.3-70b-versatile",
            "timestamp": datetime.now().isoformat()
        }
        
        # Ensure commands has command_type for frontend
        if "command_type" not in response["commands"]:
            response["commands"]["command_type"] = "ai_sequence"
        
        return response
        
    except Exception as e:
        print(f"❌ Voice command processing failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/text-command")
async def process_text_command(text: str):
    """Process text command with 70B AI interpretation"""
    try:
        commands = ai_command_interpreter(text)
        execution_success = await execute_commands(commands)
        
        response = {
            "success": execution_success,
            "commands": commands,
            "ai_interpretation": commands,
            "executed": execution_success,
            "ai_powered": True,
            "ai_model": "llama-3.3-70b-versatile",
            "timestamp": datetime.now().isoformat()
        }
        
        # Ensure commands has command_type
        if "command_type" not in response["commands"]:
            response["commands"]["command_type"] = "ai_sequence"
        
        return response
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/capabilities")
async def get_capabilities():
    """Get Alice's 70B AI-powered capabilities"""
    return {
        "ai_powered": True,
        "ai_model": "llama-3.3-70b-versatile (70B parameters - MOST POWERFUL)",
        "audio_mqtt_enabled": True,
        "security_enabled": True,
        "event_loop_fixed": True,
        "capabilities": [
            "Direct forward, backward, turn, arm and stop commands",
            "AI sequences for explicitly requested performances",
            "Secure Audio MQTT processing",
            "Advanced cultural dance interpretation", 
            "Creative movement generation",
            "Style-aware choreography",
            "Enhanced pattern recognition",
            "Contextual movement adaptation",
            "Real-time audio via MQTT",
            "Fixed async/sync event loop handling"
        ],
        "styles": ["energetic", "gentle", "playful", "dramatic", "elegant", "creative", "cultural", "normal"],
        "creativity_levels": ["low", "medium", "high", "maximum"],
        "cultural_support": ["Indian classical", "Folk dances", "Ringa Ringa", "Custom"],
        "example_commands": [
            "Zero, move forward",
            "Zero, move backward",
            "Zero, stop",
            "Inga Inga Roses performance",
            "energetic celebration dance",
            "gentle thank you gesture",
            "cultural folk dance",
            "creative expression"
        ]
    }

@app.get("/security-info")
async def get_security_info():
    """Get security configuration info"""
    return {
        "security_enabled": True,
        "token_required": True,
        "allowed_device_prefixes": ALLOWED_DEVICE_PREFIXES,
        "max_audio_size_mb": MAX_AUDIO_SIZE_MB,
        "audio_topic": AUDIO_TOPIC,
        "response_topic": RESPONSE_TOPIC,
        "event_loop_status": "FIXED" if main_loop else "NOT_AVAILABLE",
        "security_features": [
            "Token-based authentication",
            "Device ID validation", 
            "Audio size limits",
            "Message encryption ready",
            "MQTT audio processing",
            "Real-time response system",
            "Fixed async event loop handling"
        ]
    }

@app.post("/emergency-stop")
async def emergency_stop():
    """Emergency stop all robot movement"""
    car_success = send_command(CAR_TOPIC, "S")
    arm_success = send_command(ARM_TOPIC, "S")
    
    return {
        "success": car_success and arm_success,
        "message": "Alice emergency stop executed",
        "timestamp": datetime.now().isoformat()
    }

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "Alice Secure Audio MQTT Controller is healthy!",
        "mqtt_connected": mqtt_client is not None,
        "audio_mqtt_enabled": True,
        "security_enabled": True,
        "ai_ready": True,
        "ai_model": "llama-3.3-70b-versatile (70B parameters)",
        "max_audio_size_mb": MAX_AUDIO_SIZE_MB,
        "event_loop_fixed": True,
        "main_loop_available": main_loop is not None,
        "version": "6.2.0 - DIRECT VOICE ROUTING",
        "timestamp": datetime.now().isoformat()
    }

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
