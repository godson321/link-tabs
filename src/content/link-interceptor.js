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

/** 判断选区是否完整覆盖某个链接内容；边界比较也支持链接内部的嵌套元素。 */
function isCompleteAnchorSelection(selection, anchor) {
  if (selection === null || anchor === null || selection.rangeCount !== 1) return false;

  try {
    const selectedRange = selection.getRangeAt(0);
    const anchorRange = document.createRange();
    anchorRange.selectNodeContents(anchor);
    return selectedRange.compareBoundaryPoints(Range.START_TO_START, anchorRange) === 0 &&
      selectedRange.compareBoundaryPoints(Range.END_TO_END, anchorRange) === 0;
  } catch {
    return false;
  }
}

/** 解析选区中的完整 HTTP(S) 地址；含其他空白或不支持协议时保持原生搜索行为。 */
function resolveSelectedHttpUrl(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (value === "" || /\s/.test(value)) return null;

  try {
    const target = new URL(value);
    return ["http:", "https:"].includes(target.protocol) ? target : null;
  } catch {
    return null;
  }
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

/** 扩展上下文是否仍有效（扩展被重新加载后，旧页面中的内容脚本会失效）。 */
function isExtensionAlive() {
  return Boolean(chrome.runtime?.id);
}

/** 请求 Service worker 按动作打开链接；失败时仅记录诊断，不改写动作。 */
function requestOpenLinkTab(url, action) {
  try {
    chrome.runtime.sendMessage({
      type: "OPEN_LINK_TAB",
      url,
      action
    })
      .then(response => {
        if (!response?.ok) console.error("Link Tabs:", response?.error);
      })
      .catch(error => console.error("Link Tabs:", error));
  } catch (error) {
    // 扩展恰在发送瞬间被重新加载：保持原生行为，仅记录诊断。
    console.error("Link Tabs:", error);
  }
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
  if (!isExtensionAlive()) {
    // 扩展已重新加载：不吞这次点击，保持浏览器原生导航，提示刷新页面。
    console.error("Link Tabs: 扩展上下文已失效，已保持原生行为；刷新页面后恢复。");
    return;
  }

  event.preventDefault();
  event.stopImmediatePropagation();
  requestOpenLinkTab(target.href, action);
}, true);

// —— 拖拽开链接 / 拖动文字搜索：按住左键拖到页面空白处松手，效果与点击链接或直接搜索一致。 ——
let draggedTarget = null;      // 已武装的拖拽目标：{ kind: "link", href } 或 { kind: "search", text }
let dragDropHandled = false;   // 页面内的放置区已接收本次拖放
let dragCancelled = false;     // 拖拽中窗口失焦（拖拽被系统取消）
let dragOverClaim = null;      // 扩展为哪个元素声明了“接受拖放”（只有扩展认领的位置才有值）

/** 悬停/落点是否由浏览器原生接收拖放（文本输入框、可编辑区域；含 shadow DOM 内部）。 */
function findNativeDropTarget(event) {
  const path = typeof event.composedPath === "function" ? event.composedPath() : [];
  for (const node of path) {
    if (node instanceof Element &&
      (node.isContentEditable || node.tagName === "INPUT" || node.tagName === "TEXTAREA")) {
      return node;
    }
  }
  const target = event.target instanceof Element ? event.target : null;
  if (target !== null && (target.isContentEditable || target.closest("input, textarea") !== null)) {
    return target;
  }
  return null;
}

/** 松手点是否落在内嵌框架上（父文档收不到框架内部的拖拽事件，只能按坐标判断）。 */
function endedOverFrame(event) {
  try {
    return document.elementFromPoint(event.clientX, event.clientY) instanceof HTMLIFrameElement;
  } catch {
    return false;
  }
}

document.addEventListener("dragstart", event => {
  draggedTarget = null;
  dragDropHandled = false;
  dragCancelled = false;
  dragOverClaim = null;
  if (currentSettings === undefined) return;

  // 选区拖拽时 dragstart 的目标可能是文本节点而非元素，向上取到其所属元素；
  // 否则 Element 判断会把所有“拖动选中文字”的拖拽都挡掉。
  const source = event.target instanceof Element
    ? event.target
    : (event.target?.parentElement ?? null);
  const dragTypes = Array.from(event.dataTransfer?.types ?? []);
  const modifierPressed = event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;
  const selection = window.getSelection();
  const rawSelectionText = selection === null ? "" : selection.toString();
  const selectionText = LinkTabsDrag.normalizeSelectionText(rawSelectionText);
  const anchor = source === null ? null : source.closest("a[href]");

  // 选中文字的拖拽优先判定：选择拖拽不带 text/uri-list，且拖动源必须落在选区里，
  // 因此拖动未选中的链接不会走进这个分支。
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
  const linkArmed = LinkTabsDrag.shouldArmDrag({
    trusted: event.isTrusted,
    // 拖动链接里的图片时，用户拖的是图片而不是链接。
    sourceIsLink: anchor !== null && !(source instanceof HTMLImageElement),
    dragTypes,
    modifierPressed
  });

  if (searchArmed) {
    const completeAnchor = isCompleteAnchorSelection(selection, anchor);
    const target = completeAnchor
      ? resolveLinkTarget(anchor)
      : resolveSelectedHttpUrl(rawSelectionText);

    if (target !== null) {
      draggedTarget = { kind: "link", href: target.href };
      return;
    }

    draggedTarget = { kind: "search", text: selectionText };
    return;
  }
  if (!linkArmed) return;

  const target = resolveLinkTarget(anchor);
  if (target === null) return;
  draggedTarget = { kind: "link", href: target.href };
}, true);

// 拖拽悬停：网站自己接管了拖放、或悬停在浏览器原生放置区（输入框、编辑器）时保持原生；
// 其余位置由扩展声明“接受拖放”。浏览器只在有目标接受拖放时才不画禁止光标，
// 所以拖动链接/文字经过页面空白处时，光标由禁止符号变成可放置样式。
// 监听挂在 window 冒泡阶段：此时网站的 dragover 处理器都已执行，
// defaultPrevented 能如实反映“网站是否已经接管”。
window.addEventListener("dragover", event => {
  if (draggedTarget === null) return;
  const target = event.target instanceof Element ? event.target : null;
  const effect = LinkTabsDrag.pickDragOverEffect({
    armed: true,
    defaultPrevented: event.defaultPrevented,
    nativeDropTarget: findNativeDropTarget(event) !== null,
    effectAllowed: event.dataTransfer?.effectAllowed
  });
  // 只有扩展认领的位置才留下标记；落点与标记不符，说明这次拖放不是扩展接下的。
  dragOverClaim = effect === null ? null : target;
  if (effect === null) return;

  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = effect;
});

// 拖放落地：只有扩展认领的那一次（页面空白处）才取消浏览器默认动作（防导航），
// 是否开新标签页交给 dragend 决定；其余情况（网站放置区、浏览器原生输入框/编辑器）
// 一律保持原生行为，包括把文本原生插入输入框。
// 归属按“落点是不是扩展认领的那个元素”判断，而不是“扩展有没有看见过 dragover”：
// 网站用 stopPropagation 接管 dragover 时扩展根本收不到事件，按后者会把网站放置区误判成空白处。
// 只认完全相同的元素、不做祖先/后代包含判断：认领元素往往是 body/html 这类容器，
// 它们包含页面里几乎所有放置区，按包含判断会把网站放置区误认成空白处。
// 指针只要移动过，浏览器就会派发新的 dragover 刷新认领，因此合法落地必然与认领元素相同。
document.addEventListener("drop", event => {
  if (draggedTarget === null) return;
  const target = event.target instanceof Element ? event.target : null;
  if (dragOverClaim === null || dragOverClaim !== target || findNativeDropTarget(event) !== null) {
    dragDropHandled = true;
    return;
  }
  event.preventDefault();
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
    endedOverFrame: endedOverFrame(event),
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
  if (!isExtensionAlive()) {
    // 扩展已重新加载：保持原生行为，提示刷新页面。
    console.error("Link Tabs: 扩展上下文已失效，已保持原生行为；刷新页面后恢复。");
    return;
  }

  const url = dragged.kind === "link"
    ? dragged.href
    : LinkTabsRules.buildSearchUrl(dragged.text, currentSettings);
  requestOpenLinkTab(url, action);
}, true);
