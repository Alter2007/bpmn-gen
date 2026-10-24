#!/usr/bin/env node
'use strict';

/**
 * 本地应用服务（前台进程，Ctrl+C 即停，不注册任何服务、不建数据库）。
 *
 * 与前一个版本的差别：现在支持网页直接生成。
 * 生成是**同进程直接 require 核心模块**完成的，不 spawn 子进程（P-04 不破例）。
 *
 * 端点：
 *   GET  /                  页面
 *   GET  /api/health        运行状态（供应商 / 模型 / 是否有 Key）
 *   GET  /api/templates     模板清单
 *   GET  /api/list          已生成的 bpmn 列表
 *   GET  /api/file?name=    取某个 bpmn
 *   POST /api/generate      { text, mode: 'auto' | 'offline' } -> 生成并保存
 *
 * 用法: node web/serve.js [端口]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadTemplates, listTemplates, generateFromText, buildFromTemplate } = require('../src/nl');
const { buildSystemPrompt, buildUserMessage, parseModelOutput } = require('../src/prompt');
const { runPipeline } = require('../src/pipeline');
const { callChat, resolveConfig } = require('../src/llm');

const PORT = Number(process.argv[2] || 8099);
const HOST = '127.0.0.1';
const WEB = __dirname;
const OUT = path.join(__dirname, '..', '..', '.data', 'out');
const DIST = path.join(__dirname, 'node_modules', 'bpmn-js', 'dist');
const MAX_BODY = 256 * 1024;

// 运行时密钥：只存在于本进程内存，绝不写盘、不写日志（P-05）
// 来源优先级：界面设置的内存值 > 环境变量
let runtimeKey = '';

function currentConfig() {
  return resolveConfig(runtimeKey ? { apiKey: runtimeKey } : {});
}

// 心跳：页面活着就定时报一次。窗口关掉后超过阈值没动静，服务自动退出。
// 目的：避免残留进程一直占着内存里的旧密钥，导致「下次打开莫名已就绪」。
let lastPing = 0;
let sawPing = false;
const IDLE_LIMIT_MS = 35000;

// 进程标识：每次启动都不同。前端据此发现「服务换了」，从而刷新界面状态，
// 避免页面还停在旧进程的「已就绪」上、实际却拿不到密钥。
const SESSION_ID = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);

function maskKey(k) {
  if (!k) return '';
  if (k.length <= 8) return '****';
  return k.slice(0, 5) + '…' + k.slice(-4);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.bpmn': 'application/xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.ico': 'image/x-icon'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}
function sendJson(res, code, obj) {
  send(res, code, JSON.stringify(obj), MIME['.json']);
}
function serveFile(res, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    send(res, 404, 'not found');
    return;
  }
  if (st.isDirectory()) { send(res, 404, 'is a directory'); return; }
  const ext = path.extname(file).toLowerCase();
  send(res, 200, fs.readFileSync(file), MIME[ext] || 'application/octet-stream');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > MAX_BODY) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function ensureOut() {
  if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
}

function listBpmn() {
  ensureOut();
  return fs
    .readdirSync(OUT)
    .filter((f) => f.toLowerCase().endsWith('.bpmn'))
    .map((f) => {
      const st = fs.statSync(path.join(OUT, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function safeName(name) {
  return /^[\w\-. \u4e00-\u9fa5]+\.bpmn$/i.test(name);
}

// ---- 交互式澄清的阈值 ----
// 关键词得分低于 MIN_SCORE，或第一名与第二名差距小于 MARGIN，视为"没把握"，先反问；
// 大模型路径看置信度。宁可多问一句，也不要生成一个错的流程让用户重来。
const MIN_SCORE = 4;
const MARGIN = 2;
const CONFIDENCE_THRESHOLD = 0.7;

function buildCandidates(ranked, limit) {
  return (ranked || [])
    .filter((r) => r && r.score > 0)
    .slice(0, limit || 3)
    .map((r) => ({
      templateId: r.templateId,
      name: r.name,
      description: (r.template && r.template.description) || '',
      score: r.score,
      hits: r.hits || []
    }));
}

function clarifyPayload(question, candidates, extra) {
  return {
    code: 200,
    payload: Object.assign(
      {
        ok: false,
        needClarify: true,
        question: question,
        candidates: candidates
      },
      extra || {}
    )
  };
}

async function handleGenerate(body) {
  const started = Date.now();
  const text = String(body.text || '').trim();
  if (text === '') return { code: 400, payload: { ok: false, error: '请先输入业务描述' } };

  const templates = loadTemplates();
  const cfg = currentConfig();
  const wantOffline = body.mode === 'offline' || !cfg.hasKey;
  const pick = String(body.pickTemplate || '').trim();

  const meta = {
    mode: wantOffline ? 'offline' : 'llm',
    provider: cfg.providerName,
    model: cfg.model,
    templateId: '',
    confidence: null,
    reason: '',
    filled: {},
    actions: [],
    warnings: [],
    tokens: null
  };

  // ---- 用户在澄清卡片里手动选定了模板：直接按模板渲染，不再猜 ----
  if (pick !== '') {
    const built = buildFromTemplate(pick, {}, text);
    if (!built) {
      return { code: 422, payload: { ok: false, error: '未知模板：' + pick } };
    }
    meta.mode = 'picked';
    meta.templateId = pick;
    meta.reason = '用户手动确认模板';
    meta.filled = built.values;
    const result = runPipeline(built.ir, { repair: true });
    if (!result.ok) {
      return { code: 422, payload: { ok: false, error: '生成的流程未通过校验', errors: result.errors } };
    }
    return finishGenerate(body, meta, result, started, pick);
  }

  let ir;
  try {
    if (wantOffline) {
      const g = generateFromText(text);
      const ranked = g.ranked || [];
      const top = ranked[0];
      const second = ranked[1];
      const unsure =
        !g.ok ||
        !top ||
        top.score < MIN_SCORE ||
        (second && second.score > 0 && top.score - second.score < MARGIN);

      if (unsure && ranked.length > 0) {
        const cands = buildCandidates(ranked, 3);
        if (cands.length === 0) {
          // 一个关键词都没命中：给不出候选，直接让人补充描述
          return {
            code: 422,
            payload: {
              ok: false,
              error: '没有识别出场景：请补充业务描述（例如"差旅报销，金额小于1000主管批"），或直接指定模板'
            }
          };
        }
        return clarifyPayload(
          '这句话我没把握归到哪一类流程，先确认一下（选一个，或把描述写细一点）：',
          cands,
          { source: 'offline', topScore: top ? top.score : 0 }
        );
      }
      if (!g.ok) {
        return { code: 422, payload: { ok: false, error: g.error, ranked: ranked } };
      }
      meta.templateId = g.templateId;
      meta.confidence = null;
      meta.filled = g.filled;
      meta.warnings = g.warnings || [];
      ir = g.ir;
    } else {
      const sys = buildSystemPrompt(templates);
      const usr = buildUserMessage(text);
      const r = await callChat({
        apiKey: cfg.apiKey,           // 必须显式传入：否则 callChat 内部只读环境变量，界面里设的 Key 会丢
        provider: cfg.providerId,
        model: cfg.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: usr }
        ],
        timeoutMs: 45000
      });
      const parsed = parseModelOutput(r.content, templates);
      if (!parsed.ok) {
        return { code: 422, payload: { ok: false, error: '模型输出不可用：' + parsed.error, raw: String(r.content).slice(0, 500) } };
      }

      // 模型自己也不确定：把它的判断 + 关键词候选一起摆出来，让人来定
      const conf = typeof parsed.confidence === 'number' ? parsed.confidence : 1;
      if (conf < CONFIDENCE_THRESHOLD) {
        const ranked = require('../src/nl').rankTemplates(text, templates);
        const cands = buildCandidates(ranked, 3);
        const modelPick = {
          templateId: parsed.templateId,
          name: (templates.find((t) => t.templateId === parsed.templateId) || {}).name || parsed.templateId,
          description: '模型判断（置信度 ' + conf + '）',
          score: 0,
          hits: []
        };
        const merged = [modelPick].concat(
          cands.filter((c) => c.templateId !== parsed.templateId)
        ).slice(0, 3);
        return clarifyPayload(
          '模型不太确定（置信度 ' + conf + '），请确认是哪一类流程：',
          merged,
          {
            source: 'llm',
            confidence: conf,
            reason: parsed.reason || '',
            tokens: r.usage ? { in: r.usage.prompt_tokens, out: r.usage.completion_tokens } : null
          }
        );
      }

      meta.templateId = parsed.templateId;
      meta.confidence = parsed.confidence;
      meta.reason = parsed.reason;
      meta.warnings = parsed.warnings || [];
      if (r.usage) meta.tokens = { in: r.usage.prompt_tokens, out: r.usage.completion_tokens };
      const built = buildFromTemplate(parsed.templateId, parsed.slots, text);
      if (!built) return { code: 500, payload: { ok: false, error: '模板渲染失败: ' + parsed.templateId } };
      meta.filled = built.values;
      ir = built.ir;
    }
  } catch (e) {
    return { code: 502, payload: { ok: false, error: '生成失败：' + (e && e.message ? e.message : e) } };
  }

  const result = runPipeline(ir, { repair: true });
  if (!result.ok) {
    return { code: 422, payload: { ok: false, error: '生成的流程未通过校验', errors: result.errors, actions: result.actions } };
  }
  return finishGenerate(body, meta, result, started, meta.templateId);
}

/** 管线通过之后的收尾：写文件 + 组装返回体 */
function finishGenerate(body, meta, result, started, templateId) {
  meta.actions = result.actions;

  ensureOut();
  const fileName = templateId + '-' + stamp() + '.bpmn';
  fs.writeFileSync(path.join(OUT, fileName), result.xml, 'utf8');

  return {
    code: 200,
    payload: {
      ok: true,
      file: fileName,
      xml: result.xml,
      meta: Object.assign({}, meta, {
        nodes: result.ir.nodes.length,
        flows: result.ir.flows.length,
        bytes: Buffer.byteLength(result.xml, 'utf8'),
        ms: Date.now() - started,
        name: result.ir.name
      })
    }
  };
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://' + HOST);
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'bad url' });
    return;
  }
  const p = decodeURIComponent(url.pathname);

  // ---------- API ----------
  if (p === '/api/health') {
    const cfg = currentConfig();
    sendJson(res, 200, {
      ok: true,
      provider: cfg.providerName,
      providerId: cfg.providerId,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      hasKey: cfg.hasKey,
      keyEnv: cfg.keyEnv,
      sid: SESSION_ID,
      templates: loadTemplates().length,
      flows: listBpmn().length
    });
    return;
  }

  if (p === '/api/templates') {
    sendJson(res, 200, { ok: true, templates: listTemplates() });
    return;
  }

  if (p === '/api/list') {
    sendJson(res, 200, listBpmn());
    return;
  }

  if (p === '/api/file') {
    const name = url.searchParams.get('name') || '';
    if (!safeName(name)) { sendJson(res, 400, { ok: false, error: 'bad file name' }); return; }
    const target = path.resolve(OUT, name);
    if (!target.startsWith(path.resolve(OUT) + path.sep)) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
    serveFile(res, target);
    return;
  }

  if (p === '/api/ping') {
    lastPing = Date.now();
    sawPing = true;
    sendJson(res, 200, { ok: true, sid: SESSION_ID });
    return;
  }

  if (p === '/api/key') {
    const cfg = currentConfig();

    if (req.method === 'GET') {
      const fromEnv = !runtimeKey && cfg.hasKey;
      const raw = runtimeKey || (fromEnv ? process.env[cfg.keyEnv] || '' : '');
      sendJson(res, 200, {
        ok: true,
        hasKey: cfg.hasKey,
        source: runtimeKey ? 'memory' : (fromEnv ? 'env' : 'none'),
        masked: cfg.hasKey ? maskKey(raw) : '',
        provider: cfg.providerName,
        model: cfg.model
      });
      return;
    }

    if (req.method === 'POST') {
      let body;
      try {
        body = JSON.parse((await readBody(req)) || '{}');
      } catch (e) {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
        return;
      }
      const key = String(body.key || '').trim();
      if (key === '') { sendJson(res, 400, { ok: false, error: '密钥不能为空' }); return; }
      if (key.length < 16) { sendJson(res, 400, { ok: false, error: '密钥看起来太短，请确认是否粘贴完整' }); return; }

      runtimeKey = key;
      const c2 = currentConfig();
      // 只打印长度，不打印内容
      console.log('[密钥] 界面中已设置（仅内存，长度 ' + key.length + '），不写盘');
      sendJson(res, 200, {
        ok: true,
        hasKey: true,
        source: 'memory',
        masked: maskKey(key),
        model: c2.model,
        warning: /^sk-/.test(key) ? '' : '提示：DeepSeek 密钥通常以 sk- 开头，请确认没有粘错'
      });
      return;
    }

    if (req.method === 'DELETE') {
      runtimeKey = '';
      console.log('[密钥] 已从内存清除');
      sendJson(res, 200, { ok: true, hasKey: false, source: 'none' });
      return;
    }

    sendJson(res, 405, { ok: false, error: '只支持 GET / POST / DELETE' });
    return;
  }

  if (p === '/api/shutdown') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '请用 POST' }); return; }
    sendJson(res, 200, { ok: true, message: '服务即将退出' });
    setTimeout(() => {
      console.log('[退出] 收到界面请求，进程结束');
      process.exit(0);
    }, 200);
    return;
  }

  if (p === '/api/generate') {
    if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: '请用 POST' }); return; }
    let body;
    try {
      body = JSON.parse((await readBody(req)) || '{}');
    } catch (e) {
      sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
      return;
    }
    const out = await handleGenerate(body);
    sendJson(res, out.code, out.payload);
    return;
  }

  // ---------- 静态资源 ----------
  if (p.startsWith('/vendor/')) {
    serveFile(res, path.join(DIST, p.slice('/vendor/'.length)));
    return;
  }
  if (p === '/' || p === '/index.html') {
    serveFile(res, path.join(WEB, 'index.html'));
    return;
  }
  const safe = path.resolve(WEB, p.replace(/^\/+/, ''));
  if (!safe.startsWith(path.resolve(WEB) + path.sep)) { sendJson(res, 400, { ok: false, error: 'bad path' }); return; }
  serveFile(res, safe);
}

// ---- 兜底：任何请求异常只影响这一次请求，绝不能让整个服务退出 ----
// （Node 15+ 的未处理 Promise 拒绝默认会终止进程，这是踩过的坑）
process.on('unhandledRejection', (e) => {
  console.log('[未处理的 Promise 拒绝] ' + (e && e.stack ? e.stack : e));
});
process.on('uncaughtException', (e) => {
  console.log('[未捕获异常] ' + (e && e.stack ? e.stack : e));
});

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((e) => {
    console.log('[请求失败] ' + req.method + ' ' + req.url + ' -> ' + (e && e.message ? e.message : e));
    try {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e) });
      } else {
        res.end();
      }
    } catch (ignore) { /* 响应已不可写，忽略 */ }
  });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  const cfg = currentConfig();
  ensureOut();
  console.log('');
  console.log('=== BPMN 生成器 · 本地应用 ===');
  console.log('  地址  : http://' + HOST + ':' + PORT);
  console.log('  数据  : ' + OUT);
  console.log('  模型  : ' + cfg.providerName + ' / ' + cfg.model + '（Key ' + (cfg.hasKey ? '已就绪' : '未设置 —— 可在网页「设置」里粘贴，或只用离线模板') + '）');
  console.log('  模板  : ' + loadTemplates().length + ' 个');
  console.log('  说明  : 前台进程；关闭页面约 35 秒后自动退出，不注册服务、不建数据库');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('[ERR] 端口 ' + PORT + ' 被占用。若为上次残留进程，可用启动器重新打开，或运行 停止应用.vbs');
  } else {
    console.log('[ERR] ' + e.message);
  }
  process.exit(1);
});

// 空闲看门狗：页面关掉后自动收工（刷新页面有 35 秒宽限，不受影响）
setInterval(() => {
  if (sawPing && Date.now() - lastPing > IDLE_LIMIT_MS) {
    console.log('[空闲] 页面已关闭超过 35 秒，服务自动退出');
    process.exit(0);
  }
}, 5000);
