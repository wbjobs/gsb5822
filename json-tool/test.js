/* 验收测试：node test.js */
const E = require('./worker.js');
let passed = 0, failed = 0;

function check(name, cond, extra) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.log('  ✗ ' + name + (extra ? ' -> ' + extra : '')); }
}

console.log('1. 格式化正确性');
{
  const r = E.handle('format', { text: '{"a":1,"b":[true,null,"x"],"c":{"d":2}}', indent: 2 });
  check('格式化结果与 JSON.parse 语义一致',
    JSON.stringify(JSON.parse(r.result)) === JSON.stringify({ a: 1, b: [true, null, 'x'], c: { d: 2 } }));
  check('格式化含缩进换行', r.result.includes('\n  "a": 1'));
}

console.log('2. 压缩正确性');
{
  const r = E.handle('compress', { text: '{ "a" : 1 , "b" : [ 1, 2 ] }' });
  check('压缩结果', r.result === '{"a":1,"b":[1,2]}', r.result);
}

console.log('3. 非法 JSON 报错 + 行号');
{
  const r = E.handle('validate', { text: '{\n  "a": 1,\n  "b": tru\n}' });
  check('校验失败', !r.ok);
  check('错误行号为 3', r.error.line === 3, JSON.stringify(r.error));
  const r2 = E.handle('validate', { text: '{"a": }' });
  check('非法值报错并带列号', !r2.ok && r2.error.column > 0);
  const r3 = E.handle('validate', { text: '[1, 2,]' });
  check('尾随逗号报错', !r3.ok && /尾随逗号/.test(r3.error.message));
}

console.log('4. 1MB JSON 性能（< 1s）');
{
  const arr = [];
  for (let i = 0; i < 20000; i++) {
    arr.push({ id: i, name: 'item-' + i, flag: i % 2 === 0, val: null, scores: [i, i * 2, i * 3] });
  }
  let big = JSON.stringify({ data: arr });
  check('测试数据 >= 1MB', big.length >= 1024 * 1024, big.length + ' bytes');
  let t0 = process.hrtime.bigint();
  const r = E.handle('format', { text: big, indent: 2 });
  let ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('1MB 格式化 < 1000ms（实际 ' + ms.toFixed(0) + 'ms）', r.ok && ms < 1000);
  t0 = process.hrtime.bigint();
  const r2 = E.handle('compress', { text: big });
  ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check('1MB 压缩 < 1000ms（实际 ' + ms.toFixed(0) + 'ms）', r2.ok && ms < 1000);
  check('压缩后语义一致', JSON.stringify(JSON.parse(r2.result)) === JSON.stringify(JSON.parse(big)));
}

console.log('5. 嵌套 100 层');
{
  const deep = '['.repeat(100) + '1' + ']'.repeat(100);
  const r = E.handle('compress', { text: deep });
  check('100 层嵌套不崩且结果正确', r.ok && r.result === deep);
  const deepObj = E.handle('validate', { text: '{"a":'.repeat(100) + '1' + '}'.repeat(100) });
  check('100 层对象嵌套合法', deepObj.ok);
  const tooDeep = E.handle('validate', { text: '['.repeat(1001) + '1' + ']'.repeat(1001) });
  check('超过深度上限给出友好错误', !tooDeep.ok && /嵌套深度/.test(tooDeep.error.message));
}

console.log('6. 重复键处理一致');
{
  const r = E.handle('compress', { text: '{"a":1,"b":2,"a":3}' });
  check('重复键保留最后一个（与 JSON.parse 一致）', r.ok && r.result === '{"a":3,"b":2}', r.result);
  check('重复键有警告和行号', r.duplicates.length === 1 && r.duplicates[0].key === 'a' && r.duplicates[0].line === 1);
}

console.log('7. 大数字精度保持');
{
  const big1 = '9007199254740993';           // 超过 Number.MAX_SAFE_INTEGER
  const big2 = '123456789012345678901234567890';
  const big3 = '1.23456789012345678901234567890e-30';
  const r = E.handle('compress', { text: `{"x":${big1},"y":${big2},"z":${big3}}` });
  check('大整数精度保持', r.ok && r.result.includes(big1) && r.result.includes(big2), r.result);
  check('高精度小数保持', r.ok && r.result.includes(big3));
  check('未经 Number 转换（无精度损失）', !r.result.includes('9007199254740992'));
}

console.log('8. BOM 头处理');
{
  const r = E.handle('compress', { text: '﻿{"a":1}' });
  check('BOM 自动去除', r.ok && r.result === '{"a":1}');
  check('BOM 有提示', r.warnings.some(w => /BOM/.test(w)));
  const r2 = E.handle('validate', { text: '{"a":1} ﻿' });
  check('文本中间 BOM 报非法字符', !r2.ok && /BOM/.test(r2.error.message));
}

console.log('9. 循环引用检测');
{
  const a = { name: 'a' };
  a.self = a;
  let caught = null;
  try { E.serialize(a, {}); } catch (e) { caught = e; }
  check('序列化循环引用抛出检测错误', caught && caught.__circular === true);
}

console.log('10. 非法字符');
{
  const r = E.handle('validate', { text: '{"a":"x\t y"}' }); // 字符串内含原始 tab
  check('未转义控制字符报错并给位置', !r.ok && /控制字符/.test(r.error.message));
  const r2 = E.handle('validate', { text: '{a:1}' });
  check('未加引号的键报错', !r2.ok);
  const r3 = E.handle('validate', { text: "{'a':1}" });
  check('单引号报错', !r3.ok);
}

console.log('11. 排序键');
{
  const r = E.handle('sort', { text: '{"b":1,"a":{"d":4,"c":3}}', indent: 2 });
  check('键递归排序', r.ok && r.result.indexOf('"a"') < r.result.indexOf('"b"') &&
    r.result.indexOf('"c"') < r.result.indexOf('"d"'), r.result);
}

console.log('12. 转义 / 去转义');
{
  const r = E.handle('escape', { text: 'a"b\nc' });
  check('转义', r.ok && r.result === '"a\\"b\\nc"', r.result);
  const r2 = E.handle('unescape', { text: r.result });
  check('去转义还原', r2.ok && r2.result === 'a"b\nc');
  const r3 = E.handle('unescape', { text: 'not\\valid\\' });
  check('非法转义串报错', !r3.ok);
}

console.log('13. 超长 / 空输入保护');
{
  const r = E.handle('validate', { text: '' });
  check('空输入报错', !r.ok);
  const huge = '1'.repeat(101 * 1024 * 1024);
  const r2 = E.handle('validate', { text: huge });
  check('超长输入（>100MB）友好报错', !r2.ok && /超长/.test(r2.error.message));
}

console.log('14. 与 JSON.parse 行为对照（随机样例）');
{
  const samples = [
    '{"a":[1,2.5,-3e10],"b":{"c":"\\u4e2d\\u6587"},"d":null,"e":false}',
    '[]', '{}', '"str"', '123', '-0.5e+2', 'true', 'null',
    '[[[["deep"]]]]', '{"":""}', '{"k":"line1\\nline2\\ttab"}' 
  ];
  let allOk = true;
  for (const s of samples) {
    const r = E.handle('compress', { text: s });
    if (!r.ok) { allOk = false; console.log('    解析失败: ' + s); continue; }
    const expected = JSON.stringify(JSON.parse(s));
    // 数字按字面量保留，与 JSON.stringify 可能不同（如 -0.5e+2 -> -50），用语义比较
    if (JSON.stringify(JSON.parse(r.result)) !== expected) {
      allOk = false; console.log('    语义不一致: ' + s + ' -> ' + r.result);
    }
  }
  check('全部样例语义一致', allOk);
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
