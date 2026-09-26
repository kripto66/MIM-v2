import asyncio
import json
import math
import random
import wave
from array import array
from pathlib import Path

import edge_tts
from mutagen.mp3 import MP3

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
VOICE_DIR = PUBLIC / "voice"
VOICE_DIR.mkdir(parents=True, exist_ok=True)
VOICE = "fr-FR-DeniseNeural"

CLIPS = [
    {"id": "01-probleme", "text": "Vos biens, vos locataires et vos échéances sont dispersés ?"},
    {"id": "02-solution", "text": "Découvrez MyImmoManagement, la plateforme qui simplifie la gestion de votre patrimoine locatif."},
    {"id": "03-dashboard", "text": "Depuis un tableau de bord clair, suivez vos logements, vos occupants, vos échéances et vos incidents."},
    {"id": "04-biens", "text": "Ajoutez vos biens, rattachez les logements et réorganisez votre parc en quelques clics."},
    {"id": "05-paiements", "text": "Pour les règlements, le locataire déclare son paiement. Vous le vérifiez, puis vous le validez."},
    {"id": "06-maintenance", "text": "Un incident signalé devient une intervention planifiée, suivie et clôturée."},
    {"id": "07-equipe", "text": "Importez vos données et donnez à votre équipe les accès adaptés à son rôle."},
    {"id": "08-cta", "text": "Une gestion plus simple, plus claire, plus maîtrisée. Commencez dès aujourd’hui avec MyImmoManagement."},
]

async def generate_voice():
    metadata = []
    for clip in CLIPS:
        target = VOICE_DIR / f"{clip['id']}.mp3"
        if target.exists():
            try:
                MP3(target)
            except Exception:
                target.unlink()
        if not target.exists():
            for attempt in range(4):
                try:
                    communicator = edge_tts.Communicate(clip["text"], VOICE, rate="+8%")
                    await communicator.save(str(target))
                    break
                except Exception:
                    if attempt == 3:
                        raise
                    await asyncio.sleep(2 * (attempt + 1))
        duration = round(MP3(target).info.length, 3)
        metadata.append({"id": clip["id"], "duration": duration})
    (PUBLIC / "voice-meta.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

def generate_music():
    sample_rate = 44100
    total_seconds = 60
    sample_count = sample_rate * total_seconds
    chords = [
        (110.0, 138.59, 164.81, 220.0),
        (98.0, 123.47, 146.83, 196.0),
        (123.47, 155.56, 185.0, 246.94),
        (92.5, 116.54, 146.83, 185.0),
    ]
    rng = random.Random(17)
    left = array("h")
    right = array("h")
    for index in range(sample_count):
        t = index / sample_rate
        section = int(t // 8) % len(chords)
        local = t % 8
        pad = 0.0
        for frequency in chords[section]:
            pad += math.sin(2 * math.pi * frequency * t + math.sin(t * 0.7) * 0.4)
        pad /= len(chords)
        pad *= 0.72 + 0.28 * math.sin(2 * math.pi * t / 8)
        bass = math.sin(2 * math.pi * (chords[section][0] * 0.5) * t) * 0.18
        beat = t % 1
        kick = math.sin(2 * math.pi * (62 - beat * 22) * beat) * math.exp(-beat * 18) * 0.12
        step = t % 0.5
        pluck = math.sin(2 * math.pi * chords[section][(int(t * 2) % 4)] * 2 * t) * math.exp(-step * 14) * 0.035
        hat = (rng.random() * 2 - 1) * math.exp(-beat * 45) * 0.012
        fade_in = min(1.0, t / 2.5)
        fade_out = min(1.0, (total_seconds - t) / 2.5)
        value = (pad * 0.14 + bass * 0.08 + kick + pluck + hat) * fade_in * fade_out
        value = max(-0.8, min(0.8, value))
        left.append(int(value * 32767))
        right.append(int(value * 0.96 * 32767))
    target = PUBLIC / "music.wav"
    with wave.open(str(target), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(left.tobytes())
        output.writeframes(right.tobytes())

async def main():
    await generate_voice()
    generate_music()

asyncio.run(main())
