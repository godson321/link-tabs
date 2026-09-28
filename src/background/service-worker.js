"use strict";

// 用扩展根目录的绝对路径导入，避免相对路径在不同解析基准下失效。
importScripts("/src/shared/rules.js", "/src/shared/settings.js");

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings === undefined) {
      await LinkTabsSettings.save(LinkTabsRules.DEFAULT_SETTINGS);
    }
  } catch (error) {
    console.error("Link Tabs:", error);
  }
});

// TIM 卡片分享链接（ssl.ptlogin2.qq.com/jump）打开时 403：
// 主页面请求由 declarativeNetRequest 静态规则拦下，这里把标签页直接导航到解码后的真实地址。
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (details.frameId !== 0) return;
  const target = LinkTabsRules.decodeTimJumpUrl(details.url);
  // 目标解不出、或目标本身又是一条跳转链接（防构造互跳死循环）时不跳转。
  if (target === null || LinkTabsRules.decodeTimJumpUrl(target) !== null) return;
  chrome.tabs.update(details.tabId, { url: target }).catch(error => {
    console.error("Link Tabs:", error);
  });
}, { url: [{ urlMatches: "https?://ssl\\.ptlogin2\\.qq\\.com/jump" }] });

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPEN_LINK_TAB") return false;

  let parsed;
  try {
    parsed = new URL(message.url);
  } catch {
    sendResponse({ ok: false, error: "Invalid URL" });
    return false;
  }

  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !["background", "foreground"].includes(message.action)
  ) {
    sendResponse({ ok: false, error: "Invalid link request" });
    return false;
  }

  // TIM 卡片跳转链接直接换成真实目标地址，打开时不会经过被拦截的 403 页面。
  const targetUrl = LinkTabsRules.decodeTimJumpUrl(parsed.href) ?? parsed.href;
  chrome.tabs.create({
    url: targetUrl,
    active: message.action === "foreground"
  })
    .then(() => sendResponse({ ok: true }))
    .catch(error => sendResponse({ ok: false, error: String(error) }));
  return true;
});
