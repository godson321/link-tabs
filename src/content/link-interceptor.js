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
  if (
    !anchor ||
    anchor.hasAttribute("download") ||
    anchor.isContentEditable ||
    document.designMode === "on"
  ) return;

  let target;
  try {
    target = new URL(anchor.href, location.href);
  } catch {
    return;
  }

  if (
    !["http:", "https:"].includes(target.protocol) ||
    isSameDocumentFragment(target, anchor)
  ) return;

  let action;
  try {
    action = LinkTabsRules.resolveAction(target.href, currentSettings);
  } catch (error) {
    // 规则计算异常时保持浏览器原生行为，不能因为解析失败而吞掉用户的点击。
    console.error("Link Tabs:", error);
    return;
  }
  if (action === "native") return;

  event.preventDefault();
  event.stopImmediatePropagation();
  chrome.runtime.sendMessage({
    type: "OPEN_LINK_TAB",
    url: target.href,
    action
  })
    .then(response => {
      if (!response?.ok) console.error("Link Tabs:", response?.error);
    })
    .catch(error => console.error("Link Tabs:", error));
}, true);
