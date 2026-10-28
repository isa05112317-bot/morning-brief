// 投資晨報 Worker：證交所資料代理 + AI 摘要轉接（金鑰存在 Cloudflare Secrets）
const TWSE = 'https://openapi.twse.com.tw/v1/';
const SYS = `你是投資研究助理。只能根據使用者提供的 JSON 資料回答，不得用外部知識補充任何數字、新聞或公告。
規則：
1. 分兩段：「【事實】」只重述資料中已有的內容；「【推論與待確認】」是你的推論，並明確標示為推論。
2. 不保證報酬，不使用「必買」「必賣」等語氣，不給買賣指令。
3. 資料不足時直接寫「資料不足，無法判斷」，不要湊字數。
4. 不要自行計算精確數值，只引用資料中已有的數字。
5. 使用繁體中文，簡潔。`;

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allow = env.ALLOWED_ORIGIN || '*';
    const cors = {
      'Access-Control-Allow-Origin': allow === '*' ? '*' : allow,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    const url = new URL(req.url);

    // 1) 證交所資料代理（只允許固定格式的路徑）
    if (url.pathname.startsWith('/twse/')) {
      const path = url.pathname.slice(6);
      if (!/^(exchangeReport|opendata)\/[A-Za-z0-9_]+$/.test(path)) return json({ error: 'path not allowed' }, 400);
      const r = await fetch(TWSE + path, { cf: { cacheTtl: 300, cacheEverything: true } });
      return new Response(r.body, { status: r.status, headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' } });
    }

    // 2) AI 摘要轉接
    if (url.pathname === '/ai' && req.method === 'POST') {
      if (allow !== '*' && origin !== allow) return json({ error: 'origin not allowed' }, 403);
      if (!env.GEMINI_API_KEY) return json({ error: '尚未設定 GEMINI_API_KEY' }, 503);
      const raw = await req.text();
      if (raw.length > 20000) return json({ error: '資料過大' }, 413);
      let facts; try { facts = JSON.parse(raw).facts; } catch { return json({ error: '格式錯誤' }, 400); }
      const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYS }] },
            contents: [{ role: 'user', parts: [{ text: '資料：\n' + JSON.stringify(facts) }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
          }),
        });
        const j = await r.json();
        if (!r.ok) return json({ error: j.error?.message || 'AI 服務錯誤 ' + r.status }, 502);
        const text = j.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
        return text ? json({ text }) : json({ error: 'AI 沒有回傳內容' }, 502);
      } catch (e) { return json({ error: e.message }, 502); }
    }
    return json({ ok: true, routes: ['/twse/<path>', 'POST /ai'] });
  },
};
