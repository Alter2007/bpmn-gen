'use strict';

/**
 * S3：自然语言 -> IR（离线版，不依赖任何大模型）。
 *
 * 三段：
 *   1. 匹配：关键词加权打分（得分 = 关键词长度 × 出现次数），选出最可能的模板
 *   2. 抽取：数字（支持"5万/3千"）、业务名词
 *   3. 填充：数字按模板声明的槽位顺序代入，渲染成合法 IR
 *
 * 关键点：LLM 将来接入时也走这条路——模型只负责"选模板 + 填参数"，
 * 不负责生成结构（P-07）。所以离线跑通 = LLM 接入的地基已经打好了。
 */

const fs = require('fs');
const path = require('path');

const TEMPLATE_DIR = path.join(__dirname, 'templates');
let cache = null;

function loadTemplates(fresh) {
  if (cache && !fresh) return cache;
  if (!fs.existsSync(TEMPLATE_DIR)) { cache = []; return cache; }
  const files = fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json')).sort();
  const list = [];
  for (const f of files) {
    const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, f), 'utf8'));
    tpl.__file = f;
    list.push(tpl);
  }
  cache = list;
  return cache;
}

function listTemplates() {
  return loadTemplates().map((t) => ({
    templateId: t.templateId,
    name: t.name,
    description: t.description,
    keywords: t.keywords,
    nodeCount: (t.nodes || []).length,
    flowCount: (t.flows || []).length
  }));
}

function countOccurrences(text, kw) {
  let n = 0;
  let i = 0;
  while ((i = text.indexOf(kw, i)) !== -1) { n++; i += kw.length; }
  return n;
}

function scoreTemplate(text, tpl) {
  let score = 0;
  const hits = [];
  for (const kw of tpl.keywords || []) {
    if (!kw) continue;
    const n = countOccurrences(text, kw);
    if (n > 0) {
      score += kw.length * n;
      hits.push(kw + (n > 1 ? '×' + n : ''));
    }
  }
  return { score, hits };
}

function rankTemplates(text, templates) {
  const list = templates || loadTemplates();
  return list
    .map((t) => {
      const r = scoreTemplate(text, t);
      return { template: t, templateId: t.templateId, name: t.name, score: r.score, hits: r.hits };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.templateId).localeCompare(String(b.templateId));
    });
}

// ---------------- 抽取 ----------------
function extractNumbers(text) {
  const out = [];
  const re = /(\d+(?:\.\d+)?)\s*(万|w|W|千|k|K)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    let v = parseFloat(m[1]);
    const unit = m[2];
    if (unit === '万' || unit === 'w' || unit === 'W') v = v * 10000;
    else if (unit === '千' || unit === 'k' || unit === 'K') v = v * 1000;
    out.push(v);
  }
  return out;
}

function uniqueNumbers(list) {
  const seen = new Set();
  const out = [];
  for (const n of list) {
    if (!seen.has(n)) { seen.add(n); out.push(n); }
  }
  return out;
}

const SUBJECT_RULES = [
  { key: '报销', words: ['报销', '差旅', '费用', '发票', '垫付'] },
  { key: '请假', words: ['请假', '休假', '年假', '调休', '病假'] },
  { key: '采购', words: ['采购', '购买', '供应商', '询价', '申购'] },
  { key: '合同', words: ['合同', '法务', '会签', '条款'] },
  { key: '用章', words: ['用章', '盖章', '公章', '印章', '用印'] },
  { key: '入职', words: ['入职', '新员工', '报到'] }
];

function detectSubject(text) {
  for (const rule of SUBJECT_RULES) {
    for (const w of rule.words) {
      if (text.indexOf(w) !== -1) return rule.key;
    }
  }
  return null;
}

// ---------------- 渲染 ----------------
const PLACEHOLDER = /@([A-Za-z_][A-Za-z0-9_]*)@/g;

function renderString(s, values) {
  if (typeof s !== 'string') return s;
  return s.replace(PLACEHOLDER, (all, key) => {
    if (Object.prototype.hasOwnProperty.call(values, key)) return String(values[key]);
    return all;
  });
}

function renderDeep(value, values) {
  if (typeof value === 'string') return renderString(value, values);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, values));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = renderDeep(value[k], values);
    return o;
  }
  return value;
}

function findUnresolved(ir) {
  const found = [];
  const walk = (v) => {
    if (typeof v === 'string') {
      const m = v.match(PLACEHOLDER);
      if (m) found.push(v);
      return;
    }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') { Object.keys(v).forEach((k) => walk(v[k])); }
  };
  walk(ir);
  return found;
}

/**
 * 按模板 + 槽位值直接构建 IR（不再从文本抽取）。
 * 这是 LLM 通道的落点：模型只给 templateId + slots，结构仍由模板保证（P-07）。
 */
function buildFromTemplate(templateId, values, sourceText) {
  const templates = loadTemplates();
  const tpl = templates.filter((t) => t.templateId === templateId)[0];
  if (!tpl) return null;

  const vals = {};
  for (const s of tpl.slots || []) {
    const v = values ? values[s.name] : undefined;
    vals[s.name] = (v === undefined || v === null || v === '') ? s.default : v;
  }

  const ir = {
    id: tpl.templateId,
    name: renderString(tpl.processName || tpl.name, vals),
    processKey: tpl.processId || tpl.templateId,
    sourceText: sourceText || '',
    variables: renderDeep(tpl.variables || [], vals),
    nodes: renderDeep(tpl.nodes || [], vals),
    flows: renderDeep(tpl.flows || [], vals)
  };

  return { ir: ir, values: vals, unresolved: findUnresolved(ir), template: tpl };
}

// ---------------- 主流程 ----------------
/**
 * @param {string} text 业务人员的自然语言描述
 * @param {object} [opts] { templateId: 强制指定模板 }
 * @returns {{ok:boolean, templateId?, ir?, filled?, warnings?, ranked?, error?}}
 */
function generateFromText(text, opts) {
  const options = opts || {};
  const input = String(text || '').trim();
  if (input === '') {
    return { ok: false, error: '输入为空' };
  }

  const templates = loadTemplates();
  const ranked = rankTemplates(input, templates);

  let chosen = null;
  let chosenScore = 0;

  if (options.templateId) {
    chosen = templates.filter((t) => t.templateId === options.templateId)[0] || null;
    if (!chosen) {
      return { ok: false, error: '指定的模板不存在: ' + options.templateId, ranked: ranked.slice(0, 3) };
    }
    chosenScore = (ranked.filter((r) => r.templateId === chosen.templateId)[0] || {}).score || 0;
  } else {
    const best = ranked[0];
    if (!best || best.score === 0) {
      return {
        ok: false,
        error: '没有匹配到任何模板（所有模板关键词得分均为 0），请补充业务描述或指定 --template',
        ranked: ranked.slice(0, 3)
      };
    }
    chosen = best.template;
    chosenScore = best.score;
  }

  const warnings = [];
  const values = {};
  for (const s of chosen.slots || []) values[s.name] = s.default;

  // 业务名词覆盖
  const subject = detectSubject(input);
  if (subject && Object.prototype.hasOwnProperty.call(values, 'subject')) {
    values.subject = subject;
  }

  // 数字按升序填进 slotOrder
  const nums = uniqueNumbers(extractNumbers(input)).sort((a, b) => a - b);
  const order = chosen.slotOrder || [];
  let idx = 0;
  const filledNumeric = [];
  for (const slotName of order) {
    if (idx < nums.length) {
      values[slotName] = nums[idx];
      filledNumeric.push(slotName + '=' + nums[idx]);
      idx++;
    } else {
      warnings.push('槽位 ' + slotName + ' 未从文本中提取到数值，使用默认值 ' + values[slotName]);
    }
  }
  if (idx < nums.length) {
    warnings.push('文本中有 ' + (nums.length - idx) + ' 个数值未被使用');
  }

  // 阈值必须递增，否则中间分支会变成空区间
  if (values.tier1 !== undefined && values.tier2 !== undefined) {
    const t1 = Number(values.tier1);
    const t2 = Number(values.tier2);
    if (t1 >= t2) {
      warnings.push('阈值顺序异常（tier1=' + t1 + ' >= tier2=' + t2 + '），已按 tier1×10 修正 tier2');
      values.tier2 = t1 * 10;
    }
  }

  const ir = {
    id: chosen.templateId,
    name: renderString(chosen.processName || chosen.name, values),
    processKey: chosen.processId || chosen.templateId,
    sourceText: input,
    variables: renderDeep(chosen.variables || [], values),
    nodes: renderDeep(chosen.nodes || [], values),
    flows: renderDeep(chosen.flows || [], values)
  };

  const unresolved = findUnresolved(ir);
  if (unresolved.length > 0) {
    warnings.push('有 ' + unresolved.length + ' 处占位符未解析: ' + unresolved.slice(0, 3).join(' | '));
  }

  return {
    ok: true,
    templateId: chosen.templateId,
    templateName: chosen.name,
    score: chosenScore,
    filled: values,
    filledNumeric: filledNumeric,
    warnings: warnings,
    ir: ir,
    ranked: ranked.slice(0, 3).map((r) => ({ templateId: r.templateId, score: r.score, hits: r.hits }))
  };
}

module.exports = {
  generateFromText,
  buildFromTemplate,
  loadTemplates,
  listTemplates,
  rankTemplates,
  extractNumbers,
  uniqueNumbers,
  detectSubject
};
