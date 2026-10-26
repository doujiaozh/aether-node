// aether-node 沙箱运行台 —— 纯 JS，无构建工具、无框架。
// 所有交互都是对同一 JSON-RPC 端点（POST /）的 fetch 调用。
"use strict";

const codeEl = document.getElementById("code");
const runBtn = document.getElementById("run");
const stateBtn = document.getElementById("state");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const logsEl = document.getElementById("logs");
const metaEl = document.getElementById("node-meta");

let nextId = 1;

/** POST / with one JSON-RPC 2.0 request, return the parsed result. */
async function rpc(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params });
  const res = await fetch("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  if (res.status === 204) return undefined; // notification: no response body
  const doc = await res.json();
  if (doc.error) {
    throw Object.assign(new Error(doc.error.message), { code: doc.error.code, data: doc.error.data });
  }
  return doc.result;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function render(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function showError(error) {
  resultEl.classList.add("error");
  resultEl.textContent = `调用失败（code ${error.code ?? "?"}）：${error.message}`;
}

runBtn.addEventListener("click", async () => {
  runBtn.disabled = true;
  setStatus("执行中…");
  try {
    const result = await rpc("vm.execute", { code: codeEl.value });
    resultEl.classList.remove("error");
    resultEl.textContent = `ok=${result.ok} status=${result.status}（${result.durationMs} ms）\nvalue = ${render(result.value)}`;
    logsEl.textContent = result.logs.length ? result.logs.join("\n") : "（无日志）";
    setStatus(`完成：${result.status}`);
  } catch (error) {
    showError(error);
    logsEl.textContent = "（无日志）";
    setStatus("失败");
  } finally {
    runBtn.disabled = false;
  }
});

stateBtn.addEventListener("click", async () => {
  setStatus("读取节点状态…");
  try {
    const state = await rpc("sync.getState", {});
    metaEl.innerHTML = "";
    const entries = [
      ["node", state.node],
      ["version", String(state.version)],
      ["registers", String(Object.keys(state.registers).length)],
      ["counters", String(Object.keys(state.counters).length)],
    ];
    for (const [k, v] of entries) {
      const span = document.createElement("span");
      span.textContent = `${k}: ${v}`;
      metaEl.appendChild(span);
    }
    resultEl.classList.remove("error");
    resultEl.textContent = render(state.registers);
    logsEl.textContent = `sync.getState · node=${state.node} version=${state.version}`;
    setStatus("已获取节点状态");
  } catch (error) {
    showError(error);
    setStatus("失败");
  }
});

// 页面打开时先展示一次节点状态，确认 JSON-RPC 链路通。
stateBtn.click();
