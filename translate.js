// Cloudflare Pages Function: /api/translate
// Claude APIを使った書類翻訳エンドポイント
// セキュリティ: CORS制限・レート制限・入力サイズ上限

const ALLOWED_ORIGINS = [
  'https://benriya-system.pages.dev',
  'https://anojimairori-blip.github.io',
  'http://localhost:8080',
  'http://localhost:3000'
];

const RATE_LIMIT_PER_MINUTE = 30;
const MAX_TEXT_LENGTH = 5000;

function getCorsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - 60000;
  const requests = (rateLimitMap.get(ip) || []).filter(t => t > windowStart);
  if (requests.length >= RATE_LIMIT_PER_MINUTE) return false;
  requests.push(now);
  rateLimitMap.set(ip, requests);
  // 古いエントリを掃除
  if (rateLimitMap.size > 10000) {
    for (const [k, v] of rateLimitMap.entries()) {
      if (!v.some(t => t > windowStart)) rateLimitMap.delete(k);
    }
  }
  return true;
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const cors = getCorsHeaders(origin);

  try {
    // Origin チェック
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: 'Forbidden origin' }), {
        status: 403,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // レート制限
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRateLimit(ip)) {
      return new Response(JSON.stringify({ error: 'Rate limit exceeded. Max 30/minute.' }), {
        status: 429,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    // 入力バリデーション
    const body = await request.json();
    const { text, targetLang } = body;
    if (!text || typeof text !== 'string') {
      return new Response(JSON.stringify({ error: 'text is required' }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    if (text.length > MAX_TEXT_LENGTH) {
      return new Response(JSON.stringify({ error: `Text too long (max ${MAX_TEXT_LENGTH} chars)` }), {
        status: 400,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }
    const allowedLangs = ['Japanese', 'English', 'Chinese (Simplified)', 'Vietnamese', 'Korean'];
    const target = allowedLangs.includes(targetLang) ? targetLang : 'English';

    // Claude API 呼び出し
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), {
        status: 500,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const prompt = `Translate the following business document text to ${target}. Keep numbers, dates, and proper nouns as-is. Return ONLY the translated text, no explanations.\n\nText:\n${text}`;

    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      return new Response(JSON.stringify({ error: 'Translation API failed', detail: errText.slice(0, 200) }), {
        status: apiRes.status,
        headers: { ...cors, 'Content-Type': 'application/json' }
      });
    }

    const data = await apiRes.json();
    const translated = data.content?.[0]?.text?.trim() || text;

    return new Response(JSON.stringify({ translated, sourceLang: 'auto', targetLang: target }), {
      status: 200,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'Server error', message: e.message }), {
      status: 500,
      headers: { ...cors, 'Content-Type': 'application/json' }
    });
  }
}
