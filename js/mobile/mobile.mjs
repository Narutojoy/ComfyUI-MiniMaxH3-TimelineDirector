import { createWindows, setWindowContributionDuration, applyGlobalOverlapFrames, editWindow } from "../segment_windows.mjs";

const helpDialog = document.querySelector("#connect-dialog");
const pairInput = document.querySelector("#pair-code");
const pairButton = document.querySelector("#connect-pair");
const pairFeedback = document.querySelector("#pair-feedback");
const connectionTitle = document.querySelector(".connection-copy strong");
const connectionDescription = document.querySelector(".connection-copy span");
const connectionState = document.querySelector(".connection-state");
const editor = document.querySelector("#mobile-editor");
const editorContent = document.querySelector("#editor-content");
const editorHeading = document.querySelector("#editor-heading");
const editorSyncStatus = document.querySelector("#editor-sync-status");
const runButton = document.querySelector("#mobile-run-button");
const stopButton = document.querySelector("#mobile-stop-button");
const saveWorkflowButton = document.querySelector("#mobile-save-workflow-button");
const runStatus = document.querySelector("#mobile-run-status");
const runDetail = document.querySelector("#mobile-run-detail");
const runProgressBar = document.querySelector("#mobile-run-progress-bar");
const runSegmentLabel = document.querySelector("#mobile-run-segment");
const runProgressLabel = document.querySelector("#mobile-run-progress-label");

const queueCount = document.querySelector("#mobile-queue-count");
const queueList = document.querySelector("#mobile-queue-list");
let latestQueue = { queue_running: [], queue_pending: [] };
let mobileRunQueue = [];
let mobileRunSequence = 0;
let runDispatchInFlight = false;

function renderQueue(snapshot = latestQueue) {
  latestQueue = snapshot && typeof snapshot === "object" ? snapshot : { queue_running: [], queue_pending: [] };
  const running = Array.isArray(latestQueue.queue_running) ? latestQueue.queue_running : [];
  const pending = Array.isArray(latestQueue.queue_pending) ? latestQueue.queue_pending : [];
  const localPending = mobileRunQueue.map(item => ({ label: "手机提交任务 " + item.sequence, prompt_id: "", state: "等待提交" }));
  const localSubmitting = pendingCommandType === "run_request" && pendingCommandId
    ? [{ label: "手机提交任务", prompt_id: "", state: "正在提交" }]
    : [];
  if (queueCount) queueCount.textContent = String(running.length + pending.length + localPending.length + localSubmitting.length);
  if (!queueList) return;
  const rows = [
    ...running.map(item => ({ ...item, state: "正在执行" })),
    ...pending.map(item => ({ ...item, state: "等待执行" })),
    ...localSubmitting,
    ...localPending
  ];
  if (!rows.length) {
    queueList.innerHTML = '<p class="mobile-queue-empty">当前没有排队任务</p>';
    return;
  }
  queueList.innerHTML = rows.map(item => {
    const label = escapeHTML(item.label || "工作流任务");
    const id = escapeHTML(String(item.prompt_id || "").slice(0, 8));
    const meta = id ? "任务编号 " + id : item.state === "等待提交" || item.state === "正在提交" ? "手机端请求" : "ComfyUI 队列任务";
    return '<div class="mobile-queue-item"><div class="mobile-queue-item-main"><strong>' + label + '</strong><small>' + meta + '</small></div><span class="mobile-queue-state ' + (item.state === "正在执行" ? "is-running" : "") + '">' + item.state + '</span></div>';
  }).join("");
}

const gettingStarted = document.querySelector("#getting-started");
const footerNote = document.querySelector("#mobile-footer-note");
const API_ROOT = "/minimax_h3_timeline/mobile";
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const UPLOAD_SUBFOLDER = "minimax_h3_timeline_director";

let sessionToken = "";
let sessionGeneration = 0;
let currentState = null;
let revision = 0;
let socket = null;
let reconnectTimer = 0;
let reconnectDelay = 1000;
let activePanel = "segments";
let activeSegment = 0;
let rememberedSegmentPromptScrollTop = 0;
let executingSegmentIndex = null;
let selectedVideoId = "";
let mobilePlayhead = 0;
let mobileTimelineScale = 44;
let videoDrag = null;
const previewProxyRequests = new Set();
let saveTimer = 0;
let saveInFlight = false;
let pendingStateJson = "";
let dirty = false;
let conflict = false;
let nodeUuid = "";
let referenceSize = { width: 832, height: 480 };
let activePromptId = "";
let pendingCommandId = "";
let pendingCommandType = "";
let workflowBusy = false;
let executionTerminal = false;

const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}[ch]));
const uid = () => globalThis.crypto?.randomUUID?.() || "m3td-" + Date.now().toString(36) + Math.random().toString(36).slice(2,10);
const segments = () => currentState?.segmentConfig?.segments || [];
const groups = () => currentState?.segmentConfig?.groups || [];
const images = () => currentState?.images || [];
const audios = () => currentState?.audios || [];
const videos = () => currentState?.videoClips || [];
const mediaURL = file => { const parts=String(file||"").replace(/\\/g,"/").split("/"); const filename=parts.pop(); const params=new URLSearchParams({filename,type:"input"}); if(parts.length)params.set("subfolder",parts.join("/")); return "/view?"+params.toString(); };
const segmentLabel = (segment,index) => segment?.name || "第 " + (index+1) + " 段";
const setSyncStatus = text => { if(editorSyncStatus) editorSyncStatus.textContent = text; };

function setRunStatus(status, detail = "", percent = null) {
  if (runStatus) runStatus.textContent = status;
  if (runDetail) runDetail.textContent = detail;
  if (runProgressBar) runProgressBar.style.width = percent == null ? "0%" : Math.max(0, Math.min(100, percent)) + "%";
  if (runProgressLabel) runProgressLabel.textContent = percent == null ? "当前采样进度" : "当前采样进度 · " + Math.round(Math.max(0, Math.min(100, percent))) + "%";
  if (runButton) runButton.disabled = !sessionToken || conflict || pendingCommandType === "save_request";
  if (stopButton) stopButton.disabled = !activePromptId || !sessionToken;
  if (saveWorkflowButton) saveWorkflowButton.disabled = !!pendingCommandId || !sessionToken || conflict;
}

async function flushStateBeforeCommand() {
  if (conflict) throw new Error("同步存在冲突，请先解决冲突");
  clearTimeout(saveTimer);
  if (dirty && !saveInFlight) await saveState();
  const deadline = Date.now() + 10000;
  while ((dirty || saveInFlight) && Date.now() < deadline) {
    if (conflict) throw new Error("同步存在冲突，请先解决冲突");
    if (dirty && !saveInFlight) await saveState();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (dirty || saveInFlight || conflict) throw new Error("修改尚未同步完成，请稍后重试");
}

function createRequestId() {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  // Request IDs are correlation/idempotency keys, not authentication tokens.
  return "m3td-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function sendRunCommand(type, extra = {}) {
  if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("手机与电脑的实时连接尚未建立");
  const requestId = createRequestId();
  pendingCommandId = requestId;
  pendingCommandType = type;
  socket.send(JSON.stringify({ type, request_id: requestId, revision, ...extra }));
  return requestId;
}

async function requestWorkflowSave() {
  if (!sessionToken || pendingCommandId || mobileRunQueue.length || runDispatchInFlight) return;
  setRunStatus("正在同步", "正在确认手机端最新修改已同步到电脑…");
  try {
    await flushStateBeforeCommand();
    sendRunCommand("save_request");
    setRunStatus("保存请求已发送", "电脑端正在执行 ComfyUI 原生保存命令…");
  } catch (error) {
    setRunStatus("无法保存", error.message);
  }
}

async function dispatchNextMobileRun() {
  if (!sessionToken || pendingCommandId || runDispatchInFlight || !mobileRunQueue.length) return;
  runDispatchInFlight = true;
  try {
    await flushStateBeforeCommand();
    const task = mobileRunQueue.shift();
    sendRunCommand("run_request", { mobile_queue_sequence: task.sequence });
    setRunStatus("正在提交队列", "已提交当前请求，手机端还有 " + mobileRunQueue.length + " 个任务等待提交…");
  } catch (error) {
    mobileRunQueue = [];
    workflowBusy = false;
    setRunStatus("无法加入队列", error.message);
  } finally {
    runDispatchInFlight = false;
    renderQueue();
  }
}

async function requestWorkflowRun() {
  if (!sessionToken || conflict || pendingCommandType === "save_request") return;
  mobileRunQueue.push({ sequence: ++mobileRunSequence });
  workflowBusy = true;
  executionTerminal = false;
  setRunStatus("已加入手机队列", "手机端还有 " + mobileRunQueue.length + " 个任务等待提交…");
  renderQueue();
  void dispatchNextMobileRun();
}

function requestWorkflowStop() {
  if (!activePromptId || !sessionToken) return;
  try {
    sendRunCommand("interrupt_request", { prompt_id: activePromptId });
    setRunStatus("正在停止", "已向电脑端发送停止请求…");
  } catch (error) {
    setRunStatus("停止失败", error.message);
  }
}

function receiveExecutionStatus(message) {
  if (message.prompt_id) activePromptId = message.prompt_id;
  if (message.status === "queued") {
    executionTerminal = false;
    workflowBusy = true;
    executingSegmentIndex = null;
    if (runSegmentLabel) runSegmentLabel.textContent = "当前启用分段：等待识别";
    setRunStatus("已加入队列", "工作流已提交给 ComfyUI，等待执行…");
  } else if (message.status === "stopping") {
    setRunStatus("正在停止", "ComfyUI 正在处理中断请求…");
  } else if (message.status === "running") {
    executionTerminal = false;
    workflowBusy = true;
    const percent = Number.isFinite(Number(message.percent)) ? Number(message.percent) : null;
    const parsedIndex = Number(message.segment_index);
    const hasSegmentProgress = Number.isInteger(parsedIndex) && parsedIndex >= 0;
    if (hasSegmentProgress) {
      const enabledSegments = segments().map((segment, index) => ({ segment, index }))
        .filter(item => item.segment?.enabled !== false);
      const explicitRank = Number(message.enabled_segment_index);
      const explicitTotal = Number(message.enabled_segment_count);
      const hasExplicitEnabledPosition = Number.isInteger(explicitRank) && explicitRank >= 0 &&
        Number.isInteger(explicitTotal) && explicitTotal > explicitRank;
      const enabledRank = hasExplicitEnabledPosition
        ? explicitRank
        : enabledSegments.findIndex(item => item.index === parsedIndex);
      const enabledTotal = hasExplicitEnabledPosition ? explicitTotal : enabledSegments.length;
      if (enabledRank >= 0 && enabledRank < enabledTotal) {
        executingSegmentIndex = parsedIndex;
        if (runSegmentLabel) {
          const segmentPrefix = message.segment_status === "completed" ? "已完成启用分段：" : "当前启用分段：";
          runSegmentLabel.textContent = segmentPrefix + (enabledRank + 1) + " / " + enabledTotal +
            "（原第 " + (parsedIndex + 1) + " 段）";
        }
      }
    } else if (runSegmentLabel && executingSegmentIndex == null) {
      runSegmentLabel.textContent = "当前启用分段：识别中";
    }
    setRunStatus("执行中", hasSegmentProgress ? "正在生成本段视频…" : "ComfyUI 正在执行工作流…", percent);
  } else if (message.status === "finishing") {
    setRunStatus("收尾中", "ComfyUI 正在完成当前工作流…", 100);
  } else if (message.status === "completed") {
    activePromptId = "";
    workflowBusy = false;
    executionTerminal = true;
    if (runSegmentLabel) runSegmentLabel.textContent = "本次工作流已完成";
    setRunStatus("已完成", "工作流执行成功。", 100);
  } else if (message.status === "failed") {
    activePromptId = "";
    workflowBusy = false;
    executionTerminal = true;
    if (runSegmentLabel) runSegmentLabel.textContent = "本次工作流执行失败";
    setRunStatus("执行失败", message.message || "请在电脑端查看 ComfyUI 错误详情。");
  } else if (message.status === "interrupted") {
    activePromptId = "";
    workflowBusy = false;
    executionTerminal = true;
    if (runSegmentLabel) runSegmentLabel.textContent = "本次工作流已停止";
    setRunStatus("已停止", "当前工作流已中断。");
  }
}

function feedback(message, state = "") {
  if (!pairFeedback) return;
  pairFeedback.textContent = message;
  pairFeedback.dataset.state = state;
}

function setConnected(connected, detail = "") {
  if (connectionTitle) connectionTitle.textContent = connected ? "已连接导演台" : "尚未连接导演台";
  if (connectionDescription) connectionDescription.textContent = connected
    ? (detail || "已连接到电脑端对应的导演台。")
    : "请先在电脑端导演台生成一次性配对码。";
  if (connectionState) connectionState.textContent = connected ? "已连接" : "未连接";
  document.body.classList.toggle("is-connected", connected);
  if (editor) editor.hidden = !connected;
  if (!connected) {
    activePromptId = "";
    workflowBusy = false;
  }
  if (runButton) runButton.disabled = !connected || conflict || pendingCommandType === "save_request";
  if (stopButton) stopButton.disabled = !connected || !activePromptId;
  if (saveWorkflowButton) saveWorkflowButton.disabled = !connected || !!pendingCommandId || conflict;
  if (gettingStarted) gettingStarted.hidden = connected;
  if (footerNote) footerNote.hidden = connected;
  document.querySelector(".bottom-nav")?.classList.toggle("is-visible", connected);
  if (connected) renderPanel();
}

function syncActiveSelection() {
  const segment=segments()[activeSegment];
  if(!segment)return;
  currentState.segmentConfig.activeIndex=activeSegment;
  if(Number.isInteger(segment.startFrame)&&Number.isInteger(segment.endFrame)){
    currentState.selection={start:segment.startFrame/24,duration:(segment.endFrame-segment.startFrame)/24};
  }
}

function selectedSegment() {
  const list = segments();
  activeSegment = Math.max(0, Math.min(activeSegment, list.length - 1));
  syncActiveSelection();
  return list[activeSegment] || null;
}

function scheduleSave() {
  if (!sessionToken || !currentState || conflict) return;
  dirty = true;
  setSyncStatus("有未同步修改…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 350);
}

async function saveState() {
  if (!dirty || saveInFlight || !sessionToken || conflict) return;
  const requestGeneration = sessionGeneration;
  const requestToken = sessionToken;
  const expectedRevision = revision;
  saveInFlight = true;
  dirty = false;
  pendingStateJson = JSON.stringify(currentState);
  try {
    const response = await fetch(API_ROOT + "/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + requestToken },
      body: JSON.stringify({ expected_revision: expectedRevision, state: JSON.parse(pendingStateJson) }),
    });
    const payload = await response.json();
    if (requestGeneration !== sessionGeneration || requestToken !== sessionToken) return;
    if (response.status === 409) {
      if (JSON.stringify(payload.state) === pendingStateJson) {
        revision = Number(payload.revision) || revision;
        dirty = JSON.stringify(currentState) !== pendingStateJson;
        setSyncStatus("服务器已保存相同内容 · 版本 " + revision);
        return;
      }
      conflict = true;
      dirty = false;
      setSyncStatus("同步冲突：已暂停自动保存，请重新配对并核对两端内容。");
      feedback("检测到电脑端与手机端同时修改，系统没有自动覆盖任何一端。", "error");
      return;
    }
    if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
    revision = Number(payload.revision) || revision + 1;
    setSyncStatus("已同步 · 版本 " + revision);
  } catch (error) {
    if (requestGeneration === sessionGeneration && requestToken === sessionToken) {
      dirty = true;
      setSyncStatus("同步失败：" + error.message);
    }
  } finally {
    if (requestGeneration === sessionGeneration && requestToken === sessionToken) {
      saveInFlight = false;
      pendingStateJson = "";
      if (dirty && !conflict) saveTimer = setTimeout(saveState, 700);
    }
  }
}

function receiveRemote(message) {
  const nextRevision = Number(message.revision) || 0;
  if (nextRevision <= revision) return;
  // The relay broadcasts writes to every socket, including the writer. Treat
  // our own in-flight save echo as an acknowledgement, not a concurrent edit.
  if (saveInFlight && JSON.stringify(message.state) === pendingStateJson) {
    revision = nextRevision;
    setSyncStatus("已同步 · 版本 " + revision);
    return;
  }
  if (dirty || saveInFlight) {
    conflict = true;
    dirty = false;
    clearTimeout(saveTimer);
    setSyncStatus("检测到另一端修改，已暂停同步以防覆盖。");
    feedback("两端出现并发修改，请关闭旧连接后重新配对核对内容。", "error");
    return;
  }
  currentState = message.state;
  revision = nextRevision;
  activeSegment = Math.max(0, Math.min(Number(currentState.segmentConfig?.activeIndex) || 0, Math.max(0, segments().length - 1)));
  setSyncStatus("电脑端已更新 · 版本 " + revision);
  renderPanel();
}

function connectEvents(token) {
  clearTimeout(reconnectTimer);
  reconnectTimer = 0;
  const url = new URL(API_ROOT + "/events", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let activeSocket;
  try {
    activeSocket = new WebSocket(url);
  } catch {
    scheduleMobileReconnect(token);
    return;
  }
  const previousSocket = socket;
  socket = activeSocket;
  if (previousSocket && previousSocket !== activeSocket) previousSocket.close();
  activeSocket.addEventListener("open", () => {
    if (socket === activeSocket) activeSocket.send(JSON.stringify({ token }));
  });
  activeSocket.addEventListener("message", event => {
    if (socket !== activeSocket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready") {
      if (message.queue_status) renderQueue(message.queue_status);
      const remoteRevision = Number(message.revision) || 0;
      if (dirty || saveInFlight) {
        if (remoteRevision > revision && JSON.stringify(message.state) === JSON.stringify(currentState)) {
          revision = remoteRevision;
          dirty = false;
          clearTimeout(saveTimer);
          setSyncStatus("连接恢复，服务器内容与手机一致 · 版本 " + revision);
        } else if (remoteRevision !== revision) {
          conflict = true;
          clearTimeout(saveTimer);
          setSyncStatus("断线期间两端内容均有变化，已暂停同步以防覆盖。请核对后重新配对。");
          feedback("检测到断线期间的并发修改，系统保留当前手机内容，没有自动覆盖。", "error");
          activeSocket.close();
          return;
        } else {
          setSyncStatus("连接已恢复，正在补同步手机端修改…");
          if (dirty && !saveInFlight) saveState();
        }
      } else if (remoteRevision >= revision) {
        if (remoteRevision > revision) {
          currentState = message.state;
          activeSegment = Math.max(0, Math.min(Number(currentState.segmentConfig?.activeIndex) || 0, Math.max(0, segments().length - 1)));
          renderPanel();
        }
        revision = remoteRevision;
        setSyncStatus("已连接 · 版本 " + revision);
      } else {
        conflict = true;
        setSyncStatus("服务器版本低于手机端已知版本，已暂停同步以防数据丢失。");
        activeSocket.close();
        return;
      }
      reconnectDelay = 1000;
      nodeUuid = message.node_uuid || nodeUuid;
      if (message.execution_status?.status) receiveExecutionStatus(message.execution_status);
      setConnected(true, "已连接到电脑端。手机编辑会实时同步回对应导演台。");
      feedback("连接成功，手机端编辑已启用。", "success");
    } else if (message.type === "state") {
      receiveRemote(message);
    } else if (message.type === "paired") {
      feedback("配对成功，正在建立实时同步。", "success");
    } else if (message.type === "command_result") {
      if (message.request_id && message.request_id !== pendingCommandId) return;
      const completedCommandType = pendingCommandType;
      pendingCommandId = "";
      pendingCommandType = "";
      if (message.ok) {
        if (completedCommandType === "run_request") {
          workflowBusy = true;
          if (mobileRunQueue.length) {
            setRunStatus("正在提交队列", "当前任务已交给 ComfyUI，继续提交剩余 " + mobileRunQueue.length + " 个任务…");
          }
        }
        if (message.status === "saved") {
          setRunStatus("已保存", "ComfyUI 已完成工作流保存。");
        } else if (message.status === "queued" && !executionTerminal) {
          workflowBusy = true;
          setRunStatus("已加入队列", "工作流已提交给 ComfyUI，等待执行…");
        } else if (message.status === "interrupt_requested") {
          setRunStatus("停止请求已发送", "ComfyUI 正在处理中断请求…");
        }
      } else {
        if (completedCommandType === "run_request") workflowBusy = false;
        const errors = {
          desktop_offline: "电脑端导演台没有在线连接",
          revision_mismatch: "手机与电脑版本不一致，请等待同步后重试",
          desktop_state_not_synced: "电脑端尚未应用手机端最新修改",
          workflow_busy: "工作流正在运行或提交中",
          queue_rejected: "ComfyUI 没有接受运行请求",
          queue_failed: "提交工作流时发生错误",
          no_matching_active_prompt: "没有找到可停止的当前任务",
          interrupt_failed: "停止请求失败",
          save_failed: "电脑端保存工作流失败",
        };
        setRunStatus("操作未完成", errors[message.error] || message.message || message.error || "未知错误");
        if (completedCommandType === "run_request") mobileRunQueue = [];
      }
      if (completedCommandType === "run_request" && mobileRunQueue.length) {
        queueMicrotask(() => void dispatchNextMobileRun());
      } else {
        renderQueue();
      }
    } else if (message.type === "queue_status") {
      renderQueue(message);
    } else if (message.type === "execution_status") {
      receiveExecutionStatus(message);
    }
  });
  activeSocket.addEventListener("close", event => {
    if (socket !== activeSocket) return;
    if (event.code === 4002 || event.code === 4003) {
      sessionGeneration += 1;
      clearTimeout(saveTimer);
      clearTimeout(reconnectTimer);
      reconnectTimer = 0;
      saveInFlight = false;
      pendingStateJson = "";
      sessionStorage.removeItem("m3td-mobile-token");
      sessionStorage.removeItem("m3td-mobile-node");
      sessionToken = "";
      currentState = null;
      revision = 0;
      dirty = false;
      conflict = false;
      setConnected(false);
      setSyncStatus("手机授权已撤销或配对已被替换");
      feedback("当前手机授权已失效，请重新扫描电脑端二维码。", "error");
    } else if (sessionToken) {
      setConnected(false);
      setSyncStatus("连接已断开，正在自动重连…");
      scheduleMobileReconnect(sessionToken);
    }
  });
  activeSocket.addEventListener("error", () => {
    if (socket === activeSocket) setSyncStatus("实时连接中断，正在尝试自动重连…");
  });
}

function scheduleMobileReconnect(token) {
  if (!token || conflict || reconnectTimer) return;
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  setSyncStatus("网络中断，" + Math.ceil(delay / 1000) + " 秒后自动重连…");
  reconnectTimer = setTimeout(() => {
    reconnectTimer = 0;
    if (sessionToken === token) connectEvents(token);
  }, delay);
}

async function claimPairingCode() {
  if (pairButton?.disabled) return;
  const code = String(pairInput?.value || "").trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(code)) {
    feedback("请输入电脑端显示的 8 位配对码。", "error");
    return;
  }
  pairButton.disabled = true;
  const requestGeneration = ++sessionGeneration;
  clearTimeout(saveTimer);
  clearTimeout(reconnectTimer);
  saveTimer = 0;
  reconnectTimer = 0;
  const previousSocket = socket;
  socket = null;
  previousSocket?.close();
  sessionToken = "";
  currentState = null;
  revision = 0;
  saveInFlight = false;
  pendingStateJson = "";
  dirty = false;
  conflict = false;
  setConnected(false);
  feedback("正在验证配对码…");
  try {
    const response = await fetch(API_ROOT + "/pair/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const payload = await response.json();
    if (requestGeneration !== sessionGeneration) return;
    if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
    sessionToken = payload.token;
    currentState = payload.state;
    revision = Number(payload.revision) || 1;
    nodeUuid = payload.node_uuid || "";
    referenceSize = payload.reference_size || referenceSize;
    activeSegment = Number(currentState.segmentConfig?.activeIndex) || 0;
    sessionStorage.setItem("m3td-mobile-token", sessionToken);
    sessionStorage.setItem("m3td-mobile-node", nodeUuid);
    feedback("配对成功，正在建立实时连接…", "success");
    connectEvents(sessionToken);
  } catch (error) {
    if (requestGeneration === sessionGeneration) feedback("连接失败：" + error.message, "error");
  } finally {
    if (requestGeneration === sessionGeneration) pairButton.disabled = false;
  }
}

async function restoreSession() {
  const requestGeneration = sessionGeneration;
  const saved = sessionStorage.getItem("m3td-mobile-token");
  if (!saved) return;
  try {
    const response = await fetch(API_ROOT + "/state", {
      headers: { Authorization: "Bearer " + saved },
    });
    if (!response.ok) throw new Error("session expired");
    const payload = await response.json();
    if (requestGeneration !== sessionGeneration) return;
    sessionToken = saved;
    currentState = payload.state;
    revision = Number(payload.revision) || 1;
    nodeUuid = payload.node_uuid || sessionStorage.getItem("m3td-mobile-node") || "";
    referenceSize = payload.reference_size || referenceSize;
    activeSegment = Number(currentState.segmentConfig?.activeIndex) || 0;
    connectEvents(sessionToken);
  } catch {
    if (requestGeneration !== sessionGeneration) return;
    // A temporary network failure must not erase a still-valid pairing token.
    // The WebSocket retry will distinguish an offline server from a revoked session.
    sessionToken = saved;
    setConnected(false);
    setSyncStatus("暂时无法读取电脑端状态，正在尝试恢复连接…");
    connectEvents(saved);
  }
}

function renderPanel() {
  if (!currentState || !editorContent) return;
  // Re-rendering the editor replaces the segment chips. Preserve the user's
  // horizontal position so selecting a segment does not jump back to #1.
  const previousWindowScrollX = window.scrollX;
  const previousWindowScrollY = window.scrollY;
  const previousPrompt = editorContent.querySelector("#segment-prompt");
  if (activePanel === "segments" && previousPrompt) rememberedSegmentPromptScrollTop = previousPrompt.scrollTop;
  const previousSegmentPicker = activePanel === "segments"
    ? editorContent.querySelector(".mobile-segment-picker")
    : null;
  const previousSegmentScrollLeft = previousSegmentPicker?.scrollLeft ?? 0;
  const previousSelectedChip = previousSegmentPicker?.querySelector(
    '[data-select-mobile-segment="' + activeSegment + '"]'
  );
  const previousSelectedChipLeft = previousSelectedChip && previousSegmentPicker
    ? previousSelectedChip.getBoundingClientRect().left - previousSegmentPicker.getBoundingClientRect().left
    : null;
  document.querySelectorAll(".bottom-nav [data-panel]").forEach(button => button.classList.toggle("active", button.dataset.panel === activePanel));
  const titles = { segments:"分段编辑", assets:"素材管理", groups:"分组管理", settings:"连接设置" };
  editorHeading.textContent = titles[activePanel] || "移动导演台";
  if (activePanel === "segments") renderSegmentsPanel();
  else if (activePanel === "assets") renderAssetsPanel();
  else if (activePanel === "groups") renderGroupsPanel();
  else renderSettingsPanel();
  requestAnimationFrame(() => {
    // Keep the document at the same vertical position when the editor is
    // re-rendered after reordering/removing an asset.
    window.scrollTo(previousWindowScrollX, previousWindowScrollY);
    if (activePanel !== "segments") return;
    const nextPrompt = editorContent.querySelector("#segment-prompt");
    if (nextPrompt) nextPrompt.scrollTop = rememberedSegmentPromptScrollTop;
    const nextSegmentPicker = editorContent.querySelector(".mobile-segment-picker");
    if (!nextSegmentPicker) return;
    nextSegmentPicker.scrollLeft = previousSegmentScrollLeft;
    const nextSelectedChip = nextSegmentPicker.querySelector(
      '[data-select-mobile-segment="' + activeSegment + '"]'
    );
    if (nextSelectedChip && previousSelectedChipLeft !== null) {
      const nextLeft = nextSelectedChip.getBoundingClientRect().left - nextSegmentPicker.getBoundingClientRect().left;
      nextSegmentPicker.scrollLeft += nextLeft - previousSelectedChipLeft;
    }
  });
}

function incomingOverlapFrames(index) {
  const list = segments();
  if (index <= 0 || !list[index] || !list[index - 1]) return 0;
  const overlap = Number(list[index - 1].endFrame) - Number(list[index].startFrame);
  return Number.isFinite(overlap) ? Math.max(0, Math.round(overlap)) : 0;
}

function renderSegmentPicker() {
  return `<div class="mobile-segment-picker">${segments().map((segment,index)=>`
    <button type="button" class="mobile-segment-chip ${index===activeSegment?"active":""} ${segment.enabled===false?"disabled":""}" data-select-mobile-segment="${index}">
      <strong>${escapeHTML(segmentLabel(segment,index))}</strong><small>${segment.enabled===false?"已禁用":((segment.endFrame-segment.startFrame)/24).toFixed(2)+" 秒 · 重叠 "+incomingOverlapFrames(index)+" 帧"}</small>
    </button>`).join("")}</div>`;
}

function renderSegmentsPanel() {
  const segment = selectedSegment();
  if (!segment) { editorContent.innerHTML = '<p class="mobile-empty">当前没有可编辑的分段。</p>'; return; }
  const groupOptions = ['<option value="">未分组</option>', ...groups().map(group=>`<option value="${escapeHTML(group.id)}" ${segment.groupId===group.id?"selected":""}>${escapeHTML(group.name)}</option>`)].join("");
  const duration = Math.max(5/24, (segment.endFrame-segment.startFrame)/24);
  editorContent.innerHTML = `
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>分段数量与重叠</h3><span>最多 64 段</span></div>
      <div class="mobile-field-row">
        <label class="mobile-field">分段数量<input id="segment-count" type="number" min="1" max="64" step="1" value="${segments().length}"></label>
        <label class="mobile-field">全局重叠帧<input id="global-overlap" type="number" min="0" max="3587" step="1" value="${currentState.segmentConfig.globalOverlapFrames||39}"></label>
      </div>
      <div class="mobile-field-row">
        <button type="button" class="mobile-secondary" id="apply-segment-count">应用分段数量</button>
        <button type="button" class="mobile-secondary" id="apply-global-overlap">应用全局重叠</button>
      </div>
      <p class="mobile-hint">分段数量和重叠计算复用电脑端的 H3 帧对齐规则。</p>
    </section>
    ${renderSegmentPicker()}
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>分段属性</h3><span>第 ${activeSegment+1} / ${segments().length} 段 · 重叠 ${incomingOverlapFrames(activeSegment)} 帧</span></div>
      <label class="mobile-field">分段名称<input id="segment-name" maxlength="40" value="${escapeHTML(segment.name||"第 "+(activeSegment+1)+" 段")}"></label>
      <div class="mobile-field-row">
        <label class="mobile-field">起始时间（秒）<input id="segment-start" type="number" min="0" step="0.04" value="${(segment.startFrame/24).toFixed(2)}"></label>
        <label class="mobile-field">目标时长（秒）<input id="segment-duration" type="number" min="0.21" step="0.04" value="${duration.toFixed(2)}"></label>
      </div>
      <label class="mobile-field">所属分组<select id="segment-group">${groupOptions}</select></label>
      <label class="mobile-switch"><input id="segment-enabled" type="checkbox" ${segment.enabled===false?"":"checked"}><span>启用此分段</span></label>
      <p class="mobile-hint">时长调整沿用电脑端相同的 H3 帧对齐与后续分段联动算法。</p>
    </section>
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>本段提示词</h3><span>直接写入原始数据</span></div>
      <textarea id="segment-prompt" class="mobile-prompt" rows="8" placeholder="输入本段的 H3 提示词…">${escapeHTML(segment.prompt||"")}</textarea>
    </section>
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>本段素材引用</h3><span>图片最多 9 个 · 音频最多 3 个</span></div>
      <p class="mobile-hint">图片：${segment.images.length} 个　音频：${segment.audios.length} 个。可在此调整本段内的引用顺序。</p>
      <div class="mobile-assigned-list"><strong>图片顺序</strong>
        ${segment.images.map((id,index)=>{const asset=images().find(item=>String(item.id)===String(id));return asset?`<div class="mobile-assigned-row" data-sortable-segment-asset="images" data-index="${index}"><button type="button" class="mobile-drag-handle" aria-label="拖动调整图片顺序" title="按住拖动排序">⠿</button><span>Picture ${index+1} · ${escapeHTML(asset.name||asset.file)}</span><div class="mobile-order-actions"><button type="button" data-reorder-segment-asset="images" data-index="${index}" data-direction="up" ${index===0?"disabled":""}>↑</button><button type="button" data-reorder-segment-asset="images" data-index="${index}" data-direction="down" ${index===segment.images.length-1?"disabled":""}>↓</button><button type="button" class="mobile-icon-button" data-remove-segment-asset="images" data-asset-id="${escapeHTML(id)}" aria-label="从本段移除这张图片" title="从本段移除">×</button></div></div>`:"";}).join("")||'<p class="mobile-empty">本段尚未引用图片。</p>'}
      </div>
      <div class="mobile-assigned-list"><strong>音频顺序</strong>
        ${segment.audios.map((id,index)=>{const asset=audios().find(item=>String(item.id)===String(id));return asset?`<div class="mobile-assigned-row" data-sortable-segment-asset="audios" data-index="${index}"><button type="button" class="mobile-drag-handle" aria-label="拖动调整音频顺序" title="按住拖动排序">⠿</button><span>Audio ${index+1} · ${escapeHTML(asset.name||asset.file)} ${asset.audioMode==="locked"?"（锁定）":""}</span><div class="mobile-order-actions"><button type="button" data-reorder-segment-asset="audios" data-index="${index}" data-direction="up" ${index===0?"disabled":""}>↑</button><button type="button" data-reorder-segment-asset="audios" data-index="${index}" data-direction="down" ${index===segment.audios.length-1?"disabled":""}>↓</button><button type="button" class="mobile-icon-button" data-remove-segment-asset="audios" data-asset-id="${escapeHTML(id)}" aria-label="从本段移除这个音频" title="从本段移除">×</button></div></div>`:"";}).join("")||'<p class="mobile-empty">本段尚未引用音频。</p>'}
      </div>
      <button type="button" class="mobile-secondary full-width" data-open-assets>管理本段素材</button>
    </section>
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>全局提示词</h3><span>${segments().some(item=>String(item.prompt||"").trim())?"分段提示词模式已启用":"全局模式"}</span></div>
      <textarea id="global-prompt" class="mobile-prompt" rows="5" placeholder="输入全局提示词…">${escapeHTML(currentState.globalPrompt||"")}</textarea>
    </section>`;
  editorContent.querySelectorAll("[data-select-mobile-segment]").forEach(button=>button.addEventListener("click",()=>{
    activeSegment=Number(button.dataset.selectMobileSegment);syncActiveSelection();scheduleSave();renderPanel();
  }));
  editorContent.querySelector("#apply-segment-count").addEventListener("click",()=>{
    const count=Math.max(1,Math.min(64,Math.floor(Number(editorContent.querySelector("#segment-count").value)||1)));
    const previous=segments();
    const validGroups=new Set(groups().map(group=>String(group.id)));
    const next=createWindows(previous,count,(currentState.selection?.duration||5)*24,currentState.segmentConfig.globalOverlapFrames||39);
    for(const item of next)if(item.groupId&&!validGroups.has(String(item.groupId)))delete item.groupId;
    const used=new Set(next.map(item=>String(item.groupId||"")).filter(Boolean));
    currentState.segmentConfig={...currentState.segmentConfig,count,mode:"timeline",groups:groups().filter(group=>used.has(String(group.id))),segments:next};
    activeSegment=Math.min(activeSegment,count-1);
    syncActiveSelection();scheduleSave();renderPanel();
  });
  editorContent.querySelector("#apply-global-overlap").addEventListener("click",()=>{
    const requested=Math.max(0,Math.floor(Number(editorContent.querySelector("#global-overlap").value)||0));
    const effective=[0,1,...Array.from({length:Math.max(0,Math.floor((3587-5)/17)+1)},(_,i)=>5+17*i)].reduce((best,n)=>n<=3587&&Math.abs(n-requested)<Math.abs(best-requested)?n:best,0);
    if(!currentState.segmentConfig.segments.every(item=>Number.isInteger(item.startFrame)&&Number.isInteger(item.endFrame))){
      currentState.segmentConfig.segments=createWindows(segments(),segments().length,(currentState.selection?.duration||5)*24,currentState.segmentConfig.globalOverlapFrames||39);
    }
    currentState.segmentConfig.globalOverlapFrames=effective;
    currentState.segmentConfig.segments=applyGlobalOverlapFrames(segments(),effective);
    syncActiveSelection();scheduleSave();renderPanel();
  });
  editorContent.querySelector("#segment-name").addEventListener("change",event=>{
    const value=event.target.value.trim();if(value)segment.name=value;scheduleSave();renderPanel();
  });
  editorContent.querySelector("#segment-start").addEventListener("change",event=>{
    const requested=Math.max(0,Number(event.target.value)||0);
    currentState.segmentConfig.segments=editWindow(segments(),activeSegment,"move",Math.round(requested*24));
    syncActiveSelection();scheduleSave();renderPanel();
  });
  editorContent.querySelector("#segment-duration").addEventListener("change",event=>{
    const requested=Math.max(5/24,Number(event.target.value)||5);
    if(!Number.isInteger(segment.startFrame)||!Number.isInteger(segment.endFrame)){
      currentState.segmentConfig.segments=createWindows(segments(),currentState.segmentConfig.count,Math.round((currentState.selection?.duration||5)*24),currentState.segmentConfig.globalOverlapFrames||39);
      currentState.segmentConfig.mode="timeline";
    }
    currentState.segmentConfig.segments=setWindowContributionDuration(segments(),activeSegment,Math.round(requested*24));
    syncActiveSelection();scheduleSave();renderPanel();
  });
  editorContent.querySelector("#segment-group").addEventListener("change",event=>{
    if(event.target.value)segment.groupId=event.target.value;else delete segment.groupId;scheduleSave();renderPanel();
  });
  editorContent.querySelector("#segment-enabled").addEventListener("change",event=>{
    segment.enabled=event.target.checked;scheduleSave();renderPanel();
  });
  editorContent.querySelector("#segment-prompt").addEventListener("input",event=>{
    segment.prompt=event.target.value;scheduleSave();
  });
  editorContent.querySelector("#global-prompt").addEventListener("input",event=>{
    currentState.globalPrompt=event.target.value;scheduleSave();
  });
  editorContent.querySelectorAll("[data-open-assets]").forEach(button=>button.addEventListener("click",()=>{
    const prompt=editorContent.querySelector("#segment-prompt");
    if(prompt)rememberedSegmentPromptScrollTop=prompt.scrollTop;
    activePanel="assets";renderPanel();
  }));
  editorContent.querySelectorAll("[data-remove-segment-asset]").forEach(button=>button.addEventListener("click",()=>{
    const kind=button.dataset.removeSegmentAsset;
    const id=button.dataset.assetId;
    if(!["images","audios"].includes(kind))return;
    segment[kind]=(segment[kind]||[]).filter(value=>String(value)!==id);
    scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-reorder-segment-asset]").forEach(button=>button.addEventListener("click",()=>{
    const kind=button.dataset.reorderSegmentAsset,index=Number(button.dataset.index),list=segment[kind];
    const target=index+(button.dataset.direction==="up"?-1:1);
    if(!Array.isArray(list)||target<0||target>=list.length)return;
    [list[index],list[target]]=[list[target],list[index]];
    scheduleSave();renderPanel();
  }));

  let assetDrag=null;
  const clearAssetDrag=()=>{
    editorContent.querySelectorAll(".mobile-assigned-row.is-dragging,.mobile-assigned-row.is-drop-target").forEach(row=>row.classList.remove("is-dragging","is-drop-target"));
    window.removeEventListener("pointermove",moveAssignedAsset);
    window.removeEventListener("pointerup",finishAssignedAsset);
    window.removeEventListener("pointercancel",cancelAssignedAsset);
    assetDrag=null;
  };
  const moveAssignedAsset=event=>{
    if(!assetDrag||event.pointerId!==assetDrag.pointerId)return;
    event.preventDefault();
    const under=document.elementFromPoint(event.clientX,event.clientY)?.closest("[data-sortable-segment-asset]");
    editorContent.querySelectorAll(".mobile-assigned-row.is-drop-target").forEach(row=>row.classList.remove("is-drop-target"));
    if(under&&under.dataset.sortableSegmentAsset===assetDrag.kind&&Number(under.dataset.index)!==assetDrag.from){
      assetDrag.to=Number(under.dataset.index);
      under.classList.add("is-drop-target");
    }
  };
  const finishAssignedAsset=event=>{
    if(!assetDrag||event.pointerId!==assetDrag.pointerId)return;
    const {kind,from,to}=assetDrag;
    clearAssetDrag();
    if(to===null||to===from)return;
    const list=segment[kind];
    if(!Array.isArray(list)||from<0||from>=list.length||to<0||to>=list.length)return;
    const [moved]=list.splice(from,1);
    list.splice(to,0,moved);
    scheduleSave();renderPanel();
  };
  const cancelAssignedAsset=()=>clearAssetDrag();
  editorContent.querySelectorAll(".mobile-drag-handle").forEach(handle=>handle.addEventListener("pointerdown",event=>{
    if(event.pointerType==="mouse"&&event.button!==0)return;
    const row=handle.closest("[data-sortable-segment-asset]");
    if(!row)return;
    event.preventDefault();
    const kind=row.dataset.sortableSegmentAsset,from=Number(row.dataset.index);
    assetDrag={kind,from,to:null,pointerId:event.pointerId};
    row.classList.add("is-dragging");
    window.addEventListener("pointermove",moveAssignedAsset,{passive:false});
    window.addEventListener("pointerup",finishAssignedAsset,{once:true});
    window.addEventListener("pointercancel",cancelAssignedAsset,{once:true});
  }));
}

function renderVideoTimeline() {
  const list=[...videos()].sort((a,b)=>Number(a.start||0)-Number(b.start||0));
  const end=Math.max(12,...list.map(clip=>Number(clip.start||0)+Number(clip.duration||0)+1));
  const scale=mobileTimelineScale;
  const selected=list.find(clip=>String(clip.id)===String(selectedVideoId))||list[0]||null;
  selectedVideoId=selected?.id||"";
  mobilePlayhead=Math.max(0,Math.min(mobilePlayhead,end));
  const ruler=Array.from({length:Math.ceil(end/5)+1},(_,i)=>i*5).filter(t=>t<=end).map(t=>'<span style="left:'+(t*scale)+'px">'+t.toFixed(0)+'s</span>').join("");
  const clips=list.map((clip,index)=>'<div class="mobile-timeline-clip '+(String(clip.id)===String(selectedVideoId)?"selected":"")+'" data-video-clip="'+escapeHTML(clip.id)+'" style="left:'+(Number(clip.start||0)*scale)+'px;width:'+Math.max(28,Number(clip.duration||0)*scale)+'px"><button type="button" class="mobile-timeline-handle left" data-video-edge="left" aria-label="调整片段起点"></button><strong>'+escapeHTML(clip.name||"视频 "+(index+1))+'</strong><small>'+Number(clip.duration||0).toFixed(2)+'s</small><button type="button" class="mobile-timeline-handle right" data-video-edge="right" aria-label="调整片段终点"></button></div>').join("");
  const preview=selected?'<div class="mobile-video-preview"><strong>'+escapeHTML(selected.name||"参考视频预览")+'</strong><video controls playsinline preload="metadata" src="'+escapeHTML(mediaURL(selected.file))+'"></video></div>':"";
  return '<section class="mobile-card mobile-timeline-card"><div class="mobile-card-heading"><h3>视频时间轴</h3><button type="button" class="mobile-secondary" id="fit-video-timeline">适应全部</button></div><label class="mobile-field">时间轴缩放<input id="video-timeline-zoom" type="range" min="24" max="100" step="4" value="'+scale+'"></label>'+(list.length?'<div class="mobile-timeline-scroll"><div class="mobile-timeline-track" style="width:'+Math.max(100,end*scale)+'px"><div class="mobile-timeline-ruler">'+ruler+'</div>'+clips+'<i class="mobile-timeline-playhead" style="left:'+(mobilePlayhead*scale)+'px"></i></div></div><label class="mobile-field mobile-playhead-control">播放位置 · '+mobilePlayhead.toFixed(2)+' 秒<input id="video-playhead" type="range" min="0" max="'+end+'" step="0.0416667" value="'+mobilePlayhead+'"></label><div class="mobile-timeline-actions"><button type="button" class="mobile-secondary" id="split-video" '+(selected?"":"disabled")+'>在播放位置分割</button><button type="button" class="mobile-danger" id="delete-selected-video" '+(selected?"":"disabled")+'>删除选中片段</button></div>'+preview:'<p class="mobile-empty">上传参考视频后，这里会显示可拖动的视频时间轴。</p>')+'</section>';
}

async function loadMobilePreview(clip, video) {
  if(!clip||!video)return;
  const requestGeneration=sessionGeneration;
  if(clip.proxy){video.src=mediaURL(clip.proxy);return;}
  if(previewProxyRequests.has(String(clip.id)))return;
  previewProxyRequests.add(String(clip.id));
  try{
    const response=await fetch("/minimax_h3_timeline/preview_proxy",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({filename:clip.file})
    });
    const payload=await response.json();
    if(requestGeneration!==sessionGeneration)return;
    if(!response.ok||payload.error)throw new Error(payload.error||("HTTP "+response.status));
    clip.proxy=payload.proxy;
    if(video.isConnected)video.src=mediaURL(clip.proxy);
    scheduleSave();
  }catch(error){
    if(requestGeneration===sessionGeneration&&video.isConnected)video.insertAdjacentHTML("afterend",'<p class="mobile-hint">预览代理生成失败：'+escapeHTML(error.message)+'</p>');
  }finally{
    previewProxyRequests.delete(String(clip.id));
  }
}

function renderAssetsPanel() {
  const segment=selectedSegment();
  const imageCategories=[["character","人物"],["props","道具"],["scene","环境"]];
  const audioCategories=[["ref","音频参考"],["music","音乐参考"]];
  const imageCards=images().map(asset=>{
    const category=imageCategories.find(([key])=>key===(asset.group||"character"))?.[1]||"人物";
    const assigned=segment?.images?.some(id=>String(id)===String(asset.id));
    return `<article class="mobile-asset-card">
      <img src="${escapeHTML(mediaURL(asset.file))}" alt="">
      <div class="mobile-asset-info"><input class="mobile-asset-name" data-rename-image="${escapeHTML(asset.id)}" value="${escapeHTML(asset.name)}" aria-label="图片名称"><small>${category}</small>
        <select data-image-category="${escapeHTML(asset.id)}">${imageCategories.map(([key,label])=>`<option value="${key}" ${(asset.group||"character")===key?"selected":""}>${label}</option>`).join("")}</select>
      </div>
      <label class="mobile-assign"><input type="checkbox" data-assign-image="${escapeHTML(asset.id)}" ${assigned?"checked":""}>加入本段</label>
      <div class="mobile-order-actions"><button type="button" data-move-image="${escapeHTML(asset.id)}" data-direction="up" aria-label="图片上移">↑</button><button type="button" data-move-image="${escapeHTML(asset.id)}" data-direction="down" aria-label="图片下移">↓</button><button type="button" class="mobile-icon-button" data-delete-image="${escapeHTML(asset.id)}" aria-label="删除图片">×</button></div>
    </article>`;
  }).join("");
  const audioCards=audios().map(asset=>{
    const category=audioCategories.find(([key])=>key===(asset.audioGroup||"ref"))?.[1]||"音频参考";
    const assigned=segment?.audios?.some(id=>String(id)===String(asset.id));
    return `<article class="mobile-asset-card audio-card">
      <div class="mobile-audio-symbol">♫</div><div class="mobile-asset-info"><input class="mobile-asset-name" data-rename-audio="${escapeHTML(asset.id)}" value="${escapeHTML(asset.name)}" aria-label="音频名称"><small>${category}</small>
        <select data-audio-category="${escapeHTML(asset.id)}">${audioCategories.map(([key,label])=>`<option value="${key}" ${(asset.audioGroup||"ref")===key?"selected":""}>${label}</option>`).join("")}</select>
        <select data-audio-mode="${escapeHTML(asset.id)}"><option value="reference" ${asset.audioMode!=="locked"?"selected":""}>参考音频</option><option value="locked" ${asset.audioMode==="locked"?"selected":""}>锁定音频</option></select>
      </div>
      <label class="mobile-assign"><input type="checkbox" data-assign-audio="${escapeHTML(asset.id)}" ${assigned?"checked":""}>加入本段</label>
      <div class="mobile-order-actions"><button type="button" data-move-audio="${escapeHTML(asset.id)}" data-direction="up" aria-label="音频上移">↑</button><button type="button" data-move-audio="${escapeHTML(asset.id)}" data-direction="down" aria-label="音频下移">↓</button><button type="button" class="mobile-icon-button" data-delete-audio="${escapeHTML(asset.id)}" aria-label="删除音频">×</button></div>
    </article>`;
  }).join("");
  editorContent.innerHTML = `
    ${renderSegmentPicker()}
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>上传素材</h3><span>最大 512 MB</span></div>
      <label class="mobile-field">素材分类
        <select id="upload-category"><option value="character">人物图片</option><option value="props">道具图片</option><option value="scene">环境图片</option><option value="ref">音频参考</option><option value="music">音乐参考</option><option value="video">参考视频</option></select>
      </label>
      <label class="mobile-upload-button">选择图片、音频或视频文件<input id="mobile-upload" type="file" accept="image/*,audio/*,video/*" multiple></label>
      <p class="mobile-hint">上传后会加入素材库；如当前只有一个分段，系统会按电脑端规则自动加入该段。</p>
    </section>
    ${renderVideoTimeline()}
    <section class="mobile-card"><div class="mobile-card-heading"><h3>参考视频（${videos().length}）</h3><label class="mobile-switch"><input id="video-audio-enabled" type="checkbox" ${currentState.videoAudioEnabled===false?"":"checked"}><span>保留视频音轨</span></label></div>
      ${videos().map((clip,index)=>`<article class="mobile-asset-card video-card"><video src="${escapeHTML(mediaURL(clip.file))}" muted playsinline preload="metadata"></video><div class="mobile-asset-info"><strong>${escapeHTML(clip.name||"参考视频 "+(index+1))}</strong><small>${Number(clip.duration||0).toFixed(2)} 秒 · ${clip.hasAudio?"含音轨":"无音轨"}</small><label>开始位置<input type="number" step="0.04" min="0" data-video-start="${escapeHTML(clip.id)}" value="${Number(clip.start||0).toFixed(2)}"></label><label>使用时长<input type="number" step="0.04" min="0.21" data-video-duration="${escapeHTML(clip.id)}" value="${Number(clip.duration||0).toFixed(2)}"></label><label>源视频裁切起点<input type="number" step="0.04" min="0" data-video-trim-start="${escapeHTML(clip.id)}" value="${Number(clip.trimStart||0).toFixed(2)}"></label><div class="mobile-field-row"><label>参考宽度<input type="number" step="32" min="32" max="16384" data-video-width="${escapeHTML(clip.id)}" value="${Number(clip.referenceWidth||832)}"></label><label>参考高度<input type="number" step="32" min="32" max="16384" data-video-height="${escapeHTML(clip.id)}" value="${Number(clip.referenceHeight||480)}"></label></div><select data-video-mode="${escapeHTML(clip.id)}"><option value="guide" ${clip.referenceMode==="guide"?"selected":""}>完整参考</option><option value="edit" ${clip.referenceMode==="edit"?"selected":""}>普通参考视频</option><option value="boundary" ${clip.referenceMode==="boundary"?"selected":""}>边界参考</option></select></div><button type="button" class="mobile-icon-button" data-delete-video="${escapeHTML(clip.id)}" aria-label="删除视频">×</button></article>`).join("")||'<p class="mobile-empty">还没有参考视频。</p>'}
    </section>
    <section class="mobile-card"><div class="mobile-card-heading"><h3>图片素材（${images().length}）</h3><label class="mobile-switch"><input id="global-apply-images" type="checkbox"><span>应用到所有分段</span></label></div>
      ${imageCards||'<p class="mobile-empty">还没有图片素材。</p>'}
    </section>
    <section class="mobile-card"><div class="mobile-card-heading"><h3>音频素材（${audios().length}）</h3><span>参考 / 锁定</span></div>
      ${audioCards||'<p class="mobile-empty">还没有音频素材。</p>'}
    </section>`;
  editorContent.querySelectorAll("[data-select-mobile-segment]").forEach(button=>button.addEventListener("click",()=>{
    activeSegment=Number(button.dataset.selectMobileSegment);syncActiveSelection();scheduleSave();renderPanel();
  }));
  editorContent.querySelector("#mobile-upload").addEventListener("change",async event=>{
    const category=editorContent.querySelector("#upload-category").value;
    for(const file of Array.from(event.target.files||[])){
      await uploadAsset(file,["ref","music"].includes(category)?"audio":category==="video"?"video":"image",category);
    }
    renderPanel();
  });
  const zoomInput=editorContent.querySelector("#video-timeline-zoom");
  zoomInput?.addEventListener("change",event=>{
    mobileTimelineScale=Math.max(24,Math.min(100,Number(event.target.value)||44));renderPanel();
  });
  editorContent.querySelector("#fit-video-timeline")?.addEventListener("click",()=>{
    const end=Math.max(12,...videos().map(clip=>Number(clip.start||0)+Number(clip.duration||0)+1));
    const width=editorContent.querySelector(".mobile-timeline-scroll")?.clientWidth||320;
    mobileTimelineScale=Math.max(24,Math.min(100,(width-24)/end));renderPanel();
  });
  const previewClip=videos().find(item=>String(item.id)===String(selectedVideoId));
  const previewElement=editorContent.querySelector(".mobile-video-preview video");
  loadMobilePreview(previewClip,previewElement);
  if(previewClip&&previewElement){
    previewElement.addEventListener("loadedmetadata",()=>{
      const offset=Math.max(0,Math.min(Number(previewClip.duration||0),mobilePlayhead-Number(previewClip.start||0)));
      try{previewElement.currentTime=Math.min(previewElement.duration-.01,Number(previewClip.trimStart||0)+offset);}catch{}
    });
    previewElement.addEventListener("timeupdate",()=>{
      const sourceEnd=Number(previewClip.trimStart||0)+Number(previewClip.duration||0);
      if(previewElement.currentTime>=sourceEnd-1/24){
        try{previewElement.currentTime=sourceEnd;}catch{}
        previewElement.pause();
      }
      mobilePlayhead=Number(previewClip.start||0)+previewElement.currentTime-Number(previewClip.trimStart||0);
      const slider=editorContent.querySelector("#video-playhead");
      if(slider)slider.value=String(mobilePlayhead);
      const marker=editorContent.querySelector(".mobile-timeline-playhead");
      if(marker)marker.style.left=(mobilePlayhead*mobileTimelineScale)+"px";
      const label=editorContent.querySelector(".mobile-playhead-control");
      if(label)label.firstChild.textContent="播放位置 · "+mobilePlayhead.toFixed(2)+" 秒";
    });
  }
  const playheadInput=editorContent.querySelector("#video-playhead");
  playheadInput?.addEventListener("input",event=>{
    mobilePlayhead=Number(event.target.value)||0;
    const marker=editorContent.querySelector(".mobile-timeline-playhead");
    if(marker)marker.style.left=(mobilePlayhead*mobileTimelineScale)+"px";
    const label=editorContent.querySelector(".mobile-playhead-control");
    if(label)label.firstChild.textContent="播放位置 · "+mobilePlayhead.toFixed(2)+" 秒";
    const clip=videos().find(item=>String(item.id)===String(selectedVideoId));
    const video=editorContent.querySelector(".mobile-video-preview video");
    if(clip&&video&&video.readyState>=1&&mobilePlayhead>=clip.start&&mobilePlayhead<=clip.start+clip.duration){
      try{video.currentTime=Math.min(video.duration-.01,Number(clip.trimStart||0)+mobilePlayhead-clip.start);}catch{}
    }
  });
  editorContent.querySelectorAll("[data-video-clip]").forEach(element=>element.addEventListener("pointerdown",event=>{
    const clip=videos().find(item=>String(item.id)===element.dataset.videoClip);
    if(!clip)return;
    if(String(selectedVideoId)!==String(clip.id))mobilePlayhead=Number(clip.start||0);
    selectedVideoId=clip.id;
    const edge=event.target.closest("[data-video-edge]")?.dataset.videoEdge||"move";
    event.preventDefault();event.stopPropagation();
    videoDrag={clip,edge,startX:event.clientX,start:Number(clip.start||0),duration:Number(clip.duration||0),trimStart:Number(clip.trimStart||0),pointerId:event.pointerId};
    element.setPointerCapture?.(event.pointerId);
    element.classList.add("dragging");
    window.addEventListener("pointermove",moveVideoDrag,{passive:false});
    window.addEventListener("pointerup",finishVideoDrag,{once:true});
    window.addEventListener("pointercancel",finishVideoDrag,{once:true});
  }));
  const finishVideoDrag=()=>{
    if(!videoDrag)return;
    window.removeEventListener("pointermove",moveVideoDrag);
    window.removeEventListener("pointerup",finishVideoDrag);
    window.removeEventListener("pointercancel",finishVideoDrag);
    videoDrag=null;scheduleSave();renderPanel();
  };
  const moveVideoDrag=event=>{
    if(!videoDrag||event.pointerId!==videoDrag.pointerId)return;
    event.preventDefault();
    const clip=videoDrag.clip,edge=videoDrag.edge,start=videoDrag.start,duration=videoDrag.duration,trimStart=videoDrag.trimStart;
    const delta=Math.round(((event.clientX-videoDrag.startX)/mobileTimelineScale)*24)/24;
    const points=[0,...videos().filter(item=>item.id!==clip.id).flatMap(item=>[Number(item.start||0),Number(item.start||0)+Number(item.duration||0)]),Number(currentState.selection?.start||0),Number(currentState.selection?.start||0)+Number(currentState.selection?.duration||0)];
    const snapValue=value=>{
      const threshold=10/Math.max(24,mobileTimelineScale);
      let best=value,distance=threshold+1,snapped=false;
      for(const point of points){const current=Math.abs(point-value);if(current<=threshold&&current<distance){best=point;distance=current;snapped=true;}}
      return {value:Math.max(0,best),snapped};
    };
    if(edge==="move"){
      const proposed=start+delta,left=snapValue(proposed),right=snapValue(proposed+duration);
      const nextStart=left.snapped&&(!right.snapped||Math.abs(left.value-proposed)<=Math.abs(right.value-(proposed+duration)))?left.value:right.snapped?right.value-duration:proposed;
      clip.start=Math.max(0,nextStart);
    }else if(edge==="left"){
      const end=start+duration,proposed=Math.max(0,Math.min(end-5/24,start+delta)),nextStart=Math.max(0,Math.min(end-5/24,snapValue(proposed).value)),applied=nextStart-start;
      clip.start=nextStart;clip.duration=end-nextStart;
      clip.trimStart=Math.max(0,Math.min(trimStart+duration-5/24,trimStart+applied));
    }else{
      const available=Math.max(5/24,Number(clip.sourceDuration||duration)-trimStart);
      const proposedEnd=start+Math.max(5/24,Math.min(available,duration+delta));
      clip.duration=Math.max(5/24,Math.min(available,snapValue(proposedEnd).value-start));
    }
    const bar=editorContent.querySelector('[data-video-clip="'+CSS.escape(String(clip.id))+'"]');
    if(bar){bar.style.left=(clip.start*mobileTimelineScale)+"px";bar.style.width=Math.max(28,clip.duration*mobileTimelineScale)+"px";}
  };
  editorContent.querySelector("#split-video")?.addEventListener("click",()=>{
    const index=videos().findIndex(item=>String(item.id)===String(selectedVideoId));
    if(index<0)return;
    const clip=videos()[index],cut=mobilePlayhead-Number(clip.start||0);
    if(cut<=5/24||cut>=Number(clip.duration||0)-5/24){feedback("播放位置必须位于片段内部，并为两侧保留至少 5 帧。","error");return;}
    const right={...clip,id:uid(),start:mobilePlayhead,duration:clip.duration-cut,trimStart:clip.trimStart+cut};
    clip.duration=cut;currentState.videoClips.splice(index+1,0,right);selectedVideoId=right.id;
    scheduleSave();renderPanel();
  });
  editorContent.querySelector("#delete-selected-video")?.addEventListener("click",()=>{
    if(!selectedVideoId)return;
    currentState.videoClips=videos().filter(item=>String(item.id)!==String(selectedVideoId));
    selectedVideoId="";scheduleSave();renderPanel();
  });
  editorContent.querySelector("#video-audio-enabled").addEventListener("change",event=>{
    currentState.videoAudioEnabled=event.target.checked;scheduleSave();
  });
  editorContent.querySelectorAll("[data-video-start]").forEach(input=>input.addEventListener("change",()=>{
    const clip=videos().find(item=>String(item.id)===input.dataset.videoStart);
    if(clip){clip.start=Math.max(0,Number(input.value)||0);scheduleSave();}
  }));
  editorContent.querySelectorAll("[data-video-duration]").forEach(input=>input.addEventListener("change",()=>{
    const clip=videos().find(item=>String(item.id)===input.dataset.videoDuration);
    if(clip){clip.duration=Math.max(5/24,Number(input.value)||5);scheduleSave();}
  }));
  editorContent.querySelectorAll("[data-video-trim-start]").forEach(input=>input.addEventListener("change",()=>{
    const clip=videos().find(item=>String(item.id)===input.dataset.videoTrimStart);
    if(clip){const max=Math.max(0,Number(clip.sourceDuration||clip.duration)-5/24);clip.trimStart=Math.max(0,Math.min(max,Number(input.value)||0));clip.duration=Math.min(clip.duration,Math.max(5/24,Number(clip.sourceDuration||clip.duration)-clip.trimStart));scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-video-width]").forEach(input=>input.addEventListener("change",()=>{
    const clip=videos().find(item=>String(item.id)===input.dataset.videoWidth);
    if(clip){clip.referenceWidth=Math.max(32,Math.min(16384,Math.round((Number(input.value)||832)/32)*32));scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-video-height]").forEach(input=>input.addEventListener("change",()=>{
    const clip=videos().find(item=>String(item.id)===input.dataset.videoHeight);
    if(clip){clip.referenceHeight=Math.max(32,Math.min(16384,Math.round((Number(input.value)||480)/32)*32));scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-video-mode]").forEach(select=>select.addEventListener("change",()=>{
    const clip=videos().find(item=>String(item.id)===select.dataset.videoMode);
    if(clip){clip.referenceMode=select.value;scheduleSave();}
  }));
  editorContent.querySelectorAll("[data-delete-video]").forEach(button=>button.addEventListener("click",()=>{
    currentState.videoClips=videos().filter(item=>String(item.id)!==button.dataset.deleteVideo);
    scheduleSave();renderPanel();
  }));
  editorContent.querySelector("#global-apply-images").addEventListener("change",event=>{
    if(!event.target.checked)return;
    const ids=images().map(asset=>asset.id).slice(0,9);
    for(const item of segments())item.images=ids.slice();
    scheduleSave();renderPanel();
    feedback("已将当前图片素材应用到所有分段。","success");
  });
  editorContent.querySelectorAll("[data-rename-image]").forEach(input=>input.addEventListener("change",()=>{
    const asset=images().find(item=>String(item.id)===input.dataset.renameImage);
    if(asset){asset.name=input.value.trim()||asset.name;scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-rename-audio]").forEach(input=>input.addEventListener("change",()=>{
    const asset=audios().find(item=>String(item.id)===input.dataset.renameAudio);
    if(asset){asset.name=input.value.trim()||asset.name;scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-move-image]").forEach(button=>button.addEventListener("click",()=>{
    const list=currentState.images||[],index=list.findIndex(item=>String(item.id)===button.dataset.moveImage);
    if(index<0)return;
    const group=list[index].group||"character";
    const peers=list.map((item,i)=>({item,i})).filter(entry=>(entry.item.group||"character")===group);
    const peerIndex=peers.findIndex(entry=>entry.i===index),targetPeer=peerIndex+(button.dataset.direction==="up"?-1:1);
    if(targetPeer<0||targetPeer>=peers.length)return;
    const target=peers[targetPeer].i;
    [list[index],list[target]]=[list[target],list[index]];scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-move-audio]").forEach(button=>button.addEventListener("click",()=>{
    const list=currentState.audios||[],index=list.findIndex(item=>String(item.id)===button.dataset.moveAudio);
    if(index<0)return;
    const group=list[index].audioGroup||"ref";
    const peers=list.map((item,i)=>({item,i})).filter(entry=>(entry.item.audioGroup||"ref")===group);
    const peerIndex=peers.findIndex(entry=>entry.i===index),targetPeer=peerIndex+(button.dataset.direction==="up"?-1:1);
    if(targetPeer<0||targetPeer>=peers.length)return;
    const target=peers[targetPeer].i;
    [list[index],list[target]]=[list[target],list[index]];scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-image-category]").forEach(select=>select.addEventListener("change",()=>{
    const asset=images().find(item=>String(item.id)===select.dataset.imageCategory);if(asset){asset.group=select.value;scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-audio-category]").forEach(select=>select.addEventListener("change",()=>{
    const asset=audios().find(item=>String(item.id)===select.dataset.audioCategory);if(asset){asset.audioGroup=select.value;scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-audio-mode]").forEach(select=>select.addEventListener("change",()=>{
    const asset=audios().find(item=>String(item.id)===select.dataset.audioMode);if(asset)asset.audioMode=select.value;scheduleSave();
  }));
  editorContent.querySelectorAll("[data-assign-image]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.assignImage;if(!segment)return;
    segment.images=segment.images||[];
    if(input.checked){if(segment.images.length>=9){input.checked=false;feedback("每段最多引用 9 个图片素材。","error");return;}if(!segment.images.some(item=>String(item)===id))segment.images.push(id);}
    else segment.images=segment.images.filter(item=>String(item)!==id);
    scheduleSave();
  }));
  editorContent.querySelectorAll("[data-assign-audio]").forEach(input=>input.addEventListener("change",()=>{
    const id=input.dataset.assignAudio;if(!segment)return;
    segment.audios=segment.audios||[];
    if(input.checked){if(segment.audios.length>=3){input.checked=false;feedback("每段最多引用 3 个音频素材。","error");return;}if(!segment.audios.some(item=>String(item)===id))segment.audios.push(id);}
    else segment.audios=segment.audios.filter(item=>String(item)!==id);
    scheduleSave();
  }));
  editorContent.querySelectorAll("[data-delete-image]").forEach(button=>button.addEventListener("click",()=>{
    const id=button.dataset.deleteImage;currentState.images=images().filter(item=>String(item.id)!==id);
    for(const item of segments())item.images=(item.images||[]).filter(value=>String(value)!==id);
    scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-delete-audio]").forEach(button=>button.addEventListener("click",()=>{
    const id=button.dataset.deleteAudio;currentState.audios=audios().filter(item=>String(item.id)!==id);
    for(const item of segments())item.audios=(item.audios||[]).filter(value=>String(value)!==id);
    scheduleSave();renderPanel();
  }));
}

async function uploadAsset(file,kind,category) {
  if(!file || !sessionToken)return;
  const requestGeneration=sessionGeneration;
  const requestToken=sessionToken;
  if(file.size<=0 || file.size>MAX_UPLOAD_BYTES){feedback(file.size>MAX_UPLOAD_BYTES?"文件超过 512 MB 限制。":"文件为空。","error");return;}
  const serverName=Date.now()+"_"+Math.random().toString(36).slice(2,7)+"_"+file.name.replace(/[^\w.()\-\u4e00-\u9fff]+/gu,"_");
  const data=new FormData();
  data.append("image",file,serverName);data.append("type","input");data.append("subfolder",UPLOAD_SUBFOLDER);
  setSyncStatus("正在上传 "+file.name+"…");
  try{
    const upload=await fetch("/upload/image",{method:"POST",body:data});
    const uploaded=await upload.json();
    if(requestGeneration!==sessionGeneration||requestToken!==sessionToken)return;
    if(!upload.ok)throw new Error(uploaded.error||("上传失败 HTTP "+upload.status));
    const uploadedName=String(uploaded?.name||"").replace(/[\\/]+/g,"_");
    const uploadedFolder=String(uploaded?.subfolder||"").replace(/\\/g,"/").replace(/^\/+|\/+$/g,"");
    if(!uploadedName)throw new Error("ComfyUI 未返回上传后的文件名");
    const filename=uploadedFolder?uploadedFolder+"/"+uploadedName:uploadedName;
    const infoResponse=await fetch("/minimax_h3_timeline/media_info",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({filename,kind})
    });
    const info=await infoResponse.json();
    if(requestGeneration!==sessionGeneration||requestToken!==sessionToken)return;
    if(!infoResponse.ok||info.error)throw new Error(info.error||"媒体检查失败");
    if(kind==="image"){
      currentState.images.push({id:uid(),file:info.filename,name:file.name,width:info.width||0,height:info.height||0,group:category});
      const first=segments().length===1?segments()[0]:null;
      if(first && first.images.length<9)first.images.push(currentState.images.at(-1).id);
    }else if(kind==="video"){
      if(!info.hasVideo)throw new Error("视频文件中没有可用画面轨道");
      const start=videos().reduce((max,clip)=>Math.max(max,Number(clip.start||0)+Number(clip.duration||0)),0);
      const duration=Math.max(5/24,Number(info.duration)||5);
      currentState.videoClips.push({id:uid(),file:info.filename,name:file.name,start,duration,trimStart:0,sourceDuration:duration,hasAudio:!!info.hasAudio,referenceMode:"edit",referenceWidth:Number(referenceSize.width)||832,referenceHeight:Number(referenceSize.height)||480,peaks:info.peaks||[],proxy:""});
    }else{
      if(!info.hasAudio)throw new Error("文件中没有可用音轨");
      currentState.audios.push({id:uid(),file:info.filename,name:file.name,duration:info.duration||0,trimStart:0,audioMode:"reference",audioGroup:category});
      const first=segments().length===1?segments()[0]:null;
      if(first && first.audios.length<3)first.audios.push(currentState.audios.at(-1).id);
    }
    scheduleSave();setSyncStatus("上传完成，等待同步…");
  }catch(error){if(requestGeneration===sessionGeneration&&requestToken===sessionToken){feedback("上传失败："+error.message,"error");setSyncStatus("上传失败");}}
}

function renderGroupsPanel() {
  const rows=groups().map(group=>{
    const allSegments=segments();
    const members=allSegments.filter(segment=>segment.groupId===group.id);
    const enabledCount=members.filter(segment=>segment.enabled!==false).length;
    const disabledCount=members.length-enabledCount;
    return `<details class="mobile-card mobile-group-card">
      <summary class="mobile-group-summary">
        <span class="mobile-group-summary-title">${escapeHTML(group.name)}</span>
        <span class="mobile-group-summary-meta">${members.length} 段 · 启用 ${enabledCount} / 禁用 ${disabledCount}</span>
        <span class="mobile-group-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div class="mobile-group-content">
        <label class="mobile-field">分组名称<input data-group-name="${escapeHTML(group.id)}" maxlength="40" value="${escapeHTML(group.name)}"></label>
        <div class="mobile-group-members">${allSegments.map((segment,index)=>`
          <label class="mobile-group-member">
            <input type="checkbox" data-group-member="${index}" data-group-id="${escapeHTML(group.id)}" ${segment.groupId===group.id?"checked":""}>
            <span class="mobile-group-member-name">${escapeHTML(segmentLabel(segment,index))}</span>
            <span class="mobile-segment-state ${segment.enabled===false?"is-disabled":"is-enabled"}">${segment.enabled===false?"禁用":"启用"}</span>
          </label>`).join("")}</div>
        <div class="mobile-field-row"><button type="button" class="mobile-secondary" data-toggle-group="${escapeHTML(group.id)}">批量启用 / 禁用</button><button type="button" class="mobile-danger" data-dissolve-group="${escapeHTML(group.id)}">解散分组</button></div>
      </div>
    </details>`;
  }).join("");
  editorContent.innerHTML = `
    <section class="mobile-card"><div class="mobile-card-heading"><h3>新建分组</h3><span>按幕或场景整理分段</span></div>
      <div class="mobile-field-row"><label class="mobile-field">分组名称<input id="new-group-name" maxlength="40" placeholder="例如：第一幕"></label><button class="mobile-primary" type="button" id="create-group">创建</button></div>
    </section>
    ${rows||'<p class="mobile-empty">还没有分组。创建分组后可勾选分段进行归类。</p>'}`;
  editorContent.querySelector("#create-group").addEventListener("click",()=>{
    const input=editorContent.querySelector("#new-group-name"),name=input.value.trim();
    if(!name){feedback("请先输入分组名称。","error");return;}
    groups().push({id:uid(),name});scheduleSave();renderPanel();
  });
  editorContent.querySelectorAll("[data-group-name]").forEach(input=>input.addEventListener("change",()=>{
    const group=groups().find(item=>String(item.id)===input.dataset.groupName);if(group){group.name=input.value.trim()||group.name;scheduleSave();renderPanel();}
  }));
  editorContent.querySelectorAll("[data-group-member]").forEach(input=>input.addEventListener("change",()=>{
    const segment=segments()[Number(input.dataset.groupMember)],groupId=input.dataset.groupId;
    if(!segment)return;
    if(input.checked)segment.groupId=groupId;else if(segment.groupId===groupId)delete segment.groupId;
    scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-toggle-group]").forEach(button=>button.addEventListener("click",()=>{
    const id=button.dataset.toggleGroup;
    const members=segments().filter(segment=>String(segment.groupId)===id);
    if(!members.length)return;
    const enable=members.every(segment=>segment.enabled===false);
    for(const segment of members)segment.enabled=enable;
    scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-dissolve-group]").forEach(button=>button.addEventListener("click",()=>{
    const id=button.dataset.dissolveGroup;
    for(const segment of segments())if(segment.groupId===id)delete segment.groupId;
    currentState.segmentConfig.groups=groups().filter(group=>String(group.id)!==id);
    scheduleSave();renderPanel();
  }));
}

function renderSettingsPanel() {
  editorContent.innerHTML = `
    <section class="mobile-card"><div class="mobile-card-heading"><h3>二阶段采样</h3><span>导演台全局设置</span></div>
      <label class="mobile-switch"><input id="second-pass-enabled" type="checkbox" ${currentState.secondPass===true?"checked":""}><span>启用二阶段采样</span></label>
      <label class="mobile-field">放大模型名称<input id="second-pass-model" maxlength="160" value="${escapeHTML(currentState.secondPassModel||"")}" placeholder="填写电脑端可用的放大模型名称"></label>
      <label class="mobile-field">高分辨率采样步数<input id="second-pass-steps" type="number" min="1" max="200" step="1" value="${Math.max(1,Math.floor(Number(currentState.secondPassHighSteps)||4))}"></label>
      <p class="mobile-hint">模型名称需与电脑端已安装的放大模型一致。</p>
    </section>
    <section class="mobile-card"><div class="mobile-card-heading"><h3>同步状态</h3><span>实时连接</span></div>
      <p class="mobile-settings-status">${conflict?"存在冲突，已暂停同步":dirty?"有待保存的修改":"连接正常"}</p>
      <p class="mobile-hint">当前版本：${revision}<br>节点标识：<code>${escapeHTML(nodeUuid||"未知")}</code></p>
      <button type="button" class="mobile-secondary full-width" id="save-now">立即同步</button>
    </section>
    <section class="mobile-card"><div class="mobile-card-heading"><h3>重新连接</h3></div>
      <p class="mobile-hint">如果两端同时修改导致冲突，请先确认保留哪一端的数据，再重新配对。重新配对会撤销该节点旧的手机连接。</p>
      <button type="button" class="mobile-danger" id="disconnect-mobile">断开手机连接</button>
    </section>`;
  editorContent.querySelector("#second-pass-enabled").addEventListener("change",event=>{
    currentState.secondPass=event.target.checked;scheduleSave();
  });
  editorContent.querySelector("#second-pass-model").addEventListener("change",event=>{
    currentState.secondPassModel=event.target.value.trim();scheduleSave();
  });
  editorContent.querySelector("#second-pass-steps").addEventListener("change",event=>{
    currentState.secondPassHighSteps=Math.max(1,Math.min(200,Math.floor(Number(event.target.value)||1)));scheduleSave();
  });
  editorContent.querySelector("#save-now").addEventListener("click",()=>{
    if(conflict){feedback("当前存在同步冲突，请重新配对。","error");return;}
    clearTimeout(saveTimer);saveState();
  });
  editorContent.querySelector("#disconnect-mobile").addEventListener("click",async()=>{
    const button=editorContent.querySelector("#disconnect-mobile");button.disabled=true;clearTimeout(saveTimer);
    const requestGeneration=sessionGeneration,requestToken=sessionToken;
    try {
      const response=await fetch(API_ROOT+"/session/revoke",{method:"POST",headers:{Authorization:"Bearer "+requestToken}});
      const payload=await response.json().catch(()=>({}));
      if(requestGeneration!==sessionGeneration||requestToken!==sessionToken)return;
      if(!response.ok)throw new Error(payload.error||("HTTP "+response.status));
      sessionGeneration+=1;
      clearTimeout(saveTimer);clearTimeout(reconnectTimer);saveTimer=0;reconnectTimer=0;
      const previousSocket=socket;socket=null;previousSocket?.close();
      sessionStorage.removeItem("m3td-mobile-token");sessionStorage.removeItem("m3td-mobile-node");
      sessionToken="";currentState=null;revision=0;saveInFlight=false;pendingStateJson="";dirty=false;conflict=false;
      setConnected(false);feedback("手机授权已从服务器撤销。","success");
    } catch(error) {if(requestGeneration===sessionGeneration&&requestToken===sessionToken){button.disabled=false;feedback("服务器撤销失败，凭据仍保留，请联网后重试："+error.message,"error");}}
  });
}

document.querySelector("#scan-help")?.addEventListener("click",()=>{helpDialog.hidden=false;});
document.querySelector("#close-dialog")?.addEventListener("click",()=>{helpDialog.hidden=true;});
document.querySelector("#confirm-dialog")?.addEventListener("click",()=>{helpDialog.hidden=true;});
document.querySelector("#refresh-page")?.addEventListener("click",()=>window.location.reload());
document.querySelector("#desktop-mode")?.addEventListener("click",()=>{window.location.href="/";});
pairButton?.addEventListener("click",claimPairingCode);
runButton?.addEventListener("click", requestWorkflowRun);
stopButton?.addEventListener("click", requestWorkflowStop);
saveWorkflowButton?.addEventListener("click", requestWorkflowSave);
pairInput?.addEventListener("keydown",event=>{if(event.key==="Enter")claimPairingCode();});
pairInput?.addEventListener("input",()=>{pairInput.value=pairInput.value.toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,8);});
document.querySelectorAll(".bottom-nav [data-panel]").forEach(button=>button.addEventListener("click",()=>{
  const prompt=editorContent?.querySelector("#segment-prompt");
  if(activePanel==="segments"&&prompt)rememberedSegmentPromptScrollTop=prompt.scrollTop;
  activePanel=button.dataset.panel;renderPanel();
}));
helpDialog?.addEventListener("click",event=>{if(event.target===helpDialog)helpDialog.hidden=true;});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&helpDialog&&!helpDialog.hidden)helpDialog.hidden=true;});

const deviceModeHint=document.querySelector("#device-mode-hint");
const detectedMobile=typeof navigator.userAgentData?.mobile==="boolean"?navigator.userAgentData.mobile:/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
if(deviceModeHint)deviceModeHint.hidden=detectedMobile;

const pairingHash=new URLSearchParams(window.location.hash.slice(1));
const scannedCode=pairingHash.get("pair");
if(scannedCode&&pairInput){
  pairInput.value=scannedCode.toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,8);
  history.replaceState(null,"",window.location.pathname+window.location.search);
  claimPairingCode();
}else restoreSession();
