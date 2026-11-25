const helpDialog = document.querySelector("#connect-dialog");
const openHelp = () => { helpDialog.hidden = false; };
const closeHelp = () => { helpDialog.hidden = true; };
const pairInput = document.querySelector("#pair-code");
const pairButton = document.querySelector("#connect-pair");
const pairFeedback = document.querySelector("#pair-feedback");
const connectionTitle = document.querySelector(".connection-copy strong");
const connectionDescription = document.querySelector(".connection-copy span");
const connectionState = document.querySelector(".connection-state");
const API_ROOT = "/minimax_h3_timeline/mobile";

let sessionToken = "";
let currentState = null;
let revision = 0;
let socket = null;

function feedback(message, state = "") {
  if (!pairFeedback) return;
  pairFeedback.textContent = message;
  pairFeedback.dataset.state = state;
}

function setConnected(connected, detail = "") {
  if (connectionTitle) connectionTitle.textContent = connected ? "已连接导演台" : "尚未连接导演台";
  if (connectionDescription) connectionDescription.textContent = connected
    ? (detail || "已连接到电脑端对应的导演台。移动编辑界面正在接入。")
    : "请在电脑端导演台生成配对码，然后在此输入。";
  if (connectionState) connectionState.textContent = connected ? "已连接" : "未连接";
}

function connectEvents(token) {
  socket?.close();
  const url = new URL(API_ROOT + "/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(url);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ token })));
  socket.addEventListener("message", event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready") {
      currentState = message.state;
      revision = Number(message.revision) || 1;
      setConnected(true, "已连接到电脑端。当前移动端编辑界面尚在开发中，请暂时不要进行编辑。");
      feedback("连接成功。此阶段已建立安全配对和状态通道。", "success");
    } else if (message.type === "state") {
      currentState = message.state;
      revision = Number(message.revision) || revision;
      feedback("已收到电脑端最新状态。", "success");
    }
  });
  socket.addEventListener("close", () => {
    if (sessionToken) {
      setConnected(false);
      feedback("连接已断开。请重新打开页面或重新配对。", "error");
    }
  });
  socket.addEventListener("error", () => feedback("实时连接失败，请确认手机和电脑能访问同一个 ComfyUI 地址。", "error"));
}

async function claimPairingCode() {
  const code = String(pairInput?.value || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) {
    feedback("请输入电脑端显示的 8 位配对码。", "error");
    return;
  }
  pairButton.disabled = true;
  feedback("正在验证配对码…");
  try {
    const response = await fetch(API_ROOT + "/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
    sessionToken = payload.token;
    currentState = payload.state;
    revision = Number(payload.revision) || 1;
    sessionStorage.setItem("m3td-mobile-token", sessionToken);
    sessionStorage.setItem("m3td-mobile-node", payload.node_uuid || "");
    setConnected(true, "已连接到电脑端。当前移动端编辑界面尚在开发中，请暂时不要进行编辑。");
    feedback("配对成功，正在建立实时连接…", "success");
    connectEvents(sessionToken);
  } catch (error) {
    feedback("连接失败：" + error.message, "error");
  } finally {
    pairButton.disabled = false;
  }
}

async function restoreSession() {
  const saved = sessionStorage.getItem("m3td-mobile-token");
  if (!saved) return;
  try {
    const response = await fetch(API_ROOT + "/state", {
      headers: { Authorization: "Bearer " + saved },
    });
    if (!response.ok) throw new Error("session expired");
    const payload = await response.json();
    sessionToken = saved;
    currentState = payload.state;
    revision = Number(payload.revision) || 1;
    setConnected(true, "已恢复与电脑端的连接。当前移动端编辑界面尚在开发中，请暂时不要进行编辑。");
    connectEvents(sessionToken);
  } catch {
    sessionStorage.removeItem("m3td-mobile-token");
    sessionStorage.removeItem("m3td-mobile-node");
    setConnected(false);
  }
}

document.querySelector("#scan-help")?.addEventListener("click", openHelp);
document.querySelector("#close-dialog")?.addEventListener("click", closeHelp);
document.querySelector("#confirm-dialog")?.addEventListener("click", closeHelp);
document.querySelector("#refresh-page")?.addEventListener("click", () => window.location.reload());
document.querySelector("#desktop-mode")?.addEventListener("click", () => {
  window.location.href = "/";
});
pairButton?.addEventListener("click", claimPairingCode);
pairInput?.addEventListener("keydown", event => {
  if (event.key === "Enter") claimPairingCode();
});
pairInput?.addEventListener("input", () => {
  pairInput.value = pairInput.value.toUpperCase().replace(/[^A-Z2-9]/g, "").slice(0, 8);
});

helpDialog?.addEventListener("click", event => {
  if (event.target === helpDialog) closeHelp();
});

document.addEventListener("keydown", event => {
  if (event.key === "Escape" && helpDialog && !helpDialog.hidden) closeHelp();
});

restoreSession();
