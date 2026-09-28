"use strict";

// 用扩展根目录的绝对路径导入，避免相对路径在不同解析基准下失效。
importScripts("/src/shared/rules.js", "/src/shared/settings.js");

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const { settings } = await chrome.storage.local.get("settings");
    if (settings === undefined) {
      await LinkTabsSettings.save({
        enabled: true,
        defaultAction: "background",
        domainRules: [],
        urlRules: []
      });
    }
  } catch (error) {
    console.error("Link Tabs:", error);
  }
});

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

  chrome.tabs.create({
    url: parsed.href,
    active: message.action === "foreground"
  })
    .then(() => sendResponse({ ok: true }))
    .catch(error => sendResponse({ ok: false, error: String(error) }));
  return true;
});
