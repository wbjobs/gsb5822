'use strict';

(function () {
  var MAX_INPUT = 50 * 1024 * 1024; // 50MB 上限，超出直接拒绝
  var MAX_HISTORY = 10;
  var MAX_STORE_SIZE = 2 * 1024 * 1024; // 单条历史最多存 2MB
  var DB_NAME = 'json-tool-db';
  var STORE = 'history';

  var inputEl = document.getElementById('input');
  var outputEl = document.getElementById('output');
  var errorPanel = document.getElementById('error-panel');
  var warnPanel = document.getElementById('warn-panel');
  var statusEl = document.getElementById('status');
  var indentSel = document.getElementById('indent');
  var historyList = document.getElementById('history-list');
  var busyBar = document.getElementById('busy');

  // ---------- Web Worker ----------
  var worker = null;
  var reqId = 0;
  var pending = {};

  try {
    worker = new Worker('worker.js');
  } catch (e) {
    worker = null;
  }

  if (worker) {
    worker.onmessage = function (e) {
      var cb = pending[e.data.id];
      if (cb) {
        delete pending[e.data.id];
        cb(e.data);
      }
    };
    worker.onerror = function () {
      showError({ message: 'Web Worker 加载失败。请通过 HTTP 服务访问（如 python3 -m http.server），不要用 file:// 直接打开。' });
      setBusy(false);
    };
  } else {
    showError({ message: '无法创建 Web Worker。请通过 HTTP 服务访问（如 python3 -m http.server），不要用 file:// 直接打开。' });
  }

  function runWorker(action, text, options) {
    return new Promise(function (resolve, reject) {
      if (!worker) return reject(new Error('Worker 不可用'));
      var id = ++reqId;
      pending[id] = resolve;
      worker.postMessage({ id: id, action: action, text: text, options: options });
    });
  }

  // ---------- 工具 ----------
  function formatSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function setBusy(busy) {
    busyBar.style.visibility = busy ? 'visible' : 'hidden';
    var btns = document.querySelectorAll('#toolbar button');
    for (var k = 0; k < btns.length; k++) btns[k].disabled = busy;
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function clearPanels() {
    errorPanel.hidden = true;
    errorPanel.textContent = '';
    warnPanel.hidden = true;
    warnPanel.textContent = '';
  }

  function guessHint(text) {
    if (/\[Circular|<ref \*\d+|circular reference/i.test(text)) {
      return '检测到循环引用标记（如 [Circular] / <ref *>）。循环引用不是合法 JSON，请先在来源处解除循环（如移除自引用字段）后再导出。';
    }
    if (/^\s*\{[^"]*\w+\s*:/m.test(text) || /^\s*\w+\s*:/m.test(text)) {
      return '检测到未加引号的键，输入可能是 JS 对象字面量而非 JSON。JSON 要求键使用双引号，且不支持 undefined/function/循环引用。';
    }
    if (/\bundefined\b|\bfunction\b|=>/.test(text)) {
      return '输入包含 undefined/function 等 JS 语法，不是合法 JSON。';
    }
    if (/'[^']*'\s*:/.test(text)) {
      return '检测到单引号字符串，JSON 只支持双引号。';
    }
    return null;
  }

  function showError(err, hint) {
    errorPanel.hidden = false;
    errorPanel.textContent = '';

    var title = document.createElement('div');
    title.className = 'err-title';
    var loc = (typeof err.line === 'number' && err.line !== null)
      ? '（第 ' + err.line + ' 行，第 ' + err.col + ' 列）'
      : '';
    title.textContent = '✗ ' + err.message + loc;
    errorPanel.appendChild(title);

    if (typeof err.line === 'number' && err.line !== null) {
      errorPanel.appendChild(buildSnippet(err.line, err.col));
      // 把光标定位到错误处
      if (typeof err.pos === 'number' && err.pos !== null) {
        inputEl.focus();
        var pos = Math.min(err.pos, inputEl.value.length);
        inputEl.setSelectionRange(pos, pos);
        inputEl.blur();
        inputEl.focus();
      }
    }

    if (hint) {
      var hintEl = document.createElement('div');
      hintEl.className = 'err-hint';
      hintEl.textContent = '提示：' + hint;
      errorPanel.appendChild(hintEl);
    }
  }

  function buildSnippet(errLine, errCol) {
    var lines = inputEl.value.split('\n');
    var box = document.createElement('div');
    box.className = 'err-snippet';
    var from = Math.max(1, errLine - 2);
    var to = Math.min(lines.length, errLine + 1);
    for (var n = from; n <= to; n++) {
      var row = document.createElement('div');
      row.className = 'err-line' + (n === errLine ? ' err-line-bad' : '');
      var num = document.createElement('span');
      num.className = 'err-lineno';
      num.textContent = n;
      var code = document.createElement('span');
      code.className = 'err-code';
      var text = lines[n - 1];
      code.textContent = text.length > 200 ? text.slice(0, 200) + ' …' : text;
      row.appendChild(num);
      row.appendChild(code);
      box.appendChild(row);
      if (n === errLine && typeof errCol === 'number') {
        var caret = document.createElement('div');
        caret.className = 'err-caret';
        var pad = document.createElement('span');
        pad.className = 'err-lineno';
        pad.textContent = '';
        var marker = document.createElement('span');
        marker.className = 'err-code';
        marker.textContent = new Array(Math.min(errCol, 200)).join(' ') + '^';
        caret.appendChild(pad);
        caret.appendChild(marker);
        box.appendChild(caret);
      }
    }
    return box;
  }

  function showWarnings(warnings, extraHint) {
    var items = [];
    if (extraHint) items.push(extraHint);
    if (warnings && warnings.length) {
      var shown = warnings.slice(0, 50);
      for (var k = 0; k < shown.length; k++) {
        var w = shown[k];
        items.push('第 ' + w.line + ' 行: ' + w.message);
      }
      if (warnings.length > 50) items.push('… 其余 ' + (warnings.length - 50) + ' 条告警已省略');
    }
    if (!items.length) return;
    warnPanel.hidden = false;
    warnPanel.textContent = '';
    var head = document.createElement('div');
    head.className = 'warn-title';
    head.textContent = '⚠ ' + items.length + ' 条提示';
    warnPanel.appendChild(head);
    for (var m = 0; m < items.length; m++) {
      var div = document.createElement('div');
      div.className = 'warn-item';
      div.textContent = items[m];
      warnPanel.appendChild(div);
    }
  }

  function indentOption() {
    var v = indentSel.value;
    return v === 'tab' ? { indent: 'tab' } : { indent: parseInt(v, 10) };
  }

  // ---------- 主操作 ----------
  async function runAction(action) {
    clearPanels();
    var text = inputEl.value;

    if (!text.length) {
      showError({ message: '输入为空' });
      return;
    }
    if (text.length > MAX_INPUT) {
      showError({ message: '输入超长：' + formatSize(text.length) + '，超过 50MB 上限，请分段处理' });
      return;
    }

    var hint = guessHint(text);
    setBusy(true);
    setStatus('处理中…（Worker 后台运行，界面不会卡顿）');

    try {
      var resp = await runWorker(action, text, indentOption());
      if (!resp.ok) {
        outputEl.value = '';
        showError(resp.error, hint);
        setStatus('解析失败 · 耗时 ' + resp.duration.toFixed(1) + ' ms');
        return;
      }

      if (action === 'validate') {
        outputEl.value = '✓ JSON 合法';
      } else {
        outputEl.value = resp.result;
      }

      showWarnings(resp.warnings, null);

      var stat = '✓ 完成 · 耗时 ' + resp.duration.toFixed(1) + ' ms · 输入 ' + formatSize(text.length);
      if (resp.stats) {
        stat += ' · 深度 ' + resp.stats.maxDepth + ' · 键 ' + resp.stats.keys + ' · 值 ' +
          (resp.stats.strings + resp.stats.numbers + resp.stats.literals);
      }
      if (resp.result != null) stat += ' · 输出 ' + formatSize(resp.result.length);
      setStatus(stat);

      saveHistory(text, action).then(renderHistory);
    } catch (e) {
      showError({ message: e.message || String(e) });
      setStatus('出错');
    } finally {
      setBusy(false);
    }
  }

  // ---------- IndexedDB 历史 ----------
  function openDB() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  async function saveHistory(text, action) {
    if (!text || text.length > MAX_STORE_SIZE) return;
    try {
      var db = await openDB();
      var tx = db.transaction(STORE, 'readwrite');
      var store = tx.objectStore(STORE);
      store.add({ text: text, action: action, time: Date.now(), size: text.length });
      await new Promise(function (res, rej) { tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; });
      // 只保留最近 MAX_HISTORY 条
      var all = await getAllHistory(db);
      if (all.length > MAX_HISTORY) {
        var toDelete = all.slice(MAX_HISTORY); // all 已按时间倒序
        var tx2 = db.transaction(STORE, 'readwrite');
        var st2 = tx2.objectStore(STORE);
        toDelete.forEach(function (item) { st2.delete(item.id); });
        await new Promise(function (res, rej) { tx2.oncomplete = res; tx2.onerror = function () { rej(tx2.error); }; });
      }
      db.close();
    } catch (e) {
      console.warn('历史保存失败', e);
    }
  }

  function getAllHistory(db) {
    return new Promise(function (resolve, reject) {
      var own = !db;
      var p = own ? openDB() : Promise.resolve(db);
      p.then(function (d) {
        var tx = d.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () {
          var rows = req.result || [];
          rows.sort(function (a, b) { return b.id - a.id; });
          if (own) d.close();
          resolve(rows);
        };
        req.onerror = function () { reject(req.error); };
      }, reject);
    });
  }

  async function deleteHistory(id) {
    var db = await openDB();
    var tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    await new Promise(function (res, rej) { tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; });
    db.close();
  }

  async function clearHistory() {
    var db = await openDB();
    var tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await new Promise(function (res, rej) { tx.oncomplete = res; tx.onerror = function () { rej(tx.error); }; });
    db.close();
  }

  async function renderHistory() {
    var rows;
    try {
      rows = await getAllHistory(null);
    } catch (e) {
      return;
    }
    historyList.textContent = '';
    if (!rows.length) {
      var empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = '暂无历史记录';
      historyList.appendChild(empty);
      return;
    }
    rows.forEach(function (row) {
      var item = document.createElement('div');
      item.className = 'history-item';

      var meta = document.createElement('div');
      meta.className = 'history-meta';
      var d = new Date(row.time);
      meta.textContent = d.toLocaleString() + ' · ' + (row.action || '') + ' · ' + formatSize(row.size || 0);

      var preview = document.createElement('div');
      preview.className = 'history-preview';
      var p = row.text.replace(/\s+/g, ' ');
      preview.textContent = p.length > 80 ? p.slice(0, 80) + ' …' : p;

      var del = document.createElement('button');
      del.className = 'history-del';
      del.textContent = '✕';
      del.title = '删除此条';
      del.addEventListener('click', function (ev) {
        ev.stopPropagation();
        deleteHistory(row.id).then(renderHistory);
      });

      item.appendChild(meta);
      item.appendChild(preview);
      item.appendChild(del);
      item.addEventListener('click', function () {
        inputEl.value = row.text;
        updateInputStatus();
        clearPanels();
        setStatus('已恢复历史记录（' + formatSize(row.size || 0) + '）');
      });
      historyList.appendChild(item);
    });
  }

  // ---------- 输入状态 ----------
  function updateInputStatus() {
    var v = inputEl.value;
    var lines = v ? v.split('\n').length : 0;
    setStatus('输入 ' + formatSize(v.length) + ' · ' + lines + ' 行' +
      (v.length > MAX_INPUT ? ' · ⚠ 超过 50MB 上限' : ''));
  }

  // ---------- 事件绑定 ----------
  var actions = ['format', 'minify', 'validate', 'sort', 'escape', 'unescape'];
  actions.forEach(function (action) {
    document.getElementById('btn-' + action).addEventListener('click', function () {
      runAction(action);
    });
  });

  document.getElementById('btn-copy').addEventListener('click', function () {
    var text = outputEl.value;
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        setStatus('已复制到剪贴板（' + formatSize(text.length) + '）');
      });
    } else {
      outputEl.select();
      document.execCommand('copy');
      setStatus('已复制到剪贴板');
    }
  });

  document.getElementById('btn-clear').addEventListener('click', function () {
    inputEl.value = '';
    outputEl.value = '';
    clearPanels();
    updateInputStatus();
  });

  document.getElementById('btn-clear-history').addEventListener('click', function () {
    clearHistory().then(renderHistory);
  });

  var inputTimer = null;
  inputEl.addEventListener('input', function () {
    clearTimeout(inputTimer);
    inputTimer = setTimeout(updateInputStatus, 200);
  });

  updateInputStatus();
  renderHistory();
})();
