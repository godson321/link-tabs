const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldArmDrag, shouldArmSearchDrag, shouldOpenOnRelease, normalizeSelectionText, pickDropEffect, pickDragOverEffect } = require("../src/shared/drag.js");

const armedDrag = {
  trusted: true,
  sourceIsLink: true,
  dragTypes: ["text/plain", "text/uri-list", "text/html"],
  modifierPressed: false
};
test("拖动链接会武装拖拽", () => {
  assert.equal(shouldArmDrag(armedDrag), true);
  assert.equal(shouldArmDrag({ ...armedDrag, dragTypes: ["text/uri-list"] }), true);
  assert.equal(shouldArmDrag({ ...armedDrag, modifierPressed: undefined }), true);
});
test("任一条件不满足都不武装", () => {
  assert.equal(shouldArmDrag({ ...armedDrag, trusted: false }), false);
  // 拖动的来源不在链接内（例如选中的文字）。
  assert.equal(shouldArmDrag({ ...armedDrag, sourceIsLink: false }), false);
  // 不是原生链接拖拽（缺少 text/uri-list）。
  assert.equal(shouldArmDrag({ ...armedDrag, dragTypes: ["text/plain", "text/html"] }), false);
  assert.equal(shouldArmDrag({ ...armedDrag, dragTypes: [] }), false);
  assert.equal(shouldArmDrag({ ...armedDrag, dragTypes: undefined }), false);
  // 带修饰键的拖动保持原生。
  assert.equal(shouldArmDrag({ ...armedDrag, modifierPressed: true }), false);
});

const release = {
  dropHandled: false,
  cancelled: false,
  endedOverFrame: false,
  endTrusted: true,
  clientX: 100,
  clientY: 200
};
test("页面内空白处松手会打开链接", () => {
  assert.equal(shouldOpenOnRelease(release, 800, 600), true);
});
test("放置区接收、拖拽取消或框架上的松手都不打开", () => {
  // 网页内的放置区（编辑器、上传框等）已接收这次拖放。
  assert.equal(shouldOpenOnRelease({ ...release, dropHandled: true }, 800, 600), false);
  // 拖拽中窗口失焦，等同取消。
  assert.equal(shouldOpenOnRelease({ ...release, cancelled: true }, 800, 600), false);
  // 松手位置在无法确认的内嵌框架上，保守放弃。
  assert.equal(shouldOpenOnRelease({ ...release, endedOverFrame: true }, 800, 600), false);
  // 非用户产生的拖拽结束事件。
  assert.equal(shouldOpenOnRelease({ ...release, endTrusted: false }, 800, 600), false);
});
test("松手位置在视口外（浏览器界面、窗口外）不打开", () => {
  assert.equal(shouldOpenOnRelease({ ...release, clientX: -1 }, 800, 600), false);
  assert.equal(shouldOpenOnRelease({ ...release, clientY: -1 }, 800, 600), false);
  assert.equal(shouldOpenOnRelease({ ...release, clientX: 801 }, 800, 600), false);
  assert.equal(shouldOpenOnRelease({ ...release, clientY: 601 }, 800, 600), false);
  // 非法坐标（NaN/undefined）不得视为页面内。
  assert.equal(shouldOpenOnRelease({ ...release, clientX: NaN }, 800, 600), false);
  assert.equal(shouldOpenOnRelease({ ...release, clientY: undefined }, 800, 600), false);
});
test("视口边界坐标仍视为页面内", () => {
  assert.equal(shouldOpenOnRelease({ ...release, clientX: 0, clientY: 0 }, 800, 600), true);
  assert.equal(shouldOpenOnRelease({ ...release, clientX: 800, clientY: 600 }, 800, 600), true);
});

const armedSearch = {
  trusted: true,
  sourceIsSearchable: true,
  dragTypes: ["text/plain", "text/html"],
  modifierPressed: false
};
test("拖动选中的文字会武装搜索", () => {
  assert.equal(shouldArmSearchDrag(armedSearch), true);
});
test("搜索拖拽的任一条件不满足都不武装", () => {
  assert.equal(shouldArmSearchDrag({ ...armedSearch, trusted: false }), false);
  // 选中内容为空、位于输入框/编辑器内或拖动的是图片时都不搜索。
  assert.equal(shouldArmSearchDrag({ ...armedSearch, sourceIsSearchable: false }), false);
  assert.equal(shouldArmSearchDrag({ ...armedSearch, dragTypes: ["text/html"] }), false);
  assert.equal(shouldArmSearchDrag({ ...armedSearch, dragTypes: undefined }), false);
  assert.equal(shouldArmSearchDrag({ ...armedSearch, modifierPressed: true }), false);
});
test("选取文本做修剪并按码点截取前 500 个字符", () => {
  assert.equal(normalizeSelectionText("  hello world  "), "hello world");
  assert.equal(normalizeSelectionText("   "), "");
  assert.equal(normalizeSelectionText("a".repeat(600)).length, 500);
  const cut = normalizeSelectionText("😀".repeat(600));
  assert.equal(Array.from(cut).length, 500);
  // 截断处不得留下落单的代理项（encodeURIComponent 遇到会抛错）。
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(cut), false);
});

test("按拖拽源允许的效果挑一个兼容的 dropEffect", () => {
  // 目标必须把 dropEffect 设为 effectAllowed 允许的值，否则浏览器仍显示“禁止”光标。
  assert.equal(pickDropEffect("copy"), "copy");
  assert.equal(pickDropEffect("copyMove"), "copy");
  assert.equal(pickDropEffect("copyLink"), "copy");
  assert.equal(pickDropEffect("all"), "copy");
  assert.equal(pickDropEffect("link"), "link");
  assert.equal(pickDropEffect("linkMove"), "link");
  assert.equal(pickDropEffect("move"), "move");
  // 取值缺失或未知时按“源未限定”处理（规范中 uninitialized 允许目标自选），用最通用的 copy；
  // 只有源明确禁止拖放（none）才不干预。
  assert.equal(pickDropEffect("uninitialized"), "copy");
  assert.equal(pickDropEffect(undefined), "copy");
  assert.equal(pickDropEffect(""), "copy");
  assert.equal(pickDropEffect("none"), null);
});

const hover = { armed: true, defaultPrevented: false, nativeDropTarget: false, effectAllowed: "copyMove" };
test("空白处悬停时由扩展声明接受拖放，并挑出兼容的 dropEffect", () => {
  assert.equal(pickDragOverEffect(hover), "copy");
  assert.equal(pickDragOverEffect({ ...hover, effectAllowed: "link" }), "link");
  assert.equal(pickDragOverEffect({ ...hover, effectAllowed: "move" }), "move");
});
test("网站接管、原生放置区、未武装或源禁止拖放时都不干预", () => {
  // 网站自己 preventDefault 了 dragover：它的光标与放置逻辑优先。
  assert.equal(pickDragOverEffect({ ...hover, defaultPrevented: true }), null);
  // 浏览器原生放置区（输入框、可编辑区域）：保持原生插入与光标。
  assert.equal(pickDragOverEffect({ ...hover, nativeDropTarget: true }), null);
  assert.equal(pickDragOverEffect({ ...hover, armed: false }), null);
  // 源明确禁止拖放（none）：接受也没有意义，保持浏览器原有表现；
  // 取值缺失按“源未限定”处理，照常接受。
  assert.equal(pickDragOverEffect({ ...hover, effectAllowed: "none" }), null);
  assert.equal(pickDragOverEffect({ ...hover, effectAllowed: undefined }), "copy");
  assert.equal(pickDragOverEffect({}), null);
});
