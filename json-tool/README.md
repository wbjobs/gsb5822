# JSON 工具

纯前端 JSON 工具：格式化、压缩、校验、排序键、转义/去转义。
DOM + Web Worker + IndexedDB，无构建依赖。

## 运行

```bash
cd json-tool
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

注意：Web Worker 在 `file://` 协议下不可用，必须通过 HTTP 访问。

## 测试

```bash
node test.js   # 41 项验收测试
```

## 特性

- 自研解析器（worker.js）：数字保留原始字面量，大数字不丢精度
- 非法 JSON 报错带行号/列号/上下文代码片段，光标自动定位到错误处
- 重复键全部保留并逐条告警（不覆盖、不丢弃，行为一致）
- BOM 头自动忽略并提示；非法控制字符精确定位
- 嵌套深度上限 1000 层（100 层轻松支持），超限友好报错而非崩溃
- 解析/格式化在 Web Worker 中执行，1MB JSON 约 100ms，主线程不卡
- 输入超 50MB 直接拒绝并提示；检测到循环引用标记/JS 对象语法时给出针对性提示
- IndexedDB 保存最近 10 次输入，点击即可恢复，可单条删除或清空
