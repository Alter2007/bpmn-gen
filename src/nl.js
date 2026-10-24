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
const CN_DIGIT = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 };

/** 中文数字转阿拉伯数字：五千=5000、两万=20000、一万五=15000、一千二=1200 */
function cnToNumber(s) {
  let total = 0;
  let section = 0;
  let num = 0;
  let lastUnit = 0;
  for (const ch of s) {
    if (CN_DIGIT[ch] !== undefined) {
      num = CN_DIGIT[ch];
    } else if (CN_UNIT[ch] !== undefined) {
      section += (num || 1) * CN_UNIT[ch];
      num = 0;
      lastUnit = CN_UNIT[ch];
    } else if (ch === '万') {
      section = section + num || 1;
      total += section * 10000;
      section = 0;
      num = 0;
      lastUnit = 10000;
    } else if (ch === '亿') {
      total = (total + section + num) * 100000000;
      section = 0;
      num = 0;
      lastUnit = 100000000;
    }
  }
  // 省略单位的口语写法：一万五 => 10000 + 5*1000；一千二 => 1000 + 2*100
  if (num && lastUnit >= 10000) section += num * 1000;
  else if (num && lastUnit === 1000) section += num * 100;
  else section += num;
  return total + section;
}

/** 上下文词：出现这些词说明后面的中文数字是阈值 */
const CN_CUES = ['超过', '小于', '大于', '多于', '少于', '不到', '不超过', '以内', '以下', '以上', '等于', '至少', '最多'];
/** 数字后面的量词：出现这些说明是业务量而不是"三级"这类序数 */
// 强量词：单个数词跟它就能判定是数值（请假三天、50元）
const CN_STRONG_UNITS = ['元', '块', '天', '人', '小时', '万', '千'];
// 弱量词：只有带量级（十/百/千/万）时才算，避免把"做一个流程""两个方案"当成数字
const CN_WEAK_UNITS = ['个', '次', '单', '件', '份'];

/**
 * 抽中文数字。
 * 为了避免把「三级审批」「十分认真」误判成数字，要求满足其一：
 *   1) 前后有比较词（超过/小于/以内…）
 *   2) 后面紧跟量词（元/块/天/人/小时…）
 *   3) 本身含"万/千"且不是"三级"这种序数组合
 */
function extractChineseNumbers(text) {
  const out = [];
  const re = /[零一二两三四五六七八九十百千万亿]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const run = m[0];
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    const after = text.slice(m.index + run.length, m.index + run.length + 3);
    // "10万" 里的"万"已经被阿拉伯数字那套吃掉了，别再算一遍，否则会多出一个 10000
    const prevChar = text.charAt(m.index - 1);
    if (prevChar && /\d/.test(prevChar)) continue;
    // 光一个"万/千/百"没有数字成分，不是数值（"十万"含"十"才算）
    if (!/[零一二两三四五六七八九十]/.test(run)) continue;
    const hasCue = CN_CUES.some((c) => before.indexOf(c) !== -1);
    const strongAfter = CN_STRONG_UNITS.some((u) => after.indexOf(u) === 0);
    const weakAfter = CN_WEAK_UNITS.some((u) => after.indexOf(u) === 0);
    const hasMagnitude = /[十百千万亿]/.test(run);
    const isOrdinal = /[级档类]/.test(after.charAt(0));
    if (isOrdinal) continue;
    if (!hasCue && !strongAfter && !(weakAfter && hasMagnitude) && !hasMagnitude) continue;
    const v = cnToNumber(run);
    if (v > 0 && isFinite(v)) out.push(v);
  }
  return out;
}

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
  // 中文数字（五千 / 两万 / 一万五）也要认，否则会静默退回默认阈值
  for (const v of extractChineseNumbers(text)) out.push(v);
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
  const slotLabel = function (n) {
    const s = (chosen.slots || []).filter(function (x) { return x.name === n; })[0];
    return (s && s.label) ? s.label : n;
  };
  let idx = 0;
  const filledNumeric = [];
  const defaulted = [];
  for (const slotName of order) {
    if (idx < nums.length) {
      values[slotName] = nums[idx];
      filledNumeric.push(slotName + '=' + nums[idx]);
      idx++;
    } else {
      defaulted.push(slotName);
    }
  }
  const extraNums = nums.slice(idx);

  // 阈值必须递增，否则中间分支会变成空区间
  let tier2Estimated = false;
  if (values.tier1 !== undefined && values.tier2 !== undefined) {
    const t1 = Number(values.tier1);
    const t2 = Number(values.tier2);
    if (t1 >= t2) {
      values.tier2 = t1 * 10;
      tier2Estimated = true;
      // 这个槽位已经从"用默认值"变成"按估算值"，下面不要再重复抱怨
      const p = defaulted.indexOf('tier2');
      if (p !== -1) defaulted.splice(p, 1);
    }
  }

  // 提示按"用户能看懂"的粒度汇总，同一件事只说一遍
  // 只有当模板真的有数值槽位时，才需要抱怨"没认出数值"
  if (order.length > 0 && filledNumeric.length === 0) {
    warnings.push('没从这句话里认出任何数值，' + order.map(slotLabel).join('、') + ' 全部按模板默认值生成；' +
      '想指定就直接写数字（例如「超过1000」或「超过五千」）');
  }
  for (const slotName of defaulted) {
    warnings.push('「' + slotLabel(slotName) + '」没认出对应数值，按默认值 ' + values[slotName] + ' 生成，请在图上核对');
  }
  if (tier2Estimated) {
    warnings.push('你只描述了一个阈值（' + values.tier1 + '），模板需要两档；第二档先按 ' + values.tier2 +
      ' 估算，请在图上核对');
  }
  if (extraNums.length > 0) {
    warnings.push('你一共提到了 ' + nums.length + ' 个阈值（' + nums.join('、') + '），但模板「' +
      (chosen.name || chosen.templateId) + '」只支持 ' + order.length + ' 个，多出的 ' +
      extraNums.join('、') + ' 没有生成');
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
