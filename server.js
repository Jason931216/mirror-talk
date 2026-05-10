import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DK = 'sk-a12413807af2448d8b6fb2a46061d9ea';

function detectLang(text) {
  // Simplified Chinese characters → Mandarin
  // Traditional Chinese characters → Cantonese/Traditional Mandarin
  // Check for common simplified chars
  const simplified = /[为什么没这们过开时个会后来对动学现经发长样关当点体进说里种面去为机从]/.test(text);
  const traditional = /[為什麼沒這們過開時個會後來對動學現經發長樣關當點體進說裡種麵去為機從臺粵嘅咗唔佢]/.test(text);
  if (simplified && !traditional) return 'mandarin';
  if (traditional && !simplified) return 'cantonese';
  return 'mandarin'; // default
}

async function detectProfile(text) {
  const lang = detectLang(text);
  // Only call LLM for gender detection now, language is detected client-side
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${DK}` },
    body: JSON.stringify({
      model: 'deepseek-chat', max_tokens: 20, temperature: 0,
      messages: [{ role: 'user', content: `From this Chinese text, what is the likely gender? Reply ONLY one word: male, female, or unknown. Text: "${text.substring(0,100)}"` }]
    })
  });
  const d = await res.json();
  let gender = 'unknown';
  try {
    const g = d.choices[0].message.content.toLowerCase();
    if (g.includes('male')) gender = 'male';
    else if (g.includes('female')) gender = 'female';
  } catch(e) {}
  return { lang, gender };
}

async function chat(text, history, profile) {
  const langMap = { cantonese: '繁体粤语口语', mandarin: '简体中文', english: 'English' };
  const voiceHint = profile.gender === 'male' ? '用户是男性，用女声口吻回复' : profile.gender === 'female' ? '用户是女性，用男声口吻回复' : '用自然口吻';

  const isCantonese = profile.lang === 'cantonese';
  const isMale = profile.gender === 'male';
  const isFemale = profile.gender === 'female';

  const sys = isCantonese
    ? `你是照了么的AI镜中人。用户正对镜同你倾偈。你必须用繁体粤语口语回复。最多3-4句。${isMale?'用户系男仔，你用女声口吻回复。':isFemale?'用户系女仔，你用男声口吻回复。':'语气自然亲切。'}好似面对面倾偈咁。`
    : `你是"照了么"的AI镜中人，用户正在对着镜子和你聊天。你必须用简体中文普通话回复。最多3-4句，口语化。${isMale?'用户是男性，用女性口吻回复。':isFemale?'用户是女性，用男性口吻回复。':'语气自然亲切。'}像面对面聊天一样。`;

  const msgs = [
    { role: 'system', content: sys },
    ...history.slice(-4),
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

// Main endpoint — browser SpeechRecognition does STT, server only does lang/gender detect + DeepSeek reply
app.post('/api/talk', async (req, res) => {
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

app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Mirror Talk on :${PORT}`));
