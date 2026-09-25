'use strict';

/*
 * JSON 解析 / 序列化 Worker。
 * 自研解析器（不依赖 JSON.parse 的对象化结果），以便：
 *  - 数字保留原始字面量，大数字不丢精度
 *  - 重复键全部保留并给出告警（行为一致：不覆盖、不丢弃）
 *  - 报错带行号 / 列号 / 字符偏移
 *  - 检测 BOM、非法控制字符、嵌套深度
 */

var MAX_DEPTH = 1000; // 远超需求的 100 层，同时防止栈溢出

function now() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function ParseError(message, line, col, pos) {
  var e = new Error(message);
  e.name = 'ParseError';
  e.line = line;
  e.col = col;
  e.pos = pos;
  return e;
}

function hex4(code) {
  var s = code.toString(16).toUpperCase();
  while (s.length < 4) s = '0' + s;
  return s;
}

function parse(text) {
  var warnings = [];
  var len = text.length;
  var i = 0, line = 1, col = 1, maxDepth = 0;

  // BOM 头处理
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) {
    i = 1;
    col = 2;
    warnings.push({ type: 'bom', message: '检测到 BOM 头（U+FEFF），已自动忽略', line: 1, col: 1 });
  }

  function error(message) {
    throw ParseError(message, line, col, i);
  }

  function advance() {
    var ch = text[i++];
    if (ch === '\n') { line++; col = 1; } else { col++; }
    return ch;
  }

  function skipWhitespace() {
    while (i < len) {
      var ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        advance();
      } else if (ch < ' ') {
        error('非法控制字符 U+' + hex4(ch.charCodeAt(0)) + '（JSON 只允许空格/制表/换行作为空白）');
      } else {
        break;
      }
    }
  }

  function parseString() {
    advance(); // 消费开头的 "
    var out = '';
    var chunkStart = i;
    for (;;) {
      if (i >= len) error('字符串未闭合（缺少结束引号 "）');
      var ch = text[i];
      if (ch === '"') {
        out += text.slice(chunkStart, i);
        advance();
        return out;
      }
      if (ch === '\\') {
        out += text.slice(chunkStart, i);
        advance();
        if (i >= len) error('转义序列不完整');
        var esc = advance();
        if (esc === '"') out += '"';
        else if (esc === '\\') out += '\\';
        else if (esc === '/') out += '/';
        else if (esc === 'b') out += '\b';
        else if (esc === 'f') out += '\f';
        else if (esc === 'n') out += '\n';
        else if (esc === 'r') out += '\r';
        else if (esc === 't') out += '\t';
        else if (esc === 'u') {
          var hex = '';
          for (var k = 0; k < 4; k++) {
            if (i >= len || !/[0-9a-fA-F]/.test(text[i])) {
              error('\\u 后必须跟 4 位十六进制字符');
            }
            hex += advance();
          }
          out += String.fromCharCode(parseInt(hex, 16));
        } else {
          error("非法转义字符 '\\" + esc + "'");
        }
        chunkStart = i;
      } else if (ch < ' ') {
        error('字符串中包含未转义的控制字符 U+' + hex4(ch.charCodeAt(0)) + '，请改用 \\u 转义');
      } else {
        advance();
      }
    }
  }

  function parseNumber(startLine, startCol) {
    var start = i;
    if (text[i] === '-') advance();
    if (i >= len) error('数字不完整');
    if (text[i] === '0') {
      advance();
    } else if (text[i] >= '1' && text[i] <= '9') {
      while (i < len && text[i] >= '0' && text[i] <= '9') advance();
    } else {
      error('非法数字（前导零、单独负号或非数字字符）');
    }
    if (text[i] === '.') {
      advance();
      if (!(text[i] >= '0' && text[i] <= '9')) error('小数点后必须跟数字');
      while (i < len && text[i] >= '0' && text[i] <= '9') advance();
    }
    if (text[i] === 'e' || text[i] === 'E') {
      advance();
      if (text[i] === '+' || text[i] === '-') advance();
      if (!(text[i] >= '0' && text[i] <= '9')) error('指数部分必须跟数字');
      while (i < len && text[i] >= '0' && text[i] <= '9') advance();
    }
    return { type: 'number', raw: text.slice(start, i), line: startLine, col: startCol };
  }

  function parseLiteral(word, startLine, startCol) {
    for (var k = 0; k < word.length; k++) {
      if (text[i] !== word[k]) error("非法字面量，期望 '" + word + "'");
      advance();
    }
    return { type: 'literal', raw: word, line: startLine, col: startCol };
  }

  function parseObject(depth) {
    if (depth > MAX_DEPTH) error('嵌套深度超过限制（' + MAX_DEPTH + ' 层）');
    if (depth > maxDepth) maxDepth = depth;
    var startLine = line, startCol = col;
    advance(); // {
    var pairs = [];
    var seen = {}; // key -> 首次出现的行号
    skipWhitespace();
    if (text[i] === '}') {
      advance();
      return { type: 'object', pairs: pairs, line: startLine, col: startCol };
    }
    for (;;) {
      skipWhitespace();
      if (text[i] !== '"') error('对象键必须是双引号字符串');
      var keyLine = line, keyCol = col;
      var key = parseString();
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        warnings.push({
          type: 'duplicate',
          message: '重复键 "' + key + '"（首次出现于第 ' + seen[key] + ' 行，两处均保留）',
          line: keyLine,
          col: keyCol
        });
      } else {
        seen[key] = keyLine;
      }
      skipWhitespace();
      if (text[i] !== ':') error("键后期望 ':'");
      advance();
      var value = parseValue(depth + 1);
      pairs.push({ key: key, value: value, line: keyLine, col: keyCol });
      skipWhitespace();
      if (text[i] === ',') {
        advance();
        skipWhitespace();
        if (text[i] === '}') error('对象不允许尾随逗号');
        continue;
      }
      if (text[i] === '}') { advance(); break; }
      error("期望 ',' 或 '}'");
    }
    return { type: 'object', pairs: pairs, line: startLine, col: startCol };
  }

  function parseArray(depth) {
    if (depth > MAX_DEPTH) error('嵌套深度超过限制（' + MAX_DEPTH + ' 层）');
    if (depth > maxDepth) maxDepth = depth;
    var startLine = line, startCol = col;
    advance(); // [
    var items = [];
    skipWhitespace();
    if (text[i] === ']') {
      advance();
      return { type: 'array', items: items, line: startLine, col: startCol };
    }
    for (;;) {
      var value = parseValue(depth + 1);
      items.push(value);
      skipWhitespace();
      if (text[i] === ',') {
        advance();
        skipWhitespace();
        if (text[i] === ']') error('数组不允许尾随逗号');
        continue;
      }
      if (text[i] === ']') { advance(); break; }
      error("期望 ',' 或 ']'");
    }
    return { type: 'array', items: items, line: startLine, col: startCol };
  }

  function parseValue(depth) {
    skipWhitespace();
    if (i >= len) error('意外的输入结束（JSON 不完整）');
    var ch = text[i];
    var startLine = line, startCol = col;
    if (ch === '{') return parseObject(depth);
    if (ch === '[') return parseArray(depth);
    if (ch === '"') {
      var s = parseString();
      return { type: 'string', value: s, line: startLine, col: startCol };
    }
    if (ch === 't') return parseLiteral('true', startLine, startCol);
    if (ch === 'f') return parseLiteral('false', startLine, startCol);
    if (ch === 'n') return parseLiteral('null', startLine, startCol);
    if (ch === '-' || (ch >= '0' && ch <= '9')) return parseNumber(startLine, startCol);
    error("意外的字符 '" + ch + "'");
  }

  skipWhitespace();
  if (i >= len) error('输入为空或仅包含空白字符');
  var ast = parseValue(1);
  skipWhitespace();
  if (i < len) error("JSON 内容之后存在多余字符 '" + text[i] + "'");

  return { ast: ast, warnings: warnings, maxDepth: maxDepth };
}

function compareKeys(a, b) {
  if (a.key < b.key) return -1;
  if (a.key > b.key) return 1;
  return 0; // 重复键保持原始相对顺序（稳定排序）
}

function serialize(root, indentUnit, sortKeys) {
  var pretty = indentUnit !== '';
  var chunks = [];

  function write(node, level) {
    var idx, childIndent;
    if (node.type === 'string') {
      chunks.push(JSON.stringify(node.value));
    } else if (node.type === 'number' || node.type === 'literal') {
      chunks.push(node.raw); // 数字输出原始字面量，保证大数字精度
    } else if (node.type === 'object') {
      if (node.pairs.length === 0) { chunks.push('{}'); return; }
      var pairs = node.pairs;
      if (sortKeys) pairs = node.pairs.slice().sort(compareKeys);
      chunks.push('{');
      childIndent = pretty ? indentUnit.repeat(level + 1) : '';
      for (idx = 0; idx < pairs.length; idx++) {
        if (pretty) chunks.push('\n', childIndent);
        chunks.push(JSON.stringify(pairs[idx].key), pretty ? ': ' : ':');
        write(pairs[idx].value, level + 1);
        if (idx < pairs.length - 1) chunks.push(',');
      }
      if (pretty) chunks.push('\n', indentUnit.repeat(level));
      chunks.push('}');
    } else { // array
      if (node.items.length === 0) { chunks.push('[]'); return; }
      chunks.push('[');
      childIndent = pretty ? indentUnit.repeat(level + 1) : '';
      for (idx = 0; idx < node.items.length; idx++) {
        if (pretty) chunks.push('\n', childIndent);
        write(node.items[idx], level + 1);
        if (idx < node.items.length - 1) chunks.push(',');
      }
      if (pretty) chunks.push('\n', indentUnit.repeat(level));
      chunks.push(']');
    }
  }

  write(root, 0);
  return chunks.join('');
}

function collectStats(root, maxDepth) {
  var stats = { maxDepth: maxDepth, objects: 0, arrays: 0, strings: 0, numbers: 0, literals: 0, keys: 0 };
  var stack = [root];
  while (stack.length) {
    var node = stack.pop();
    if (node.type === 'object') {
      stats.objects++;
      stats.keys += node.pairs.length;
      for (var k = 0; k < node.pairs.length; k++) stack.push(node.pairs[k].value);
    } else if (node.type === 'array') {
      stats.arrays++;
      for (var m = 0; m < node.items.length; m++) stack.push(node.items[m]);
    } else if (node.type === 'string') stats.strings++;
    else if (node.type === 'number') stats.numbers++;
    else stats.literals++;
  }
  return stats;
}

function escapeText(text) {
  // 输出不带首尾引号的转义结果，便于直接嵌入 JSON 字符串
  var s = JSON.stringify(text);
  return s.slice(1, s.length - 1);
}

function unescapeText(text) {
  var t = text.trim();
  var parsed;
  try {
    parsed = JSON.parse(t);
  } catch (e1) {
    // 兼容不带首尾引号、且含真实换行的转义内容
    var wrapped = '"' + t.replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
    try {
      parsed = JSON.parse(wrapped);
    } catch (e2) {
      throw ParseError('无法去转义：输入不是合法的 JSON 转义字符串（' + e1.message + '）', 1, 1, 0);
    }
  }
  if (typeof parsed !== 'string') {
    throw ParseError('去转义结果不是字符串：请输入带转义内容的文本或 JSON 字符串字面量', 1, 1, 0);
  }
  return parsed;
}

function handleMessage(data) {
  var t0 = now();
  var action = data.action;
  var text = data.text;
  var options = data.options || {};
  var indentUnit = options.indent === 'tab' ? '\t' : ' '.repeat(options.indent || 2);

  var result = null, warnings = [], stats = null;

  if (action === 'escape') {
    result = escapeText(text);
  } else if (action === 'unescape') {
    result = unescapeText(text);
  } else {
    var parsed = parse(text);
    warnings = parsed.warnings;
    stats = collectStats(parsed.ast, parsed.maxDepth);
    if (action === 'format') {
      result = serialize(parsed.ast, indentUnit, false);
    } else if (action === 'minify') {
      result = serialize(parsed.ast, '', false);
    } else if (action === 'sort') {
      result = serialize(parsed.ast, indentUnit, true);
    } else if (action === 'validate') {
      result = null;
    } else {
      throw ParseError('未知操作: ' + action, 1, 1, 0);
    }
  }

  return {
    ok: true,
    result: result,
    warnings: warnings,
    stats: stats,
    duration: now() - t0
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = function (e) {
    var data = e.data;
    try {
      var resp = handleMessage(data);
      resp.id = data.id;
      self.postMessage(resp);
    } catch (ex) {
      self.postMessage({
        id: data.id,
        ok: false,
        error: {
          message: ex.message || String(ex),
          line: typeof ex.line === 'number' ? ex.line : null,
          col: typeof ex.col === 'number' ? ex.col : null,
          pos: typeof ex.pos === 'number' ? ex.pos : null
        },
        duration: 0
      });
    }
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { parse: parse, serialize: serialize, escapeText: escapeText, unescapeText: unescapeText, handleMessage: handleMessage, MAX_DEPTH: MAX_DEPTH };
}
