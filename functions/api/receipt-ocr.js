// Cloudflare Pages Function: /api/receipt-ocr v2
// セキュリティ: サイズ上限・MIME検証・レート制限・CORS制限

const ALLOWED_ORIGINS = [
  'https://benriya-system.pages.dev',
  'https://anojimairori-blip.github.io',
  'http://localhost:8080',
  'http://localhost:3000'
];

const RATE_LIMIT_PER_MINUTE = 10;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_SIZE_BYTES * 4 / 3);

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];

function detectImageType(base64) {
  try {
    const binary = atob(base64.slice(0, 32));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return 'image/jpeg';
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
    return null;
  } catch (e) { return null; }
}

function getCorsHeaders(origin) {
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json',
    'Vary': 'Origin'
  };
}

const rateLimitMap = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const key = `${ip}:${minute}`;
  for (const [k] of rateLimitMap) {
    const m = parseInt(k.split(':').pop());
    if (m < minute - 1) rateLimitMap.delete(k);
  }
  const count = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);
  return count <= RATE_LIMIT_PER_MINUTE;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin') || '';
  const corsHeaders = getCorsHeaders(origin);

  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return new Response(JSON.stringify({ error: 'このドメインからのアクセスは許可されていません' }),
      { status: 403, headers: corsHeaders });
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return new Response(JSON.stringify({
      error: `リクエストが多すぎます。1分あたり${RATE_LIMIT_PER_MINUTE}回までです。少し待ってから再度お試しください。`
    }), { status: 429, headers: corsHeaders });
  }

  try {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'APIキーが設定されていません' }),
        { status: 500, headers: corsHeaders });
    }

    const contentLength = parseInt(request.headers.get('Content-Length') || '0');
    if (contentLength > MAX_BASE64_LENGTH + 1024) {
      return new Response(JSON.stringify({
        error: `リクエストサイズが大きすぎます（最大${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB）`
      }), { status: 413, headers: corsHeaders });
    }

    let body;
    try { body = await request.json(); }
    catch (e) {
      return new Response(JSON.stringify({ error: '不正なリクエスト形式です' }),
        { status: 400, headers: corsHeaders });
    }

    const imageData = body.image;
    let mediaType = body.mediaType || 'image/jpeg';

    if (!imageData || typeof imageData !== 'string') {
      return new Response(JSON.stringify({ error: '画像データがありません' }),
        { status: 400, headers: corsHeaders });
    }

    if (imageData.length > MAX_BASE64_LENGTH) {
      return new Response(JSON.stringify({
        error: `画像サイズが大きすぎます（最大${MAX_IMAGE_SIZE_BYTES / 1024 / 1024}MB）`
      }), { status: 413, headers: corsHeaders });
    }

    if (!/^[A-Za-z0-9+/]+=*$/.test(imageData)) {
      return new Response(JSON.stringify({ error: '不正な画像形式です' }),
        { status: 400, headers: corsHeaders });
    }

    const detectedType = detectImageType(imageData);
    if (!detectedType) {
      return new Response(JSON.stringify({
        error: '対応していない画像形式です（JPEG/PNG/WebP/GIFのみ対応）'
      }), { status: 400, headers: corsHeaders });
    }
    mediaType = detectedType;

    if (!ALLOWED_MIME_TYPES.includes(mediaType)) {
      return new Response(JSON.stringify({ error: '対応していない画像形式です' }),
        { status: 400, headers: corsHeaders });
    }

    const claudeResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageData } },
            { type: 'text', text: `この日本語のレシート/領収書を読み取って、以下のJSON形式のみで返してください（説明文不要、JSONのみ）：

{
  "date": "YYYY-MM-DD形式の日付",
  "vendor": "店舗名・発行者名",
  "amount_total": 税込合計金額（数値のみ、¥や,なし）,
  "amount_pretax": 税抜金額（数値、わからなければtotalと同じ）,
  "tax_amount": 消費税額（数値、わからなければ0）,
  "tax_rate": "10" または "8" または "0",
  "category": "以下から最も近いものを1つ選択：交通費/通信費/消耗品費/工具・備品/燃料費/広告宣伝費/接待交際費/その他",
  "payment_method": "現金/クレジットカード/銀行振込/電子マネー/その他のいずれか",
  "memo": "品目や用途の概要（30文字以内）"
}

読み取れない項目は空文字 "" または 0 にしてください。
日付が不明な場合は今日の日付を使ってください。
JSONのみを返してください。マークダウンのコードブロック（\`\`\`）は不要です。` }
          ]
        }]
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      return new Response(JSON.stringify({ error: 'Claude API エラー: ' + errText.slice(0, 200) }),
        { status: 500, headers: corsHeaders });
    }

    const claudeData = await claudeResponse.json();
    const responseText = claudeData.content?.[0]?.text || '';

    let parsedData;
    try {
      const cleanText = responseText.replace(/```json\s*|\s*```/g, '').trim();
      parsedData = JSON.parse(cleanText);
    } catch (e) {
      return new Response(JSON.stringify({ error: 'JSON解析失敗', raw: responseText.slice(0, 500) }),
        { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, data: parsedData, usage: claudeData.usage }),
      { status: 200, headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({ error: 'サーバーエラーが発生しました' }),
      { status: 500, headers: corsHeaders });
  }
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: getCorsHeaders(origin) });
}
