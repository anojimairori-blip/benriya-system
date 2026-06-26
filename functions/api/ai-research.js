// Cloudflare Pages Function: /api/ai-research
// AI企業調査プロキシ - Claude API（Web Search）を中継

const ALLOWED_ORIGINS = [
  'https://benriya-system.pages.dev',
  'https://anojimairori-blip.github.io',
  'http://localhost:8080',
  'http://localhost:3000'
];

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
}

export async function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  const headers = corsHeaders(origin);

  try {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({ error: 'API key not configured' }), { status: 500, headers });
    }

    const body = await request.json();
    const { name, address, tel } = body;

    if (!name) {
      return new Response(JSON.stringify({ error: '会社名が必要です' }), { status: 400, headers });
    }

    const parts = [];
    if (name) parts.push('会社名: ' + name);
    if (address) parts.push('住所: ' + address);
    if (tel) parts.push('電話: ' + tel);

    const prompt = '以下の会社・顧客についてWebで調査し、JSONのみで回答してください。\n'
      + parts.join(' / ')
      + '\n\n以下のJSON形式で返してください（不明な場合はnull）:\n'
      + '{"url":"公式URL","ceo":"代表者名","employees":"従業員数・規模","description":"事業内容100文字以内","rating":"評価","reputation":"評判要約150文字以内","note":"特記事項"}';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await res.json();

    if (!res.ok) {
      return new Response(JSON.stringify({ error: data.error?.message || 'API error' }), { status: res.status, headers });
    }

    // テキストブロックを抽出
    const textContent = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    const jsonMatch = textContent.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) {
      return new Response(JSON.stringify({ error: '情報を取得できませんでした' }), { status: 200, headers });
    }

    const result = JSON.parse(jsonMatch[0]);
    return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message || 'Unknown error' }), { status: 500, headers });
  }
}
