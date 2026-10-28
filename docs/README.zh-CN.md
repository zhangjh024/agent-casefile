# Agent Casefile · 中文快速开始

**把“Agent 卡住了”变成可以检查、可以分享、可以离线断言的证据。**

Agent Casefile 使用一个带版本的 JSON 文件，记录模型与工具调用边界、运行结束状态、缺失证据和预期行为。它提供 TypeScript 录制 API、命令行、本地查看器和可独立运行的 Node.js 测试导出。

> **离线检查不等于重新运行 Agent。** 工具只检查你提供的记录，不调用模型、不执行记录中的工具、不证明根因，也不证明代码修改已经修复问题。

## 快速体验

需要 **Node.js 22.18 或更新版本**。目前是源码版本，尚未发布 npm 包。

```bash
git clone https://github.com/zhangjh024/agent-casefile.git
cd agent-casefile
npm ci
npm run build
npm run demo
```

在浏览器打开终端打印的 localhost 地址。你可以查看时间线、事件数据、断言结果、证据完整性提示和脱敏预览，也可以从本地载入 JSON 文件。通过文件选择器载入的数据仅在浏览器中处理，不会上传。

```bash
node dist/cli.js validate examples/tool-timeout.casefile.json
node dist/cli.js replay examples/tool-timeout.casefile.json
```

示例会故意失败：工具已经超时、运行也已经记录为 `error`，但最终 UI 快照仍然是 `running`，不满足 `ui-stops-spinning` 断言。

## 常用命令

| 命令                                  | 用途                                     |
| ------------------------------------- | ---------------------------------------- |
| `validate <file> [--json]`            | 校验格式，并提示录制缺口。               |
| `replay <file> [--json]`              | 仅对已有记录执行声明式断言。             |
| `compare <before> <after> [--json]`   | 比较两份记录；不推断因果关系。           |
| `redact <file>`                       | 预览可能敏感的位置与类别，不打印匹配值。 |
| `redact <file> --out <new-file>`      | 输出脱敏后的记录。                       |
| `export <file> --out <new-directory>` | 导出默认脱敏的记录和独立 Node.js 测试。  |
| `inspect [file] [--port <number>]`    | 启动仅绑定 localhost 的查看器。          |

```bash
node dist/cli.js redact examples/tool-timeout.casefile.json
node dist/cli.js export examples/tool-timeout.casefile.json \
  --out /tmp/timeout-regression
cd /tmp/timeout-regression
node --test regression.test.mjs
```

这个失败示例导出的测试仍然应该失败。导出不会“修好”记录。

退出码：`0` 成功／通过，`1` 断言失败，`2` 输入、用法或 I/O 错误，`3` 证据不足。

对于规则无法识别的敏感字段，可以重复使用 `--pointer` 指定相对于整个文件的 JSON Pointer：

```bash
node dist/cli.js redact examples/tool-timeout.casefile.json \
  --pointer /events/0/data/messages/0/content \
  --out /tmp/reviewed.casefile.json
```

**自动脱敏不是安全保证。** 分享前仍需人工检查姓名、业务标识、提示词、专有内容和特殊格式的凭证。脱敏移除了断言所需的证据时，不能把结果当作可靠的通过。

## 如何真正用于回归测试

1. 在自己的应用中，使用 `createRecorder` 显式包装要记录的模型／工具函数，或将已有日志转换为本项目格式。
2. 为观察到的边界行为写声明式断言，例如终态、错误字段、调用是否都有结果。
3. 检查完整性，保留真实的缺失证据说明；审阅脱敏结果后再分享。
4. 修改应用后，**重新运行应用并录制新的证据**，再检查新记录是否满足断言。

仅编辑示例 JSON，让断言从红变绿，**不是**证明应用修复成功。录制 API 的完整示例见[英文 README](../README.md#capture-from-your-own-code)。CLI 不执行来自 casefile 的代码。

### 实际录制一次本地示例

```bash
node examples/capture-local.mjs          # 故意失败的本地恢复分支
node examples/capture-local.mjs --fixed  # 重新执行另一个恢复分支并录制
```

这两条命令会实际执行仓库自己的本地示例函数，并分别生成 `capture-broken.local.casefile.json` 和 `capture-fixed.local.casefile.json`。这里没有外部模型、网络请求或真实计时超时，工具函数会故意抛出一个 `TimeoutError`。`--fixed` 改变的是实际执行的本地代码分支，不是修改已有记录。已有文件不会被覆盖；本地录制文件默认被 Git 忽略。

## 示例的真实性边界

仓库里的所有示例均为原创、手工编写的**合成数据**，不是生产轨迹，也不是对某个第三方 SDK issue 的已验证复现。

- `tool-timeout.casefile.json`：超时后 UI 仍显示运行中。
- `tool-timeout-fixed.casefile.json`：展示预期 UI 状态的合成替代记录；没有实际修改或重跑应用。
- `error-shape.casefile.json`：错误边界丢失了预期的错误名称。
- `incomplete.casefile.json`：缺少工具结果和最终运行事件的部分记录。

## 开发

```bash
npm run check
```

运行严格类型检查、构建和本地测试。应用没有运行时 npm 依赖，不需要账户、遥测或定时任务。

[贡献指南](../CONTRIBUTING.md) · [安全说明](../SECURITY.md) · [MIT 许可证](../LICENSE)
