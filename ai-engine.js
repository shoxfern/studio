/* =====================================================================
   ai-engine.js — AI 生圖「智慧導演」升級模組
   放在 index.html 同一個資料夾，並在 </body> 前加入：
       <script src="ai-engine.js"></script>
   （必須放在原本兩段 <script> 之後）

   新增能力：
   1. AI 導演：用免費文字模型把中文構想改寫成專業英文提示詞（失敗自動退回本機規則）
   2. 提示詞結構化：主體 → 景別 → 光線 → 配色 → 留白 → 風格 → 品質，全部用「正向描述」
   3. 參考圖配色萃取：自動分析主色與明暗，沿用到新圖
   4. 一次多張時自動變化構圖（標準／低角度／遠景／柔光近景）
   5. 品質檢查：全黑、全白、無內容的圖自動換 seed 重畫（最多 2 次）
   6. 文字留白區：為卡牌標題或內文預留乾淨空間
   7. 提示詞預覽、可編輯、可鎖定；模型可選
   8. 停用自製去浮水印（會傷畫面），安全模式預設開啟
   ===================================================================== */
(() => {
  "use strict";
  const G = globalThis;
  const OPT_KEY = "ai-studio-director-opts-v1";

  const NEG = "blurry, low quality, jpeg artifacts, deformed hands, extra fingers, malformed anatomy, cropped head, text, watermark, logo, signature";
  const ANATOMY = "natural anatomy, well-formed hands, expressive face, complete figure in frame";
  const QUALITY = {
    photo: "sharp focus, realistic textures, natural light falloff, high dynamic range, fine detail",
    traditional: "fine detail, cohesive texture, balanced composition, museum quality",
    illustration: "clean linework, harmonious color palette, polished finish, highly detailed",
    three_d: "smooth materials, studio lighting, crisp details, clean render",
    general: "highly detailed, balanced composition, professional quality"
  };
  const VARIANTS = [
    { label: "標準構圖", add: "" },
    { label: "低角度戲劇", add: "dramatic low-angle perspective, strong sense of depth" },
    { label: "遠景全貌", add: "wide establishing view, subject smaller within a vast environment" },
    { label: "柔光近景", add: "intimate medium framing, soft side light, shallow depth of field" }
  ];
  const LIGHTS = [
    [/夜|night|midnight/i, "moody night lighting with luminous accents"],
    [/雪|snow/i, "soft diffused snowy light"],
    [/黃昏|夕陽|sunset|dusk/i, "golden hour sunset glow"],
    [/陽光|sunlight|sunbeam|雲層|god ?rays/i, "warm golden sunlight with visible light rays"],
    [/霓虹|neon/i, "vivid neon glow with reflections"],
    [/雨|rain/i, "rain-soaked reflective atmosphere"],
    [/霧|fog|mist/i, "soft atmospheric haze"]
  ];
  const SPACE_TEXT = {
    bottom: "composition with the main subject in the upper two thirds and calm uncluttered negative space across the bottom third for text overlay",
    top: "composition with the main subject in the lower two thirds and calm uncluttered negative space across the top third for text overlay"
  };
  const NAMED = [
    ["black", [15, 15, 15]], ["charcoal gray", [70, 70, 70]], ["light gray", [190, 190, 190]], ["white", [245, 245, 245]],
    ["cream", [240, 230, 200]], ["parchment beige", [222, 205, 165]], ["warm brown", [120, 80, 50]], ["dark brown", [60, 40, 25]],
    ["deep forest green", [30, 60, 40]], ["emerald green", [40, 140, 90]], ["olive green", [110, 115, 50]], ["teal", [30, 120, 125]],
    ["sky blue", [110, 170, 220]], ["navy blue", [25, 40, 90]], ["royal purple", [90, 50, 140]], ["rose pink", [220, 130, 160]],
    ["crimson red", [170, 30, 45]], ["burgundy", [110, 25, 40]], ["terracotta orange", [200, 100, 60]],
    ["amber orange", [230, 150, 40]], ["golden yellow", [220, 180, 50]]
  ];

  /* ---------------- 純函式：分析與組裝 ---------------- */
  function styleGroup(style) {
    const s = (style || "").toLowerCase();
    if (!s) return "general";
    if (/cinematic|photoreal|unreal engine|arri/.test(s)) return "photo";
    if (/pop mart|octane|3d/.test(s)) return "three_d";
    if (/anime|manhwa|vector|flat|fantasy|concept art/.test(s)) return "illustration";
    if (/etching|manuscript|ink|pencil|ukiyo|watercolor|oil|painting/.test(s)) return "traditional";
    return "general";
  }

  function analyze(text) {
    const t = text || "";
    const info = {
      person: /人|男|女|孩|使徒|保羅|耶穌|戰士|騎士|少女|老人|公主|國王|\b(man|woman|girl|boy|person|apostle|warrior|knight|king|queen|priest|child|people|crowd|portrait)\b/i.test(t),
      animal: /狗|貓|犬|鳥|馬|魚|龍|獅|熊|兔|柴犬|\b(dog|cat|bird|horse|fish|dragon|lion|bear|rabbit|fox|wolf|animal)\b/i.test(t),
      scene: /背景|風景|場景|街|路|城|店|房|室|山|海|河|森林|公園|學校|舞台|建築|衛城|神廟|羅馬|\b(landscape|city|street|temple|mountain|forest|sea|river|village|castle|room|interior|steps|sky|acropolis)\b/i.test(t),
      product: /產品|商品|瓶|包裝|手機|鞋|杯|\b(product|bottle|packaging|shoe|watch)\b/i.test(t)
    };
    const labels = [];
    if (info.person) labels.push("人物");
    if (info.animal) labels.push("動物");
    if (info.scene) labels.push("場景");
    if (info.product) labels.push("物件");
    info.labels = labels.join("＋") || "一般主題";
    return info;
  }

  function shotFor(info, mode) {
    if (mode && mode !== "auto") return mode.replace(/,?\s*NOT [^,]*/gi, "").trim();
    if (info.person && info.scene) return "wide environmental medium-long shot, full-body figure within a detailed setting, complete background";
    if (info.person) return "medium shot, clear gesture and expression, readable background";
    if (info.animal) return "full-body view of the animal in its natural setting";
    if (info.scene) return "expansive establishing shot with strong depth";
    if (info.product) return "centered hero shot, clean isolated composition";
    return "";
  }

  function lightingFor(text, group) {
    for (const [re, phrase] of LIGHTS) if (re.test(text)) return phrase;
    return group === "photo" ? "cinematic lighting" : "";
  }

  function cleanRaw(raw) {
    let s = (raw || "")
      .replace(/排版(跟|與|和)?(它|他|原圖|圖片)?(一模)?一樣/g, "")
      .replace(/文字(跟|與|和)?(我給的圖|原圖|它|他)?(一模)?一樣/g, "")
      .trim();
    const scene = /背景|風景|場景|街|路|城市|店|房|室|山|海|河|森林|公園|學校|舞台|建築|雅典|衛城|神廟|羅馬|聖經|故事|站|走|跑|跳|坐|宣教|講道|全身|遠景|全景/.test(s);
    const face = /人臉|臉部|五官|表情|眼神|刻劃|仔細|詳細/.test(s);
    if (scene && face) {
      s = s.replace(/人臉的?刻劃幫我做詳細一點[，,、]?/g, "")
        .replace(/人臉|臉部/g, "人物全身衣著與神態表情")
        .replace(/做仔細一點/g, "背景建築環境與人物刻劃細膩豐富");
    }
    return s;
  }

  function truncate(s, max) {
    if (s.length <= max) return s;
    const cut = s.slice(0, max), i = cut.lastIndexOf(", ");
    return i > max * 0.6 ? cut.slice(0, i) : cut;
  }
  const joinParts = parts => parts.map(x => (x || "").trim().replace(/[,，.。\s]+$/, "")).filter(Boolean).join(", ");
  const withVariant = (base, v) => (v && v.add) ? joinParts([base, v.add]) : base;

  async function directorRewrite(text) {
    const sys = "You are an expert prompt engineer for text-to-image models. Rewrite the user's idea into ONE vivid English prompt of at most 60 words describing subject, action, setting, composition, lighting and mood. Keep every concrete element the user mentioned. Do not mention art style or medium. Do not include text, logos or watermarks. Output only the prompt.";
    const url = "https://text.pollinations.ai/" + encodeURIComponent(text) + "?model=openai&private=true&system=" + encodeURIComponent(sys);
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 9000);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      if (!r.ok) return null;
      const s = (await r.text()).trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\s+/g, " ");
      if (s.length < 20 || s.length > 700 || /[<>{}]/.test(s) || /^error/i.test(s) || hasCJK(s)) return null;
      return s;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  /* o = { director, palette, space, style, shotMode, locked, lockedText } */
  async function planPrompt(raw, o) {
    const notes = [];
    if (o.locked && (o.lockedText || "").trim()) {
      return { base: truncate(o.lockedText.trim(), 900), negative: NEG, notes: ["已使用你鎖定的提示詞"] };
    }
    const cleaned = cleanRaw(raw);
    let en = cleaned;
    if (!cleaned) {
      en = "a new artwork inspired by the reference image";
    } else if (hasCJK(cleaned)) {
      let via = "";
      if (o.director) {
        setStatus("🧠 AI 導演正在構思畫面…");
        const d = await directorRewrite(cleaned);
        if (d) { en = d; via = "director"; notes.push("AI 導演已改寫提示詞"); }
      }
      if (!via) {
        setStatus("🌐 翻譯提示詞…");
        const t = await translateText(cleaned, "en");
        if (t && !hasCJK(t)) { en = t; via = "translate"; }
        else notes.push("⚠️ 翻譯服務暫時失效，已直接送出中文（效果較差，建議手動填英文）");
      }
    }

    const group = styleGroup(o.style);
    const info = analyze(cleaned + " " + en);
    const shot = shotFor(info, o.shotMode);
    const light = lightingFor(cleaned + " " + en, group);
    const ref = (typeof Ref !== "undefined") ? Ref : null;
    const pal = (o.palette && ref && ref.blob && ref.palette) ? ref.palette.phrase : "";
    const space = SPACE_TEXT[o.space] || "";

    notes.push(`偵測：${info.labels}${shot ? " → 已套用對應景別" : ""}`);
    if (pal) notes.push("已沿用參考圖配色");
    if (space) notes.push("已預留文字留白區");

    const base = truncate(joinParts([
      en, shot, light, pal, space, o.style, QUALITY[group], info.person ? ANATOMY : ""
    ]), 860);
    return { base, negative: NEG, notes, info, group };
  }

  /* ---------------- 品質檢查 ---------------- */
  function scoreFromStats(mean, std, edge) {
    const ok = std >= 6 && mean >= 8 && mean <= 250;
    const score = Math.round(100 * (Math.min(1, std / 55) * 0.4 + Math.min(1, edge / 9) * 0.4 + (1 - Math.min(1, Math.abs(mean - 128) / 128)) * 0.2));
    return { ok, score };
  }
  async function assessQuality(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const w = 96, h = Math.max(16, Math.round(96 * bmp.height / bmp.width));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      const x = c.getContext("2d", { willReadFrequently: true });
      x.drawImage(bmp, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data, n = w * h, L = new Float32Array(n);
      let sum = 0;
      for (let i = 0; i < n; i++) { L[i] = d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114; sum += L[i]; }
      const mean = sum / n;
      let v = 0; for (let i = 0; i < n; i++) v += (L[i] - mean) ** 2;
      const std = Math.sqrt(v / n);
      let e = 0, ec = 0;
      for (let y = 0; y < h - 1; y++) for (let xx = 0; xx < w - 1; xx++) {
        const i = y * w + xx; e += Math.abs(L[i] - L[i + 1]) + Math.abs(L[i] - L[i + w]); ec += 2;
      }
      return scoreFromStats(mean, std, e / (ec || 1));
    } catch { return { ok: true, score: null }; }
  }

  /* ---------------- 參考圖配色 ---------------- */
  function nearestName(r, g, b) {
    let best = NAMED[0][0], bd = Infinity;
    for (const [name, [nr, ng, nb]] of NAMED) {
      const d = (r - nr) ** 2 + (g - ng) ** 2 + (b - nb) ** 2;
      if (d < bd) { bd = d; best = name; }
    }
    return best;
  }
  const hex = (r, g, b) => "#" + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("");
  async function extractPalette(blob) {
    const bmp = await createImageBitmap(blob);
    const w = 64, h = Math.max(8, Math.round(64 * bmp.height / bmp.width));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(bmp, 0, 0, w, h);
    const d = x.getImageData(0, 0, w, h).data, buckets = new Map();
    let lumSum = 0, cnt = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 200) continue;
      const r = d[i], g = d[i + 1], b = d[i + 2];
      lumSum += r * 0.299 + g * 0.587 + b * 0.114; cnt++;
      const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      let e = buckets.get(k); if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(k, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
    }
    const byName = new Map();
    for (const e of buckets.values()) {
      const nm = nearestName(e.r / e.n, e.g / e.n, e.b / e.n);
      const cur = byName.get(nm) || { n: 0, r: 0, g: 0, b: 0 };
      cur.n += e.n; cur.r += e.r; cur.g += e.g; cur.b += e.b; byName.set(nm, cur);
    }
    const top = [...byName.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 3).filter(([, v]) => v.n / (cnt || 1) >= 0.06);
    const names = top.map(([n]) => n);
    const swatches = top.map(([n, v]) => ({ name: n, hex: hex(v.r / v.n, v.g / v.n, v.b / v.n) }));
    const avg = lumSum / (cnt || 1);
    const mood = avg < 85 ? "dark moody tones" : avg > 175 ? "bright airy tones" : "";
    const phrase = names.length ? joinParts([`harmonious color palette of ${names.join(", ")}`, mood]) : "";
    return { names, swatches, mood, phrase };
  }

  G.AIEngine = { planPrompt, styleGroup, analyze, shotFor, scoreFromStats, cleanRaw, joinParts, withVariant, VARIANTS, NEG };

  /* ---------------- 以下僅在瀏覽器頁面安裝 ---------------- */
  if (typeof document === "undefined" || !document.getElementById("generate")) return;

  const metaMap = new WeakMap();
  function refreshMeta(entry) {
    const el = metaMap.get(entry);
    if (el) el.textContent = `${entry.original || "(參考圖變化)"}${entry.variantLabel ? " · " + entry.variantLabel : ""} · seed ${entry.seed}`;
  }

  function buildPanel() {
    const panel = document.createElement("details");
    panel.className = "fav-drawer"; panel.id = "dirPanel"; panel.open = true;
    panel.innerHTML = `
      <summary><span>🧠 AI 導演面板（更聰明的提示詞與品質檢查）</span><span style="color:var(--muted);font-weight:normal">展開 ▼</span></summary>
      <div style="margin-top:8px">
        <label class="check"><input type="checkbox" id="dirDirector" checked> 🧠 AI 導演：把中文構想改寫成專業英文提示詞</label>
        <label class="check"><input type="checkbox" id="dirVariants" checked> 🎞️ 一次多張時，自動變化構圖</label>
        <label class="check"><input type="checkbox" id="dirQuality" checked> 🔎 品質檢查：全黑／全白／無內容自動重畫</label>
        <label class="check"><input type="checkbox" id="dirSafe" checked> 🛡️ 安全模式（過濾不當內容）</label>
        <label class="check"><input type="checkbox" id="dirPalette" checked> 🎨 沿用參考圖配色</label>
        <div id="dirPaletteInfo" class="tip" style="margin:4px 0 0 22px"></div>
        <div class="row">
          <div><label for="dirSpace">✍️ 預留文字留白區</label>
            <select id="dirSpace"><option value="none">不預留</option><option value="bottom">下方留白</option><option value="top">上方留白</option></select></div>
          <div><label for="dirModel">🤖 模型</label>
            <select id="dirModel"><option value="auto">自動（失敗會換線）</option><option value="flux">flux</option><option value="flux-realism">flux-realism</option><option value="turbo">turbo（較快）</option></select></div>
        </div>
        <button id="dirPreview" class="pro-btn" style="width:100%;margin-top:10px;padding:8px;font-size:12px">👁️ 預覽最終英文提示詞</button>
        <textarea id="dirFinal" placeholder="按上方按鈕或開始生成後，這裡會顯示實際送出的英文提示詞，可直接修改" style="min-height:70px;font-size:12px;margin-top:6px"></textarea>
        <label class="check"><input type="checkbox" id="dirLock"> 🔒 鎖定：直接使用上面這段提示詞（不再自動改寫）</label>
        <div id="dirNote" class="tip" style="margin-top:6px"></div>
      </div>`;
    $("generate").insertAdjacentElement("beforebegin", panel);

    const ids = ["dirDirector", "dirVariants", "dirQuality", "dirSafe", "dirPalette", "dirSpace", "dirModel"];
    try {
      const saved = JSON.parse(localStorage.getItem(OPT_KEY) || "{}");
      ids.forEach(id => { if (id in saved) { const el = $(id); if (el.type === "checkbox") el.checked = !!saved[id]; else el.value = saved[id]; } });
    } catch {}
    ids.forEach(id => $(id).addEventListener("change", () => {
      const o = {}; ids.forEach(k => { const el = $(k); o[k] = el.type === "checkbox" ? el.checked : el.value; });
      try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch {}
    }));
    paintPalette();
    $("dirPreview").onclick = async () => {
      const raw = $("prompt").value.trim();
      if (!raw && !Ref.blob) return setStatus("⚠️ 請先輸入圖片描述或上傳參考圖！");
      const o = readOpts(); o.locked = false;
      const plan = await planPrompt(raw, o);
      $("dirFinal").value = plan.base; showNotes(plan.notes);
      setStatus("👁️ 已產生提示詞預覽（可直接編輯，勾選鎖定後會原樣使用）");
    };
  }
  const showNotes = notes => { const el = $("dirNote"); if (el) el.textContent = (notes || []).join(" · "); };
  function readOpts() {
    return {
      director: $("dirDirector").checked, variants: $("dirVariants").checked, quality: $("dirQuality").checked,
      safe: $("dirSafe").checked, palette: $("dirPalette").checked, space: $("dirSpace").value, model: $("dirModel").value,
      locked: $("dirLock").checked, lockedText: $("dirFinal").value,
      style: $("style").value, shotMode: $("shotTypeSelect")?.value || "auto"
    };
  }
  function paintPalette() {
    const el = $("dirPaletteInfo"); if (!el) return;
    const p = Ref.palette; el.innerHTML = "";
    if (!p || !p.names.length) { el.textContent = "（上傳參考圖後會自動分析主色）"; return; }
    p.swatches.forEach(s => {
      const sp = document.createElement("span");
      sp.style.cssText = `display:inline-block;width:14px;height:14px;border-radius:4px;margin-right:4px;vertical-align:middle;border:1px solid #2c3040;background:${s.hex}`;
      sp.title = s.name; el.appendChild(sp);
    });
    el.appendChild(document.createTextNode(p.names.join("、") + (p.mood ? " · " + p.mood : "")));
  }

  const modelsFor = entry => {
    const base = FALLBACK_MODELS.slice(), pref = entry.modelPref;
    return pref && pref !== "auto" ? [pref, ...base.filter(m => m !== pref)] : base;
  };

  async function runQueueSmart() {
    if (running) return; running = true;
    try {
      while (queue.length) {
        const entry = queue[0], models = modelsFor(entry);
        let done = false, netFails = 0, qFails = 0;
        try {
          while (!done && !entry.cancelled && netFails < models.length) {
            const model = models[netFails];
            const until = (+localStorage.getItem(LAST_KEY) || 0) + ((netFails === 0 && qFails === 0) ? COOLDOWN_MS : 4000);
            while (Date.now() < until && !entry.cancelled) {
              entry.card.wait(`排隊中 ${Math.ceil((until - Date.now()) / 1000)} 秒…`);
              await sleep(400);
            }
            if (entry.cancelled) break;
            entry.card.wait(qFails ? `畫面品質不佳，換 seed 重畫 (${qFails}/2)…` : netFails ? `自動換線重試中 (${model})…` : "AI 繪圖中…");
            setStatus("🎨 AI 繪圖中…");
            localStorage.setItem(LAST_KEY, Date.now());
            entry.url = imageUrl(entry, model);
            try {
              const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 26000));
              const res = await Promise.race([fetch(entry.url), timeout]);
              if (!res || !res.ok) throw new Error("HTTP error");
              let blob = await res.blob();
              if (blob.size < 1500) throw new Error("Empty");

              const q = entry.qualityOn === false ? { ok: true, score: null } : await assessQuality(blob);
              if (!q.ok && qFails < 2) { qFails++; entry.seed = rand(); refreshMeta(entry); continue; }

              entry.rawBgBlob = blob;
              if (entry.ocrLines?.length) {
                entry.card.wait("正在 1:1 疊加原圖中文字…");
                blob = await OCRLayoutEngine.compositeLayoutOntoImage(blob, entry.ocrLines, entry.customOcrText);
              }
              entry.blob = blob; entry.score = q.score;
              const { card, cancelled, ...plain } = entry;
              await imgPut(plain);
              await card.show(URL.createObjectURL(blob));
              card.wait(q.score != null ? `品質分 ${q.score}${qFails ? ` · 已自動重畫 ${qFails} 次` : ""}` : "");
              done = true;
            } catch {
              if (await entry.card.show(entry.url)) {
                done = true;
                const { card, cancelled, ...plain } = entry;
                await imgPut(plain).catch(() => {});
              } else { netFails++; await sleep(1500); }
            }
          }
          if (!done && !entry.cancelled) entry.card.fail("伺服器忙碌，請點「🔄 重畫」");
        } finally { queue.shift(); }
      }
    } finally { running = false; setStatus("✅ 生圖完成！"); }
  }

  async function generateSmart() {
    const raw = $("prompt").value.trim();
    if (!raw && !Ref.blob) { setStatus("⚠️ 請先輸入圖片描述或上傳參考圖！"); $("prompt").focus(); return; }
    $("generate").disabled = true;
    try {
      const o = readOpts();
      const wantsSameLayout = /排版|一樣|同款|文字/.test(raw) || $("refCloneLayoutChk")?.checked;
      const plan = await planPrompt(raw, o);
      $("dirFinal").value = plan.base; showNotes(plan.notes);
      const count = +$("count").value;
      const baseSeed = $("seed").value === "" ? rand() : +$("seed").value;
      for (let i = 0; i < count; i++) {
        const variant = (o.variants && count > 1 && !o.locked) ? VARIANTS[i % VARIANTS.length] : null;
        const entry = {
          id: Date.now() + "-" + i, original: raw, prompt: withVariant(plan.base, variant), negative: plan.negative,
          size: $("size").value, seed: baseSeed + i, styleValue: o.style, time: Date.now(),
          modelPref: o.model, qualityOn: o.quality, safe: o.safe, variantLabel: variant ? variant.label : "",
          ocrLines: (Ref.blob && wantsSameLayout && Ref.ocrLines?.length) ? JSON.parse(JSON.stringify(Ref.ocrLines)) : null,
          customOcrText: $("refOcrText")?.value || ""
        };
        createCard(entry); refreshMeta(entry); enqueue(entry);
      }
    } catch (e) {
      setStatus("發生錯誤：" + e.message);
    } finally { $("generate").disabled = false; }
  }

  function install() {
    buildPanel();

    G.removeCornerWatermark = async blob => blob;

    G.imageUrl = (e, overrideModel = null) => {
      const [w, h] = e.size.split("x");
      const q = new URLSearchParams({
        width: w, height: h, seed: e.seed, model: overrideModel || "flux",
        nologo: "true", private: "true", safe: e.safe === false ? "false" : "true"
      });
      if (e.negative) q.set("negative_prompt", e.negative);
      return IMG_API + encodeURIComponent(e.prompt) + "?" + q.toString();
    };

    const origCreate = G.createCard;
    G.createCard = function (entry, prepend = true) {
      const card = origCreate(entry, prepend);
      const item = prepend ? $("gallery").firstElementChild : $("gallery").lastElementChild;
      const meta = item?.querySelector(".meta");
      if (meta) { metaMap.set(entry, meta); refreshMeta(entry); }
      return card;
    };

    G.runQueue = runQueueSmart;

    const origSetRef = G.setReference;
    G.setReference = async function (file) {
      if (file && file.type?.startsWith("image/")) {
        extractPalette(file).then(p => { Ref.palette = p; paintPalette(); }).catch(() => {});
      }
      return origSetRef(file);
    };
    const origClear = G.clearReference;
    $("refRemove").onclick = () => { Ref.palette = null; paintPalette(); origClear(); };

    $("generate").onclick = generateSmart;
  }
  install();
})();
