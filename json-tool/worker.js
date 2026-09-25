/*
 * JSON 引擎：解析 / 格式化 / 压缩 / 排序键 / 转义 / 去转义
 * 同一份代码可运行于：Web Worker、浏览器主线程（降级）、Node（测试）
 *
 * 设计要点：
 * - 手写递归下降解析器，错误可报告精确的行号 / 列号 / 字符位置
 * - 数字一律保留原始字面量（{__num: "..."}），大数字不丢精度
 * - 重复键与 JSON.parse 行为一致（保留最后一个），并记录重复键位置
 * - 解析前自动去除 BOM；文本中间出现 BOM 报“非法字符”
 * - 序列化器带循环引用检测，遇到环给出明确提示
 */
(function (global) {
  'use strict';

  var MAX_DEPTH = 1000;          // 嵌套深度上限（远超验收要求的 100 层）
  var MAX_INPUT = 100 * 1024 * 1024; // 超长输入保护：100MB

  function isRawNum(v) {
    return v !== null && typeof v === 'object' && typeof v.__num === 'string';
  }

  function posOf(text, index) {
    var line = 1, col = 1;
    for (var p = 0; p < index; p++) {
      if (text.charCodeAt(p) === 10) { line++; col = 1; } else { col++; }
    }
    return { line: line, column: col, index: index };
  }

  function hex4(code) {
    var s = code.toString(16);
    while (s.length < 4) s = '0' + s;
    return s;
  }

  /* ---------------- 解析器 ---------------- */

  function parse(text) {
    if (typeof text !== 'string') {
      return { ok: false, error: { message: '输入必须是字符串', line: 1, column: 1, index: 0 }, duplicates: [], warnings: [] };
    }
    if (text.length > MAX_INPUT) {
      return { ok: false, error: { message: '输入超长：超过 100MB 上限，当前约 ' + (text.length / 1048576).toFixed(1) + 'MB', line: 1, column: 1, index: 0 }, duplicates: [], warnings: [] };
    }

    var i = 0;
    var len = text.length;
    var duplicates = [];
    var warnings = [];

    // BOM 头：仅允许出现在开头，自动去除并提示
    if (text.charCodeAt(0) === 0xFEFF) {
      i = 1;
      warnings.push('已自动去除 BOM 头 (U+FEFF)');
    }

    function fail(index, message) {
      var pos = posOf(text, Math.min(index, len));
      throw { __jsonError: { message: message, line: pos.line, column: pos.column, index: pos.index } };
    }

    function skipWs() {
      while (i < len) {
        var c = text.charCodeAt(i);
        if (c === 32 || c === 9 || c === 10 || c === 13) { i++; }
        else if (c === 0xFEFF) { fail(i, '非法字符：BOM (U+FEFF) 只能出现在文本开头'); }
        else { return; }
      }
    }

    function parseValue(depth) {
      if (depth > MAX_DEPTH) {
        fail(i, '嵌套深度超过限制（' + MAX_DEPTH + ' 层）');
      }
      skipWs();
      if (i >= len) fail(i, '意外的输入结束：期望一个 JSON 值');
      var c = text[i];
      if (c === '{') return parseObject(depth);
      if (c === '[') return parseArray(depth);
      if (c === '"') return parseString();
      if (c === 't') return parseLiteral('true', true);
      if (c === 'f') return parseLiteral('false', false);
      if (c === 'n') return parseLiteral('null', null);
      if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
      var code = text.charCodeAt(i);
      if (code < 0x20) {
        fail(i, '非法字符：未转义的控制字符 U+' + hex4(code));
      }
      fail(i, '非法字符 "' + c + '" (U+' + hex4(code) + ')，期望一个 JSON 值');
    }

    function parseLiteral(word, val) {
      if (text.substr(i, word.length) === word) { i += word.length; return val; }
      fail(i, '非法的字面量，期望 "' + word + '"');
    }

    function parseString() {
      i++; // 跳过开引号
      var start = i;
      var out = '';
      while (i < len) {
        var code = text.charCodeAt(i);
        if (code === 34) { // "
          out += text.slice(start, i);
          i++;
          return out;
        }
        if (code === 92) { // 反斜杠
          out += text.slice(start, i);
          i++;
          if (i >= len) fail(i - 1, '意外的输入结束：转义序列不完整');
          var e = text[i];
          if (e === '"') out += '"';
          else if (e === '\\') out += '\\';
          else if (e === '/') out += '/';
          else if (e === 'b') out += '\b';
          else if (e === 'f') out += '\f';
          else if (e === 'n') out += '\n';
          else if (e === 'r') out += '\r';
          else if (e === 't') out += '\t';
          else if (e === 'u') {
            var hex = text.substr(i + 1, 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail(i - 1, '非法的 \\u 转义序列');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            fail(i - 1, '非法的转义字符 "\\' + e + '"');
          }
          i++;
          start = i;
          continue;
        }
        if (code < 0x20) {
          fail(i, '非法字符：字符串中包含未转义的控制字符 U+' + hex4(code));
        }
        i++;
      }
      fail(len, '意外的输入结束：字符串缺少结束引号');
    }

    function parseNumber() {
      var start = i;
      if (text[i] === '-') i++;
      if (text[i] === '0') { i++; }
      else if (text[i] >= '1' && text[i] <= '9') {
        while (text[i] >= '0' && text[i] <= '9') i++;
      } else {
        fail(start, '非法的数字');
      }
      if (text[i] === '.') {
        i++;
        if (!(text[i] >= '0' && text[i] <= '9')) fail(i, '非法的数字：小数点后缺少数字');
        while (text[i] >= '0' && text[i] <= '9') i++;
      }
      if (text[i] === 'e' || text[i] === 'E') {
        i++;
        if (text[i] === '+' || text[i] === '-') i++;
        if (!(text[i] >= '0' && text[i] <= '9')) fail(i, '非法的数字：指数部分缺少数字');
        while (text[i] >= '0' && text[i] <= '9') i++;
      }
      // 关键：保留原始字面量，大数字不经过 Number，精度零损失
      return { __num: text.slice(start, i) };
    }

    function parseObject(depth) {
      i++; // {
      var obj = {};
      var seen = new Set();
      skipWs();
      if (text[i] === '}') { i++; return obj; }
      while (true) {
        skipWs();
        if (text[i] === '}') fail(i, '非法的尾随逗号：对象最后一个键值对后不能有 ","');
        if (text[i] !== '"') fail(i, '对象的键必须是双引号字符串');
        var keyIndex = i;
        var key = parseString();
        if (seen.has(key)) {
          var pos = posOf(text, keyIndex);
          duplicates.push({ key: key, line: pos.line, column: pos.column });
        }
        seen.add(key);
        skipWs();
        if (text[i] !== ':') fail(i, '期望 ":"');
        i++;
        obj[key] = parseValue(depth + 1); // 重复键保留最后一个，与 JSON.parse 一致
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return obj; }
        fail(i, '期望 "," 或 "}"');
      }
    }

    function parseArray(depth) {
      i++; // [
      var arr = [];
      skipWs();
      if (text[i] === ']') { i++; return arr; }
      while (true) {
        skipWs();
        if (text[i] === ']') fail(i, '非法的尾随逗号：数组最后一个元素后不能有 ","');
        arr.push(parseValue(depth + 1));
        skipWs();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return arr; }
        fail(i, '期望 "," 或 "]"');
      }
    }

    try {
      skipWs();
      if (i >= len) fail(i, '输入为空：期望一个 JSON 值');
      var value = parseValue(1);
      skipWs();
      if (i < len) fail(i, 'JSON 内容结束后存在多余字符');
      return { ok: true, value: value, duplicates: duplicates, warnings: warnings };
    } catch (e) {
      if (e && e.__jsonError) {
        return { ok: false, error: e.__jsonError, duplicates: [], warnings: warnings };
      }
      throw e;
    }
  }

  /* ---------------- 序列化器 ---------------- */

  function serialize(value, options) {
    options = options || {};
    var indent = options.indent == null ? null : options.indent;
    var sortKeys = !!options.sortKeys;
    var seen = new Set(); // 循环引用检测
    var parts = [];

    function newline(level) {
      if (indent === null) return;
      parts.push('\n');
      for (var k = 0; k < level; k++) parts.push(indent);
    }

    function write(v, level) {
      if (v === null) { parts.push('null'); return; }
      if (typeof v === 'string') { parts.push(JSON.stringify(v)); return; }
      if (typeof v === 'boolean') { parts.push(v ? 'true' : 'false'); return; }
      if (typeof v === 'number') { parts.push(String(v)); return; }
      if (isRawNum(v)) { parts.push(v.__num); return; } // 大数字原样输出

      if (Array.isArray(v)) {
        if (seen.has(v)) throw { __circular: true };
        if (v.length === 0) { parts.push('[]'); return; }
        seen.add(v);
        parts.push('[');
        for (var a = 0; a < v.length; a++) {
          if (a > 0) parts.push(',');
          newline(level + 1);
          write(v[a], level + 1);
        }
        newline(level);
        parts.push(']');
        seen.delete(v);
        return;
      }

      if (typeof v === 'object') {
        if (seen.has(v)) throw { __circular: true };
        var keys = Object.keys(v);
        if (sortKeys) keys.sort();
        if (keys.length === 0) { parts.push('{}'); return; }
        seen.add(v);
        parts.push('{');
        for (var k = 0; k < keys.length; k++) {
          if (k > 0) parts.push(',');
          newline(level + 1);
          parts.push(JSON.stringify(keys[k]));
          parts.push(indent === null ? ':' : ': ');
          write(v[keys[k]], level + 1);
        }
        newline(level);
        parts.push('}');
        seen.delete(v);
        return;
      }

      throw { __jsonError: { message: '不支持的值类型：' + typeof v, line: 1, column: 1, index: 0 } };
    }

    write(value, 0);
    return parts.join('');
  }

  /* ---------------- 转义 / 去转义 ---------------- */

  function escapeText(text) {
    return JSON.stringify(text);
  }

  function unescapeText(text) {
    var t = text.replace(/^\uFEFF/, '').trim();
    try {
      var v = JSON.parse(t);
      if (typeof v === 'string') return { ok: true, result: v };
      return { ok: false, error: { message: '去转义失败：输入解析后不是字符串', line: 1, column: 1, index: 0 } };
    } catch (e1) {
      try {
        return { ok: true, result: JSON.parse('"' + t.replace(/^\uFEFF/, '') + '"') };
      } catch (e2) {
        return { ok: false, error: { message: '去转义失败：不是合法的转义字符串（' + e1.message + '）', line: 1, column: 1, index: 0 } };
      }
    }
  }

  /* ---------------- 动作分发 ---------------- */

  function handle(action, payload) {
    payload = payload || {};
    var t0 = Date.now();

    if (action === 'escape') {
      return { ok: true, result: escapeText(String(payload.text || '')), duplicates: [], warnings: [], elapsedMs: Date.now() - t0 };
    }
    if (action === 'unescape') {
      var u = unescapeText(String(payload.text || ''));
      if (!u.ok) return { ok: false, error: u.error, duplicates: [], warnings: [] };
      return { ok: true, result: u.result, duplicates: [], warnings: [], elapsedMs: Date.now() - t0 };
    }

    var parsed = parse(String(payload.text || ''));
    if (!parsed.ok) {
      return { ok: false, error: parsed.error, duplicates: [], warnings: parsed.warnings };
    }

    var indent = payload.indent === '\t' ? '\t' : ' '.repeat(payload.indent === 4 ? 4 : 2);
    var result = null;
    try {
      if (action === 'validate') {
        result = null;
      } else if (action === 'format') {
        result = serialize(parsed.value, { indent: indent });
      } else if (action === 'compress') {
        result = serialize(parsed.value, {});
      } else if (action === 'sort') {
        result = serialize(parsed.value, { indent: indent, sortKeys: true });
      } else {
        return { ok: false, error: { message: '未知操作：' + action, line: 1, column: 1, index: 0 }, duplicates: [], warnings: [] };
      }
    } catch (e) {
      if (e && e.__circular) {
        return { ok: false, error: { message: '检测到循环引用：该结构不是合法的 JSON，无法序列化', line: 1, column: 1, index: 0 }, duplicates: [], warnings: parsed.warnings };
      }
      throw e;
    }

    return { ok: true, result: result, duplicates: parsed.duplicates, warnings: parsed.warnings, elapsedMs: Date.now() - t0 };
  }

  var JsonEngine = {
    parse: parse,
    serialize: serialize,
    escapeText: escapeText,
    unescapeText: unescapeText,
    handle: handle,
    MAX_DEPTH: MAX_DEPTH
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = JsonEngine; // Node（测试用）
  }
  if (typeof window === 'undefined' && typeof self !== 'undefined' && typeof self.postMessage === 'function') {
    self.onmessage = function (e) {
      var data = e.data || {};
      try {
        var res = handle(data.action, data.payload);
        res.id = data.id;
        self.postMessage(res);
      } catch (err) {
        self.postMessage({
          id: data.id,
          ok: false,
          error: { message: '内部错误：' + (err && err.message ? err.message : String(err)), line: 1, column: 1, index: 0 },
          duplicates: [],
          warnings: []
        });
      }
    };
  }
  global.JsonEngine = JsonEngine;
})(typeof self !== 'undefined' ? self : this);
