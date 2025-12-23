// ==UserScript==
// @name         Universal AI Chat Exporter （ChatGPT / Gemini / Grok）
// @namespace    local.only.exporter
// @version      1.3.2
// @description  Export ChatGPT / Gemini / Grok conversations to Markdown/JSON. Better TeX extraction, multiline math normalization, unified attachment/image fallback scan (all platforms), optional embedded images (data URI, Typora-friendly HTML), UI isolated via Shadow DOM.
// @match        https://chat.openai.com/*
// @match        https://chatgpt.com/*
// @match        https://gemini.google.com/*
// @match        https://bard.google.com/*
// @match        https://www.bard.google.com/*
// @match        https://grok.x.ai/*
// @match        https://x.com/i/grok*
// @run-at       document_idle
// @grant        none
// ==/UserScript==

// 用法：打开任意一条对话页 → 右下角点击 “Export” → 选择导出/复制。
// 说明：
// - 默认只在本地处理，不上传任何对话内容；仅当开启 allowImageFetch 时才会对图片 URL 发起下载（用于转 data URI）。
// - 若你用 Typora，建议在“图片内嵌到 MD”开启时使用 data URI 的 HTML 渲染模式（本脚本默认）。

(() => {
  "use strict";

  /********************************************************************
   * 安全边界
   * - 默认不做网络请求；不上传任何对话内容
   * - 若开启 allowImageFetch：会对图片 URL 发起下载请求，只用于转 data URI
   ********************************************************************/

  const DEFAULT_SETTINGS = {
    // 历史加载
    autoLoadAll: true,
    allowClickLoadMoreButtons: true,
    maxScrollTries: 220,
    scrollDelayMs: 900,
    stableRoundsToStop: 3,
    jiggleTimesPerTry: 2,

    // 输出
    exportFormat: "md", // "md" | "json"
    includeYamlFrontMatter: true,
    includeTOC: false,
    headingStyle: "role", // "role" | "qa"
    includeRawUrl: true,

    // 文件名
    filenamePrefix: "",
    customFilename: "",        // 不含扩展名
    useCustomFilename: false,
    includeTimestampInFilename: true, // ⚠️ 当 useCustomFilename=true 时会被强制忽略（不加时间戳）

    // 去重/清理
    dedupeConsecutive: true,
    stripUIJunk: true,
    compactBlankLines: true,
    exportVisibleOnly: true, // 只按 display/visibility/hidden 过滤（不误伤 aria-hidden）

    // 思路 / 已思考
    includeReasoning: true,
    autoExpandReasoning: false,

    // 数学公式
    preferBlockMathForMultiline: true,
    normalizeMultilineMath: true, // array->aligned 等
    inlineMathDelim: "$",
    blockMathDelim: "$$",

    // 图片
    embedImagesInMarkdown: false, // data URI 内嵌
    allowImageFetch: false,       // canvas 失败时允许 fetch 图片（会发起图片请求）
    maxEmbedImageBytes: 2_500_000,
    dataUriImageMode: "html",     // "md" | "html"（Typora 更兼容 html）

    // ✅ 统一附件/图片兜底策略（ChatGPT / Gemini / Grok）
    attachmentFallbackScan: true,

    // ✅ 修复/移动 UI 里的图片画廊区块（例如 Gemini 的 **Images**）
    relocateUiImageBlocks: true,

    debug: false,
  };

  const LS_KEY = "uai_exporter_settings_v132"; // 新 key：避免旧版本脏配置干扰（也做兼容迁移）
  let SETTINGS = loadSettings();

  const log = (...args) => SETTINGS.debug && console.log("[UAI-Exporter]", ...args);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function loadSettings() {
    try {
      const raw132 = localStorage.getItem(LS_KEY);
      if (raw132) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw132) };

      // 兼容读取 v131（若存在）
      const raw131 = localStorage.getItem("uai_exporter_settings_v131");
      if (!raw131) return { ...DEFAULT_SETTINGS };
      const obj = JSON.parse(raw131);

      // 迁移字段
      if (obj && typeof obj === "object") {
        if (obj.geminiAttachmentFallbackScan !== undefined && obj.attachmentFallbackScan === undefined) {
          obj.attachmentFallbackScan = obj.geminiAttachmentFallbackScan;
        }
      }
      return { ...DEFAULT_SETTINGS, ...obj };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings(s) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(s)); } catch {}
  }

  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  }

  function sanitizeFilename(name) {
    const illegalRe = /[\/\\\?\%\*\:\|"<>\.]/g;
    const controlRe = /[\x00-\x1f\x80-\x9f]/g;
    let n = (name || "").replace(illegalRe, "_").replace(controlRe, "_").replace(/\s+/g, " ").trim();
    if (!n) n = "conversation";
    return n;
  }

  // ✅ 修复点：当 useCustomFilename=true 时，不附加时间戳（即使 includeTimestampInFilename=true）
  function buildFilename(baseTitle, extWithDot) {
    const prefix = (SETTINGS.filenamePrefix || "").trim();

    const base =
      SETTINGS.useCustomFilename && (SETTINGS.customFilename || "").trim()
        ? SETTINGS.customFilename.trim()
        : (baseTitle || "conversation");

    const useTs =
      !SETTINGS.useCustomFilename && SETTINGS.includeTimestampInFilename;

    const ts = useTs ? `${nowStamp()}_` : "";
    return `${prefix}${ts}${sanitizeFilename(base)}${extWithDot}`;
  }

  function downloadText(filename, text, mime = "text/plain;charset=utf-8") {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.focus(); ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }

  /********************
   * 平台识别与适配器
   ********************/
  function detectPlatform() {
    const h = location.host;
    const p = location.pathname;
    if (h.includes("chatgpt.com") || h.includes("chat.openai.com")) return "chatgpt";
    if (h.includes("gemini.google.com") || h.includes("bard.google.com")) return "gemini";
    if (h.includes("grok.x.ai")) return "grok";
    if (h === "x.com" && p.startsWith("/i/grok")) return "grok";
    return "unknown";
  }

  function getTitleFallback() {
    return (document.title || "conversation").replace(/\s+-\s+.*$/, "").trim();
  }

  function firstNonNull(...xs) { for (const x of xs) if (x) return x; return null; }

  function findScrollableContainer(cands) {
    for (const el of cands) {
      if (!el) continue;
      if (el === window) return window;
      if (el.scrollHeight > el.clientHeight + 80) return el;
    }
    return window;
  }

  const Adapters = {
    chatgpt: {
      getTitle() {
        return firstNonNull(
          document.querySelector("main h1")?.textContent?.trim(),
          document.querySelector('nav a[aria-current="page"]')?.textContent?.trim(),
          getTitleFallback()
        );
      },
      getScrollContainer() {
        return findScrollableContainer([document.querySelector("main"), document.scrollingElement, window]);
      },
      getMessages() {
        const scope = document.querySelector("main") || document.body;
        const nodes = Array.from(scope.querySelectorAll('div[data-message-author-role]'));
        return nodes.map((n, idx) => {
          const role = n.getAttribute("data-message-author-role") || "unknown";
          const contentRoot = n.querySelector(".markdown") || n.querySelector(".prose") || n;
          const key = n.getAttribute("data-message-id") || n.id || `${role}-${idx}`;
          return { role, contentRoot, key };
        }).filter(m => m.contentRoot && (m.role==="user"||m.role==="assistant"||m.role==="system"));
      },
      findLoadMoreButtons() {
        const scope = document.querySelector("main") || document.body;
        const btns = Array.from(scope.querySelectorAll("button"));
        const patterns = [/show more/i,/load more/i,/显示更多/,/加载更多/,/展开/];
        return btns.filter(b => patterns.some(re => re.test((b.textContent||"").trim())));
      },
      findReasoningToggles() {
        const scope = document.querySelector("main") || document.body;
        const cands = Array.from(scope.querySelectorAll('button,[role="button"]'));
        const patterns = [/已思考/,/显示思考/,/显示推理/,/显示思路/,/show reasoning/i,/view reasoning/i];
        return cands.filter(el => patterns.some(re => re.test((el.textContent||"").trim())));
      }
    },

    gemini: {
      getTitle() {
        return firstNonNull(
          document.querySelector("div.conversation-title")?.textContent?.trim(),
          document.querySelector("h1")?.textContent?.trim(),
          getTitleFallback()
        );
      },
      getScrollContainer() {
        return findScrollableContainer([document.scrollingElement, document.querySelector("main"), window]);
      },
      getMessages() {
        const list = Array.from(document.querySelectorAll("user-query, model-response"));
        if (list.length) {
          return list.map((el, idx) => ({
            role: el.tagName.toLowerCase()==="user-query" ? "user" : "assistant",
            contentRoot: el,
            key: el.id || `${el.tagName}-${idx}`
          }));
        }
        const scope = document.querySelector("main") || document.body;
        const blocks = Array.from(scope.querySelectorAll('[role="listitem"]'));
        return blocks.map((el, idx) => ({
          role: idx%2===0 ? "user" : "assistant",
          contentRoot: el,
          key: el.id || `li-${idx}`
        }));
      },
      findLoadMoreButtons() {
        const scope = document.querySelector("main") || document.body;
        const btns = Array.from(scope.querySelectorAll("button,[role='button']"));
        const patterns = [/more/i,/load/i,/show/i,/加载/,/更多/,/展开/,/继续/,/older/i];
        return btns.filter(b => patterns.some(re => re.test((b.textContent||"").trim())));
      },
      findReasoningToggles() {
        const scope = document.querySelector("main") || document.body;
        const cands = Array.from(scope.querySelectorAll('button,[role="button"]'));
        const patterns = [/显示思路/,/隐藏思路/,/思考过程/,/show reasoning/i,/hide reasoning/i,/thoughts/i];
        return cands.filter(el => patterns.some(re => re.test((el.textContent||"").trim())));
      }
    },

    grok: {
      getTitle() { return getTitleFallback(); },
      getScrollContainer() {
        return findScrollableContainer([document.querySelector("main"), document.scrollingElement, window]);
      },
      getMessages() {
        const scope = document.querySelector("main") || document.body;
        let nodes = Array.from(scope.querySelectorAll("div.message-bubble"));
        if (!nodes.length) nodes = Array.from(scope.querySelectorAll('[data-testid*="message"],article'));
        const guessRole = (el, idx) => {
          const text = (el.textContent||"").trim();
          if (/^\s*you\s*[:：]/i.test(text) || /\bYou\b/.test(text)) return "user";
          if (/\bGrok\b/.test(text)) return "assistant";
          return idx%2===0 ? "user" : "assistant";
        };
        return nodes.map((el, idx) => ({ role: guessRole(el, idx), contentRoot: el, key: el.id || `g-${idx}` }));
      },
      findLoadMoreButtons() {
        const scope = document.querySelector("main") || document.body;
        const btns = Array.from(scope.querySelectorAll("button,[role='button']"));
        const patterns = [/show more/i,/load more/i,/more/i,/加载更多/,/显示更多/,/展开/];
        return btns.filter(b => patterns.some(re => re.test((b.textContent||"").trim())));
      },
      findReasoningToggles() {
        const scope = document.querySelector("main") || document.body;
        const cands = Array.from(scope.querySelectorAll('button,[role="button"]'));
        const patterns = [/show reasoning/i,/hide reasoning/i,/thoughts/i,/推理/,/思路/,/思考/];
        return cands.filter(el => patterns.some(re => re.test((el.textContent||"").trim())));
      }
    },
  };

  /********************
   * 历史加载（仅在导出时触发）
   ********************/
  function scrollToTop(container) {
    try {
      if (container === window) window.scrollTo({ top: 0, behavior: "instant" });
      else container.scrollTo({ top: 0, behavior: "instant" });
    } catch {}
  }

  function computeSignature(adapter) {
    const msgs = adapter.getMessages();
    const first = msgs[0]?.contentRoot?.textContent?.trim()?.slice(0,80) || "";
    const last = msgs[msgs.length-1]?.contentRoot?.textContent?.trim()?.slice(0,80) || "";
    const len = msgs.reduce((a,m)=>a+((m.contentRoot?.textContent||"").length),0);
    return `${msgs.length}::${len}::${first}::${last}`;
  }

  async function tryClickLoadMore(adapter, limit=10) {
    if (!SETTINGS.allowClickLoadMoreButtons) return 0;
    let clicked = 0;
    for (let i=0;i<limit;i++) {
      const btns = adapter.findLoadMoreButtons?.() || [];
      const b = btns.find(x => {
        const r = x.getBoundingClientRect();
        return r.width>0 && r.height>0;
      });
      if (!b) break;
      try { b.click(); clicked++; await sleep(220); } catch { break; }
    }
    return clicked;
  }

  async function autoLoadAll(adapter) {
    if (!SETTINGS.autoLoadAll) return;
    const container = adapter.getScrollContainer();
    let stable=0, prevSig="";
    await tryClickLoadMore(adapter, 6);
    for (let t=0;t<SETTINGS.maxScrollTries;t++) {
      for (let j=0;j<SETTINGS.jiggleTimesPerTry;j++) { scrollToTop(container); await sleep(60); }
      await tryClickLoadMore(adapter, 2);
      await sleep(SETTINGS.scrollDelayMs);
      const sig = computeSignature(adapter);
      stable = (sig===prevSig) ? (stable+1) : 0;
      prevSig = sig;
      updateStatus(`Loading history… ${t+1}/${SETTINGS.maxScrollTries} (stable ${stable}/${SETTINGS.stableRoundsToStop})`);
      if (stable >= SETTINGS.stableRoundsToStop) break;
    }
  }

  /********************
   * 思路展开（仅在导出时触发）
   ********************/
  function looksLikeExpandText(t) {
    t = (t||"").trim();
    return /显示|展开|show/i.test(t) && !/隐藏|收起|hide/i.test(t);
  }

  async function expandReasoning(adapter) {
    if (!SETTINGS.autoExpandReasoning || !SETTINGS.includeReasoning) return 0;
    const toggles = adapter.findReasoningToggles?.() || [];
    let clicked=0;
    for (const el of toggles) {
      const t = (el.textContent||"").trim();
      if (!looksLikeExpandText(t)) continue;
      try { el.click(); clicked++; await sleep(160); } catch {}
    }
    document.querySelectorAll("details").forEach(d => { try { d.open = true; } catch {} });
    return clicked;
  }

  /********************
   * 可见性过滤（不使用 aria-hidden）
   ********************/
  const visibleCache = new WeakMap();
  function isVisibleEl(el) {
    if (!SETTINGS.exportVisibleOnly) return true;
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return true;
    if (visibleCache.has(el)) return visibleCache.get(el);

    let ok = true;
    try {
      if (el.hidden) ok = false;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") ok = false;
    } catch {}
    visibleCache.set(el, ok);
    return ok;
  }

  const SKIP_TAGS = new Set(["button","svg","path","textarea","input","select","option","noscript"]);
  function shouldSkip(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (!isVisibleEl(el)) return true;

    const tag = el.tagName.toLowerCase();
    if (SETTINGS.stripUIJunk && SKIP_TAGS.has(tag)) return true;

    if (SETTINGS.stripUIJunk) {
      const aria = (el.getAttribute("aria-label")||"").toLowerCase();
      const cls = (el.className||"").toString().toLowerCase();
      if (aria.includes("copy") || aria.includes("复制")) return true;
      if (cls.includes("copy") && tag !== "a") return true;
    }
    return false;
  }

  /********************
   * 深度遍历：open shadowRoot + slot assignedNodes
   ********************/
  function getTraversalRootsForElement(el) {
    const roots = [];
    if (el?.shadowRoot && el.shadowRoot.childNodes?.length) roots.push(el.shadowRoot);
    roots.push(el);
    return roots;
  }

  /********************
   * 数学处理：块公式/多行规范化
   ********************/
  function isLatexLike(s) {
    if (!s) return false;
    const t = s.trim();
    return /\\[a-zA-Z]+/.test(t) || /(\^|_)\{?/.test(t) || /\\begin\{/.test(t);
  }

  function normalizeMultilineTex(tex) {
    let t = (tex || "").trim();
    if (!t) return t;
    t = t.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n");

    if (SETTINGS.normalizeMultilineMath) {
      t = t.replace(/\\begin\{array\}\{[^}]*\}/g, "\\begin{aligned}");
      t = t.replace(/\\end\{array\}/g, "\\end{aligned}");
    }
    t = t.replace(/\n\s*\n/g, "\n");
    return t.trim();
  }

  function looksMultilineTex(tex) {
    const t = (tex || "").trim();
    if (!t) return false;
    return /\n/.test(t) || /\\begin\{[^}]+\}/.test(t) || /\\\\/.test(t) || t.length > 120;
  }

  function wrapMath(tex, displayPreferred) {
    const t = normalizeMultilineTex(tex);
    const wantBlock = displayPreferred || (SETTINGS.preferBlockMathForMultiline && looksMultilineTex(t));
    if (wantBlock) {
      return `\n${SETTINGS.blockMathDelim}\n${t}\n${SETTINGS.blockMathDelim}\n`;
    }
    return `${SETTINGS.inlineMathDelim}${t}${SETTINGS.inlineMathDelim}`;
  }

  function extractLatexFromAttributes(el) {
    const attrs = ["data-latex","data-tex","data-math","data-equation","data-formula","latex","tex","math","equation"];
    for (const a of attrs) {
      const v = el.getAttribute?.(a);
      if (v && isLatexLike(v)) return v.trim();
    }
    const aria = el.getAttribute?.("aria-label");
    if (aria && isLatexLike(aria)) return aria.trim();
    const title = el.getAttribute?.("title");
    if (title && isLatexLike(title)) return title.trim();
    return "";
  }

  function extractTexFromMathML(el) {
    const ann = el.querySelector?.('annotation[encoding="application/x-tex"],annotation[encoding="application/tex"]');
    if (ann?.textContent?.trim()) return ann.textContent.trim();
    const aria = el.getAttribute?.("aria-label");
    if (aria && isLatexLike(aria)) return aria.trim();
    return "";
  }

  function extractTexFromKatex(el) {
    const host = el?.classList?.contains("katex") ? el : (el?.closest?.(".katex") || el);
    if (!host) return "";

    let ann =
      host.querySelector?.('span.katex-mathml annotation[encoding="application/x-tex"]') ||
      host.querySelector?.('annotation[encoding="application/x-tex"]');

    if (!ann && host.parentElement) {
      ann = host.parentElement.querySelector?.('span.katex-mathml annotation[encoding="application/x-tex"]') || ann;
    }
    const tex = ann?.textContent?.trim();
    if (tex) return tex;

    const attr =
      host.getAttribute?.("data-tex") ||
      host.getAttribute?.("data-latex") ||
      host.getAttribute?.("aria-label") ||
      "";
    return (attr || "").trim();
  }

  function isKatexDisplay(el) {
    return !!(el?.closest?.(".katex-display"));
  }

  /********************
   * 图片提取与内嵌
   ********************/
  function escapeMdInline(s) {
    return (s||"").replace(/\\/g,"\\\\").replace(/`/g,"\\`");
  }

  function escapeHtmlAttr(s) {
    return (s || "").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  function getImgSrc(img) {
    if (!img) return "";
    if (img.currentSrc) return img.currentSrc;
    const ds = img.getAttribute("data-src") || img.getAttribute("data-original") || "";
    if (ds) return ds;
    return img.getAttribute("src") || img.src || "";
  }

  function getBackgroundImageUrl(el) {
    try {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundImage || "";
      const m = bg.match(/url\(["']?(.+?)["']?\)/i);
      if (!m) return "";
      const url = m[1];
      if (!url || url === "none") return "";
      return url;
    } catch { return ""; }
  }

  function isLikelyMessageImageBox(el) {
    try {
      const r = el.getBoundingClientRect();
      return r.width >= 55 && r.height >= 55;
    } catch { return false; }
  }

  function looksLikeImageUrl(u) {
    return /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(u || "");
  }

  async function blobToDataURL(blob) {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  }

  async function imageToDataUri(imgEl, src) {
    // 优先 canvas（仅同源/带 CORS 的图片可用）
    try {
      if (imgEl && imgEl.naturalWidth && imgEl.naturalHeight) {
        const canvas = document.createElement("canvas");
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(imgEl, 0, 0);
        const data = canvas.toDataURL("image/png");
        if (data && data.length * 0.75 <= SETTINGS.maxEmbedImageBytes) return data;
      }
    } catch (e) { log("canvas embed failed:", e); }

    // 兜底 fetch（受 CORS 影响；开启后会发起网络请求）
    if (!SETTINGS.allowImageFetch) return null;
    try {
      const abs = new URL(src, location.href).toString();
      const resp = await fetch(abs, { mode: "cors", credentials: "include" });
      if (!resp.ok) return null;
      const blob = await resp.blob();
      if (blob.size > SETTINGS.maxEmbedImageBytes) return null;
      return await blobToDataURL(blob);
    } catch (e) { log("fetch embed failed:", e); return null; }
  }

  async function embedImages(markdown, images) {
    if (!SETTINGS.embedImagesInMarkdown || !images.length) return markdown;
    let out = markdown;

    for (const img of images) {
      const src = img.src || "";
      const placeholder = `![${img.alt}](${img.token})`;

      // 已经是 data URI
      if (src.startsWith("data:")) {
        if (SETTINGS.dataUriImageMode === "html") {
          out = out.replaceAll(placeholder, `<img alt="${escapeHtmlAttr(img.alt)}" src="${src}" />`);
        } else {
          out = out.replaceAll(`](${img.token})`, `](${src})`);
        }
        continue;
      }

      const dataUri = await imageToDataUri(img.el, src);
      if (dataUri) {
        if (SETTINGS.dataUriImageMode === "html") {
          out = out.replaceAll(placeholder, `<img alt="${escapeHtmlAttr(img.alt)}" src="${dataUri}" />`);
        } else {
          out = out.replaceAll(`](${img.token})`, `](${dataUri})`);
        }
      } else {
        // 内嵌失败：回落到原始 URL
        out = out.replaceAll(`](${img.token})`, `](${src})`);
      }
    }
    return out;
  }

  /********************
   * 统一附件/图片兜底：跨平台
   ********************/
  function isGeminiUploadedImg(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    if (el.tagName?.toLowerCase() !== "img") return false;
    const dt = el.getAttribute("data-test-id") || "";
    const cls = (el.className || "").toString();
    const alt = el.getAttribute("alt") || "";
    const aria = el.getAttribute("aria-label") || "";
    if (dt === "uploaded-img") return true;
    if (/preview-image/.test(cls)) return true;
    if (/(预览图|上传.*图片|uploaded)/i.test(alt) || /(预览图|上传.*图片|uploaded)/i.test(aria)) return true;
    return false;
  }

  function isChatgptUploadedImg(el, src) {
    if (!src) return false;
    if (el?.tagName?.toLowerCase() !== "img") return false;
    const alt = el.getAttribute?.("alt") || "";
    // ChatGPT 的文件/图片一般走 estuary/content?id=file_...
    if (/\/backend-api\/estuary\/content\?id=file_/i.test(src) || /\bid=file_/i.test(src)) return true;
    if (/(已上传|uploaded)/i.test(alt) && /(图片|image)/i.test(alt)) return true;
    return false;
  }

  function isGrokUploadedImg(el, src) {
    if (!el || el.tagName?.toLowerCase() !== "img") return false;
    const alt = el.getAttribute("alt") || "";
    const cls = (el.className || "").toString().toLowerCase();
    if (/(uploaded|attachment|附件|上传)/i.test(alt)) return true;
    if (cls.includes("attachment") || cls.includes("uploaded")) return true;
    // grok 可能用 blob:
    if ((src || "").startsWith("blob:")) return true;
    return false;
  }

  function isUploadedImgForPlatform(platform, el, src) {
    if (platform === "gemini") return isGeminiUploadedImg(el);
    if (platform === "chatgpt") return isChatgptUploadedImg(el, src);
    if (platform === "grok") return isGrokUploadedImg(el, src);
    return false;
  }

  function isCandidateContentImage(platform, el, src) {
    // 排除明显 UI 图标/头像
    try {
      const r = el?.getBoundingClientRect?.();
      if (r && (r.width < 48 || r.height < 48)) return false;
    } catch {}
    // Gemini 的 licensed-image / ChatGPT 的生成图等
    if (platform === "gemini" && el?.classList?.contains("licensed-image")) return true;
    if (/encrypted-tbn\d+\.gstatic\.com\/licensed-image/i.test(src || "")) return true;
    if (looksLikeImageUrl(src)) return true;
    // 其它：只要足够大就算
    return isLikelyMessageImageBox(el);
  }

  function deepCollectImages(root) {
    const out = [];
    const seenNodes = new WeakSet();
    const stack = [root];

    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;

      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node;
        if (seenNodes.has(el)) continue;
        seenNodes.add(el);

        if (el.tagName?.toLowerCase() === "slot") {
          try {
            const assigned = el.assignedNodes ? el.assignedNodes({ flatten: true }) : [];
            for (const n of assigned) stack.push(n);
          } catch {}
        }

        if (el.shadowRoot) stack.push(el.shadowRoot);

        if (el.tagName?.toLowerCase() === "img") {
          const src = getImgSrc(el);
          if (src) out.push({ el, src, alt: el.getAttribute("alt") || "" });
        }

        const bg = getBackgroundImageUrl(el);
        if (bg && isLikelyMessageImageBox(el)) out.push({ el: null, src: bg, alt: el.getAttribute("aria-label") || "image" });

        for (const c of Array.from(el.childNodes)) stack.push(c);
      } else if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const c of Array.from(node.childNodes)) stack.push(c);
      }
    }
    return out;
  }

  function hasAnyMarkdownImage(md) {
    return /!\[[^\]]*]\([^)]+\)/.test(md || "") || /<img\s+[^>]*src=/.test(md || "");
  }

  function collectSrcsFromMarkdown(md) {
    const set = new Set();
    (md || "").replace(/!\[[^\]]*]\(([^)]+)\)/g, (_, src) => { if (src) set.add(src.trim()); return ""; });
    (md || "").replace(/<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>/gi, (_, src) => { if (src) set.add(src.trim()); return ""; });
    return set;
  }

  function buildImageLine(state, alt, src, el) {
    alt = (alt || "image").trim();
    src = (src || "").trim();
    if (!src) return "";

    if (!SETTINGS.embedImagesInMarkdown) return `![${alt}](${src})`;

    const token = `uai-img-${state.images.length}`;
    state.images.push({ token, alt, src, el });
    return `![${alt}](${token})`;
  }

  function fallbackScanForMessage(platform, role, contentRoot, state, existingSrcSet) {
    if (!SETTINGS.attachmentFallbackScan) return "";

    // role=user：不要扫 next/prev，避免把 assistant 的图误归类到用户附件
    const candidates = [];
    if (contentRoot) candidates.push(contentRoot);
    if (contentRoot?.parentElement) candidates.push(contentRoot.parentElement);

    if (role !== "user") {
      if (contentRoot?.previousElementSibling) candidates.push(contentRoot.previousElementSibling);
      if (contentRoot?.nextElementSibling) candidates.push(contentRoot.nextElementSibling);
    }

    const srcSet = new Set();
    const lines = [];

    for (const root of candidates) {
      const imgs = deepCollectImages(root);
      for (const it of imgs) {
        if (!it.src || srcSet.has(it.src) || existingSrcSet?.has(it.src)) continue;

        const alt = (it.alt || "image").trim();
        const isUploaded = it.el ? isUploadedImgForPlatform(platform, it.el, it.src) : false;

        let ok = false;
        if (role === "user") {
          ok = isUploaded; // 用户消息：只兜底“上传/附件”图
        } else {
          // assistant：兜底“内容图”（排除附件图以免重复）
          ok = !isUploaded && it.el && isCandidateContentImage(platform, it.el, it.src);
        }

        if (!ok) continue;

        srcSet.add(it.src);
        lines.push(buildImageLine(state, alt, it.src, it.el));
      }
    }

    if (!lines.length) return "";
    if (role === "user") {
      // 用户附件：放在该条消息内，不做全局汇总
      return `\n\n**Attachments**\n\n${lines.map(x => `- ${x}`).join("\n")}\n`;
    }
    // assistant：直接插入图片（不加 Images 标题）
    return `\n\n${lines.join("\n\n")}\n`;
  }

  // 解析并移除类似 Gemini 的 “**Images** + 图片列表” UI 区块，把图片挪到更合理位置
  function extractUiImageBlocks(md) {
    if (!SETTINGS.relocateUiImageBlocks) return { md, blocks: [] };

    const blocks = [];
    let out = md;

    // 仅处理 **Images**（必要时可扩展）
    out = out.replace(/\n\*\*Images\*\*\n\n((?:- !\[[^\]]*]\([^)]+\)\n)+)\n*/g, (all, items) => {
      blocks.push(items.trim());
      return "\n\n";
    });

    return { md: out, blocks };
  }

  function insertImagesNearCaption(md, imageLines, existingSrcSet) {
    const lines = (imageLines || "").split("\n").map(s => s.trim()).filter(Boolean)
      .map(s => s.replace(/^[-*]\s+/, ""));

    // 去重：只保留 md 里未出现过的 src
    const kept = [];
    for (const l of lines) {
      const m = l.match(/!\[[^\]]*]\(([^)]+)\)/);
      const src = m?.[1]?.trim();
      if (!src) continue;
      if (existingSrcSet && existingSrcSet.has(src)) continue;
      kept.push(l);
      if (existingSrcSet) existingSrcSet.add(src);
    }
    if (!kept.length) return md;

    const block = `\n\n${kept.join("\n")}\n\n`;

    // 优先插到 “图示/图:” 之类的说明前；否则放在开头
    const capRe = /(^|\n)(图示[:：]|图[:：]|Figure[:：]|Fig\.[:：])/m;
    const m = md.match(capRe);
    if (m && m.index != null) {
      const idx = m.index + (m[1] ? m[1].length : 0); // 插到换行后
      return md.slice(0, idx) + block + md.slice(idx);
    }
    return block + md;
  }

  /********************
   * DOM -> Markdown（shadow + light + slot）
   ********************/
  function childrenToMd(el, ctx, state) {
    const roots = getTraversalRootsForElement(el);
    let out = "";
    for (const r of roots) {
      if (!r) continue;
      if (r.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        out += nodeToMarkdown(r, ctx, state);
      } else {
        out += Array.from(r.childNodes).map(n => nodeToMarkdown(n, ctx, state)).join("");
      }
    }
    return out;
  }

  function nodeToMarkdown(node, ctx, state) {
    if (!node) return "";
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return Array.from(node.childNodes).map(n => nodeToMarkdown(n, ctx, state)).join("");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const el = node;
    if (shouldSkip(el)) return "";

    const tag = el.tagName.toLowerCase();

    if (tag === "slot") {
      try {
        const assigned = el.assignedNodes ? el.assignedNodes({ flatten: true }) : [];
        if (assigned && assigned.length) return assigned.map(n => nodeToMarkdown(n, ctx, state)).join("");
      } catch {}
      return "";
    }

    if (tag === "math") {
      const tex = extractTexFromMathML(el);
      if (tex) return wrapMath(tex, true);
      return `\n<!-- MathML -->\n${el.outerHTML}\n`;
    }

    if (el.classList?.contains("katex") || el.classList?.contains("katex-html") || el.classList?.contains("katex-mathml")) {
      const tex = extractTexFromKatex(el);
      if (tex) return wrapMath(tex, isKatexDisplay(el));
      return (el.textContent || "");
    }

    if (tag === "mjx-container") {
      const tex = (el.getAttribute("aria-label") || "").trim();
      if (tex) return wrapMath(tex, true);
    }

    {
      const tex = extractLatexFromAttributes(el);
      if (tex) return wrapMath(tex, false);
    }

    if (tag === "br") return "\n";

    if (tag === "pre") {
      const codeEl = el.querySelector("code");
      const cls = (codeEl?.className || "").toString();
      const m = cls.match(/language-([a-z0-9_+-]+)/i);
      const lang = m?.[1] || (codeEl?.getAttribute?.("data-language") || "");
      const code = (codeEl ? codeEl.textContent : el.textContent) || "";
      return `\n\`\`\`${lang}\n${code.replace(/\n+$/g, "")}\n\`\`\`\n`;
    }
    if (tag === "code") return `\`${escapeMdInline(el.textContent || "")}\``;

    const hm = tag.match(/^h([1-6])$/);
    if (hm) {
      const level = Number(hm[1]);
      const text = childrenToMd(el, ctx, state).trim();
      return `\n${"#".repeat(level)} ${text}\n\n`;
    }

    if (tag === "a") {
      const href = el.getAttribute("href") || "";
      if (href && looksLikeImageUrl(href)) {
        const alt = (el.textContent || el.getAttribute("aria-label") || "image").trim();
        if (!SETTINGS.embedImagesInMarkdown) return `![${alt}](${href})`;
        const token = `uai-img-${state.images.length}`;
        state.images.push({ token, alt, src: href, el: null });
        return `![${alt}](${token})`;
      }
      const text = (childrenToMd(el, ctx, state).trim() || href).trim();
      return href ? `[${text}](${href})` : text;
    }

    if (tag === "img") {
      const alt = el.getAttribute("alt") || "";
      const src = getImgSrc(el);
      if (!src) return "";
      if (!SETTINGS.embedImagesInMarkdown) return `![${alt}](${src})`;
      const token = `uai-img-${state.images.length}`;
      state.images.push({ token, alt, src, el });
      return `![${alt}](${token})`;
    }

    {
      const bgUrl = getBackgroundImageUrl(el);
      if (bgUrl && isLikelyMessageImageBox(el)) {
        const alt = el.getAttribute("aria-label") || "image";
        if (!SETTINGS.embedImagesInMarkdown) return `![${alt}](${bgUrl})`;
        const token = `uai-img-${state.images.length}`;
        state.images.push({ token, alt, src: bgUrl, el: null });
        return `![${alt}](${token})`;
      }
    }

    if (tag === "blockquote") {
      const inner = childrenToMd(el, ctx, state).trim();
      const lines = inner.split("\n").map(l => (l ? `> ${l}` : `>`)).join("\n");
      return `\n${lines}\n\n`;
    }
    if (tag === "hr") return "\n---\n";

    if (tag === "ul" || tag === "ol") {
      const items = Array.from(el.children).filter(c => c.tagName?.toLowerCase()==="li" && isVisibleEl(c));
      const ordered = tag === "ol";
      const lines = items.map((li, i) => {
        const prefix = ordered ? `${i+1}. ` : `- `;
        const content = childrenToMd(li, { ...ctx, listLevel:(ctx.listLevel||0)+1 }, state).trim().replace(/\n+/g," ");
        return `${"  ".repeat(ctx.listLevel||0)}${prefix}${content}`;
      });
      return `\n${lines.join("\n")}\n`;
    }
    if (tag === "li") return childrenToMd(el, ctx, state);

    if (tag === "table") {
      const rows = Array.from(el.querySelectorAll("tr")).filter(r => isVisibleEl(r));
      if (!rows.length) return "";
      const rowCells = (tr) => Array.from(tr.querySelectorAll("th,td"))
        .filter(c => isVisibleEl(c))
        .map(c => (c.textContent||"").trim());
      const header = rowCells(rows[0]);
      const body = rows.slice(1).map(rowCells);
      const esc = (s) => (s||"").replace(/\|/g,"\\|").replace(/\n/g," ");
      const md = [];
      md.push(`| ${header.map(esc).join(" | ")} |`);
      md.push(`| ${header.map(()=> "---").join(" | ")} |`);
      for (const r of body) md.push(`| ${r.map(esc).join(" | ")} |`);
      return `\n${md.join("\n")}\n\n`;
    }

    if (tag === "details") {
      const summary = el.querySelector("summary")?.textContent?.trim() || "Details";
      const rest = Array.from(el.childNodes)
        .filter(n => !(n.tagName && n.tagName.toLowerCase()==="summary"))
        .map(n => nodeToMarkdown(n, ctx, state)).join("").trim();
      if (!rest) return `\n> **${summary}**\n\n`;
      return `\n> **${summary}**\n>\n> ${rest.replace(/\n/g,"\n> ")}\n\n`;
    }

    const inner = childrenToMd(el, ctx, state);
    if (tag === "p" || tag === "div" || tag === "section" || tag === "article" || tag === "main" || tag.includes("-")) {
      const t = inner.trim();
      return t ? `\n${t}\n` : "";
    }

    return inner;
  }

  function toPlainText(contentRoot) {
    const roots = getTraversalRootsForElement(contentRoot);
    const texts = roots.map(r => (r?.textContent || "")).join("\n");
    return texts.replace(/\s+\n/g,"\n").trim();
  }

  async function toMarkdownAsync(contentRoot, roleHint, platform) {
    const state = { images: [] };
    let md = nodeToMarkdown(contentRoot, { listLevel: 0 }, state);

    if (SETTINGS.compactBlankLines) md = md.replace(/\n{3,}/g,"\n\n").trim();

    // 1) 把 UI 里的 “**Images**” 区块提取并挪走（只影响本条消息）
    const existingSrcSet = collectSrcsFromMarkdown(md);
    const ex = extractUiImageBlocks(md);
    md = ex.md;
    if (ex.blocks.length) {
      const merged = ex.blocks.join("\n").trim();
      md = insertImagesNearCaption(md, merged, existingSrcSet);
    }

    // 2) 兜底扫描：当本条消息正文里没有抓到任何图片时，尝试把“附件/图片”补回来
    if (SETTINGS.attachmentFallbackScan && !hasAnyMarkdownImage(md)) {
      const extra = fallbackScanForMessage(platform, roleHint, contentRoot, state, existingSrcSet);
      if (extra) {
        if (roleHint === "assistant") {
          md = insertImagesNearCaption(md, extra, existingSrcSet);
        } else {
          md += extra;
        }
      }
    }

    if (SETTINGS.compactBlankLines) md = md.replace(/\n{3,}/g,"\n\n").trim();
    md = await embedImages(md, state.images);
    if (SETTINGS.compactBlankLines) md = md.replace(/\n{3,}/g,"\n\n").trim();

    return { md, state };
  }

  function normalizeTextForDedupe(s) {
    return (s||"").replace(/\s+/g," ").replace(/\u200b/g,"").trim().toLowerCase();
  }
  function dedupeMessages(msgs) {
    if (!SETTINGS.dedupeConsecutive) return msgs;
    const out=[]; let prev="";
    for (const m of msgs) {
      const k = `${m.role}::${normalizeTextForDedupe(m.text||m.md)}`;
      if (k && k===prev) continue;
      out.push(m); prev=k;
    }
    return out;
  }

  async function extractConversation(adapter, platform) {
    const title = adapter.getTitle();
    const url = location.href;

    const raw = adapter.getMessages();
    const messages = [];

    for (const m of raw) {
      const { md } = await toMarkdownAsync(m.contentRoot, m.role, platform);
      const text = toPlainText(m.contentRoot);

      if ((md && md.trim()) || (text && text.trim())) {
        messages.push({ role:m.role||"unknown", md, text, key:m.key });
      }
    }

    return { platform, title, url, messages: dedupeMessages(messages) };
  }

  function buildMarkdownDoc({ platform, title, url, messages }) {
    const ts = new Date().toISOString();
    let out = "";

    if (SETTINGS.includeYamlFrontMatter) {
      out += `---\n`;
      out += `title: "${(title||"").replace(/"/g,'\\"')}"\n`;
      out += `platform: "${platform}"\n`;
      if (SETTINGS.includeRawUrl) out += `source_url: "${url}"\n`;
      out += `exported_at: "${ts}"\n`;
      out += `message_count: ${messages.length}\n`;
      out += `---\n\n`;
    } else {
      out += `# ${title}\n\n- Platform: ${platform}\n- Exported at: ${ts}\n`;
      if (SETTINGS.includeRawUrl) out += `- Source: ${url}\n`;
      out += `\n`;
    }

    if (SETTINGS.includeTOC) {
      out += `## Table of Contents\n`;
      out += messages.map((m,i)=>`- [${i+1}. ${m.role}](#msg-${i+1})`).join("\n");
      out += `\n\n`;
    }

    const roleLabel = (r)=> (r==="user"?"User":(r==="assistant"?"Assistant":(r==="system"?"System":(r||"Unknown"))));

    messages.forEach((m,i)=>{
      const anchor = SETTINGS.includeTOC ? `<a id="msg-${i+1}"></a>\n` : "";
      if (SETTINGS.headingStyle==="qa") {
        out += (m.role==="user") ? `${anchor}# Q\n\n${m.md}\n\n` : `${anchor}# A\n\n${m.md}\n\n`;
      } else {
        out += `${anchor}## ${roleLabel(m.role)}\n\n${m.md}\n\n`;
      }
    });

    if (SETTINGS.compactBlankLines) out = out.replace(/\n{3,}/g,"\n\n");
    return out.trim()+"\n";
  }

  function buildJsonDoc({ platform, title, url, messages }) {
    const ts = new Date().toISOString();
    return JSON.stringify({
      title, platform,
      source_url: SETTINGS.includeRawUrl ? url : undefined,
      exported_at: ts,
      message_count: messages.length,
      messages: messages.map(m=>({ role:m.role, text:m.text, markdown:m.md })),
    }, null, 2);
  }

  /********************************************************************
   * ✅ UI：隔离到 Shadow DOM，避免影响页面
   ********************************************************************/
  let ui = { host:null, shadow:null, status:null, panel:null, btn:null, running:false };

  function ensureUI() {
    // 只创建一次
    let host = document.getElementById("uai-exporter-host");
    if (host && ui.shadow) return;

    if (!host) {
      host = document.createElement("div");
      host.id = "uai-exporter-host";
      host.style.position = "fixed";
      host.style.right = "14px";
      host.style.bottom = "14px";
      host.style.zIndex = "2147483647";
      document.body.appendChild(host);
    }

    const shadow = host.shadowRoot || host.attachShadow({ mode: "open" });

    // 清理旧内容（避免重复注入）
    while (shadow.firstChild) shadow.removeChild(shadow.firstChild);

    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .root{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, "PingFang SC", "Microsoft YaHei", Arial; }
      .btn{ display:inline-flex; align-items:center; padding:10px 12px; border-radius:12px; border:1px solid rgba(0,0,0,.18); background:rgba(18,18,18,.88); color:#fff; font-size:13px; cursor:pointer; user-select:none; backdrop-filter: blur(6px);}
      .btn:hover{ background:rgba(18,18,18,.95); }
      .status{ margin-bottom:10px; padding:8px 10px; border-radius:12px; border:1px solid rgba(0,0,0,.15); background:rgba(255,255,255,.92); color:#111; font-size:12px; display:none; max-width:520px; white-space:pre-wrap; }
      .panel{ margin-bottom:10px; padding:10px 10px; border-radius:12px; border:1px solid rgba(0,0,0,.15); background:rgba(255,255,255,.96); color:#111; font-size:12px; display:none; max-width:520px; box-shadow:0 10px 30px rgba(0,0,0,.12); }
      .row{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:4px 0; }
      .row label{ display:flex; align-items:center; gap:8px; cursor:pointer; }
      .sel, .input{ font-size:12px; padding:4px 6px; border-radius:8px; border:1px solid rgba(0,0,0,.2); background:#fff; color:#111; }
      .actions{ display:flex; gap:8px; flex-wrap:wrap; margin-top:8px; }
      .mini{ padding:6px 8px; border-radius:10px; border:1px solid rgba(0,0,0,.15); background:#fff; cursor:pointer; color:#111; }
      .mini:hover{ background:#f4f4f4; }
      .hint{ opacity:.75; margin-top:6px; line-height:1.35; white-space:pre-wrap; color:#111; }
      .title{ font-weight:700; margin-bottom:6px; }
    `;
    shadow.appendChild(style);

    const root = document.createElement("div");
    root.className = "root";

    const status = document.createElement("div");
    status.className = "status";

    const panel = document.createElement("div");
    panel.className = "panel";

    const btn = document.createElement("div");
    btn.className = "btn";
    btn.textContent = "Export";
    btn.title = "Export current conversation (local-first)";
    btn.addEventListener("click", ()=> togglePanel());

    root.appendChild(status);
    root.appendChild(panel);
    root.appendChild(btn);
    shadow.appendChild(root);

    ui.host = host;
    ui.shadow = shadow;
    ui.status = status;
    ui.panel = panel;
    ui.btn = btn;

    renderPanel();
  }

  function updateStatus(t) { ensureUI(); ui.status.style.display="block"; ui.status.textContent=t||""; }
  function clearStatus(ms=1200) { setTimeout(()=>{ if(!ui.status) return; ui.status.style.display="none"; ui.status.textContent=""; }, ms); }

  function togglePanel(force) {
    ensureUI();
    const show = (typeof force==="boolean") ? force : (ui.panel.style.display!=="block");
    ui.panel.style.display = show ? "block" : "none";
  }

  function renderPanel() {
    ensureUI();
    const panel = ui.panel;
    while (panel.firstChild) panel.removeChild(panel.firstChild);

    const row = (l, r) => { const d=document.createElement("div"); d.className="row"; d.appendChild(l); if(r) d.appendChild(r); return d; };

    const makeCheckbox = (k, text) => {
      const lab=document.createElement("label");
      const cb=document.createElement("input"); cb.type="checkbox"; cb.checked=!!SETTINGS[k];
      cb.addEventListener("change", ()=>{ SETTINGS[k]=cb.checked; saveSettings(SETTINGS); renderPanel(); });
      const sp=document.createElement("span"); sp.textContent=text;
      lab.appendChild(cb); lab.appendChild(sp); return lab;
    };

    const makeSelect = (k, opts) => {
      const sel=document.createElement("select"); sel.className="sel";
      for (const [v,lab] of opts) {
        const o=document.createElement("option");
        o.value=v; o.textContent=lab;
        if(SETTINGS[k]===v) o.selected=true;
        sel.appendChild(o);
      }
      sel.addEventListener("change", ()=>{ SETTINGS[k]=sel.value; saveSettings(SETTINGS); renderPanel(); });
      return sel;
    };

    const makeText = (k, placeholder, widthPx=220) => {
      const input=document.createElement("input");
      input.className="input";
      input.type="text";
      input.placeholder=placeholder;
      input.value = SETTINGS[k] || "";
      input.style.width = `${widthPx}px`;
      input.addEventListener("input", ()=>{ SETTINGS[k]=input.value || ""; saveSettings(SETTINGS); });
      return input;
    };

    const title=document.createElement("div");
    title.className="title";
    title.textContent="Exporter Settings";
    panel.appendChild(title);

    panel.appendChild(row(makeCheckbox("autoLoadAll","自动尽量加载完整历史"), null));
    panel.appendChild(row(makeCheckbox("allowClickLoadMoreButtons","允许尝试点击“加载更多”"), null));
    panel.appendChild(row(makeCheckbox("exportVisibleOnly","仅导出视觉可见内容"), null));

    panel.appendChild(row(makeCheckbox("attachmentFallbackScan","附件/图片兜底扫描（ChatGPT/Gemini/Grok）"), null));
    panel.appendChild(row(makeCheckbox("relocateUiImageBlocks","修复并移动 UI 的 Images 区块（避免重复/位置错误）"), null));

    panel.appendChild(row(document.createTextNode("文件名前缀"), makeText("filenamePrefix", "例如：AI_", 160)));
    panel.appendChild(row(makeCheckbox("includeTimestampInFilename","文件名包含时间戳（自定义文件名时无效）"), null));
    panel.appendChild(row(makeCheckbox("useCustomFilename","使用自定义文件名（覆盖标题，不加时间戳）"), null));
    if (SETTINGS.useCustomFilename) {
      panel.appendChild(row(document.createTextNode("自定义文件名"), makeText("customFilename", "不含扩展名，如：我的对话", 260)));
    }

    panel.appendChild(row(makeCheckbox("includeReasoning","包含已展开的“显示思路/已思考”"), null));
    panel.appendChild(row(makeCheckbox("autoExpandReasoning","导出时自动展开“显示思路/已思考”"), null));

    panel.appendChild(row(makeCheckbox("preferBlockMathForMultiline","多行/环境公式输出为块公式 $$...$$"), null));
    panel.appendChild(row(makeCheckbox("normalizeMultilineMath","多行公式兼容化（array→aligned）"), null));

    panel.appendChild(row(makeCheckbox("embedImagesInMarkdown","图片内嵌到 MD（data URI）"), null));
    if (SETTINGS.embedImagesInMarkdown) {
      panel.appendChild(row(document.createTextNode("data URI 渲染"), makeSelect("dataUriImageMode", [["html","HTML <img>（Typora 友好）"],["md","Markdown ![]()"]])) );
      panel.appendChild(row(makeCheckbox("allowImageFetch","允许 fetch 图片（提高跨域图内嵌成功率）"), null));
    }

    panel.appendChild(row(document.createTextNode("标题风格"), makeSelect("headingStyle", [["role","按角色（User/Assistant）"],["qa","按 Q/A"]])));

    panel.appendChild(row(document.createTextNode("导出格式"), makeSelect("exportFormat", [["md","Markdown (.md)"],["json","JSON (.json)"]])));

    const actions=document.createElement("div"); actions.className="actions";
    const b1=document.createElement("button"); b1.className="mini"; b1.textContent="导出下载"; b1.onclick=()=>runExport({mode:"download"});
    const b2=document.createElement("button"); b2.className="mini"; b2.textContent="复制 Markdown"; b2.onclick=()=>runExport({mode:"copy-md"});
    const b3=document.createElement("button"); b3.className="mini"; b3.textContent=SETTINGS.debug?"关闭 Debug":"开启 Debug";
    b3.onclick=()=>{ SETTINGS.debug=!SETTINGS.debug; saveSettings(SETTINGS); renderPanel(); };
    actions.appendChild(b1); actions.appendChild(b2); actions.appendChild(b3);
    panel.appendChild(actions);

    const hint=document.createElement("div"); hint.className="hint";
    hint.textContent =
` 1.基本用法：
 1) 打开任意一条对话页面
 2) 右下角点击 Export → 打开设置面板
 3) 点「导出下载」生成文件，或点「复制 Markdown」直接复制到剪贴板
 2.主要功能点：
 - 自动加载历史（可选）：导出前尝试上滑加载更多 + 点击“加载更多/展开”等按钮
 - Reasoning/思路（可选）：可包含“已思考/显示思路”，并可在导出时自动展开
 - 数学公式：提取 KaTeX/MathML/属性里的 TeX；多行公式可转块公式 $$...$$，并可 array→aligned
 - 图片：默认导出为图片链接；可选内嵌为 data URI（离线友好）
 - UI 隔离：设置面板使用 Shadow DOM，尽量避免影响原网页样式/交互
 3. 隐私与网络请求：
 - 默认不上传任何对话内容；默认不主动发起网络请求`;
    panel.appendChild(hint);
  }

  /********************
   * 主流程（仅在点击导出时跑，不会常驻改页面）
   ********************/
  async function runExport({mode}) {
    if (ui.running) return;
    ui.running=true;
    ensureUI();

    try {
      const platform = detectPlatform();
      const adapter = Adapters[platform];
      if (!adapter) { alert("Unsupported site."); return; }

      togglePanel(false);
      ui.btn.textContent="Working…";
      updateStatus("Preparing…");

      await autoLoadAll(adapter);

      if (SETTINGS.includeReasoning && SETTINGS.autoExpandReasoning) {
        updateStatus("Expanding reasoning…");
        await expandReasoning(adapter);
        await sleep(200);
      }

      updateStatus("Extracting & converting…");
      const convo = await extractConversation(adapter, platform);
      if (!convo.messages.length) { alert("No messages found."); return; }

      if (mode==="copy-md") {
        const md = buildMarkdownDoc(convo);
        updateStatus("Copying to clipboard…");
        const ok = await copyToClipboard(md);
        updateStatus(ok ? "Copied Markdown ✅" : "Copy failed ❌");
        clearStatus(1500);
        return;
      }

      if (SETTINGS.exportFormat==="json") {
        const content = buildJsonDoc(convo);
        const filename = buildFilename(convo.title, ".json");
        updateStatus(`Downloading: ${filename}`);
        downloadText(filename, content, "application/json;charset=utf-8");
        clearStatus(1200);
      } else {
        const content = buildMarkdownDoc(convo);
        const filename = buildFilename(convo.title, ".md");
        updateStatus(`Downloading: ${filename}`);
        downloadText(filename, content, "text/markdown;charset=utf-8");
        clearStatus(1200);
      }
    } catch(e) {
      console.error(e);
      updateStatus(`Failed: ${String(e?.message||e)}`);
      alert(`Export failed: ${String(e?.message||e)}`);
    } finally {
      ui.btn.textContent="Export";
      ui.running=false;
    }
  }

  /********************
   * 启动：只注入一次 UI，不使用全局 MutationObserver/疯狂 setInterval
   ********************/
  function boot() {
    ensureUI();
    // 如果 SPA 切页导致 host 被删除，轻量重建（低频）
    setInterval(() => {
      if (!document.getElementById("uai-exporter-host")) {
        try { ui = { host:null, shadow:null, status:null, panel:null, btn:null, running:false }; } catch {}
        ensureUI();
      }
    }, 3000);
  }

  if (document.readyState==="complete" || document.readyState==="interactive") boot();
  else window.addEventListener("DOMContentLoaded", boot, {once:true});
})();
