'use strict';

/**
 * 极简 XML 良构性检查（L1）：不依赖任何第三方库。
 * 只做栈式配对、标签闭合、注释/CDATA/指令完整性。
 * 它不是 XSD 校验，定位是"在进引擎之前拦住 90% 的语法级事故"。
 */

function lintXml(text) {
  const errors = [];
  const stack = [];
  const len = text.length;
  let i = 0;
  let elements = 0;
  let rootCount = 0;

  while (i < len) {
    const lt = text.indexOf('<', i);
    if (lt === -1) break;

    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) { errors.push('未闭合注释 @' + lt); break; }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1) { errors.push('未闭合 CDATA @' + lt); break; }
      i = end + 3;
      continue;
    }
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) { errors.push('未闭合处理指令 @' + lt); break; }
      i = end + 2;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2);
      if (end === -1) { errors.push('未闭合声明 @' + lt); break; }
      i = end + 1;
      continue;
    }

    // 找标签结束的 '>'，跳过属性值里的 '>'
    let j = lt + 1;
    let quote = null;
    for (; j < len; j++) {
      const ch = text[j];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
    }
    if (j >= len) { errors.push('标签未闭合 @' + lt); break; }

    const inner = text.slice(lt + 1, j);
    const selfClosing = inner.trimEnd().endsWith('/');
    const body = (selfClosing ? inner.trimEnd().slice(0, -1) : inner).trim();

    if (body === '') {
      errors.push('空标签 @' + lt);
      i = j + 1;
      continue;
    }

    if (body.startsWith('/')) {
      const name = body.slice(1).trim();
      const open = stack.pop();
      if (open === undefined) {
        errors.push('多余的闭合标签 </' + name + '> @' + lt);
      } else if (open !== name) {
        errors.push('标签不匹配: <' + open + '> 被 </' + name + '> 关闭 @' + lt);
      }
    } else {
      const name = body.split(/\s+/)[0];
      if (!/^[A-Za-z_:]/.test(name)) {
        errors.push('非法标签名 <' + name + '> @' + lt);
      }
      elements++;
      if (stack.length === 0) rootCount++;
      if (!selfClosing) stack.push(name);
    }

    i = j + 1;
  }

  if (stack.length > 0) {
    errors.push('以下标签未闭合: ' + stack.join(' > '));
  }
  if (rootCount !== 1) {
    errors.push('XML 必须且只能有 1 个根元素，当前 ' + rootCount + ' 个');
  }

  return { ok: errors.length === 0, errors, elements };
}

module.exports = { lintXml };
