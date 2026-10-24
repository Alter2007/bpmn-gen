'use strict';

/**
 * S3：提示词构建与模型输出解析（纯函数，可离线测试）。
 *
 * 设计要点（对应 P-07）：
 *   模型只回答"用哪个模板 + 槽位填什么"，绝不回答"流程长什么样"。
 *   所以提示词里必须出现完整模板清单，且明确禁止模型臆造模板。
 */

const { loadTemplates } = require('./nl');

function describeTemplate(tpl) {
  const slotText = (tpl.slots || [])
    .map((s) => s.name + '(' + s.type + '，默认 ' + JSON.stringify(s.default) + ')')
    .join('、');
  return (
    '- ' + tpl.templateId + ' ｜ ' + tpl.name + ' ｜ ' + (tpl.description || '') + '\n' +
    '  槽位: ' + (slotText || '无') + '\n' +
    '  关键词: ' + (tpl.keywords || []).join('/')
  );
}

function buildSystemPrompt(templates) {
  const list = templates || loadTemplates();
  const lines = [];
  lines.push('你是企业审批流生成器中的「模板选择器」。');
  lines.push('');
  lines.push('你的唯一职责：读懂业务人员的描述，从给定模板中选择最合适的一个，并填好它的槽位参数。');
  lines.push('你不负责设计流程结构，也没有权限创造新节点、新连线。');
  lines.push('');
  lines.push('【输出格式】只输出一个 JSON 对象，不要任何解释文字，不要 Markdown 代码块：');
  lines.push('{"templateId":"<模板id>","slots":{...},"confidence":0.0,"reason":"<一句话理由>"}');
  lines.push('');
  lines.push('【规则】');
  lines.push('1. templateId 必须严格等于下面列表中的某一个；完全无法判断时输出 null。');
  lines.push('2. slots 只填写你从描述中明确读到的参数，读不到就不要出现该字段（系统会用默认值）。');
  lines.push('3. 数字槽位必须是 number 类型，不要加引号、不要带单位："5万" 要写成 50000。');
  lines.push('4. 禁止编造列表里不存在的模板 id。');
  lines.push('5. 当描述里出现多个金额/天数阈值时，按从小到大依次填入 tier1、tier2。');
  lines.push('');
  lines.push('【可用模板】');
  for (const t of list) lines.push(describeTemplate(t));
  return lines.join('\n');
}

function buildUserMessage(text) {
  return '业务描述：\n"""\n' + String(text || '') + '\n"""\n\n请按约定格式输出 JSON。';
}

function extractJson(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/**
 * 解析并校验模型输出。
 * 校验失败一律返回 ok:false —— 不猜、不兜底（P-08）。
 */
function parseModelOutput(raw, templates) {
  const list = templates || loadTemplates();
  const jsonText = extractJson(raw);
  if (jsonText === null) {
    return { ok: false, error: '模型输出中找不到 JSON 对象' };
  }

  let obj;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    return { ok: false, error: '模型输出 JSON 解析失败: ' + e.message };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, error: '模型输出不是 JSON 对象' };
  }

  const templateId = obj.templateId === undefined ? null : obj.templateId;
  if (templateId === null) {
    return { ok: false, error: '模型表示无法判断（templateId 为 null）', reason: String(obj.reason || '') };
  }

  const tpl = list.filter((t) => t.templateId === templateId)[0];
  if (!tpl) {
    return { ok: false, error: '模型给出的模板不存在: ' + templateId, templateId: templateId };
  }

  const warnings = [];
  const rawSlots = obj.slots && typeof obj.slots === 'object' ? obj.slots : {};
  const slots = {};

  for (const s of tpl.slots || []) {
    if (!Object.prototype.hasOwnProperty.call(rawSlots, s.name)) continue;
    let v = rawSlots[s.name];
    if (s.type === 'number') {
      const n = Number(v);
      if (!isFinite(n)) {
        warnings.push('槽位 ' + s.name + ' 不是有效数字，已忽略: ' + JSON.stringify(v));
        continue;
      }
      v = n;
    } else {
      v = String(v);
    }
    slots[s.name] = v;
  }

  for (const k of Object.keys(rawSlots)) {
    if (!(tpl.slots || []).some((s) => s.name === k)) {
      warnings.push('未知槽位已忽略: ' + k);
    }
  }

  let confidence = Number(obj.confidence);
  if (!isFinite(confidence)) confidence = null;

  return {
    ok: true,
    templateId: templateId,
    slots: slots,
    confidence: confidence,
    reason: String(obj.reason || ''),
    warnings: warnings
  };
}

module.exports = { buildSystemPrompt, buildUserMessage, extractJson, parseModelOutput, describeTemplate };
