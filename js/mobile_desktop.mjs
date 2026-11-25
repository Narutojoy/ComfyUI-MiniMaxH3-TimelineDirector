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

  const button = document.createElement("button");
  button.type = "button";
  button.className = "m3td-btn";
  button.textContent = "手机配对";
  button.title = "生成手机移动导演台的一次性配对码";
  head.insertBefore(button, head.children[1] || null);

  const dialog = ensureDialog();
  const status = dialog.querySelector("[data-status]");
  const urlInput = dialog.querySelector("[data-url]");
  const codeBox = dialog.querySelector("[data-code]");
  const qrBox = dialog.querySelector("[data-qr]");
  const mobileUrl = new URL("./mobile/index.html", import.meta.url).href;
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
  let revision = 0;
  let socket = null;
  let applyingRemote = false;
  let pendingTimer = 0;
  let pushInFlight = false;
  let localQueued = false;
  let pendingStateJson = "";
  let conflict = false;

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
    pushInFlight = true;
    pendingStateJson = JSON.stringify(ui.state);
    try {
      const response = await fetch(API_ROOT + "/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ expected_revision: revision, state: ui.state }),
      });
      const payload = await response.json();
      if (response.status === 409) {
        conflict = true;
        setStatus("检测到并发修改。为避免覆盖，已暂停同步；请关闭配对后重新连接并核对两端内容。");
        return;
      }
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      revision = payload.revision;
    } catch (error) {
      setStatus("同步暂时失败：" + error.message);
    } finally {
      pushInFlight = false;
      pendingStateJson = "";
      if (localQueued && !conflict) {
        localQueued = false;
        queueMicrotask(pushLocal);
      }
    }
  };

  const originalSync = ui.sync.bind(ui);
  ui.sync = (...args) => {
    const result = originalSync(...args);
    if (!applyingRemote && token && !conflict) {
      if (pushInFlight) localQueued = true;
      clearTimeout(pendingTimer);
      pendingTimer = setTimeout(() => { pendingTimer = 0; pushLocal(); }, 180);
    }
    return result;
  };

  button.addEventListener("click", async () => {
    dialog.style.display = "flex";
    urlInput.value = mobileUrl;
    codeBox.textContent = "--------";
    qrBox.replaceChildren();
    setStatus("正在生成配对码…");
    token = "";
    conflict = false;
    clearTimeout(pendingTimer);
    pendingTimer = 0;
    if (socket) socket.close();
    try {
      const response = await fetch(API_ROOT + "/pair/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_uuid: nodeUuid(ui), state: ui.state, reference_size: { width: Number(ui.node.widgets?.find(widget => widget.name === "width")?.value) || 832, height: Number(ui.node.widgets?.find(widget => widget.name === "height")?.value) || 480 } }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || ("HTTP " + response.status));
      token = payload.token;
      revision = payload.revision;
      codeBox.textContent = payload.code;
      const pairingUrl = mobileUrl + "#pair=" + encodeURIComponent(payload.code);
      const qr = qrcode(0, "M");
      qr.addData(pairingUrl);
      qr.make();
      const qrImage = document.createElement("img");
      qrImage.alt = "手机移动导演台配对二维码";
      qrImage.width = 196;
      qrImage.height = 196;
      qrImage.style.cssText = "display:block;width:196px;height:196px;background:#fff;padding:8px;border-radius:10px";
      qrImage.src = qr.createDataURL(4, 4);
      qrBox.replaceChildren(qrImage);
      setStatus("请用手机扫描二维码，或手动打开页面输入配对码。（3 分钟有效）");
      const wsUrl = new URL(API_ROOT + "/events", window.location.href);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(wsUrl);
      socket.addEventListener("open", () => socket.send(JSON.stringify({ token })));
      socket.addEventListener("message", event => {
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === "ready") {
          revision = Number(message.revision) || revision;
          setStatus("电脑端同步通道已就绪，等待手机完成配对…");
        } else if (message.type === "paired") {
          setStatus("手机已完成配对，实时同步已建立。");
        } else if (message.type === "state") {
          if (Number(message.revision) <= revision) return;
          if (pushInFlight && JSON.stringify(message.state) === pendingStateJson) {
            revision = Number(message.revision) || revision;
            setStatus("电脑端修改已同步。");
          } else if (pendingTimer || pushInFlight) {
            conflict = true;
            setStatus("手机端与电脑端同时修改。同步已暂停，保留电脑端当前内容，请先核对两端。");
          } else {
            applyRemote(message);
            setStatus("手机端修改已同步到电脑。");
          }
        }
      });
      socket.addEventListener("close", () => {
        if (token && !conflict) setStatus("手机连接已断开。");
      });
      socket.addEventListener("error", () => setStatus("实时连接失败，请检查同一 ComfyUI 地址是否可访问。"));
    } catch (error) {
      token = "";
      setStatus("配对码生成失败：" + error.message);
    }
  });

  const normalizeMobileState = value => value;
  ui.root.addEventListener("DOMNodeRemoved", event => {
    if (event.target === ui.root) {
      clearTimeout(pendingTimer);
      socket?.close();
    }
  }, { once: true });
}
