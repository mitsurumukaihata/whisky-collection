// PHOTO STUDIO（旧 whisky-collection）フロント配信 Worker
//
// GitHub の index.html をそのまま配信する。
// 旧実装はキャッシュが強すぎて git push しても本番に何十分も反映されなかったため、
// サブリクエストのTTLを30秒に固定し、ブラウザ側は毎回再検証させる。
//
// デプロイ: cd worker-site && npx wrangler deploy

const RAW = 'https://raw.githubusercontent.com/mitsurumukaihata/whisky-collection/main/index.html';

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // ヘルスチェック用（配信中の内容の指紋を返す）
    if (url.pathname === '/__version') {
      const r = await fetch(RAW, { cf: { cacheTtl: 0, cacheEverything: false } });
      const t = await r.text();
      return json({
        upstreamStatus: r.status,
        bytes: t.length,
        isPhotoStudio: t.includes('PHOTO STUDIO'),
        hasCanvasRenderer: t.includes('function renderFull'),
        fetchedAt: new Date().toISOString()
      });
    }

    let upstream;
    try {
      upstream = await fetch(RAW, {
        // 30秒だけエッジに置く: push後すぐ反映されつつGitHubを叩きすぎない
        cf: { cacheTtl: 30, cacheEverything: true },
        headers: { 'User-Agent': 'whisky-collection-worker' }
      });
    } catch (e) {
      return new Response('Upstream fetch failed: ' + e.message, { status: 502 });
    }
    if (!upstream.ok) {
      return new Response('Upstream error: ' + upstream.status, { status: 502 });
    }

    const html = await upstream.text();
    return new Response(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // ブラウザ/エッジに毎回確認させる（古い画面が居座るのを防ぐ）
        'Cache-Control': 'no-cache, must-revalidate',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }
};

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}
