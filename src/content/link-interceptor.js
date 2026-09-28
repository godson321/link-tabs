"use strict";

let currentSettings;

function isSameDocumentFragment(target, anchor) {
  const href = anchor.getAttribute("href");
  const fragmentOnly = href !== null && href.trimStart().startsWith("#");
  return (Boolean(target.hash) || fragmentOnly) &&
    target.origin === location.origin &&
    target.pathname === location.pathname &&
    target.search === location.search;
}

/** 解析可拦截的链接目标；不满足拦截条件（下载、可编辑区域、非 HTTP(S)、同文档片段）时返回 null。 */
function resolveLinkTarget(anchor) {
  if (
    !anchor ||
    anchor.hasAttribute("download") ||
    anchor.isContentEditable ||
    document.designMode === "on"
  ) return null;

  let target;
  try {
    target = new URL(anchor.href, location.href);
  } catch {
    return null;
  }

  if (
    !["http:", "https:"].includes(target.protocol) ||
    isSameDocumentFragment(target, anchor)
  ) return null;
  return target;
}

/** 计算应执行的动作；规则计算异常时返回 null 并记录诊断，保持浏览器原生行为。 */
function resolveActionDiagnosed(url) {
  try {
    return LinkTabsRules.resolveAction(url, currentSettings);
  } catch (error) {
    console.error("Link Tabs:", error);
    return null;
  }
}

/** 请求 Service worker 按动作打开链接；失败时仅记录诊断，不改写动作。 */
function requestOpenLinkTab(url, action) {
  chrome.runtime.sendMessage({
    type: "OPEN_LINK_TAB",
    url,
    action
  })
    .then(response => {
      if (!response?.ok) console.error("Link Tabs:", response?.error);
    })
    .catch(error => console.error("Link Tabs:", error));
}

LinkTabsSettings.load()
  .then(settings => {
    currentSettings = settings;
  })
  .catch(error => {
    console.error("Link Tabs:", error);
  });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  currentSettings = LinkTabsRules.normalizeSettings(changes.settings.newValue);
});

document.addEventListener("click", event => {
  // 网站已在捕获阶段取消这次点击时，不再额外打开标签页。
  if (event.defaultPrevented) return;
  if (currentSettings === undefined) return;
  if (
    event.button !== 0 ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    event.metaKey
  ) return;

  const anchor = event.target instanceof Element
    ? event.target.closest("a[href]")
    : null;
  const target = resolveLinkTarget(anchor);
  if (target === null) return;

  const action = resolveActionDiagnosed(target.href);
  if (action === null || action === "native") return;

  event.preventDefault();
  event.stopImmediatePropagation();
  requestOpenLinkTab(target.href, action);
}, true);

// —— 拖拽开链接：按住左键把链接拖到页面空白处松手，效果与点击该链接一致。 ——
let draggedLink = null;        // 已武装的拖拽目标 { href }
let dragDropHandled = false;   // 页面内的放置区已接收本次拖放
let dragCancelled = false;     // 拖拽中窗口失焦（拖拽被系统取消）
let lastDragOverFrame = false; // 最近一次拖拽悬停的目标是内嵌框架

document.addEventListener("dragstart", event => {
  draggedLink = null;
  dragDropHandled = false;
  dragCancelled = false;
  lastDragOverFrame = false;
  if (currentSettings === undefined) return;

  const source = event.target instanceof Element ? event.target : null;
  const anchor = source === null ? null : source.closest("a[href]");
  const armed = LinkTabsDrag.shouldArmDrag({
    trusted: event.isTrusted,
    // 拖动链接里的图片时，用户拖的是图片而不是链接。
    sourceIsLink: anchor !== null && !(source instanceof HTMLImageElement),
    dragTypes: Array.from(event.dataTransfer?.types ?? []),
    modifierPressed: event.ctrlKey || event.shiftKey || event.altKey || event.metaKey
  });
  if (!armed) return;

  const target = resolveLinkTarget(anchor);
  if (target === null) return;
  draggedLink = { href: target.href };
}, true);

const trackDragTarget = event => {
  if (draggedLink === null) return;
  lastDragOverFrame = event.target instanceof HTMLIFrameElement;
};
document.addEventListener("dragenter", trackDragTarget, true);
document.addEventListener("dragover", trackDragTarget, true);

document.addEventListener("drop", () => {
  // 页面内的放置区（编辑器、上传框等）接收了这次拖放，保持原生。
  if (draggedLink !== null) dragDropHandled = true;
}, true);

window.addEventListener("blur", () => {
  if (draggedLink !== null) dragCancelled = true;
});

document.addEventListener("dragend", event => {
  const link = draggedLink;
  draggedLink = null;
  if (link === null) return;

  const open = LinkTabsDrag.shouldOpenOnRelease({
    dropHandled: dragDropHandled,
    cancelled: dragCancelled,
    endedOverFrame: lastDragOverFrame,
    endTrusted: event.isTrusted,
    clientX: event.clientX,
    clientY: event.clientY
  }, window.innerWidth, window.innerHeight);
  if (!open || currentSettings === undefined) return;

  const action = resolveActionDiagnosed(link.href);
  if (action === null || action === "native") return;
  requestOpenLinkTab(link.href, action);
}, true);
