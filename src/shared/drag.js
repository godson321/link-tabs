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

const LinkTabsDrag = { shouldArmDrag, shouldOpenOnRelease };

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinkTabsDrag;
}
if (typeof globalThis !== "undefined") {
  globalThis.LinkTabsDrag = LinkTabsDrag;
}
