// ════════════════════════════════════════════════════════════════
//  ULEN VOICE ENGINE — voice.js  (v2 — Zero OpenAI)
//  STT: Vosk (runs locally, free, no API key needed)
//  TTS: gTTS Nigerian English (free, no API key needed)
//
//  To upgrade to YOUR real voice later:
//  1. Sign up at elevenlabs.io
//  2. Record 1–3 mins of yourself talking
//  3. Upload → get Voice ID
//  4. Add on Render env vars:
//       ELEVENLABS_API_KEY=your_key
//       ELEVENLABS_VOICE_ID=your_voice_id
//  5. It activates automatically — zero code change needed
// ════════════════════════════════════════════════════════════════

const fs        = require('fs');
const path      = require('path');
const { exec, execSync } = require('child_process');
const { promisify }      = require('util');
const execAsync = promisify(exec);

// ── Environment (ElevenLabs only — no OpenAI ever) ───────────────
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY  || '';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '';
const TMP_DIR             = '/tmp/ulen_voice';

if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

// ── Check Python tools availability ─────────────────────────────
let gttsPythonAvailable = false;
let voskAvailable       = false;

try {
  execSync('python3 -c "import gtts"', { stdio: 'ignore' });
  gttsPythonAvailable = true;
  console.log('[VOICE] gTTS ready — Nigerian English TTS active.');
} catch {
  console.warn('[VOICE] gTTS not found. Build command must include: pip3 install gtts');
}

try {
  execSync('python3 -c "import vosk"', { stdio: 'ignore' });
  voskAvailable = true;
  console.log('[VOICE] Vosk ready — local speech-to-text active.');
} catch {
  console.warn('[VOICE] Vosk not found. Build command must include: pip3 install vosk');
  console.warn('[VOICE] Voice notes will be acknowledged but not transcribed until Vosk is installed.');
}

// ════════════════════════════════════════════════════════════════
//  isVoiceNote
// ════════════════════════════════════════════════════════════════

function isVoiceNote(msg) {
  const audio = msg.message?.audioMessage;
  if (!audio) return false;
  return audio.ptt === true || (audio.mimetype || '').includes('ogg');
}

// ════════════════════════════════════════════════════════════════
//  transcribeVoiceNote — Vosk local STT (no API, no OpenAI)
// ════════════════════════════════════════════════════════════════

async function transcribeVoiceNote(audioBuffer) {
  if (!voskAvailable) {
    console.warn('[VOICE STT] Vosk not available — cannot transcribe.');
    return null;
  }

  const oggFile = path.join(TMP_DIR, `in_${Date.now()}.ogg`);
  const wavFile = oggFile.replace('.ogg', '.wav');
  const pyFile  = path.join(TMP_DIR, 'transcribe.py');

  try {
    // Write incoming audio
    fs.writeFileSync(oggFile, audioBuffer);

    // Convert OGG → WAV (Vosk needs WAV 16kHz mono)
    await execAsync(
      `ffmpeg -i "${oggFile}" -ar 16000 -ac 1 -f wav "${wavFile}" -y`,
      { timeout: 15000 }
    );

    if (!fs.existsSync(wavFile)) {
      console.warn('[VOICE STT] ffmpeg conversion failed.');
      return null;
    }

    // Vosk transcription Python script
    const script = `
import sys, json, wave
from vosk import Model, KaldiRecognizer

model_path = "/opt/render/project/src/vosk-model"
if not __import__('os').path.exists(model_path):
    # fallback small model path
    model_path = "./vosk-model"

try:
    model = Model(model_path)
    wf = wave.open(sys.argv[1], "rb")
    rec = KaldiRecognizer(model, wf.getframerate())
    rec.SetWords(True)
    results = []
    while True:
        data = wf.readframes(4000)
        if len(data) == 0:
            break
        if rec.AcceptWaveform(data):
            r = json.loads(rec.Result())
            results.append(r.get("text", ""))
    r = json.loads(rec.FinalResult())
    results.append(r.get("text", ""))
    print(" ".join(results).strip())
except Exception as e:
    print("", end="")
    sys.stderr.write(str(e))
`.trim();

    fs.writeFileSync(pyFile, script);

    const { stdout } = await execAsync(
      `python3 "${pyFile}" "${wavFile}"`,
      { timeout: 30000 }
    );

    const transcription = stdout?.trim();
    return transcription || null;

  } catch(err) {
    console.error('[VOICE STT FAIL]', err.message);
    return null;
  } finally {
    [oggFile, wavFile, pyFile].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

// ════════════════════════════════════════════════════════════════
//  textToVoice — TTS
//  Order: ElevenLabs (your real voice) → gTTS Nigerian EN → null
// ════════════════════════════════════════════════════════════════

async function textToVoice(text) {
  if (!text?.trim()) return null;

  // Clean text for natural speech
  const speechText = text
    .replace(/\*\*/g, '').replace(/\_\_/g, '')
    .replace(/\*/g, '').replace(/_/g, '')
    .replace(/[🌙✦🛡📈💙🔥😅🙏]/g, '')
    .replace(/\n+/g, '. ')
    .trim()
    .slice(0, 800);

  // ── ElevenLabs: your real cloned voice (future) ──
  if (ELEVENLABS_API_KEY && ELEVENLABS_VOICE_ID) {
    try {
      const result = await elevenLabsTTS(speechText);
      if (result) {
        console.log('[VOICE TTS] ElevenLabs voice used.');
        return result;
      }
    } catch(e) { console.warn('[VOICE TTS] ElevenLabs failed:', e.message); }
  }

  // ── gTTS: Nigerian English generic (current default) ──
  if (gttsPythonAvailable) {
    try {
      const result = await gttsTTS(speechText);
      if (result) {
        console.log('[VOICE TTS] gTTS Nigerian English used.');
        return result;
      }
    } catch(e) { console.warn('[VOICE TTS] gTTS failed:', e.message); }
  }

  console.warn('[VOICE TTS] No TTS method available — caller will fall back to text.');
  return null;
}

// ── gTTS ─────────────────────────────────────────────────────────
async function gttsTTS(text) {
  const mp3 = path.join(TMP_DIR, `tts_${Date.now()}.mp3`);
  const ogg = mp3.replace('.mp3', '.ogg');
  const py  = path.join(TMP_DIR, `gen_${Date.now()}.py`);

  try {
    const safeText = text.replace(/"/g, "'").replace(/\n/g, ' ');

    fs.writeFileSync(py,
      `from gtts import gTTS\nimport sys\n` +
      `gTTS(text=sys.argv[1], lang='en', tld='com.ng', slow=False).save(sys.argv[2])\n`
    );

    await execAsync(`python3 "${py}" "${safeText}" "${mp3}"`, { timeout: 20000 });
    if (!fs.existsSync(mp3)) return null;

    // Convert to OGG Opus for WhatsApp voice note
    try {
      await execAsync(
        `ffmpeg -i "${mp3}" -c:a libopus -b:a 24k "${ogg}" -y`,
        { timeout: 15000 }
      );
      if (fs.existsSync(ogg)) return fs.readFileSync(ogg);
    } catch {
      // ffmpeg not available — MP3 works as WhatsApp audio fallback
      console.warn('[VOICE] ffmpeg missing — sending MP3. Add ffmpeg to Render for OGG.');
    }

    return fs.existsSync(mp3) ? fs.readFileSync(mp3) : null;

  } catch(err) {
    console.error('[GTTS ERROR]', err.message);
    return null;
  } finally {
    [mp3, ogg, py].forEach(f => {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
}

// ── ElevenLabs (your real voice — activates when env vars are set) ─
async function elevenLabsTTS(text) {
  const tmpFile = path.join(TMP_DIR, `eleven_${Date.now()}.mp3`);
  const safeText = text.replace(/'/g, "\\'").replace(/"/g, '\\"');

  try {
    await execAsync(
      `curl -s -X POST "https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}" \
       -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
       -H "Content-Type: application/json" \
       -d '{"text":"${safeText}","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.5,"similarity_boost":0.85}}' \
       -o "${tmpFile}"`,
      { timeout: 30000 }
    );

    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size < 1000) return null;
    return fs.readFileSync(tmpFile);

  } catch(err) {
    console.error('[ELEVEN ERROR]', err.message);
    return null;
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
}

module.exports = { isVoiceNote, transcribeVoiceNote, textToVoice };
