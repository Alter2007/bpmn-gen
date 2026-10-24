'use strict';

(function () {
  var ViewerCtor = window.BpmnNavigatedViewer || window.BpmnJS;
  var viewer = null;
  if (ViewerCtor) {
    viewer = new ViewerCtor({ container: '#canvas' });
  }

  var $ = function (id) { return document.getElementById(id); };
  var els = {
    desc: $('desc'),
    btnGenerate: $('btn-generate'),
    btnExample: $('btn-example'),
    btnRefresh: $('btn-refresh'),
    btnCopy: $('btn-copy'),
    btnDownload: $('btn-download'),
    chips: $('chips'),
    search: $('search'),
    empty: $('empty'),
    badge: $('badge'),
    meta: $('meta'),
    countFlows: $('count-flows'),
    countTemplates: $('count-templates'),
    tableTemplates: $('table-templates'),
    kvSettings: $('kv-settings'),
    apiKey: $('api-key'),
    keyStatus: $('key-status'),
    keyHint: $('key-hint'),
    btnSaveKey: $('btn-save-key'),
    btnClearKey: $('btn-clear-key'),
    btnQuit: $('btn-quit'),
    clarify: $('clarify'),
    clarifyQ: $('clarify-q'),
    clarifyOpts: $('clarify-opts'),
    btnDoc: $('btn-doc'),
    btnForm: $('btn-form'),
    btnSvg: $('btn-svg'),
    sideModel: $('side-model'),
    sideProvider: $('side-provider'),
    sideDot: $('side-dot'),
    toast: $('toast'),
    tabs: $('tabs')
  };

  var state = {
    mode: 'auto',
    xml: '',
    file: '',
    flows: [],
    templates: []
  };

  var EXAMPLES = [
    '我要做一个差旅报销审批流，金额小于 1000 直接主管批，大于 1000 需要总监批，超过 5000 需要财务复核',
    '请假 3 天以内主管审批，超过 3 天需要人事备案',
    '采购 3 万元的服务器，需要部门经理和采购部审批',
    '采购合同需要法务、财务一起会签',
    '新员工入职，需要人事建档、IT 开户、行政分配工位'
  ];

  // ---------------- 工具 ----------------
  function toast(msg, isErr) {
    els.toast.textContent = msg;
    els.toast.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      els.toast.className = 'toast';
    }, isErr ? 6000 : 2600);
  }

  function api(path, opts) {
    return fetch(path, opts).catch(function () {
      throw new Error('连不上本地服务——应用可能已经退出了。请重新双击桌面图标。');
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var msg = (j && j.error) ? j.error : ('HTTP ' + r.status);
          if (j && j.errors && j.errors.length) msg += '\n· ' + j.errors.join('\n· ');
          throw new Error(msg);
        }
        return j;
      });
    });
  }

  function sizeText(n) {
    return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB';
  }

  // ---------------- 视图切换 ----------------
  document.querySelectorAll('.nav-item').forEach(function (item) {
    item.addEventListener('click', function () {
      document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.remove('active'); });
      item.classList.add('active');
      var view = item.getAttribute('data-view');
      document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
      $('view-' + view).classList.add('active');
      if (view === 'templates' && state.templates.length === 0) loadTemplates();
      if (view === 'settings') loadHealth();
    });
  });

  els.tabs.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      els.tabs.querySelectorAll('.tab').forEach(function (x) { x.classList.remove('active'); });
      t.classList.add('active');
      state.mode = t.getAttribute('data-mode');
    });
  });

  // ---------------- 健康状态 ----------------
  function renderKey(k, h) {
    var has = !!(k && k.hasKey);
    els.keyStatus.textContent = has ? '已设置' : '未设置';
    els.keyStatus.className = 'key-status' + (has ? ' on' : '');
    if (has) {
      var src = k.source === 'env' ? '来自环境变量' : '仅在本应用内存';
      els.keyHint.textContent = '当前密钥：' + k.masked + '（' + src + '）· 模型 ' +
        (k.model || h.model) + ' · 关掉应用即失效';
    } else {
      els.keyHint.textContent = '未设置密钥时，只能使用「仅用模板（不联网）」模式。';
    }
  }

  function loadHealth() {
    return Promise.all([api('/api/health'), api('/api/key')]).then(function (r) {
      var h = r[0];
      var k = r[1];
      els.sideModel.textContent = h.model || '未配置模型';
      els.sideProvider.textContent = h.provider + (h.hasKey ? ' · 已就绪' : ' · 无密钥(仅模板)');
      els.sideDot.className = 'usage-dot' + (h.hasKey ? ' on' : '');
      if (h.sid) { sessionId = h.sid; }
      renderKey(k, h);

      var rows = [
        ['供应商', h.provider + '（' + h.providerId + '）'],
        ['模型', h.model],
        ['接口地址', h.baseUrl],
        ['密钥状态', h.hasKey ? ('已设置 ' + (k.masked || '') + '（' + (k.source === 'env' ? '环境变量' : '内存') + '）') : '未设置 —— 只能使用离线模板'],
        ['模板数量', String(h.templates)],
        ['已生成流程', String(h.flows)]
      ];
      els.kvSettings.innerHTML = rows.map(function (row) {
        return '<div class="k">' + row[0] + '</div><div class="v">' + esc(row[1]) + '</div>';
      }).join('');
      return h;
    }).catch(function () {
      els.sideModel.textContent = '服务未连接';
      els.sideProvider.textContent = '请重新打开应用';
      els.keyStatus.textContent = '未知';
      els.keyStatus.className = 'key-status';
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------------- 流程列表 ----------------
  function loadList() {
    return api('/api/list').then(function (list) {
      state.flows = list || [];
      els.countFlows.textContent = state.flows.length;
      renderChips();
      return list;
    });
  }

  function renderChips() {
    var kw = (els.search.value || '').trim().toLowerCase();
    var list = state.flows.filter(function (f) {
      return kw === '' || f.name.toLowerCase().indexOf(kw) !== -1;
    });
    els.chips.innerHTML = '';
    list.slice(0, 40).forEach(function (f) {
      var b = document.createElement('button');
      b.className = 'chip' + (f.name === state.file ? ' active' : '');
      b.textContent = f.name.replace(/\.bpmn$/i, '');
      b.title = f.name + '  ·  ' + sizeText(f.size);
      b.onclick = function () { loadFile(f.name); };
      els.chips.appendChild(b);
    });
  }

  els.search.addEventListener('input', renderChips);

  function loadFile(name) {
    return fetch('/api/file?name=' + encodeURIComponent(name))
      .then(function (r) {
        if (!r.ok) throw new Error('读取失败 HTTP ' + r.status);
        return r.text();
      })
      .then(function (xml) {
        state.xml = xml;
        state.file = name;
        renderXml(xml);
        renderChips();
        els.btnCopy.disabled = false;
        els.btnDownload.disabled = false;
        els.meta.innerHTML = '已加载 <b>' + esc(name) + '</b>';
      })
      .catch(function (e) {
        toast('读取失败：' + e.message, true);
      });
  }

  // ---------------- 渲染 ----------------
  function renderXml(xml) {
    if (!viewer) {
      toast('bpmn-js 未加载，无法渲染', true);
      return Promise.resolve();
    }
    els.empty.style.display = 'none';
    return viewer.importXML(xml).then(function (result) {
      var warnings = (result && result.warnings) || [];
      viewer.get('canvas').zoom('fit-viewport');
      if (warnings.length > 0) {
        els.badge.style.display = 'block';
        els.badge.textContent = 'bpmn-moddle 警告 ' + warnings.length + ' 条';
        els.badge.title = warnings.map(function (w) { return w.message || w; }).join('\n');
      } else {
        els.badge.style.display = 'none';
      }
    }).catch(function (e) {
      els.empty.style.display = 'flex';
      toast('渲染失败：' + (e && e.message ? e.message : e), true);
    });
  }

  // ---------------- 生成 ----------------
  // ---------------- 交互式澄清 ----------------
  function hideClarify() {
    if (els.clarify) {
      els.clarify.hidden = true;
      els.clarifyOpts.innerHTML = '';
    }
  }

  function showClarify(res) {
    if (!els.clarify) return;
    els.clarifyQ.textContent = res.question || '请确认是哪一类流程：';
    els.clarifyOpts.innerHTML = '';
    (res.candidates || []).forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'clarify-opt';
      var hitLine = (c.hits && c.hits.length)
        ? '<span class="co-hit">识别到：' + esc(c.hits.join('、')) + '</span>'
        : '';
      b.innerHTML = '<span class="co-name">' + esc(c.name || c.templateId) + '</span>' +
        '<span class="co-desc">' + esc(c.description || '') + '</span>' + hitLine;
      b.title = '点击按「' + (c.name || c.templateId) + '」生成';
      b.addEventListener('click', function () { generate(c.templateId); });
      els.clarifyOpts.appendChild(b);
    });
    els.clarify.hidden = false;
    toast('不太确定，请选一个最接近的');
  }

  function generate(pick) {
    var text = (els.desc.value || '').trim();
    if (text === '') {
      els.desc.focus();
      toast('请先输入业务描述', true);
      return;
    }
    hideClarify();
    var oldLabel = els.btnGenerate.textContent;
    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = state.mode === 'auto' ? '生成中…' : '匹配中…';

    api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, mode: state.mode, pickTemplate: pick || '' })
    }).then(function (res) {
      if (res && res.needClarify) {
        showClarify(res);
        return;
      }
      state.xml = res.xml;
      state.file = res.file;
      state.artifacts = res.artifacts || null;
      els.btnCopy.disabled = false;
      els.btnDownload.disabled = false;
      if (els.btnSvg) els.btnSvg.disabled = false;
      if (els.btnDoc) els.btnDoc.disabled = !state.artifacts;
      if (els.btnForm) els.btnForm.disabled = !state.artifacts;

      var m = res.meta || {};
      var bits = [];
      bits.push('模板 <b>' + esc(m.templateId) + '</b>');
      if (m.confidence !== null && m.confidence !== undefined) bits.push('置信度 <b>' + m.confidence + '</b>');
      bits.push('节点 <b>' + m.nodes + '</b> / 连线 <b>' + m.flows + '</b>');
      bits.push('<b>' + (m.bytes / 1024).toFixed(1) + ' KB</b>');
      bits.push('耗时 <b>' + m.ms + ' ms</b>');
      if (m.tokens) bits.push('token <b>' + m.tokens.in + '/' + m.tokens.out + '</b>');
      if (m.cases) bits.push('覆盖用例 <b>' + m.cases + '</b> 条');
      els.meta.innerHTML = bits.join('　·　');

      return renderXml(res.xml).then(function () {
        return loadList();
      }).then(function () {
        if (m.reason) toast('模型理由：' + m.reason);
        else toast('生成完成，已保存为 ' + res.file);
      });
    }).catch(function (e) {
      var msg = e.message || '';
      // 密钥类错误：直接把人带到设置页，并刷新一次状态，避免界面还停在旧的「已就绪」
      if (/API Key|密钥|401|403/i.test(msg)) {
        toast('缺少可用的密钥：请到「设置」页粘贴后再生成', true);
        loadHealth();
        var navSettings = document.querySelector('.nav-item[data-view="settings"]');
        if (navSettings) navSettings.click();
        setTimeout(function () { if (els.apiKey) els.apiKey.focus(); }, 300);
      } else {
        toast('生成失败：' + msg, true);
      }
    }).then(function () {
      els.btnGenerate.disabled = false;
      els.btnGenerate.textContent = oldLabel;
    });
  }

  // 注意：不能直接写 addEventListener('click', generate)，否则点击事件对象会被当成 pick 参数
  els.btnGenerate.addEventListener('click', function () { generate(); });
  els.desc.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') generate();
  });
  els.btnExample.addEventListener('click', function () {
    var i = Math.floor(Math.random() * EXAMPLES.length);
    els.desc.value = EXAMPLES[i];
    els.desc.focus();
  });
  els.btnRefresh.addEventListener('click', function () {
    loadList().then(function () { toast('已刷新'); });
  });

  // ---------------- 下载 / 复制 ----------------
  els.btnDownload.addEventListener('click', function () {
    if (!state.xml) return;
    var blob = new Blob([state.xml], { type: 'application/xml' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = state.file || 'process.bpmn';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  });

  els.btnCopy.addEventListener('click', function () {
    if (!state.xml) return;
    var done = function () { toast('XML 已复制到剪贴板（' + state.xml.length + ' 字符）'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(state.xml).then(done).catch(function () { toast('复制失败，请手动下载', true); });
    } else {
      toast('当前浏览器不支持剪贴板 API', true);
    }
  });

  // ---------------- 密钥设置 / 退出 ----------------
  els.btnSaveKey.addEventListener('click', function () {
    var v = els.apiKey.value.trim();
    if (!v) { toast('请先粘贴密钥', true); els.apiKey.focus(); return; }
    els.btnSaveKey.disabled = true;
    api('/api/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: v })
    }).then(function (res) {
      els.apiKey.value = '';
      toast(res.warning || ('密钥已保存：' + res.masked + '（仅存于内存）'));
      return loadHealth();
    }).catch(function (e) {
      toast('保存失败：' + e.message, true);
    }).then(function () {
      els.btnSaveKey.disabled = false;
    });
  });

  els.btnClearKey.addEventListener('click', function () {
    api('/api/key', { method: 'DELETE' }).then(function () {
      toast('密钥已清除，将退回离线模板模式');
      return loadHealth();
    }).catch(function (e) {
      toast('清除失败：' + e.message, true);
    });
  });

  els.btnQuit.addEventListener('click', function () {
    api('/api/shutdown', { method: 'POST' }).then(function () {
      toast('应用已退出，可以直接关闭窗口');
      els.sideModel.textContent = '已退出';
      els.sideProvider.textContent = '重新双击图标可再次启动';
      els.sideDot.className = 'usage-dot';
    }).catch(function () {
      toast('退出请求失败', true);
    });
  });

  // ---------------- 心跳 ----------------
  // 页面活着就每 5 秒报一次。窗口关掉后，服务端 35 秒收不到心跳会自动退出，
  // 避免残留进程一直占着内存里的旧密钥（否则下次打开会莫名显示"已就绪"）。
  // 同时用 sid 识别「服务被重启过」，自动刷新界面状态。
  var sessionId = '';
  setInterval(function () {
    fetch('/api/ping', { cache: 'no-store' }).then(function (r) {
      return r.ok ? r.json() : null;     // 老版本服务没有该路由时返回 null，静默忽略
    }).then(function (j) {
      if (!j || !j.sid) return;
      if (sessionId === '') { sessionId = j.sid; return; }
      if (j.sid !== sessionId) {
        sessionId = j.sid;
        loadHealth();
        toast('应用已重启，密钥已清空，请重新填写');
      }
    }).catch(function () {
      // 只有网络层失败，才说明服务真的没了
      els.sideModel.textContent = '服务已退出';
      els.sideProvider.textContent = '重新双击图标即可启动';
      els.sideDot.className = 'usage-dot';
    });
  }, 5000);

  // 配套产物下载：流程说明（.md）/ 表单定义（.json）
  function downloadText(text, name, type) {
    var blob = new Blob([text], { type: type });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  // 导出矢量图：bpmn-js 自带 saveSVG，图放进 Word/PDF 也不会糊
  if (els.btnSvg) {
    els.btnSvg.addEventListener('click', function () {
      if (!viewer || !state.xml) return;
      var finish = function (svg) {
        var base = (state.file || 'process.bpmn').replace(/\.bpmn$/i, '');
        downloadText(svg, base + '.svg', 'image/svg+xml;charset=utf-8');
        toast('已下载 SVG（矢量图，可直接放进文档）');
      };
      try {
        var r = viewer.saveSVG({ format: true });
        if (r && typeof r.then === 'function') {
          r.then(function (res) {
            finish(typeof res === 'string' ? res : res.svg);
          }).catch(function (e) { toast('SVG 导出失败：' + (e && e.message ? e.message : e), true); });
        } else {
          finish(typeof r === 'string' ? r : (r && r.svg) || '');
        }
      } catch (e) {
        toast('SVG 导出失败：' + (e && e.message ? e.message : e), true);
      }
    });
  }
  if (els.btnDoc) {
    els.btnDoc.addEventListener('click', function () {
      if (!state.artifacts) return;
      var base = (state.file || 'process.bpmn').replace(/\.bpmn$/i, '');
      downloadText(state.artifacts.doc.markdown, base + '-说明.md', 'text/markdown;charset=utf-8');
      toast('已下载流程说明（含分支条件与驳回路径）');
    });
  }

  if (els.btnForm) {
    els.btnForm.addEventListener('click', function () {
      if (!state.artifacts) return;
      var base = (state.file || 'process.bpmn').replace(/\.bpmn$/i, '');
      downloadText(JSON.stringify(state.artifacts.form, null, 2), base + '-表单.json', 'application/json;charset=utf-8');
      toast('已下载表单定义（' + state.artifacts.form.fields.length + ' 个字段）');
    });
  }

  // ---------------- 模板库 ----------------
  function loadTemplates() {
    return api('/api/templates').then(function (res) {
      state.templates = res.templates || [];
      els.countTemplates.textContent = state.templates.length;
      var tb = els.tableTemplates.querySelector('tbody');
      tb.innerHTML = state.templates.map(function (t) {
        return '<tr>' +
          '<td><code>' + esc(t.templateId) + '</code></td>' +
          '<td>' + esc(t.name) + '</td>' +
          '<td>' + esc(t.description || '') + '</td>' +
          '<td>' + esc((t.keywords || []).join(' / ')) + '</td>' +
          '<td>' + t.nodeCount + ' 节点 / ' + t.flowCount + ' 连线</td>' +
          '</tr>';
      }).join('');
    }).catch(function (e) { toast('模板加载失败：' + e.message, true); });
  }

  // ---------------- 启动 ----------------
  function boot() {
    loadHealth();
    loadList().then(function (list) {
      if (list && list.length > 0) loadFile(list[0].name);
    });
    if (!ViewerCtor) toast('bpmn-js 加载失败，请确认 web/node_modules/bpmn-js/dist 存在', true);
  }

  boot();
})();
