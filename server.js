import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ dest: '/tmp/', limits: { fileSize: 10 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DK = 'sk-a12413807af2448d8b6fb2a46061d9ea';
const GK = 'AIzaSyAmIwGc8pVab3OHHSgp3uTyBHQ6Fpj3bIE';

async function stt(audioPath, mimeType) {
  const buf = fs.readFileSync(audioPath);
  const b64 = buf.toString('base64');
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GK}`,
    {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: 'Transcribe this audio exactly. Output ONLY the transcribed text. Detect language (Cantonese, Mandarin, English).' },
          { inline_data: { mime_type: mimeType || 'audio/webm', data: b64 } }
        ]}],
        generationConfig: { maxOutputTokens: 200, temperature: 0 }
      })
    }
  );
  if (!res.ok) throw new Error(`STT ${res.status}`);
  const d = await res.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
}

async function detectProfile(text) {
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DK}` },
    body: JSON.stringify({
      model: 'deepseek-chat', max_tokens: 30, temperature: 0,
      messages: [{ role: 'user', content: `Analyze language and gender from: "${text}". Return ONLY JSON: {"lang":"cantonese|mandarin|english","gender":"male|female|unknown"}` }]
    })
  });
  const d = await res.json();
  try { return JSON.parse(d.choices[0].message.content); }
  catch { return { lang: 'mandarin', gender: 'unknown' }; }
}

async function chat(text, history, profile) {
  const langMap = { cantonese: '繁体粤语口语', mandarin: '简体中文', english: 'English' };
  const voiceHint = profile.gender === 'male' ? '用户是男性，用女声口吻回复' : profile.gender === 'female' ? '用户是女性，用男声口吻回复' : '用自然口吻';

  const sys = `你是"照了么"AI数字镜像。规则：
1. 必须用${langMap[profile.lang] || '简体中文'}回复
2. ${voiceHint}
3. 最多4句，口语化，像朋友聊天
4. 根据情绪给实质建议或安慰`;

  const msgs = [
    { role: 'system', content: sys },
    ...history.slice(-8),
    { role: 'user', content: text }
  ];

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DK}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: msgs, max_tokens: 200, temperature: 0.75 })
  });

  if (!res.ok) throw new Error(`Chat ${res.status}`);
  const d = await res.json();
  return d.choices[0].message.content;
}

// Text-only endpoint (browser SpeechRecognition already did STT)
app.post('/api/talk-text', async (req, res) => {
  try {
    const { text, history } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: 'No text' });

    const profile = await detectProfile(text);
    const reply = await chat(text, history || [], profile);

    res.json({ userText: text, lang: profile.lang, gender: profile.gender, reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/talk', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio' });

    const history = req.body.history ? JSON.parse(req.body.history) : [];

    const transcript = await stt(req.file.path, req.file.mimetype);
    try { fs.unlinkSync(req.file.path); } catch (_) {}

    if (!transcript || transcript.length < 1) {
      return res.json({ userText: '', reply: '', error: 'no_speech' });
    }

    const profile = await detectProfile(transcript);
    const reply = await chat(transcript, history, profile);

    res.json({ userText: transcript, lang: profile.lang, gender: profile.gender, reply });
  } catch (e) {
    console.error(e);
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Mirror Talk on :${PORT}`));
