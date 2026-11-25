import { createWindows, setWindowContributionDuration, applyGlobalOverlapFrames } from "../segment_windows.mjs";

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
const gettingStarted = document.querySelector("#getting-started");
const footerNote = document.querySelector("#mobile-footer-note");
const API_ROOT = "/minimax_h3_timeline/mobile";
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;
const UPLOAD_SUBFOLDER = "minimax_h3_timeline_director";

let sessionToken = "";
let currentState = null;
let revision = 0;
let socket = null;
let activePanel = "segments";
let activeSegment = 0;
let selectedVideoId = "";
let mobilePlayhead = 0;
let videoDrag = null;
const previewProxyRequests = new Set();
let saveTimer = 0;
let saveInFlight = false;
let dirty = false;
let conflict = false;
let nodeUuid = "";

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
  saveInFlight = true;
  dirty = false;
  try {
    const response = await fetch(API_ROOT + "/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken },
      body: JSON.stringify({ expected_revision: revision, state: currentState }),
    });
    const payload = await response.json();
    if (response.status === 409) {
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
    dirty = true;
    setSyncStatus("同步失败：" + error.message);
  } finally {
    saveInFlight = false;
    if (dirty && !conflict) saveTimer = setTimeout(saveState, 700);
  }
}

function receiveRemote(message) {
  const nextRevision = Number(message.revision) || 0;
  if (nextRevision <= revision) return;
  // The relay broadcasts writes to every socket, including the writer. Treat
  // our own in-flight save echo as an acknowledgement, not a concurrent edit.
  if (saveInFlight && JSON.stringify(message.state) === JSON.stringify(currentState)) {
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
      activeSegment = Number(currentState.segmentConfig?.activeIndex) || 0;
      nodeUuid = message.node_uuid || nodeUuid;
      conflict = false;
      dirty = false;
      setConnected(true, "已连接到电脑端。手机编辑会实时同步回对应导演台。");
      setSyncStatus("已连接 · 版本 " + revision);
      feedback("连接成功，手机端编辑已启用。", "success");
    } else if (message.type === "state") {
      receiveRemote(message);
    } else if (message.type === "paired") {
      feedback("配对成功，正在建立实时同步。", "success");
    }
  });
  socket.addEventListener("close", () => {
    if (sessionToken) {
      setConnected(false);
      setSyncStatus("连接已断开");
      feedback("连接已断开。请检查网络，或重新配对。", "error");
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
    nodeUuid = payload.node_uuid || "";
    activeSegment = Number(currentState.segmentConfig?.activeIndex) || 0;
    sessionStorage.setItem("m3td-mobile-token", sessionToken);
    sessionStorage.setItem("m3td-mobile-node", nodeUuid);
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
    nodeUuid = payload.node_uuid || sessionStorage.getItem("m3td-mobile-node") || "";
    activeSegment = Number(currentState.segmentConfig?.activeIndex) || 0;
    connectEvents(sessionToken);
  } catch {
    sessionStorage.removeItem("m3td-mobile-token");
    sessionStorage.removeItem("m3td-mobile-node");
    setConnected(false);
  }
}

function renderPanel() {
  if (!currentState || !editorContent) return;
  document.querySelectorAll(".bottom-nav [data-panel]").forEach(button => button.classList.toggle("active", button.dataset.panel === activePanel));
  const titles = { segments:"分段编辑", assets:"素材管理", groups:"分组管理", settings:"连接设置" };
  editorHeading.textContent = titles[activePanel] || "移动导演台";
  if (activePanel === "segments") renderSegmentsPanel();
  else if (activePanel === "assets") renderAssetsPanel();
  else if (activePanel === "groups") renderGroupsPanel();
  else renderSettingsPanel();
}

function renderSegmentPicker() {
  return `<div class="mobile-segment-picker">${segments().map((segment,index)=>`
    <button type="button" class="mobile-segment-chip ${index===activeSegment?"active":""} ${segment.enabled===false?"disabled":""}" data-select-mobile-segment="${index}">
      <strong>${escapeHTML(segmentLabel(segment,index))}</strong><small>${segment.enabled===false?"已禁用":(segment.endFrame-segment.startFrame)/24+" 秒"}</small>
    </button>`).join("")}</div>`;
}

function renderSegmentsPanel() {
  const segment = selectedSegment();
  if (!segment) { editorContent.innerHTML = '<p class="mobile-empty">当前没有可编辑的分段。</p>'; return; }
  const groupOptions = ['<option value="">未分组</option>', ...groups().map(group=>`<option value="${escapeHTML(group.id)}" ${segment.groupId===group.id?"selected":""}>${escapeHTML(group.name)}</option>`)].join("");
  const duration = Math.max(5/24, (segment.endFrame-segment.startFrame)/24);
  editorContent.innerHTML = `
    ${renderSegmentPicker()}
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
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>分段属性</h3><span>第 ${activeSegment+1} / ${segments().length} 段</span></div>
      <label class="mobile-field">分段名称<input id="segment-name" maxlength="40" value="${escapeHTML(segment.name||"第 "+(activeSegment+1)+" 段")}"></label>
      <div class="mobile-field-row">
        <label class="mobile-field">目标时长（秒）<input id="segment-duration" type="number" min="0.21" step="0.04" value="${duration.toFixed(2)}"></label>
        <label class="mobile-field">所属分组<select id="segment-group">${groupOptions}</select></label>
      </div>
      <label class="mobile-switch"><input id="segment-enabled" type="checkbox" ${segment.enabled===false?"":"checked"}><span>启用此分段</span></label>
      <p class="mobile-hint">时长调整沿用电脑端相同的 H3 帧对齐与后续分段联动算法。</p>
    </section>
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>本段提示词</h3><span>直接写入原始数据</span></div>
      <textarea id="segment-prompt" class="mobile-prompt" rows="8" placeholder="输入本段的 H3 提示词…">${escapeHTML(segment.prompt||"")}</textarea>
    </section>
    <section class="mobile-card">
      <div class="mobile-card-heading"><h3>本段素材引用</h3><span>图片最多 9 个 · 音频最多 3 个</span></div>
      <p class="mobile-hint">图片：${segment.images.length} 个　音频：${segment.audios.length} 个</p>
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
  editorContent.querySelector("[data-open-assets]").addEventListener("click",()=>{
    activePanel="assets";renderPanel();
  });
}

function renderVideoTimeline() {
  const list=[...videos()].sort((a,b)=>Number(a.start||0)-Number(b.start||0));
  const end=Math.max(12,...list.map(clip=>Number(clip.start||0)+Number(clip.duration||0)+1));
  const scale=44;
  const selected=list.find(clip=>String(clip.id)===String(selectedVideoId))||list[0]||null;
  selectedVideoId=selected?.id||"";
  mobilePlayhead=Math.max(0,Math.min(mobilePlayhead,end));
  const ruler=Array.from({length:Math.ceil(end/5)+1},(_,i)=>i*5).filter(t=>t<=end).map(t=>'<span style="left:'+(t*scale)+'px">'+t.toFixed(0)+'s</span>').join("");
  const clips=list.map((clip,index)=>'<div class="mobile-timeline-clip '+(String(clip.id)===String(selectedVideoId)?"selected":"")+'" data-video-clip="'+escapeHTML(clip.id)+'" style="left:'+(Number(clip.start||0)*scale)+'px;width:'+Math.max(28,Number(clip.duration||0)*scale)+'px"><button type="button" class="mobile-timeline-handle left" data-video-edge="left" aria-label="调整片段起点"></button><strong>'+escapeHTML(clip.name||"视频 "+(index+1))+'</strong><small>'+Number(clip.duration||0).toFixed(2)+'s</small><button type="button" class="mobile-timeline-handle right" data-video-edge="right" aria-label="调整片段终点"></button></div>').join("");
  const preview=selected?'<div class="mobile-video-preview"><strong>'+escapeHTML(selected.name||"参考视频预览")+'</strong><video controls playsinline preload="metadata" src="'+escapeHTML(mediaURL(selected.file))+'"></video></div>':"";
  return '<section class="mobile-card mobile-timeline-card"><div class="mobile-card-heading"><h3>视频时间轴</h3><span>拖动片段或两侧边缘调整</span></div>'+(list.length?'<div class="mobile-timeline-scroll"><div class="mobile-timeline-track" style="width:'+Math.max(100,end*scale)+'px"><div class="mobile-timeline-ruler">'+ruler+'</div>'+clips+'<i class="mobile-timeline-playhead" style="left:'+(mobilePlayhead*scale)+'px"></i></div></div><label class="mobile-field mobile-playhead-control">播放位置 · '+mobilePlayhead.toFixed(2)+' 秒<input id="video-playhead" type="range" min="0" max="'+end+'" step="0.0416667" value="'+mobilePlayhead+'"></label><div class="mobile-timeline-actions"><button type="button" class="mobile-secondary" id="split-video" '+(selected?"":"disabled")+'>在播放位置分割</button><button type="button" class="mobile-danger" id="delete-selected-video" '+(selected?"":"disabled")+'>删除选中片段</button></div>'+preview:'<p class="mobile-empty">上传参考视频后，这里会显示可拖动的视频时间轴。</p>')+'</section>';
}

async function loadMobilePreview(clip, video) {
  if(!clip||!video)return;
  if(clip.proxy){video.src=mediaURL(clip.proxy);return;}
  if(previewProxyRequests.has(String(clip.id)))return;
  previewProxyRequests.add(String(clip.id));
  try{
    const response=await fetch("/minimax_h3_timeline/preview_proxy",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({filename:clip.file})
    });
    const payload=await response.json();
    if(!response.ok||payload.error)throw new Error(payload.error||("HTTP "+response.status));
    clip.proxy=payload.proxy;
    if(video.isConnected)video.src=mediaURL(clip.proxy);
    scheduleSave();
  }catch(error){
    if(video.isConnected)video.insertAdjacentHTML("afterend",'<p class="mobile-hint">预览代理生成失败：'+escapeHTML(error.message)+'</p>');
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
      ${videos().map((clip,index)=>`<article class="mobile-asset-card video-card"><video src="${escapeHTML(mediaURL(clip.file))}" muted playsinline preload="metadata"></video><div class="mobile-asset-info"><strong>${escapeHTML(clip.name||"参考视频 "+(index+1))}</strong><small>${Number(clip.duration||0).toFixed(2)} 秒 · ${clip.hasAudio?"含音轨":"无音轨"}</small><label>开始位置<input type="number" step="0.04" min="0" data-video-start="${escapeHTML(clip.id)}" value="${Number(clip.start||0).toFixed(2)}"></label><label>使用时长<input type="number" step="0.04" min="0.21" data-video-duration="${escapeHTML(clip.id)}" value="${Number(clip.duration||0).toFixed(2)}"></label><select data-video-mode="${escapeHTML(clip.id)}"><option value="guide" ${clip.referenceMode==="guide"?"selected":""}>完整参考</option><option value="edit" ${clip.referenceMode==="edit"?"selected":""}>普通参考视频</option><option value="boundary" ${clip.referenceMode==="boundary"?"selected":""}>边界参考</option></select></div><button type="button" class="mobile-icon-button" data-delete-video="${escapeHTML(clip.id)}" aria-label="删除视频">×</button></article>`).join("")||'<p class="mobile-empty">还没有参考视频。</p>'}
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
  const previewClip=videos().find(item=>String(item.id)===String(selectedVideoId));
  const previewElement=editorContent.querySelector(".mobile-video-preview video");
  loadMobilePreview(previewClip,previewElement);
  if(previewClip&&previewElement){
    previewElement.addEventListener("loadedmetadata",()=>{
      const offset=Math.max(0,Math.min(Number(previewClip.duration||0),mobilePlayhead-Number(previewClip.start||0)));
      try{previewElement.currentTime=Math.min(previewElement.duration-.01,Number(previewClip.trimStart||0)+offset);}catch{}
    });
    previewElement.addEventListener("timeupdate",()=>{
      mobilePlayhead=Number(previewClip.start||0)+previewElement.currentTime-Number(previewClip.trimStart||0);
      const slider=editorContent.querySelector("#video-playhead");
      if(slider)slider.value=String(mobilePlayhead);
      const marker=editorContent.querySelector(".mobile-timeline-playhead");
      if(marker)marker.style.left=(mobilePlayhead*44)+"px";
      const label=editorContent.querySelector(".mobile-playhead-control");
      if(label)label.firstChild.textContent="播放位置 · "+mobilePlayhead.toFixed(2)+" 秒";
    });
  }
  const playheadInput=editorContent.querySelector("#video-playhead");
  playheadInput?.addEventListener("input",event=>{
    mobilePlayhead=Number(event.target.value)||0;
    const marker=editorContent.querySelector(".mobile-timeline-playhead");
    if(marker)marker.style.left=(mobilePlayhead*44)+"px";
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
    const delta=Math.round(((event.clientX-videoDrag.startX)/44)*24)/24;
    if(edge==="move"){
      clip.start=Math.max(0,start+delta);
      const others=videos().filter(item=>item.id!==clip.id);
      const candidates=others.flatMap(item=>[Number(item.start||0),Number(item.start||0)+Number(item.duration||0)]);
      const nearest=candidates.reduce((best,value)=>Math.abs(value-clip.start)<Math.abs(best-clip.start)?value:best,clip.start);
      if(Math.abs(nearest-clip.start)<=0.12)clip.start=Math.max(0,nearest);
    }else if(edge==="left"){
      const end=start+duration,nextStart=Math.max(0,Math.min(end-5/24,start+delta)),applied=nextStart-start;
      clip.start=nextStart;clip.duration=end-nextStart;
      clip.trimStart=Math.max(0,Math.min(trimStart+duration-5/24,trimStart+applied));
    }else{
      const available=Math.max(5/24,Number(clip.sourceDuration||duration)-trimStart);
      clip.duration=Math.max(5/24,Math.min(available,duration+delta));
    }
    const bar=editorContent.querySelector('[data-video-clip="'+CSS.escape(String(clip.id))+'"]');
    if(bar){bar.style.left=(clip.start*44)+"px";bar.style.width=Math.max(28,clip.duration*44)+"px";}
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
    const target=index+(button.dataset.direction==="up"?-1:1);
    if(index<0||target<0||target>=list.length||list[target].group!==list[index].group)return;
    [list[index],list[target]]=[list[target],list[index]];scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-move-audio]").forEach(button=>button.addEventListener("click",()=>{
    const list=currentState.audios||[],index=list.findIndex(item=>String(item.id)===button.dataset.moveAudio);
    const target=index+(button.dataset.direction==="up"?-1:1);
    if(index<0||target<0||target>=list.length||(list[target].audioGroup||"ref")!==(list[index].audioGroup||"ref"))return;
    [list[index],list[target]]=[list[target],list[index]];scheduleSave();renderPanel();
  }));
  editorContent.querySelectorAll("[data-image-category]").forEach(select=>select.addEventListener("change",()=>{
    const asset=images().find(item=>String(item.id)===select.dataset.imageCategory);if(asset)asset.group=select.value;scheduleSave();
  }));
  editorContent.querySelectorAll("[data-audio-category]").forEach(select=>select.addEventListener("change",()=>{
    const asset=audios().find(item=>String(item.id)===select.dataset.audioCategory);if(asset)asset.audioGroup=select.value;scheduleSave();
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
  if(file.size<=0 || file.size>MAX_UPLOAD_BYTES){feedback(file.size>MAX_UPLOAD_BYTES?"文件超过 512 MB 限制。":"文件为空。","error");return;}
  const serverName=Date.now()+"_"+Math.random().toString(36).slice(2,7)+"_"+file.name.replace(/[^\w.()\-\u4e00-\u9fff]+/gu,"_");
  const data=new FormData();
  data.append("image",file,serverName);data.append("type","input");data.append("subfolder",UPLOAD_SUBFOLDER);
  setSyncStatus("正在上传 "+file.name+"…");
  try{
    const upload=await fetch("/upload/image",{method:"POST",body:data});
    const uploaded=await upload.json();
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
    if(!infoResponse.ok||info.error)throw new Error(info.error||"媒体检查失败");
    if(kind==="image"){
      currentState.images.push({id:uid(),file:info.filename,name:file.name,width:info.width||0,height:info.height||0,group:category});
      const first=segments().length===1?segments()[0]:null;
      if(first && first.images.length<9)first.images.push(currentState.images.at(-1).id);
    }else if(kind==="video"){
      if(!info.hasVideo)throw new Error("视频文件中没有可用画面轨道");
      const start=videos().reduce((max,clip)=>Math.max(max,Number(clip.start||0)+Number(clip.duration||0)),0);
      currentState.videoClips.push({id:uid(),file:info.filename,name:file.name,start,duration:Math.max(5/24,Number(info.duration)||5),trimStart:0,sourceDuration:Number(info.duration)||5,hasAudio:!!info.hasAudio,referenceMode:"edit",referenceWidth:Number(info.width)||832,referenceHeight:Number(info.height)||480,peaks:[],proxy:""});
    }else{
      if(!info.hasAudio)throw new Error("文件中没有可用音轨");
      currentState.audios.push({id:uid(),file:info.filename,name:file.name,duration:info.duration||0,trimStart:0,audioMode:"reference",audioGroup:category});
      const first=segments().length===1?segments()[0]:null;
      if(first && first.audios.length<3)first.audios.push(currentState.audios.at(-1).id);
    }
    scheduleSave();setSyncStatus("上传完成，等待同步…");
  }catch(error){feedback("上传失败："+error.message,"error");setSyncStatus("上传失败");}
}

function renderGroupsPanel() {
  const rows=groups().map(group=>{
    const members=segments().map((segment,index)=>({segment,index})).filter(item=>item.segment.groupId===group.id);
    return `<section class="mobile-card">
      <div class="mobile-card-heading"><h3>${escapeHTML(group.name)}</h3><span>${members.length} 个分段</span></div>
      <label class="mobile-field">分组名称<input data-group-name="${escapeHTML(group.id)}" maxlength="40" value="${escapeHTML(group.name)}"></label>
      <div class="mobile-group-members">${segments().map((segment,index)=>`
        <label><input type="checkbox" data-group-member="${index}" data-group-id="${escapeHTML(group.id)}" ${segment.groupId===group.id?"checked":""}>${escapeHTML(segmentLabel(segment,index))}</label>`).join("")}</div>
      <button type="button" class="mobile-danger" data-dissolve-group="${escapeHTML(group.id)}">解散分组</button>
    </section>`;
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
    scheduleSave();
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
  editorContent.querySelector("#disconnect-mobile").addEventListener("click",()=>{
    clearTimeout(saveTimer);socket?.close();sessionStorage.removeItem("m3td-mobile-token");sessionStorage.removeItem("m3td-mobile-node");
    sessionToken="";currentState=null;revision=0;setConnected(false);feedback("手机端已断开。","success");
  });
}

document.querySelector("#scan-help")?.addEventListener("click",()=>{helpDialog.hidden=false;});
document.querySelector("#close-dialog")?.addEventListener("click",()=>{helpDialog.hidden=true;});
document.querySelector("#confirm-dialog")?.addEventListener("click",()=>{helpDialog.hidden=true;});
document.querySelector("#refresh-page")?.addEventListener("click",()=>window.location.reload());
document.querySelector("#desktop-mode")?.addEventListener("click",()=>{window.location.href="/";});
pairButton?.addEventListener("click",claimPairingCode);
pairInput?.addEventListener("keydown",event=>{if(event.key==="Enter")claimPairingCode();});
pairInput?.addEventListener("input",()=>{pairInput.value=pairInput.value.toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,8);});
document.querySelectorAll(".bottom-nav [data-panel]").forEach(button=>button.addEventListener("click",()=>{
  activePanel=button.dataset.panel;renderPanel();
}));
helpDialog?.addEventListener("click",event=>{if(event.target===helpDialog)helpDialog.hidden=true;});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&helpDialog&&!helpDialog.hidden)helpDialog.hidden=true;});

const pairingHash=new URLSearchParams(window.location.hash.slice(1));
const scannedCode=pairingHash.get("pair");
if(scannedCode&&pairInput){
  pairInput.value=scannedCode.toUpperCase().replace(/[^A-Z2-9]/g,"").slice(0,8);
  history.replaceState(null,"",window.location.pathname+window.location.search);
  claimPairingCode();
}else restoreSession();
