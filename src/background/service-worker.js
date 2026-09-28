"use strict";

importScripts("../shared/rules.js", "../shared/settings.js");

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
