import qrcode from "./mobile/qrcode.mjs";

const API_ROOT = "/minimax_h3_timeline/mobile";

function makeUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value, index) => ([4, 6, 8, 10].includes(index) ? "-" : "") + value.toString(16).padStart(2, "0")).join("");
}

function nodeUuid(ui) {
  const node = ui.node;
  node.properties ||= {};
  let id = String(node.properties.m3tdMobileUuid || "");
  const duplicates = () => (node.graph?._nodes || []).some(other =>
    other !== node && other.properties?.m3tdMobileUuid === id
  );
  if (!id || duplicates()) {
    id = makeUuid();
    node.properties.m3tdMobileUuid = id;
    node.setDirtyCanvas?.(true, true);
  }
  return id;
}

function ensureDialog() {
  let dialog = document.querySelector("#m3td-mobile-pair-dialog");
  if (dialog) return dialog;
  dialog = document.createElement("div");
  dialog.id = "m3td-mobile-pair-dialog";
  dialog.style.cssText = "position:fixed;inset:0;z-index:100000;background:#080b12c9;display:none;align-items:center;justify-content:center;padding:18px;font:14px/1.5 system-ui,sans-serif;color:#eef2ff";
  dialog.innerHTML = `
    <section style="position:relative;width:min(520px,100%);background:#171c28;border:1px solid #354052;border-radius:16px;padding:24px;box-shadow:0 24px 80px #0009">
      <button type="button" data-close style="position:absolute;right:14px;top:10px;border:0;background:none;color:#cbd5e1;font-size:26px">×</button>
      <div style="color:#93c5fd;font-size:11px;letter-spacing:.14em;font-weight:700">MOBILE DIRECTOR</div>
      <h2 style="margin:8px 0 6px;font-size:22px">手机配对</h2>
      <p style="color:#aab6c8;margin:0 0 16px">用手机扫描二维码即可自动配对，也可打开下方页面手动输入配对码。配对码 3 分钟内有效且只能使用一次。</p>
      <label style="display:block;color:#aab6c8;font-size:12px;margin-bottom:5px">手机页面地址</label>
      <input data-url inputmode="url" autocomplete="url" spellcheck="false" style="box-sizing:border-box;width:100%;padding:10px;border-radius:8px;border:1px solid #475569;background:#0d1320;color:#dbeafe">
      <div data-qr style="display:flex;justify-content:center;padding:14px 0 4px"></div>
      <label style="display:block;color:#aab6c8;font-size:12px;margin:8px 0 5px">也可手动输入配对码</label>
      <div data-code style="font-size:30px;letter-spacing:.18em;font-weight:800;text-align:center;padding:12px;background:#0d1320;border:1px dashed #64748b;border-radius:10px;color:#f8fafc">--------</div>
      <p data-status style="min-height:22px;color:#93c5fd;margin:12px 0 0">正在等待手机连接…</p>
      <p style="color:#fbbf24;font-size:12px;margin:8px 0 0">如果地址是 localhost 或 127.0.0.1，手机无法通过它访问电脑。请把地址中的主机名改成电脑的局域网 IP，外出时则使用手机可访问的 WireGuard 地址或域名，然后点“更新二维码”。</p>
      <div style="display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:18px">
        <button type="button" data-refresh-qr style="padding:9px 14px;border:1px solid #64748b;border-radius:8px;background:#273449;color:#fff">更新二维码</button>
        <button type="button" data-copy style="padding:9px 14px;border:1px solid #64748b;border-radius:8px;background:#273449;color:#fff">复制页面地址</button>
        <button type="button" data-close style="padding:9px 14px;border:0;border-radius:8px;background:#2563eb;color:#fff">关闭</button>
      </div>
    </section>`;
  document.body.append(dialog);
  dialog.addEventListener("click", event => {
    if (event.target === dialog || event.target.closest("[data-close]")) dialog.style.display = "none";
  });
  dialog.querySelector("[data-copy]").addEventListener("click", async () => {
    const input = dialog.querySelector("[data-url]");
    input.select();
    try { await navigator.clipboard.writeText(input.value); }
    catch { document.execCommand("copy"); }
  });
  return dialog;
}

export function attachMobilePairing(ui) {
  if (!ui || ui.__m3tdMobileAttached) return;
  ui.__m3tdMobileAttached = true;
  const head = ui.root?.querySelector(".m3td-head");
  if (!head) return;

  const mobileUrl = new URL("./mobile/index.html", import.meta.url).href;
  // Resolve the node identity when needed. ComfyUI may restore node.properties
  // after onNodeCreated, so capturing the UUID here can retain a temporary ID.
  const credentialKey = () => "m3td-mobile-desktop-token:" + nodeUuid(ui);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "m3td-btn";
  button.textContent = "手机配对";
  button.title = "生成手机移动导演台的一次性配对码";
  head.insertBefore(button, head.children[1] || null);

  const mobileReturnButton = document.createElement("button");
  mobileReturnButton.type = "button";
  mobileReturnButton.className = "m3td-btn";
  mobileReturnButton.textContent = "返回移动版";
  mobileReturnButton.title = "返回移动导演台页面，保留当前配对会话";
  mobileReturnButton.addEventListener("click", () => {
    window.location.assign(mobileUrl);
  });
  head.insertBefore(mobileReturnButton, button.nextSibling);

  const restoreButton = document.createElement("button");
  restoreButton.type = "button";
  restoreButton.className = "m3td-btn";
  restoreButton.textContent = "检查手机进度";
  restoreButton.title = "读取手机端最近同步的导演台状态，确认后恢复到电脑";
  head.insertBefore(restoreButton, mobileReturnButton.nextSibling);

  const dialog = ensureDialog();
  const status = dialog.querySelector("[data-status]");
  const urlInput = dialog.querySelector("[data-url]");
  const codeBox = dialog.querySelector("[data-code]");
  const qrBox = dialog.querySelector("[data-qr]");
  let currentPairCode = "";
  const renderPairQr = () => {
    if (!currentPairCode) return;
    try {
      const target = new URL(urlInput.value.trim());
      if (!["http:", "https:"].includes(target.protocol)) throw new Error("页面地址必须使用 HTTP 或 HTTPS");
      target.hash = "pair=" + encodeURIComponent(currentPairCode);
      const qr = qrcode(0, "M");
      qr.addData(target.href);
      qr.make();
      const qrImage = document.createElement("img");
      qrImage.alt = "手机移动导演台配对二维码";
      qrImage.width = 196;
      qrImage.height = 196;
      qrImage.style.cssText = "display:block;width:196px;height:196px;background:#fff;padding:8px;border-radius:10px";
      qrImage.src = qr.createDataURL(4, 4);
      qrBox.replaceChildren(qrImage);
      setStatus("二维码已更新。请确认地址中的主机名是手机能够访问的电脑地址。");
    } catch (error) {
      qrBox.replaceChildren();
      setStatus("页面地址无效：" + error.message);
    }
  };
  dialog.querySelector("[data-refresh-qr]").addEventListener("click", renderPairQr);
  urlInput.addEventListener("change", renderPairQr);
  let token = "";
  try { token = localStorage.getItem(credentialKey()) || ""; } catch (_) {}
  let revision = 0;
  let socket = null;
  let applyingRemote = false;
  let pendingTimer = 0;
  let pushInFlight = false;
  let localQueued = false;
  let pendingStateJson = "";
  let conflict = false;
  let localDirty = false;
  let reconnectTimer = 0;
  let reconnectDelay = 1000;
  let connectionGeneration = 0;

  const setStatus = message => { status.textContent = message; };
  const applyRemote = payload => {
    if (!payload || !payload.state || typeof payload.state !== "object") return;
    applyingRemote = true;
    try {
      ui.state = normalizeMobileState(payload.state);
      const count = Math.max(1, ui.state.segmentConfig?.segments?.length || 1);
      ui.activeSegment = Math.max(0, Math.min(Number(ui.state.segmentConfig?.activeIndex) || 0, count - 1));
      ui.selectedSegments = new Set([ui.activeSegment]);
      ui.selectWindowGeometry?.();
      ui.sync(false);
      ui.render();
      revision = Number(payload.revision) || revision;
    } finally {
      applyingRemote = false;
    }
  };
  const pushLocal = async () => {
    if (!token || !socket || socket.readyState !== WebSocket.OPEN || conflict || applyingRemote) return;
    if (pushInFlight) { localQueued = true; return; }
    pushInFlight = true;
    const requestGeneration = connectionGeneration;
    const requestToken = token;
    pendingStateJson = JSON.stringify(ui.state);
    const submittedState = pendingStateJson;
    try {
      const response = await fetch(API_ROOT + "/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + requestToken },
        body: JSON.stringify({ expected_revision: revision, state: JSON.parse(submittedState) }),
      });
      const payload = await response.json();
      if (requestGeneration !== connectionGeneration) return;
      if (response.status === 409) {
        if (JSON.stringify(payload.state) === submittedState) {
          revision = Number(payload.revision) || revision;
          localDirty = JSON.stringify(ui.state) !== submittedState;
          if (localDirty) localQueued = true;
          else setStatus("连接恢复，确认服务器已保存相同内容 · 版本 " + revision);
          return;
        }
        conflict = true;
        setStatus("检测到并发修改。为避免覆盖，已暂停同步；请核对两端内容后重新配对。");
        return;
      }
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      revision = Number(payload.revision) || revision + 1;
      localDirty = JSON.stringify(ui.state) !== submittedState;
      if (localDirty) localQueued = true;
      else setStatus("已同步到手机端 · 版本 " + revision);
    } catch (error) {
      if (requestGeneration === connectionGeneration) {
        localDirty = true;
        setStatus("同步暂时失败，已保留电脑端修改；正在尝试恢复连接。");
        if (socket?.readyState === WebSocket.OPEN) socket.close();
      }
    } finally {
      if (requestGeneration === connectionGeneration) {
        pushInFlight = false;
        pendingStateJson = "";
        if (localQueued && !conflict && socket?.readyState === WebSocket.OPEN) {
          localQueued = false;
          queueMicrotask(pushLocal);
        }
      }
    }
  };

  // Shared WebSocket lifecycle for both first-time pairing and restored sessions.
      const scheduleReconnect = () => {
        if (!token || conflict || reconnectTimer) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        setStatus("网络连接中断，" + Math.ceil(delay / 1000) + " 秒后自动重连…");
        reconnectTimer = setTimeout(() => {
          reconnectTimer = 0;
          connectSocket();
        }, delay);
      };

      const connectSocket = () => {
        if (!token || conflict) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = 0;
        const wsUrl = new URL(API_ROOT + "/events", window.location.href);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
        let activeSocket;
        try {
          activeSocket = new WebSocket(wsUrl);
        } catch {
          scheduleReconnect();
          return;
        }
        socket = activeSocket;
        activeSocket.addEventListener("open", () => {
          if (socket === activeSocket) activeSocket.send(JSON.stringify({ token }));
        });
        activeSocket.addEventListener("message", event => {
          if (socket !== activeSocket) return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "ready") {
            const remoteRevision = Number(message.revision) || 0;
            if (localDirty) {
              if (remoteRevision > revision && JSON.stringify(message.state) === JSON.stringify(ui.state)) {
                revision = remoteRevision;
                localDirty = false;
                localQueued = false;
                reconnectDelay = 1000;
                setStatus("连接已恢复，服务器内容与电脑端一致 · 版本 " + revision);
                return;
              }
              if (remoteRevision !== revision) {
                conflict = true;
                setStatus("断线期间两端状态发生变化，已暂停自动同步以防覆盖；请核对两端内容。");
                activeSocket.close();
                return;
              }
              revision = remoteRevision;
              reconnectDelay = 1000;
              setStatus("连接已恢复，正在安全补同步电脑端修改…");
              pushLocal();
            } else if (remoteRevision >= revision) {
              if (remoteRevision > revision) applyRemote(message);
              revision = remoteRevision;
              reconnectDelay = 1000;
              setStatus("电脑端同步连接已恢复 · 版本 " + revision);
            } else {
              conflict = true;
              setStatus("服务器版本低于电脑端已知版本，已暂停同步以防数据丢失。");
              activeSocket.close();
            }
          } else if (message.type === "paired") {
            setStatus("手机已完成配对，实时同步已建立。");
          } else if (message.type === "state") {
            const nextRevision = Number(message.revision) || 0;
            if (nextRevision <= revision) return;
            if (pushInFlight && JSON.stringify(message.state) === pendingStateJson) {
              revision = nextRevision;
              localDirty = false;
              setStatus("电脑端修改已同步。");
            } else if (localDirty || pendingTimer || pushInFlight) {
              conflict = true;
              setStatus("手机端与电脑端同时修改。同步已暂停，保留两端内容，请先核对。");
            } else {
              applyRemote(message);
              setStatus("手机端修改已同步到电脑。");
            }
          }
        });
        activeSocket.addEventListener("close", event => {
          if (socket !== activeSocket) return;
          if (event.code === 4002 || event.code === 4003) {
            connectionGeneration += 1;
            pushInFlight = false;
            token = "";
            clearTimeout(reconnectTimer);
            reconnectTimer = 0;
            clearTimeout(pendingTimer);
            pendingTimer = 0;
            localQueued = false;
            pendingStateJson = "";
            localDirty = false;
            conflict = false;
            setStatus("手机授权已撤销、过期或配对已被替换，请重新配对。");
          } else if (token && !conflict) {
            setStatus("连接中断，正在自动重连…");
            scheduleReconnect();
          }
        });
        activeSocket.addEventListener("error", () => {
          if (socket === activeSocket) setStatus("实时连接中断，正在尝试自动重连…");
        });
      };

  const startRealtimeConnection = () => {
    if (!token || conflict) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    if (socket) {
      const previousSocket = socket;
      socket = null;
      previousSocket.close();
    }
    reconnectDelay = 1000;
    connectSocket();
  };

  const originalSync = ui.sync.bind(ui);
  ui.sync = (...args) => {
    const result = originalSync(...args);
    if (!applyingRemote && token && !conflict) {
      localDirty = true;
      if (pushInFlight) localQueued = true;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { pendingTimer = 0; pushLocal(); }, 180);
    }
    return result;
  };

  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    dialog.style.display = "flex";
    urlInput.value = mobileUrl;
    currentPairCode = "";
    codeBox.textContent = "--------";
    qrBox.replaceChildren();
    setStatus("正在生成配对码…");
    connectionGeneration += 1;
    const requestGeneration = connectionGeneration;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    reconnectDelay = 1000;
    token = "";
    conflict = false;
    localDirty = false;
    localQueued = false;
    pushInFlight = false;
    pendingStateJson = "";
    clearTimeout(pendingTimer);
    pendingTimer = 0;
    if (socket) {
      const previousSocket = socket;
      socket = null;
      previousSocket.close();
    }
    try {
      const response = await fetch(API_ROOT + "/pair/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_uuid: nodeUuid(ui), state: ui.state, reference_size: { width: Number(ui.node.widgets?.find(widget => widget.name === "width")?.value) || 832, height: Number(ui.node.widgets?.find(widget => widget.name === "height")?.value) || 480 } }),
      });
      const payload = await response.json();
      if (requestGeneration !== connectionGeneration) {
        if (payload.token) {
          fetch(API_ROOT + "/session/revoke", {
            method: "POST",
                localDirty = false;
      reconnectDelay = 1000;
      startRealtimeConnection();) => {});
        }
        return;
      }
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      token = payload.token;
      try { localStorage.setItem(credentialKey(), token); } catch (_) {}
      revision = payload.revision;
      codeBox.textContent = payload.code;
      currentPairCode = payload.code;
      renderPairQr();
      setStatus("请用手机扫描二维码，或手动打开页面输入配对码。（3 分钟有效）");
      const connectSocket = () => {
        if (!token || conflict) return;
        clearTimeout(reconnectTimer);
        reconnectTimer = 0;
        const wsUrl = new URL(API_ROOT + "/events", window.location.href);
        wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
        let activeSocket;
        try {
          activeSocket = new WebSocket(wsUrl);
        } catch {
          scheduleReconnect();
          return;
        }
        socket = activeSocket;
        activeSocket.addEventListener("open", () => {
          if (socket === activeSocket) activeSocket.send(JSON.stringify({ token }));
        });
        activeSocket.addEventListener("message", event => {
          if (socket !== activeSocket) return;
          let message;
          try { message = JSON.parse(event.data); } catch { return; }
          if (message.type === "ready") {
            const remoteRevision = Number(message.revision) || 0;
            if (localDirty) {
              if (remoteRevision > revision && JSON.stringify(message.state) === JSON.stringify(ui.state)) {
                revision = remoteRevision;
                localDirty = false;
                localQueued = false;
                reconnectDelay = 1000;
                setStatus("连接已恢复，服务器内容与电脑端一致 · 版本 " + revision);
                return;
              }
              if (remoteRevision !== revision) {
                conflict = true;
                setStatus("断线期间两端状态发生变化，已暂停自动同步以防覆盖；请核对两端内容。");
                activeSocket.close();
                return;
              }
              revision = remoteRevision;
              reconnectDelay = 1000;
              setStatus("连接已恢复，正在安全补同步电脑端修改…");
              pushLocal();
            } else if (remoteRevision >= revision) {
              if (remoteRevision > revision) applyRemote(message);
              revision = remoteRevision;
              reconnectDelay = 1000;
              setStatus("电脑端同步连接已恢复 · 版本 " + revision);
            } else {
              conflict = true;
              setStatus("服务器版本低于电脑端已知版本，已暂停同步以防数据丢失。");
              activeSocket.close();
            }
          } else if (message.type === "paired") {
            setStatus("手机已完成配对，实时同步已建立。");
          } else if (message.type === "state") {
            const nextRevision = Number(message.revision) || 0;
            if (nextRevision <= revision) return;
            if (pushInFlight && JSON.stringify(message.state) === pendingStateJson) {
              revision = nextRevision;
              localDirty = false;
              setStatus("电脑端修改已同步。");
            } else if (localDirty || pendingTimer || pushInFlight) {
              conflict = true;
              setStatus("手机端与电脑端同时修改。同步已暂停，保留两端内容，请先核对。");
            } else {
              applyRemote(message);
              setStatus("手机端修改已同步到电脑。");
            }
          }
        });
        activeSocket.addEventListener("close", event => {
          if (socket !== activeSocket) return;
          if (event.code === 4002 || event.code === 4003) {
            connectionGeneration += 1;
            pushInFlight = false;
            token = "";
            clearTimeout(reconnectTimer);
            reconnectTimer = 0;
            clearTimeout(pendingTimer);
            pendingTimer = 0;
            localQueued = false;
            pendingStateJson = "";
            localDirty = false;
            conflict = false;
            setStatus("手机授权已撤销、过期或配对已被替换，请重新配对。");
          } else if (token && !conflict) {
            setStatus("连接中断，正在自动重连…");
            scheduleReconnect();
          }
        });
        activeSocket.addEventListener("error", () => {
          if (socket === activeSocket) setStatus("实时连接中断，正在尝试自动重连…");
        });
      };
      const scheduleReconnect = () => {
        if (!token || conflict || reconnectTimer) return;
        const delay = reconnectDelay;
        reconnectDelay = Math.min(reconnectDelay * 2, 15000);
        setStatus("网络连接中断，" + Math.ceil(delay / 1000) + " 秒后自动重连…");
        reconnectTimer = setTimeout(() => {
          reconnectTimer = 0;
          connectSocket();
        }, delay);
      };
      localDirty = false;
      reconnectDelay = 1000;
      connectSocket();
    } catch (error) {
      if (requestGeneration === connectionGeneration) {
        token = "";
        setStatus("配对码生成失败：" + error.message);
      }
    } finally {
      if (requestGeneration === connectionGeneration) button.disabled = false;
    }
  });


  restoreButton.addEventListener("click", async () => {
    if (restoreButton.disabled) return;
    restoreButton.disabled = true;
    dialog.style.display = "flex";
    setStatus("正在检查手机端最新进度…");
    try {
      // Resolve identity at click time, after ComfyUI has finished configuring
      // the workflow node. Do not compare against an onNodeCreated-time UUID.
      const currentNodeUuid = nodeUuid(ui);
      const activeCredentialKey = "m3td-mobile-desktop-token:" + currentNodeUuid;
      // Validate every saved token against the server before adopting it;
      // never trust the key name alone and never delete original credentials.
      const candidates = [];
      try {
        const primary = localStorage.getItem(activeCredentialKey) || token;
        if (primary) candidates.push(primary);
        for (const key of Object.keys(localStorage)) {
          if (!key.startsWith("m3td-mobile-desktop-token:") || key === activeCredentialKey) continue;
          const value = localStorage.getItem(key);
          if (value && !candidates.includes(value)) candidates.push(value);
        }
      } catch (_) {
        if (token && !candidates.includes(token)) candidates.push(token);
      }
      if (!candidates.length) {
        throw new Error("没有找到已保存的手机配对凭证。为保护现有手机会话，请勿重新配对；请先检查浏览器存储。");
      }

      let savedToken = "";
      let payload = null;
      let lastHttpStatus = 0;
      for (const candidate of candidates) {
        const response = await fetch(API_ROOT + "/state", {
          method: "GET",
          headers: { Authorization: "Bearer " + candidate },
          cache: "no-store",
        });
        lastHttpStatus = response.status;
        let result = {};
        try { result = await response.json(); } catch (_) {}
        if (response.status === 401) continue;
        if (!response.ok) throw new Error(result.error || ("HTTP " + response.status));
        if (result.node_uuid !== currentNodeUuid) continue;
        savedToken = candidate;
        payload = result;
        break;
      }
      if (!savedToken || !payload) {
        throw new Error(
          lastHttpStatus === 401
            ? "找到的凭证均已失效，未修改或删除任何凭证。"
            : "没有找到属于当前导演台节点的手机会话，未修改任何凭证。"
        );
      }
      token = savedToken;
      try { localStorage.setItem(activeCredentialKey, savedToken); } catch (_) {}

      const remoteRevision = Number(payload.revision) || 0;
      const remoteJson = JSON.stringify(payload.state);
      const localJson = JSON.stringify(ui.state);
      const updated = Number(payload.updated_at) > 0
        ? new Date(Number(payload.updated_at) * 1000).toLocaleString()
        : "时间信息不可用";
      if (remoteJson === localJson) {
        revision = remoteRevision;
        token = savedToken;
        startRealtimeConnection();
        setStatus("手机端与电脑端内容一致 · 实时同步已连接 · 版本 " + remoteRevision + " · 最近更新 " + updated);
        return;
      }
      const confirmed = window.confirm(
        "检查到手机端有一份不同的导演台进度。\n\n手机端版本：" + remoteRevision +
        "\n最近更新：" + updated +
        "\n\n确认后将用手机端状态替换当前电脑端导演台状态。建议先保存当前工作流备份。\n\n是否恢复？"
      );
      if (!confirmed) {
        setStatus("已取消恢复，电脑端内容保持不变。手机端版本 " + remoteRevision + " · " + updated);
        return;
      }
      token = savedToken;
      revision = remoteRevision;
      applyRemote(payload);
      startRealtimeConnection();
      setStatus("已恢复手机端进度 · 实时同步正在连接 · 版本 " + remoteRevision + " · " + updated + "。请按 Ctrl+S 保存工作流。");
    } catch (error) {
      setStatus("检查手机进度失败：" + error.message);
    } finally {
      restoreButton.disabled = false;
    }
  });

  const normalizeMobileState = value => value;
  let pairingDisposed = false;
  const cleanupPairing = () => {
    if (pairingDisposed) return;
    pairingDisposed = true;
    ui.root.removeEventListener("DOMNodeRemoved", handleRootRemoved);
    clearTimeout(pendingTimer);
    pendingTimer = 0;
    localQueued = false;
    connectionGeneration += 1;
    clearTimeout(reconnectTimer);
    reconnectTimer = 0;
    token = "";
    const previousSocket = socket;
    socket = null;
    previousSocket?.close();
  };
  const handleRootRemoved = event => {
    if (event.target === ui.root) cleanupPairing();
  };
  ui.root.addEventListener("DOMNodeRemoved", handleRootRemoved, { once: true });
  return cleanupPairing;
}
