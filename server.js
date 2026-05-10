import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { readFileSync, unlinkSync, openAsBlob } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DK = process.env.DEEPSEEK_KEY || '';
const GK = process.env.GROQ_KEY || '';
if (!DK || !GK) { console.error('Missing DEEPSEEK_KEY or GROQ_KEY env vars'); process.exit(1); }

// STT via Groq Whisper (native FormData, Node 22)
async function stt(audioPath) {
  const blob = await openAsBlob(audioPath, { type: 'audio/webm' });
  const buf = readFileSync(audioPath); console.log('STT audio size:', buf.length);
  const fd = new FormData();
  fd.append('model', 'whisper-large-v3');
  fd.append('file', blob, 'audio.webm');
  fd.append('language', 'zh');

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GK}` },
    body: fd
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`STT ${res.status}: ${t.substring(0, 100)}`); }
  const d = await res.json();
  return d.text?.trim() || '';
}

function detectLang(text) {
  const simp = /[为什么没这们过开时个会后来对动学现经发长样关当点体进说里种面去为机从]/.test(text);
  const trad = /[為什麼沒這們過開時個會後來對動學現經發長樣關當點體進說裡種麵去為機從臺粵嘅咗唔佢]/.test(text);
  if (simp && !trad) return 'mandarin';
  if (trad && !simp) return 'cantonese';
  return 'mandarin';
}

async function detectGender(text) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DK}` },
    body: JSON.stringify({
      model: 'deepseek-chat', max_tokens: 10, temperature: 0,
      messages: [{ role: 'user', content: `Gender from: "${text.substring(0, 80)}". Reply: male/female/unknown only.` }]
    })
  });
  const d = await res.json();
  const g = (d.choices?.[0]?.message?.content || '').toLowerCase();
  if (g.includes('female')) return 'female';
  if (g.includes('male')) return 'male';
  return 'unknown';
}

async function chat(text, history, lang) {
  const isCant = lang === 'cantonese';
  const sys = isCant
    ? '你是照了么的AI镜中人。用户正对镜同你倾偈。用繁体粤语口语回复。用户系男仔，用女声口吻。最多3-4句，好似面对面倾偈。'
    : '你是"照了么"AI镜中人，用户对着镜子和你聊天。用简体中文普通话回复。用户是男性，用女性口吻。最多3-4句，像面对面聊天。';

  const msgs = [{ role: 'system', content: sys }, ...history.slice(-4), { role: 'user', content: text }];

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DK}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: msgs, max_tokens: 180, temperature: 0.75 })
  });

  if (!res.ok) throw new Error(`Chat ${res.status}`);
  const d = await res.json();
  return d.choices[0].message.content;
}

// Edge TTS (free, natural Chinese voice)
const EDGE = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4';
async function tts(text, voiceName) {
  const voice = voiceName === 'male' ? 'zh-CN-YunxiNeural' : 'zh-CN-XiaoxiaoNeural';
  const ssml = `<speak xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" version="1.0" xml:lang="zh-CN"><voice name="${voice}"><prosody rate="1.25" pitch="${voiceName==='male'?'-5%':'+5%'}">${text}</prosody></voice></speak>`;
  const res = await fetch(EDGE, { method:'POST', headers:{'Content-Type':'application/xml'}, body:ssml });
  if (!res.ok) return '';
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

app.post('/api/talk', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio' });
    const history = req.body.history ? JSON.parse(req.body.history) : [];

    const transcript = await stt(req.file.path);
    try { unlinkSync(req.file.path); } catch (_) {}

    if (!transcript || transcript.length < 1) {
      return res.json({ userText: '', reply: '', error: 'no_speech' });
    }

    const lang = detectLang(transcript);
    const reply = await chat(transcript, history, lang);
    const voiceGender = req.body.voice || 'female';
    const audio = await tts(reply, voiceGender);

    res.json({ userText: transcript, lang, gender: 'male', reply, audio });
  } catch (e) {
    console.error(e);
    try { if (req.file) unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Mirror Talk on :${PORT}`));
