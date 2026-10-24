'use strict';

/**
 * 大模型调用（OpenAI 兼容的 /chat/completions 接口）。
 *
 * 支持两个供应商，通过 LLM_PROVIDER 切换：
 *   deepseek  （默认）：https://api.deepseek.com                     ：deepseek-flash
 *   dashscope        ：https://dashscope.aliyuncs.com/compatible-mode/v1 ：qwen-plus
 *
 * 可用环境变量：
 *   LLM_PROVIDER   供应商，deepseek | dashscope（默认 deepseek）
 *   DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / LLM_API_KEY   密钥（按供应商取）
 *   LLM_MODEL      覆盖模型名（模型名以厂商控制台/文档为准，可用 --models 查询）
 *   LLM_BASE_URL   覆盖接口地址（换网关/换地域时用）
 *
 * ⚠ 状态（P-10 诚实原则）：**实网调用尚未验证**（编写时没有 Key）。
 *   provider 解析、端点拼接等纯逻辑已离线测试；拿到 Key 后必须实测一次。
 *
 * 约束：
 *   1. 只用 node 内置 https，不引入 SDK（P-02 核心零依赖）；
 *   2. 密钥只从 process.env 读，不打印、不落日志、不写文件（P-05）；
 *   3. temperature 压到 0.1，尽量降低同一输入的输出漂移（P-06 精神）。
 */

const https = require('https');

const PROVIDERS = {
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    keyEnv: 'DEEPSEEK_API_KEY',
    console: 'https://platform.deepseek.com/api_keys'
  },
  dashscope: {
    id: 'dashscope',
    name: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    keyEnv: 'DASHSCOPE_API_KEY',
    console: 'https://bailian.console.aliyun.com/'
  }
};

const DEFAULT_PROVIDER = 'deepseek';

function listProviders() {
  return Object.keys(PROVIDERS).map((k) => ({
    id: PROVIDERS[k].id,
    name: PROVIDERS[k].name,
    baseUrl: PROVIDERS[k].baseUrl,
    model: PROVIDERS[k].model,
    keyEnv: PROVIDERS[k].keyEnv,
    console: PROVIDERS[k].console
  }));
}

/**
 * 把 Base URL 解析成 hostname + port + path。
 * 允许写法：https://host  /  https://host/v1  /  https://host/compatible-mode/v1
 * 末尾统一补 /chat/completions。
 */
function resolveEndpoint(baseUrl) {
  const raw = String(baseUrl || PROVIDERS[DEFAULT_PROVIDER].baseUrl)
    .trim()
    .replace(/\/+$/, '');
  const u = new URL(raw);
  let path = u.pathname.replace(/\/+$/, '');
  if (path === '/') path = '';
  path = path + '/chat/completions';
  return {
    baseUrl: raw,
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || '',
    path: path
  };
}

/**
 * 合并「参数 > 环境变量 > 供应商默认值」，得到一次调用所需的完整配置。
 * 不发起网络请求，可安全用于离线检查。
 */
function resolveConfig(overrides) {
  const o = overrides || {};
  const wanted = String(o.provider || process.env.LLM_PROVIDER || DEFAULT_PROVIDER).toLowerCase();
  const provider = PROVIDERS[wanted] || PROVIDERS[DEFAULT_PROVIDER];

  const apiKey = o.apiKey !== undefined
    ? o.apiKey
    : (process.env[provider.keyEnv] || process.env.LLM_API_KEY || '');

  const model = o.model || process.env.LLM_MODEL || provider.model;
  const baseUrl = o.baseUrl || process.env.LLM_BASE_URL || provider.baseUrl;
  const endpoint = resolveEndpoint(baseUrl);

  return {
    providerId: provider.id,
    providerName: provider.name,
    keyEnv: provider.keyEnv,
    console: provider.console,
    apiKey: apiKey,
    hasKey: apiKey !== '',
    model: model,
    baseUrl: endpoint.baseUrl,
    endpoint: endpoint
  };
}

function requestJson(cfg, method, path, payload, timeoutMs) {
  const body = payload ? JSON.stringify(payload) : '';
  return new Promise((resolve, reject) => {
    const requestOptions = {
      hostname: cfg.endpoint.hostname,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.apiKey
      },
      timeout: timeoutMs || 60000
    };
    if (cfg.endpoint.port) requestOptions.port = cfg.endpoint.port;
    if (body) requestOptions.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(requestOptions, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error('HTTP ' + res.statusCode + '（' + cfg.providerName + '）：' + text.slice(0, 400)));
          return;
        }
        try {
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error('响应解析失败: ' + e.message));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时（' + (timeoutMs || 60000) + 'ms）')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * @param {{apiKey?:string, messages:Array, model?:string, baseUrl?:string, provider?:string, timeoutMs?:number}} opts
 * @returns {Promise<{content:string, usage:object|null, model:string, provider:string}>}
 */
function callChat(opts) {
  const options = opts || {};
  const cfg = resolveConfig(options);
  if (!cfg.hasKey) {
    return Promise.reject(new Error('缺少 API Key（环境变量 ' + cfg.keyEnv + '）'));
  }

  const payload = {
    model: cfg.model,
    messages: options.messages || [],
    temperature: 0.1
  };

  return requestJson(cfg, 'POST', cfg.endpoint.path, payload, options.timeoutMs).then((data) => {
    const choice = data.choices && data.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error('响应中没有 choices[0].message.content');
    return {
      content: content,
      usage: data.usage || null,
      model: data.model || cfg.model,
      provider: cfg.providerId
    };
  });
}

/**
 * 列出当前 Key 可用的模型（GET /models）。
 * 模型名会随厂商迭代变化，先用它查一次再填 LLM_MODEL，比猜名字可靠。
 */
function listModels(opts) {
  const cfg = resolveConfig(opts);
  if (!cfg.hasKey) {
    return Promise.reject(new Error('缺少 API Key（环境变量 ' + cfg.keyEnv + '）'));
  }
  const modelsPath = cfg.endpoint.path.replace(/\/chat\/completions$/, '/models');
  return requestJson(cfg, 'GET', modelsPath, null, opts && opts.timeoutMs).then((data) => {
    const rows = Array.isArray(data.data) ? data.data : [];
    return rows.map((m) => m.id || m.name || '').filter((x) => x !== '');
  });
}

module.exports = {
  callChat,
  listModels,
  resolveConfig,
  resolveEndpoint,
  listProviders,
  PROVIDERS,
  DEFAULT_PROVIDER
};
