// Cloudflare Pages Function: /api/receipt-ocr
// レシート画像をClaude APIに送って構造化データを返す

export async function onRequestPost(context) {
  const { request, env } = context;

  // CORS対応
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    // 環境変数からAPIキー取得
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(JSON.stringify({
        error: 'APIキーが設定されていません'
      }), { status: 500, headers: corsHeaders });
    }

    // リクエストボディから画像データ（base64）を取得
    const body = await request.json();
    const imageData = body.image;
    const mediaType = body.mediaType || 'image/jpeg';

    if (!imageData) {
      return new Response(JSON.stringify({
        error: '画像データがありません'
      }), { status: 400, headers: corsHeaders });
    }

    // Claude APIへのリクエスト
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
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageData
              }
            },
            {
              type: 'text',
              text: `この日本語のレシート/領収書を読み取って、以下のJSON形式のみで返してください（説明文不要、JSONのみ）：

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
JSONのみを返してください。マークダウンのコードブロック（\`\`\`）は不要です。`
            }
          ]
        }]
      })
    });

    if (!claudeResponse.ok) {
      const errText = await claudeResponse.text();
      return new Response(JSON.stringify({
        error: 'Claude API エラー: ' + errText.slice(0, 200)
      }), { status: 500, headers: corsHeaders });
    }

    const claudeData = await claudeResponse.json();
    const responseText = claudeData.content?.[0]?.text || '';

    // JSON部分を抽出
    let parsedData;
    try {
      // ```json ... ``` を除去
      const cleanText = responseText.replace(/```json\s*|\s*```/g, '').trim();
      parsedData = JSON.parse(cleanText);
    } catch (e) {
      return new Response(JSON.stringify({
        error: 'JSON解析失敗',
        raw: responseText
      }), { status: 500, headers: corsHeaders });
    }

    return new Response(JSON.stringify({
      success: true,
      data: parsedData,
      usage: claudeData.usage
    }), { status: 200, headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({
      error: 'サーバーエラー: ' + e.message
    }), { status: 500, headers: corsHeaders });
  }
}

// OPTIONSリクエスト（CORSプリフライト）
export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
