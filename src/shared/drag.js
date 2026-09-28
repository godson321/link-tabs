"use strict";

/** 拖拽开链接的判定逻辑：由内容脚本与自动化测试共用，保持无 DOM 依赖。 */

/**
 * 判断一次 dragstart 是否武装“拖拽开链接”。
 * 条件：用户真实拖拽、拖拽源属于某个链接（且不是链接里的图片）、
 * 原生链接拖拽携带 text/uri-list、未按任何修饰键。
 */
function shouldArmDrag({ trusted, sourceIsLink, dragTypes, modifierPressed }) {
  return trusted === true &&
    sourceIsLink === true &&
    Array.isArray(dragTypes) &&
    dragTypes.includes("text/uri-list") &&
    modifierPressed !== true;
}

/**
 * 判断一次 dragstart 是否武装“拖动选中文字去搜索”。
 * 条件：用户真实拖拽、选中内容可搜索（非空、来源不在输入框/编辑器内、
 * 且拖动源落在选区里）、携带 text/plain、未按任何修饰键。
 */
function shouldArmSearchDrag({ trusted, sourceIsSearchable, dragTypes, modifierPressed }) {
  return trusted === true &&
    sourceIsSearchable === true &&
    Array.isArray(dragTypes) &&
    dragTypes.includes("text/plain") &&
    modifierPressed !== true;
}

/** 搜索文本上限：足够覆盖正常选段，又不会产生超长网址。 */
const SELECTION_TEXT_LIMIT = 500;

/** 修剪选中的文本并按码点截取上限；截断不拆开代理对（emoji 等），避免编码时抛错。 */
function normalizeSelectionText(text) {
  return Array.from(text.trim()).slice(0, SELECTION_TEXT_LIMIT).join("");
}

/**
 * 判断一次 dragend 是否应打开链接。
 * 条件：页面内没有放置区接收（dropHandled）、拖拽未被取消（cancelled）、
 * 松手时不在内嵌框架上（endedOverFrame，框架内是否接收无法确认，保守放弃）、
 * 结束事件可信，且松手位置仍在本页视口内（拖到浏览器界面或窗口外则否）。
 */
function shouldOpenOnRelease(
  { dropHandled, cancelled, endedOverFrame, endTrusted, clientX, clientY },
  viewportWidth,
  viewportHeight
) {
  if (dropHandled === true || cancelled === true || endedOverFrame === true) return false;
  if (endTrusted !== true) return false;
  return clientX >= 0 && clientY >= 0 && clientX <= viewportWidth && clientY <= viewportHeight;
}

/**
 * 为拖拽悬停挑一个与拖拽源允许效果（effectAllowed）兼容的 dropEffect。
 * 目标必须把 dropEffect 设为 effectAllowed 允许的值，否则浏览器仍会显示“禁止”光标；
 * 返回 null 表示源明确禁止拖放（none），此时接受也没有意义、不干预。
 * 其余取值（copy/copyLink/copyMove/all/link/linkMove/move/uninitialized，以及取值缺失）
 * 都挑一个兼容的效果；无法确定时用最通用的 copy。
 */
function pickDropEffect(effectAllowed) {
  switch (effectAllowed) {
    case "none":
      return null;
    case "link":
    case "linkMove":
      return "link";
    case "move":
      return "move";
    default:
      return "copy";
  }
}

/**
 * 拖拽悬停时，扩展是否该为当前位置声明“接受拖放”，以及要设置的 dropEffect。
 * 浏览器只在有目标接受拖放时才不画禁止光标，因此页面空白处需要由扩展顶上。
 * 以下情况一律返回 null（不干预，保持各自原有的光标与行为）：
 * 未武装的拖拽、网站已接管的拖放（defaultPrevented）、浏览器原生放置区
 * （输入框、可编辑区域），以及拖拽源禁止拖放（none，此时接受也没有意义）。
 */
function pickDragOverEffect({ armed, defaultPrevented, nativeDropTarget, effectAllowed }) {
  if (armed !== true || defaultPrevented === true || nativeDropTarget === true) {
    return null;
  }
  return pickDropEffect(effectAllowed);
}

const LinkTabsDrag = {
  shouldArmDrag,
  shouldArmSearchDrag,
  normalizeSelectionText,
  shouldOpenOnRelease,
  pickDropEffect,
  pickDragOverEffect
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinkTabsDrag;
}
if (typeof globalThis !== "undefined") {
  globalThis.LinkTabsDrag = LinkTabsDrag;
}
