// ==============================================================
// /api/pdf - サーバーサイドPDF生成
// Cloudflare Browser Rendering API を使用
// ==============================================================
//
// 必要な設定:
// 1. Cloudflare Workers Paid Plan ($5/月)
// 2. Pages Functions の "Bindings" で "Browser Rendering" を有効化
//    wrangler.toml または Cloudflare Dashboard > Pages > Settings > Bindings
//    [[browser]] binding = "MYBROWSER"
//
// 呼び出し方:
// GET  /api/pdf?token=XXXX  → docShares から取得して PDF化
// POST /api/pdf             → ボディのHTMLを直接PDF化（開発用）
// ==============================================================

// CORS許可オリジン
const ALLOWED_ORIGINS = [
  'https://benriya-system.pages.dev',
  'https://anojimairori-blip.github.io',
  'http://localhost:8080',
  'http://localhost:8787',
  'http://localhost:5173',
  'http://127.0.0.1:8080'
];

const RATE_LIMIT_PER_MINUTE = 10; // 1分あたりのPDF生成上限
const rateLimitMap = new Map();

function isAllowedOrigin(origin){
  if(!origin) return false;
  return ALLOWED_ORIGINS.some(a => origin === a || origin.endsWith('.pages.dev'));
}

function getCorsHeaders(origin){
  const allowed = isAllowedOrigin(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : 'https://benriya-system.pages.dev',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
  };
}

function checkRateLimit(clientId){
  const now = Date.now();
  const windowStart = now - 60000;
  const history = (rateLimitMap.get(clientId) || []).filter(t => t > windowStart);
  if(history.length >= RATE_LIMIT_PER_MINUTE){
    return false;
  }
  history.push(now);
  rateLimitMap.set(clientId, history);
  // メモリ節約: 古いエントリを削除
  if(rateLimitMap.size > 1000){
    const keys = Array.from(rateLimitMap.keys()).slice(0, 500);
    keys.forEach(k => rateLimitMap.delete(k));
  }
  return true;
}

export async function onRequestOptions({ request }){
  const origin = request.headers.get('Origin');
  return new Response(null, {
    status: 204,
    headers: getCorsHeaders(origin)
  });
}

export async function onRequestGet(context){
  const { request, env } = context;
  const origin = request.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  try{
    const url = new URL(request.url);
    const token = url.searchParams.get('token');
    if(!token || !/^[a-f0-9]{32}$/.test(token)){
      return new Response(JSON.stringify({ error: 'invalid token' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // レート制限
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
    if(!checkRateLimit(clientIp)){
      return new Response(JSON.stringify({ error: 'rate limit exceeded' }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // Browser Rendering が有効かチェック
    if(!env.MYBROWSER){
      return new Response(JSON.stringify({
        error: 'Browser Rendering is not configured',
        detail: 'Cloudflare Dashboard > Pages > Settings > Functions > Bindings で Browser Rendering を有効化してください'
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // 共有URLを組み立てて、Browser Renderingに読み込ませる
    // (公開ページを直接PDF化することで HTML を個別構築する手間を省く)
    const siteUrl = url.origin + '/#docshare=' + token + '&pdf=1';

    // Puppeteer起動
    const puppeteer = await import('@cloudflare/puppeteer');
    const browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();

    // 日本語フォント用の設定
    await page.setViewport({ width: 800, height: 1130, deviceScaleFactor: 2 });

    // 公開ポータルページを読み込む
    await page.goto(siteUrl, { waitUntil: 'networkidle0', timeout: 30000 });

    // PDF用のクラスを追加してレイアウト切替
    await page.evaluate(() => {
      document.body.classList.add('pdf-mode');
      // アクションバーを非表示
      const bars = document.querySelectorAll('.action-bar, .expiry-banner, .footer-credit');
      bars.forEach(b => b.style.display = 'none');
    });

    // PDF生成（A4縦）
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
      preferCSSPageSize: false
    });

    await browser.close();

    const filename = `document_${token.slice(0,8)}.pdf`;
    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'public, max-age=3600'
      }
    });

  }catch(e){
    console.error('[PDF API Error]', e);
    return new Response(JSON.stringify({
      error: 'PDF generation failed',
      detail: e.message
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// 開発/テスト用: HTMLを直接POSTで受けてPDF化
export async function onRequestPost(context){
  const { request, env } = context;
  const origin = request.headers.get('Origin');
  const corsHeaders = getCorsHeaders(origin);

  try{
    if(!env.MYBROWSER){
      return new Response(JSON.stringify({ error: 'Browser Rendering not configured' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { html, filename } = await request.json();
    if(!html || typeof html !== 'string' || html.length > 500000){
      return new Response(JSON.stringify({ error: 'invalid html' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const puppeteer = await import('@cloudflare/puppeteer');
    const browser = await puppeteer.launch(env.MYBROWSER);
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' }
    });
    await browser.close();

    return new Response(pdfBuffer, {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename || 'document.pdf'}"`
      }
    });
  }catch(e){
    return new Response(JSON.stringify({ error: 'PDF generation failed', detail: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}
