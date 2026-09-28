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

/** 计算某块功能应执行的动作；规则计算异常时返回 null 并记录诊断，保持浏览器原生行为。 */
function resolveActionDiagnosed(url, use) {
  try {
    return LinkTabsRules.resolveAction(url, currentSettings, use);
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

  const action = resolveActionDiagnosed(target.href, "click");
  if (action === null || action === "native") return;

  event.preventDefault();
  event.stopImmediatePropagation();
  requestOpenLinkTab(target.href, action);
}, true);

// —— 拖拽开链接 / 拖动文字搜索：按住左键拖到页面空白处松手，效果与点击链接或直接搜索一致。 ——
let draggedTarget = null;      // 已武装的拖拽目标：{ kind: "link", href } 或 { kind: "search", text }
let dragDropHandled = false;   // 页面内的放置区已接收本次拖放
let dragCancelled = false;     // 拖拽中窗口失焦（拖拽被系统取消）
let lastDragOverFrame = false; // 最近一次拖拽悬停的目标是内嵌框架

document.addEventListener("dragstart", event => {
  draggedTarget = null;
  dragDropHandled = false;
  dragCancelled = false;
  lastDragOverFrame = false;
  if (currentSettings === undefined) return;

  const source = event.target instanceof Element ? event.target : null;
  const dragTypes = Array.from(event.dataTransfer?.types ?? []);
  const modifierPressed = event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;

  // 选中文字的拖拽优先判定：选择拖拽不带 text/uri-list，且拖动源必须落在选区里，
  // 因此拖动未选中的链接不会走进这个分支。
  const selection = window.getSelection();
  const selectionText = selection === null ? "" : LinkTabsDrag.normalizeSelectionText(selection.toString());
  const searchArmed = LinkTabsDrag.shouldArmSearchDrag({
    trusted: event.isTrusted,
    sourceIsSearchable: selectionText !== "" &&
      source !== null &&
      !(source instanceof HTMLImageElement) &&
      !(source.isContentEditable || source.closest("input, textarea") !== null) &&
      document.designMode !== "on" &&
      selection.containsNode(source, true),
    dragTypes,
    modifierPressed
  });
  if (searchArmed) {
    draggedTarget = { kind: "search", text: selectionText };
    return;
  }

  const anchor = source === null ? null : source.closest("a[href]");
  const linkArmed = LinkTabsDrag.shouldArmDrag({
    trusted: event.isTrusted,
    // 拖动链接里的图片时，用户拖的是图片而不是链接。
    sourceIsLink: anchor !== null && !(source instanceof HTMLImageElement),
    dragTypes,
    modifierPressed
  });
  if (!linkArmed) return;

  const target = resolveLinkTarget(anchor);
  if (target === null) return;
  draggedTarget = { kind: "link", href: target.href };
}, true);

const trackDragTarget = event => {
  if (draggedTarget === null) return;
  lastDragOverFrame = event.target instanceof HTMLIFrameElement;
};
document.addEventListener("dragenter", trackDragTarget, true);
document.addEventListener("dragover", trackDragTarget, true);

document.addEventListener("drop", () => {
  // 页面内的放置区（编辑器、上传框等）接收了这次拖放，保持原生。
  if (draggedTarget !== null) dragDropHandled = true;
}, true);

window.addEventListener("blur", () => {
  if (draggedTarget !== null) dragCancelled = true;
});

document.addEventListener("dragend", event => {
  const dragged = draggedTarget;
  draggedTarget = null;
  if (dragged === null) return;

  const open = LinkTabsDrag.shouldOpenOnRelease({
    dropHandled: dragDropHandled,
    cancelled: dragCancelled,
    endedOverFrame: lastDragOverFrame,
    endTrusted: event.isTrusted,
    clientX: event.clientX,
    clientY: event.clientY
  }, window.innerWidth, window.innerHeight);
  if (!open || currentSettings === undefined) return;

  // 链接拖动按链接目标匹配规则；文字搜索没有链接目标，按当前所在页面匹配规则
  // （内嵌框架中按框架自身地址匹配，与本框架内链接的解析口径保持一致）。
  const action = resolveActionDiagnosed(
    dragged.kind === "link" ? dragged.href : location.href,
    dragged.kind === "link" ? "drag" : "search"
  );
  if (action === null || action === "native") return;

  const url = dragged.kind === "link"
    ? dragged.href
    : LinkTabsRules.buildSearchUrl(dragged.text, currentSettings);
  requestOpenLinkTab(url, action);
}, true);
