<div align="center">

# ⚡ aether-node

**去中心化 Local-First AI 操作系统的核心引擎**

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](https://www.typescriptlang.org/)
[![Status: Scaffold](https://img.shields.io/badge/status-scaffold-orange.svg)](#roadmap)

*Sync · Sandbox · Agent —— 让数据、算力与智能在每一台设备上自由流动*

</div>

---

## 🌌 愿景

 **aether-node** 是一个野心勃勃的开源基础设施项目：我们要为「去中心化的
Local-First AI 操作系统」打造核心引擎。

今天的计算正在经历三重割裂：**数据被云端绑架**、**算力被云端垄断**、**智能体
（Agent）没有标准化的本地运行环境**。aether-node 的答案是构建一个可运行于任何
终端（手机 / 桌面 / 边缘节点 / 服务器）的微型"操作系统内核"，它同时做到三件事：

### 1. 去中心化 —— 数据主权回归用户
- 每个节点都是**对等（P2P）的**：没有中心服务器，任何两个节点之间都可以直接同步。
- 基于 **CRDT（无冲突复制数据类型）**，合并永远收敛 —— 无论网络如何分区、
  离线多久，重连后数据自动一致，永不冲突。
- 用户真正拥有自己的数据：本地优先存储，加密后再选择性同步。

### 2. 多端同步 —— 无缝的 Local-First 体验
- 同一份状态在手机、桌面、浏览器、边缘设备间实时同步。
- **离线优先**：所有操作先在本地完成，网络恢复后自动合并，离线不是异常状态而是常态。
- 统一的数据模型让"多端"不再是"多份副本"，而是"同一个世界的多个视图"。

### 3. AI 原生 —— 智能体是一等公民
- 内置 **micro-vm 沙箱**：AI 可以安全地在本地执行任意代码，读写本地数据，
  而不触碰宿主系统。
- 基于 **JSON-RPC 的 agent-protocol**：AI 与宿主能力（文件、同步、计算）之间
  有一套标准化、可审计的契约接口。
- 未来的 AI 助手不应只能"聊天"，而应能**安全地行动**：aether-node 为它提供
  手脚（沙箱）和规章制度（协议）。

> **一句话愿景**：*构建一个数据归你所有、算力就近调度、AI 安全扎根的开源计算底座。*

---

## 🏗️ 架构总览

```
┌──────────────────────────────────────────────────────────────────┐
│                        AI Agent（任意 LLM / 框架）                │
└──────────────────────────────┬───────────────────────────────────┘
                               │  JSON-RPC 2.0（agent-protocol）
                               ▼
┌──────────────────────────────────────────────────────────────────┐
│                        AetherNode Runtime                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌────────────────┐  │
│  │   sync-engine    │  │    micro-vm      │  │ agent-protocol │  │
│  │   CRDT 数据层    │◄─┤   沙箱执行层     │──┤  协议调度层    │  │
│  │  无冲突 / 离线    │  │  隔离 / 可审计   │  │  工具调用契约  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────────────┘  │
└───────────┼──────────────────────┼──────────────────────────────┘
            ▼                      ▼
     本地存储 / P2P 同步       隔离执行环境（Worker / WASM）
```

### 三大核心模块

| 模块 | 职责 | 当前状态 |
| --- | --- | --- |
| [`src/sync-engine`](./src/sync-engine) | CRDT 数据结构与同步/合并接口 | 🦴 骨架：数据结构 + LWW-Register 示例实现 |
| [`src/micro-vm`](./src/micro-vm) | 沙箱执行环境接口 | 🦴 骨架：执行接口 + 进程内参考实现 |
| [`src/agent-protocol`](./src/agent-protocol) | JSON-RPC 工具调用协议 | 🦴 骨架：协议类型 + 请求分发器 |

---

## 🚀 快速开始

### 环境要求
- Node.js ≥ 20（推荐 24+）
- pnpm / npm 任一包管理器

### 安装与运行

```bash
# 克隆仓库
git clone https://github.com/aether-node/aether-node.git
cd aether-node

# 安装依赖
pnpm install

# 构建并运行初始化流程（含三大模块自检）
pnpm start

# 开发模式（类型检查 + 构建）
pnpm build
```

运行 `pnpm start` 将看到 `AetherNode` 完成：身份引导 → 同步引擎初始化 →
沙箱自检 → JSON-RPC 协议联调，四大阶段的完整输出。

### 编程式使用

```typescript
import { createAetherNode } from "aether-node";

const node = await createAetherNode({ nodeIdentity: { alias: "my-laptop" } });

// 写入本地数据（CRDT 操作）
node.sync.applyLocal({ key: "note/1", value: { text: "hello aether" } });

// 让 AI 通过协议读取数据
const snapshot = await node.protocol.handle({
  jsonrpc: "2.0", id: 1, method: "aether.sync.getSnapshot",
});

// 让 AI 通过协议在沙箱中执行代码
const result = await node.protocol.handle({
  jsonrpc: "2.0", id: 2, method: "aether.vm.execute",
  params: { code: "40 + 2" },
});
```

---

## 🧩 模块设计

### 1. sync-engine —— CRDT 同步引擎

定义了分布式状态的核心数据结构，当前提供：

- **`HLC_timestamp`**：混合逻辑时钟，为操作提供全局可比较的时间戳。
- **`VectorClock`**：因果跟踪，回答"我是否已经见过这笔操作"。
- **`Op`**：不可变操作记录，是同步的基本单元（而非整个文档）。
- **`LWWRegister`**：Last-Write-Wins 寄存器 —— 最简单的 CRDT 之一，作为
  合并语义的参考实现（按 HLC 比较，节点 ID 仲裁平局）。
- **`SyncEngine`**：统一入口，定义 `applyLocal` / `applyRemote` / `merge` /
  `snapshot` 接口契约。

```typescript
// 合并接口的核心形状
interface Mergeable<T> {
  merge(other: T): T;        // 幂等、可交换、可结合
  snapshot(): CrdtSnapshot;  // 可序列化的导出形态
}
```

**路线图**：OR-Set / RGA（文本）/ 计数器 + 基于 Yjs/Automerge 思想的操作日志编码。

### 2. micro-vm —— 沙箱执行环境

定义"接收代码 → 安全执行 → 返回结果"的契约：

- **`ExecutionPolicy`**：声明式权限边界（超时、内存、网络、文件系统访问）。
- **`SandboxExecutor`**：统一执行接口，与具体隔离技术解耦。
- **`InProcessSandbox`**：零依赖的参考实现 —— **它不是真正的安全沙箱**，
  仅用于打通协议与跑通流程；生产实现将基于 Worker Threads / WASM / Firecracker
  microVM 分级隔离。

```typescript
interface SandboxExecutor {
  execute(request: ExecRequest): Promise<ExecResult>;
  healthCheck(): Promise<SandboxHealth>;
}
```

### 3. agent-protocol —— 智能体工具协议

基于 **JSON-RPC 2.0** 的本地工具调用协议：

- **标准化方法命名空间**：`aether.sync.*`（读/写数据）、`aether.vm.*`
  （执行代码）、`aether.agent.*`（能力声明）。
- **结构化错误码**：从参数校验到沙箱逃逸，每种失败都有明确的类别。
- **`ProtocolServer`**：请求分发器，把 AI 的每一次调用路由到对应模块，
  并记录可审计的调用日志。

```
请求:  {"jsonrpc":"2.0","id":1,"method":"aether.vm.execute","params":{"code":"1+1"}}
响应:  {"jsonrpc":"2.0","id":1,"result":{"ok":true,"returnValue":2,"durationMs":1}}
```

---

## 🗺️ Roadmap

- ✅ **v0.0.1 —— 骨架（当前）**：三大模块接口定义 + 初始化流程跑通
- 🔲 **v0.1 —— 同步Validated**：OR-Set / 计数器 CRDT + 节点间操作日志交换
- 🔲 **v0.2 —— 沙箱加固**：基于 Worker Threads 的进程级隔离 + 资源限额
- 🔲 **v0.3 —— 传输层**：局域网发现（mDNS）+ 直连同步 / WebRTC
- 🔲 **v0.4 —— 智能体层**：工具权限系统 + 多 Agent 并发调度
- 🔲 **v1.0 —— OS 体验**：声明式 UI 层 + 跨端一致的应用运行时

---

## 🤝 贡献

我们欢迎一切形式的贡献！aether-node 还在非常早期的骨架阶段 ——
每一行代码都在塑造这个项目的未来。

- 发现问题或有好点子 👉 [开一个 Issue](../../issues)
- 想提交代码 👉 [发起 Pull Request](../../pulls)
- 请先阅读我们的贡献指南与行为规范（即将发布）

## 📄 许可证

[Apache License 2.0](./LICENSE) —— 商业友好，专利授权完备。

Copyright 2025 aether-node contributors

<div align="center">

*"让每一台设备都成为自己的云。"*

</div>
