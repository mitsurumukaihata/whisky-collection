// whisky-worker.js — multi-alcohol scan対応版
// 2026/4/25 全酒類対応：カテゴリ自動判定 + カテゴリ別フィールド
//
// 【デプロイ方法】
//   wrangler deploy worker/whisky-worker.js  または
//   Cloudflare Dashboard → Workers & Pages → whisky-proxy → Edit code → 全文置換 → Deploy

export default {
  async fetch(request, env) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const url = new URL(request.url);

    // ── /upload ─ 画像をR2に保存 ──────────────────────────────
    // prefix:"studio" を渡すと studio_ で始まるキーになる（PHOTO STUDIOの保存済み一覧用）
    if (url.pathname === "/upload" && request.method === "POST") {
      try {
        const { image, mediaType, prefix, name } = await request.json();
        if (!image) return j({ error: "image is required" }, 400, cors);
        const binary = Uint8Array.from(atob(image), c => c.charCodeAt(0));
        const ext = (mediaType || "image/jpeg").split("/")[1] || "jpg";
        const pfx = prefix === "studio" ? "studio_" : "whisky_";
        const filename = `${pfx}${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
        await env.IMAGES.put(filename, binary, {
          httpMetadata: { contentType: mediaType || "image/jpeg" },
          // R2のcustomMetadataはHTTPヘッダ相当でASCIIしか安全に通らない。日本語は必ずエンコードして入れる
          customMetadata: name ? { name: encodeURIComponent(String(name).slice(0, 120)) } : undefined
        });
        return j({ url: `${url.origin}/images/${filename}`, key: filename }, 200, cors);
      } catch (e) { return j({ error: e.message }, 500, cors); }
    }

    // ── /studio/list ─ PHOTO STUDIO の保存済み一覧 ─────────────
    if (url.pathname === "/studio/list" && request.method === "GET") {
      try {
        const listed = await env.IMAGES.list({ prefix: "studio_", limit: 300, include: ["customMetadata"] });
        const items = listed.objects.map(o => ({
          key: o.key,
          size: o.size,
          uploaded: o.uploaded,
          name: safeDecode(o.customMetadata?.name),
          url: `${url.origin}/images/${o.key}`
        }));
        items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
        return j({ items, truncated: listed.truncated === true }, 200, cors);
      } catch (e) { return j({ error: e.message }, 500, cors); }
    }

    // ── /studio/captions ─ 投稿本文（ボトル番号 → 本文）────────
    // 本文はメタデータに入れるには長すぎるので、R2に1個のJSONとして置く
    if (url.pathname === "/studio/captions" && request.method === "GET") {
      try {
        const obj = await env.IMAGES.get("studio_captions.json");
        if (!obj) return j({ captions: {} }, 200, cors);
        const text = await obj.text();
        return j({ captions: JSON.parse(text) }, 200, cors);
      } catch (e) { return j({ captions: {}, error: e.message }, 200, cors); }
    }
    if (url.pathname === "/studio/captions" && request.method === "POST") {
      try {
        const body = await request.json();
        const captions = body && body.captions;
        if (!captions || typeof captions !== "object") return j({ error: "captions is required" }, 400, cors);
        const merge = body.merge === true;
        let next = captions;
        if (merge) {
          const cur = await env.IMAGES.get("studio_captions.json");
          const prev = cur ? JSON.parse(await cur.text()) : {};
          next = { ...prev, ...captions };
        }
        await env.IMAGES.put("studio_captions.json", JSON.stringify(next), {
          httpMetadata: { contentType: "application/json; charset=utf-8" }
        });
        return j({ ok: true, count: Object.keys(next).length }, 200, cors);
      } catch (e) { return j({ error: e.message }, 500, cors); }
    }

    // ── /studio/delete ─ 保存済みを1件削除 ─────────────────────
    if (url.pathname === "/studio/delete" && request.method === "POST") {
      try {
        const { key } = await request.json();
        // studio_ 以外は消させない（旧ウイスキー記録の画像を巻き込まないため）
        if (!key || typeof key !== "string" || !key.startsWith("studio_")) {
          return j({ error: "studio_ で始まるキーのみ削除できます" }, 400, cors);
        }
        await env.IMAGES.delete(key);
        return j({ ok: true, key }, 200, cors);
      } catch (e) { return j({ error: e.message }, 500, cors); }
    }

    // ── /images/{filename} ─ R2から配信 ───────────────────────
    if (url.pathname.startsWith("/images/") && request.method === "GET") {
      try {
        const filename = url.pathname.replace("/images/", "");
        const obj = await env.IMAGES.get(filename);
        if (!obj) return new Response("Not found", { status: 404, headers: cors });
        const data = await obj.arrayBuffer();
        return new Response(data, {
          headers: {
            ...cors,
            "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
            "Cache-Control": "public, max-age=31536000"
          }
        });
      } catch (e) { return j({ error: e.message }, 500, cors); }
    }

    // ── /scan ─ ラベル画像から情報抽出（全酒類対応） ──────────────
    if (url.pathname === "/scan" && request.method === "POST") {
      try {
        const { image, imageBack, mediaType, mediaTypeBack } = await request.json();
        if (!image) return j({ error: "image is required" }, 400, cors);

        const content = [
          { type: "image", source: { type: "base64", media_type: mediaType || "image/jpeg", data: image } }
        ];
        if (imageBack) {
          content.push({ type: "image", source: { type: "base64", media_type: mediaTypeBack || "image/jpeg", data: imageBack } });
        }
        content.push({ type: "text", text: SCAN_PROMPT(!!imageBack) });

        const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1500,
            messages: [{ role: "user", content }]
          })
        });
        if (!claudeRes.ok) {
          const errText = await claudeRes.text();
          return j({ error: "Claude API error: " + errText }, 500, cors);
        }
        const claudeData = await claudeRes.json();
        const text = claudeData.content?.[0]?.text;
        if (!text) return j({ error: "Claude response error" }, 500, cors);
        let parsed = {};
        try {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) parsed = JSON.parse(match[0]);
        } catch (e) { parsed = { error: "JSON parse error", raw: text }; }
        return j(parsed, 200, cors);
      } catch (e) { return j({ error: e.message }, 500, cors); }
    }

    // ── デフォルト ─ Notion APIへプロキシ ──────────────────────
    const notionUrl = "https://api.notion.com/v1" + url.pathname + url.search;
    const body = ["POST", "PATCH", "PUT"].includes(request.method) ? await request.text() : undefined;
    try {
      const res = await fetch(notionUrl, {
        method: request.method,
        headers: {
          Authorization: "Bearer " + env.NOTION_TOKEN,
          "Content-Type": "application/json",
          "Notion-Version": "2022-06-28"
        },
        body
      });
      const text = await res.text();
      return new Response(text, {
        status: res.status,
        headers: { ...cors, "Content-Type": "application/json" }
      });
    } catch (e) { return j({ error: e.message }, 500, cors); }
  }
};

// customMetadata は encodeURIComponent して入れている。旧データや壊れた値でも落ちないように
function safeDecode(v) {
  if (!v) return "";
  try { return decodeURIComponent(v); } catch (e) { return v; }
}

function j(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, "Content-Type": "application/json" }
  });
}

// ─────────────────────────────────────────────────────────────
// スキャン用プロンプト — 多酒類対応
// ─────────────────────────────────────────────────────────────
function SCAN_PROMPT(hasBack) {
  return `${hasBack ? "1枚目が表ラベル、2枚目が裏ラベルです。両方を参照して" : "このボトルのラベルから"}情報を読み取り、以下のJSON形式のみで返してください。不明な情報はnullにしてください。

まずカテゴリを判定してください。カテゴリは次のいずれか:
ウイスキー / 日本酒 / 焼酎 / ワイン / ビール / ジン / ウォッカ / ラム / テキーラ / リキュール / カクテル / その他

{
  "category": "上のいずれかのカテゴリ",
  "name": "銘柄名（日本語表記優先）",
  "distillery": "蒸留所/酒蔵/ワイナリー/ブルワリー名",
  "region": "国・地域（スコットランド/日本/アイルランド/アメリカ/カナダ/フランス/イタリア/ドイツ/その他 のいずれか。ウイスキー以外でも適用）",
  "type": "そのカテゴリにおけるタイプ（下記参照）",
  "age": 熟成年数の数字またはnull,
  "abv": アルコール度数の数字またはnull,
  "aroma": ["香りの特徴を複数選択（カテゴリに応じて適切なものを選ぶ）"],
  "taste": ["味の特徴を複数選択"],
  "finish": ["フィニッシュ/余韻の特徴を複数選択"]
}

【typeの選択肢（カテゴリ別）】
- ウイスキー: シングルモルト / ブレンデッド / シングルグレーン / バーボン / ライウイスキー / その他
- 日本酒: 純米大吟醸 / 純米吟醸 / 純米 / 大吟醸 / 吟醸 / 本醸造 / 普通酒 / その他
- 焼酎: 芋 / 麦 / 米 / 黒糖 / 蕎麦 / 泡盛 / その他
- ワイン: 赤 / 白 / ロゼ / スパークリング / 甘口/デザート / その他
- ビール: ラガー / ピルスナー / IPA / ペールエール / スタウト / ヴァイツェン / その他
- ジン: ロンドンドライ / オールドトム / プリマス / クラフト / その他
- ウォッカ / ラム / テキーラ / リキュール / カクテル / その他: その他のカテゴリは「その他」

【香り(aroma)の選択肢】
フローラル / フルーティ / バニラ / キャラメル / ハチミツ / スモーキー / ピーティ / スパイシー / シェリー / オーク / ナッツ / チョコレート / シトラス / ハーブ / 海塩 / 麦芽 / 米 / 麹 / ホップ / 樽香 / ベリー / トロピカル

【味(taste)の選択肢】
甘口 / 辛口 / まろやか / リッチ / ライト / フルーティ / スモーキー / スパイシー / バニラ / キャラメル / ドライフルーツ / ナッツ / チョコレート / シトラス / ミネラル / オーキー / 苦味 / 酸味 / 旨味 / コク

【フィニッシュ(finish)の選択肢】
長い / 短い / 甘い / スパイシー / スモーキー / ウォーム / ドライ / フルーティ / オーキー / ビター / なめらか / ペッパリー / さっぱり / 余韻深い

ラベルの記載とそのカテゴリの一般的な特徴知識を組み合わせて推定してください。確信がなければ空配列[]にしてください。
JSONのみ返してください。説明文は不要です。`;
}
