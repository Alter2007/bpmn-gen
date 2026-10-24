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

async function handleGenerate(body) {
  const started = Date.now();
  const text = String(body.text || '').trim();
  if (text === '') return { code: 400, payload: { ok: false, error: '请先输入业务描述' } };

  const templates = loadTemplates();
  const cfg = resolveConfig({});
  const wantOffline = body.mode === 'offline' || !cfg.hasKey;

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

  let ir;
  try {
    if (wantOffline) {
      const g = generateFromText(text);
      if (!g.ok) {
        return { code: 422, payload: { ok: false, error: g.error, ranked: g.ranked || [] } };
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
  meta.actions = result.actions;

  ensureOut();
  const fileName = meta.templateId + '-' + stamp() + '.bpmn';
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
    const cfg = resolveConfig({});
    sendJson(res, 200, {
      ok: true,
      provider: cfg.providerName,
      providerId: cfg.providerId,
      model: cfg.model,
      baseUrl: cfg.baseUrl,
      hasKey: cfg.hasKey,
      keyEnv: cfg.keyEnv,
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
  const cfg = resolveConfig({});
  ensureOut();
  console.log('');
  console.log('=== BPMN 生成器 · 本地应用 ===');
  console.log('  地址  : http://' + HOST + ':' + PORT);
  console.log('  数据  : ' + OUT);
  console.log('  模型  : ' + cfg.providerName + ' / ' + cfg.model + '（Key ' + (cfg.hasKey ? '已就绪' : '未设置，将只用离线模板') + '）');
  console.log('  模板  : ' + loadTemplates().length + ' 个');
  console.log('  说明  : 前台进程，Ctrl+C 结束；不注册服务、不建数据库');
  console.log('');
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.log('[ERR] 端口 ' + PORT + ' 被占用，换一个: node web/serve.js 8100');
  } else {
    console.log('[ERR] ' + e.message);
  }
  process.exit(1);
});
