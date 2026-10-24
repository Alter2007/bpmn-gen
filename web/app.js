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
      throw new Error('连不上本地服务——黑窗口可能被关掉了。请重新运行 node web\\serve.js');
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
  function loadHealth() {
    return api('/api/health').then(function (h) {
      els.sideModel.textContent = h.model || '未配置模型';
      els.sideProvider.textContent = h.provider + (h.hasKey ? ' · 已就绪' : ' · 无密钥(仅模板)');
      els.sideDot.className = 'usage-dot' + (h.hasKey ? ' on' : '');

      var rows = [
        ['供应商', h.provider + '（' + h.providerId + '）'],
        ['模型', h.model],
        ['接口地址', h.baseUrl],
        ['密钥状态', h.hasKey ? '已从环境变量读取（不落盘）' : '未设置 —— 将只能使用离线模板'],
        ['密钥变量名', h.keyEnv],
        ['模板数量', String(h.templates)],
        ['已生成流程', String(h.flows)]
      ];
      els.kvSettings.innerHTML = rows.map(function (r) {
        return '<div class="k">' + r[0] + '</div><div class="v">' + esc(r[1]) + '</div>';
      }).join('');
      return h;
    }).catch(function () {
      els.sideModel.textContent = '服务未连接';
      els.sideProvider.textContent = '请检查黑窗口是否在运行';
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
  function generate() {
    var text = (els.desc.value || '').trim();
    if (text === '') {
      els.desc.focus();
      toast('请先输入业务描述', true);
      return;
    }
    var oldLabel = els.btnGenerate.textContent;
    els.btnGenerate.disabled = true;
    els.btnGenerate.textContent = state.mode === 'auto' ? '生成中…' : '匹配中…';

    api('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text, mode: state.mode })
    }).then(function (res) {
      state.xml = res.xml;
      state.file = res.file;
      els.btnCopy.disabled = false;
      els.btnDownload.disabled = false;

      var m = res.meta || {};
      var bits = [];
      bits.push('模板 <b>' + esc(m.templateId) + '</b>');
      if (m.confidence !== null && m.confidence !== undefined) bits.push('置信度 <b>' + m.confidence + '</b>');
      bits.push('节点 <b>' + m.nodes + '</b> / 连线 <b>' + m.flows + '</b>');
      bits.push('<b>' + (m.bytes / 1024).toFixed(1) + ' KB</b>');
      bits.push('耗时 <b>' + m.ms + ' ms</b>');
      if (m.tokens) bits.push('token <b>' + m.tokens.in + '/' + m.tokens.out + '</b>');
      els.meta.innerHTML = bits.join('　·　');

      return renderXml(res.xml).then(function () {
        return loadList();
      }).then(function () {
        if (m.reason) toast('模型理由：' + m.reason);
        else toast('生成完成，已保存为 ' + res.file);
      });
    }).catch(function (e) {
      toast('生成失败：' + e.message, true);
    }).then(function () {
      els.btnGenerate.disabled = false;
      els.btnGenerate.textContent = oldLabel;
    });
  }

  els.btnGenerate.addEventListener('click', generate);
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
