'use strict';
// 验收测试：node test.js
const { parse, serialize, escapeText, unescapeText, handleMessage, MAX_DEPTH } = require('./worker.js');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' -- ' + extra : '')); }
}

console.log('1. 格式化 / 压缩正确性');
{
  const src = '{"b":2,"a":[1,{"x":"y\\n"},true,null]}';
  const { ast } = parse(src);
  const pretty = serialize(ast, '  ', false);
  ok(pretty === JSON.stringify(JSON.parse(src), null, 2), '格式化与 JSON.stringify 一致');
  const mini = serialize(ast, '', false);
  ok(mini === src, '压缩结果正确');
  ok(mini === JSON.stringify(JSON.parse(src)), '压缩与 JSON.stringify 一致');
}

console.log('2. 排序键');
{
  const { ast } = parse('{"b":1,"a":2,"c":{"z":0,"y":1}}');
  const sorted = serialize(ast, '  ', true);
  ok(sorted.indexOf('"a"') < sorted.indexOf('"b"'), '顶层键已排序');
  ok(sorted.indexOf('"y"') < sorted.indexOf('"z"'), '嵌套键已排序');
}

console.log('3. 非法 JSON 报错带行号列号');
{
  const src = '{\n  "a": 1,\n  "b": tru\n}';
  let err = null;
  try { parse(src); } catch (e) { err = e; }
  ok(err && err.line === 3, '错误行号 = 3', err && ('got line ' + err.line));
  ok(typeof err.col === 'number' && err.col > 0, '错误列号存在');
  ok(typeof err.pos === 'number', '字符偏移存在');
}
{
  let err = null;
  try { parse('{"a": 1,}'); } catch (e) { err = e; }
  ok(err && /尾随逗号/.test(err.message), '尾随逗号报错: ' + (err && err.message));
}
{
  let err = null;
  try { parse('[1, 2'); } catch (e) { err = e; }
  ok(err !== null, '未闭合数组报错');
}

console.log('4. 1MB JSON 在 1 秒内完成');
{
  const parts = ['{'];
  const n = 12000;
  for (let k = 0; k < n; k++) {
    if (k) parts.push(',');
    parts.push('"key_' + k + '":{"id":' + k + ',"name":"value-' + k + '-abcdefghij","flag":' + (k % 2 === 0) + ',"tags":["a","b","c"],"score":' + (k * 1.5) + '}');
  }
  parts.push('}');
  const big = parts.join('');
  ok(big.length > 1024 * 1024, '测试数据 > 1MB（实际 ' + (big.length / 1024 / 1024).toFixed(2) + ' MB）');
  const t0 = Date.now();
  const { ast } = parse(big);
  const out = serialize(ast, '  ', false);
  const mini = serialize(ast, '', false);
  const dt = Date.now() - t0;
  ok(dt < 1000, '解析+格式化+压缩耗时 ' + dt + ' ms < 1000 ms');
  ok(mini === big, '1MB 压缩结果与原文逐字节一致');
  ok(JSON.stringify(JSON.parse(big)) === JSON.stringify(JSON.parse(out)), '格式化结果语义一致');
}

console.log('5. 嵌套 100 层不崩');
{
  const deep = '['.repeat(100) + '1' + ']'.repeat(100);
  const { ast, maxDepth } = parse(deep);
  ok(maxDepth === 100, 'maxDepth = 100');
  const out = serialize(ast, '', false);
  ok(out === deep, '100 层压缩往返一致');
  const pretty = serialize(ast, '  ', false);
  ok(pretty.split('\n').length === 201, '100 层格式化行数正确');
}
{
  const tooDeep = '['.repeat(MAX_DEPTH + 1) + '1' + ']'.repeat(MAX_DEPTH + 1);
  let err = null;
  try { parse(tooDeep); } catch (e) { err = e; }
  ok(err && /嵌套深度/.test(err.message), '超过 ' + MAX_DEPTH + ' 层给出友好报错而非崩溃');
}

console.log('6. 重复键处理一致（全部保留 + 告警）');
{
  const src = '{"a":1,"a":2,"a":3}';
  const { ast, warnings } = parse(src);
  ok(warnings.filter(w => w.type === 'duplicate').length === 2, '产生 2 条重复键告警');
  ok(serialize(ast, '', false) === src, '重复键全部保留，不覆盖不丢弃');
  ok(warnings[0].line === 1, '告警带行号');
}

console.log('7. 大数字精度保持');
{
  const big = '123456789012345678901234567890123456789';
  const precise = '9007199254740993';
  const decimal = '0.12345678901234567890123456789012345';
  const src = '{"big":' + big + ',"safe":' + precise + ',"dec":' + decimal + ',"exp":1.7976931348623157e308}';
  const { ast } = parse(src);
  const out = serialize(ast, '', false);
  ok(out === src, '大数字原样保留（精度不丢）');
  ok(out.indexOf(big) !== -1, '39 位整数完整保留');
  ok(out.indexOf(precise) !== -1, '超过 2^53 的整数完整保留');
  ok(String(JSON.parse(src).safe) !== precise, '对照：JSON.parse 确实会丢精度（' + JSON.parse(src).safe + '）');
}

console.log('8. BOM 头处理');
{
  const { ast, warnings } = parse('﻿{"a":1}');
  ok(serialize(ast, '', false) === '{"a":1}', 'BOM 被忽略，解析正常');
  ok(warnings.some(w => w.type === 'bom'), 'BOM 产生提示');
}

console.log('9. 非法字符');
{
  let err = null;
  try { parse('{"a":"b"}'); } catch (e) { err = e; }
  ok(err && /控制字符/.test(err.message), '非法控制字符报错: ' + (err && err.message));
  ok(err && err.line === 1 && err.col > 1, '控制字符报错带行列');
  let err2 = null;
  try { parse('{"a":"x\ty"}'); } catch (e) { err2 = e; }
  ok(err2 && /控制字符/.test(err2.message), '字符串内未转义控制字符报错');
}

console.log('10. 转义 / 去转义');
{
  const raw = 'hello "world"\n中文\tend';
  const esc = escapeText(raw);
  ok(esc === 'hello \\"world\\"\\n中文\\tend', '转义结果正确');
  ok(unescapeText(esc) === raw, '去转义还原');
  ok(unescapeText(JSON.stringify(raw)) === raw, '带引号的 JSON 字符串也可去转义');
  let err = null;
  try { unescapeText('{"a":1}'); } catch (e) { err = e; }
  ok(err !== null, '非字符串输入去转义给出提示');
}

console.log('11. 深度嵌套对象 + 混合结构');
{
  let src = '{"v":0}';
  for (let d = 1; d <= 100; d++) src = '{"level":' + d + ',"child":' + src + ',"arr":[1,{"x":true}]}';
  const { ast, maxDepth } = parse(src);
  ok(maxDepth > 100, '混合结构深度统计正常（' + maxDepth + '）');
  ok(serialize(ast, '', false) === src, '混合结构压缩往返一致');
}

console.log('12. handleMessage 端到端（模拟 Worker 消息）');
{
  const r1 = handleMessage({ action: 'format', text: '{"a":1}', options: { indent: 2 } });
  ok(r1.ok && r1.result === '{\n  "a": 1\n}', 'format 消息正常');
  const r2 = handleMessage({ action: 'validate', text: '{"a":1}', options: {} });
  ok(r2.ok && r2.stats && r2.stats.keys === 1, 'validate 返回统计');
  const r3 = handleMessage({ action: 'minify', text: '{ "a" : 1 }', options: {} });
  ok(r3.ok && r3.result === '{"a":1}', 'minify 消息正常');
  const r4 = handleMessage({ action: 'escape', text: 'a"b', options: {} });
  ok(r4.ok && r4.result === 'a\\"b', 'escape 消息正常');
  let threw = false;
  try { handleMessage({ action: 'format', text: '{bad', options: {} }); } catch (e) { threw = e.line === 1; }
  ok(threw, '错误消息带行号抛出');
}

console.log('\n结果: ' + passed + ' 通过, ' + failed + ' 失败');
process.exit(failed ? 1 : 0);
