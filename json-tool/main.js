(function () {
  'use strict';

  var inputEl = document.getElementById('input');
  var outputEl = document.getElementById('output');
  var statusEl = document.getElementById('status');
  var workerStatusEl = document.getElementById('workerStatus');
  var errorBox = document.getElementById('errorBox');
  var errorText = document.getElementById('errorText');
  var warnBox = document.getElementById('warnBox');
  var locateBtn = document.getElementById('locateBtn');
  var copyBtn = document.getElementById('copyBtn');
  var clearBtn = document.getElementById('clearBtn');
  var indentSel = document.getElementById('indent');
  var historyList = document.getElementById('historyList');
  var clearHistoryBtn = document.getElementById('clearHistoryBtn');

  var ACTION_NAMES = {
    format: '格式化', compress: '压缩', validate: '校验',
    sort: '排序键', escape: '转义', unescape: '去转义'
  };

  /* ---------- Web Worker（失败时降级到主线程，仍可用） ---------- */

  var worker = null;
  var seq = 0;
  var pending = {};

  try {
    worker = new Worker('worker.js');
    worker.onmessage = function (e) {
      var res = e.data;
      var cb = pending[res.id];
      if (cb) { delete pending[res.id]; cb(res); }
    };
    worker.onerror = function () {
      worker = null;
      workerStatusEl.textContent = 'Worker 不可用，已降级为主线程模式（大文件可能短暂卡顿）';
    };
  } catch (e) {
    worker = null;
    workerStatusEl.textContent = 'Worker 不可用，已降级为主线程模式（大文件可能短暂卡顿）';
  }
  if (worker) workerStatusEl.textContent = 'Web Worker 已启用，主线程不阻塞';

  function runEngine(action, payload, cb) {
    if (worker) {
      var id = ++seq;
      pending[id] = cb;
      worker.postMessage({ id: id, action: action, payload: payload });
    } else {
      setTimeout(function () {
        try {
          cb(window.JsonEngine.handle(action, payload));
        } catch (err) {
          cb({ ok: false, error: { message: '内部错误：' + err.message, line: 1, column: 1, index: 0 }, duplicates: [], warnings: [] });
        }
      }, 0);
    }
  }

  /* ---------- IndexedDB：保存最近 10 次输入 ---------- */

  var DB_NAME = 'json-tool-db';
  var STORE = 'history';
  var MAX_HISTORY = 10;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function tx(db, mode, fn) {
    return new Promise(function (resolve, reject) {
      var t = db.transaction(STORE, mode);
      var store = t.objectStore(STORE);
      var out = fn(store);
      t.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : out); };
      t.onerror = function () { reject(t.error); };
    });
  }

  function saveHistory(input, action) {
    if (!input) return Promise.resolve();
    return openDb().then(function (db) {
      return tx(db, 'readwrite', function (store) {
        store.add({ input: input, action: action, ts: Date.now() });
      }).then(function () {
        return tx(db, 'readwrite', function (store) {
          var getAll = store.getAll();
          getAll.onsuccess = function () {
            var rows = getAll.result.sort(function (a, b) { return a.ts - b.ts; });
            for (var i = 0; i < rows.length - MAX_HISTORY; i++) {
              store.delete(rows[i].id);
            }
          };
        });
      });
    }).then(renderHistory).catch(function () { /* IndexedDB 不可用时静默降级 */ });
  }

  function loadHistory() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(STORE, 'readonly');
        var req = t.objectStore(STORE).getAll();
        req.onsuccess = function () {
          resolve(req.result.sort(function (a, b) { return b.ts - a.ts; }));
        };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clearHistory() {
    return openDb().then(function (db) {
      return tx(db, 'readwrite', function (store) { store.clear(); });
    }).then(renderHistory).catch(function () {});
  }

  function renderHistory() {
    return loadHistory().then(function (rows) {
      historyList.innerHTML = '';
      if (!rows.length) {
        var li = document.createElement('li');
        li.className = 'empty';
        li.textContent = '暂无历史记录';
        historyList.appendChild(li);
        return;
      }
      rows.forEach(function (row) {
        var li = document.createElement('li');
        var tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = ACTION_NAMES[row.action] || row.action;
        var time = document.createElement('span');
        time.className = 'time';
        time.textContent = new Date(row.ts).toLocaleString();
        var preview = document.createElement('span');
        preview.className = 'preview';
        preview.textContent = row.input.slice(0, 120);
        li.appendChild(tag);
        li.appendChild(time);
        li.appendChild(preview);
        li.title = '点击恢复此输入';
        li.addEventListener('click', function () {
          inputEl.value = row.input;
          setStatus('已恢复历史输入（' + formatBytes(byteLen(row.input)) + '）');
          hideMessages();
        });
        historyList.appendChild(li);
      });
    }).catch(function () {});
  }

  /* ---------- UI 辅助 ---------- */

  function byteLen(s) {
    return new Blob([s]).size;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(2) + ' MB';
  }

  function setStatus(msg) { statusEl.textContent = msg; }

  function hideMessages() {
    errorBox.classList.add('hidden');
    warnBox.classList.add('hidden');
  }

  var lastError = null;

  function showError(err) {
    lastError = err;
    errorText.textContent = err.message + '（第 ' + err.line + ' 行，第 ' + err.column + ' 列）';
    errorBox.classList.remove('hidden');
  }

  function showWarnings(res) {
    var msgs = [];
    (res.warnings || []).forEach(function (w) { msgs.push(w); });
    (res.duplicates || []).forEach(function (d) {
      msgs.push('重复键 "' + d.key + '"（第 ' + d.line + ' 行，第 ' + d.column + ' 列）：已保留最后一个值');
    });
    if (!msgs.length) { warnBox.classList.add('hidden'); return; }
    warnBox.innerHTML = '';
    msgs.forEach(function (m) {
      var div = document.createElement('div');
      div.textContent = '⚠ ' + m;
      warnBox.appendChild(div);
    });
    warnBox.classList.remove('hidden');
  }

  function setButtonsEnabled(enabled) {
    var btns = document.querySelectorAll('.toolbar button');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = !enabled;
  }

  /* ---------- 主流程 ---------- */

  function runAction(action) {
    var text = inputEl.value;
    if (!text) { setStatus('请输入内容'); return; }
    hideMessages();
    setButtonsEnabled(false);
    setStatus(ACTION_NAMES[action] + '中…');

    var indentRaw = indentSel.value;
    var indent = indentRaw === '\\t' ? '\t' : parseInt(indentRaw, 10);
    var t0 = performance.now();

    runEngine(action, { text: text, indent: indent }, function (res) {
      setButtonsEnabled(true);
      var elapsed = Math.max(0, Math.round(performance.now() - t0));
      if (!res.ok) {
        outputEl.value = '';
        showError(res.error);
        showWarnings(res);
        setStatus('失败，耗时 ' + elapsed + ' ms');
        saveHistory(text, action);
        return;
      }
      if (action === 'validate') {
        outputEl.value = '';
        setStatus('✓ JSON 合法，耗时 ' + elapsed + ' ms，大小 ' + formatBytes(byteLen(text)));
      } else {
        outputEl.value = res.result;
        setStatus(
          ACTION_NAMES[action] + '完成，耗时 ' + elapsed + ' ms，' +
          formatBytes(byteLen(text)) + ' → ' + formatBytes(byteLen(res.result))
        );
      }
      showWarnings(res);
      saveHistory(text, action);
    });
  }

  var actionBtns = document.querySelectorAll('.toolbar button[data-action]');
  for (var i = 0; i < actionBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () { runAction(btn.getAttribute('data-action')); });
    })(actionBtns[i]);
  }

  locateBtn.addEventListener('click', function () {
    if (!lastError) return;
    inputEl.focus();
    var idx = Math.min(lastError.index, inputEl.value.length);
    inputEl.setSelectionRange(idx, idx);
    // 滚动到错误行附近
    var lineHeight = parseFloat(getComputedStyle(inputEl).lineHeight) || 20;
    inputEl.scrollTop = Math.max(0, (lastError.line - 3) * lineHeight);
  });

  copyBtn.addEventListener('click', function () {
    var text = outputEl.value;
    if (!text) { setStatus('没有可复制的结果'); return; }
    function done() { setStatus('已复制到剪贴板'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else {
      fallbackCopy(text);
      done();
    }
  });

  function fallbackCopy(text) {
    outputEl.select();
    try { document.execCommand('copy'); } catch (e) {}
    inputEl.focus();
  }

  clearBtn.addEventListener('click', function () {
    inputEl.value = '';
    outputEl.value = '';
    hideMessages();
    setStatus('就绪');
    inputEl.focus();
  });

  clearHistoryBtn.addEventListener('click', function () {
    clearHistory();
  });

  renderHistory();
})();
