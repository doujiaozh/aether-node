# aether-tool

`aether-tool` 是 [aether-node](https://github.com/deepseek-ai) 的 DeepSeek Harness（DSH）插件：它向 DSH 注册一个供模型调用的工具 **`run_in_aether_vm`**，把 JavaScript 代码发送给一个正在运行的 aether-node 的 HTTP JSON-RPC 接口，在其沙箱化微 VM 中执行，并把结果（值、状态、沙箱日志、耗时）带回来。

只通过 DSH 的插件机制扩展，不修改 DSH 的任何核心代码。

## 前置：启动一个 aether-node

在 aether-node 仓库：

```bash
npm install
npm run demo:web        # 默认绑定 http://127.0.0.1:40001
```

`demo:web` 会把 Web UI、JSON-RPC（`POST /`）和 WebSocket P2P 传输挂在同一个端口。若 40001 被占用，会自动改用系统分配的端口——把实际地址填进插件配置即可。也可以用 `AETHER_PORT=5000 npm run demo:web` 指定端口。

## 安装

```bash
dsh plugin add ./plugins/aether-tool
# 或者把本目录作为 bundle 安装进 profile
```

安装后通过插件配置（Plugin Configuration Forms）调整：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `endpoint` | `http://127.0.0.1:40001` | aether-node 的 HTTP RPC 基址 |
| `timeoutMs` | `20000` | 单次 `vm.execute` 的传输超时（毫秒）；沙箱侧实际超时被夹取到 [50, 30000] |

## 工具：`run_in_aether_vm`

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `code` | string | 是 | 要执行的 JavaScript（沙箱内无文件系统、无网络、无 require/import；支持顶层 `return` 与 `await`） |
| `timeoutMs` | integer | 否 | 单次调用超时，夹取到 [50, 30000]，默认取插件配置 |
| `endpoint` | string | 否 | 单次调用覆盖 aether-node 地址，默认取插件配置 |

返回值是 aether-node `VmResult` 信封的透传（`ok` / `status` / `value` / `error` / `logs` / `durationMs`），再附上命中的 `endpoint`；传输层失败一律是带闭集 `status` 的结构化结果而非异常：

| `status` | 含义 |
| --- | --- |
| `ok` / `timeout` / `memory` / `crash` / `runtime` … | 沙箱裁决透传（aether-node `vm.execute` 永不抛错） |
| `invalid-endpoint` / `invalid-code` | 参数不可用 |
| `network-error` | 连不上 aether-node（先启动它） |
| `timeout` | 传输超时 |
| `http-error` / `rpc-error` | 对端应答不是预期的 RPC 结果 |
| `cancelled` | 调用方取消了本次工具调用 |
| `internal-error` | 插件自身未预期失败（bug） |

`execute` 绝不抛错；`exec.signal` 被尊重（已取消的调用立即返回 `cancelled`）。

## 自包含验证

不依赖 DSH 运行时即可跑通整条链路（用桩模块替换 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/schemastery`，并拉起一个真实的 aether-node web 服务做后端）：

```bash
# 在 aether-node 仓库根目录
npm run build
node plugins/aether-tool/verify.mjs
```

## 布局

```
plugins/aether-tool/
├── package.json        # bundle 元数据：peer 依赖、dsh.bundle.patch、icon、locale
├── cordis.patch.yml    # 往 profile 注入本插件的一行 patch
├── index.js            # 插件入口：name / inject / apply
├── config.js           # Schemastery Config（endpoint / timeoutMs）
├── vm.js               # run_in_aether_vm 工具实现（JSON-RPC 客户端 + 渲染）
├── locale/{zh,en}.json # 展示元数据
├── icon.svg
├── verify.mjs          # 自包含冒烟验证
└── tests/              # 桩模块（loader + dsh-tools/schemastery 桩）
```

## 许可

Apache-2.0，与 aether-node 一致。
