"use strict";

// 用扩展根目录的绝对路径导入，避免相对路径在不同解析基准下失效。
importScripts("/src/shared/rules.js", "/src/shared/settings.js");

/** 已加载的设置；读取失败时保持 undefined，处理事件前按需重试。 */
let currentSettings;

/** 最近一次规则集同步是否成功；失败时会在下一个事件里重试。 */
let timRulesetSynced = false;

async function loadSettings() {
  try {
    currentSettings = await LinkTabsSettings.load();
  } catch (error) {
    console.error("Link Tabs:", error);
  }
}

/** 让 TIM 拦截规则集与设置保持一致（静态规则集可在运行时启停）。 */
async function syncTimRuleset() {
  const enabled = currentSettings?.timFixEnabled !== false;
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets(
      enabled
        ? { enableRulesetIds: ["tim_jump"] }
        : { disableRulesetIds: ["tim_jump"] }
    );
    timRulesetSynced = true;
  } catch (error) {
    timRulesetSynced = false;
    console.error("Link Tabs:", error);
  }
}

loadSettings().then(syncTimRuleset);

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) return;
  currentSettings = LinkTabsRules.normalizeSettings(changes.settings.newValue);
  syncTimRuleset();
});

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
chrome.webNavigation.onBeforeNavigate.addListener(async details => {
  if (details.frameId !== 0) return;
  if (currentSettings === undefined) await loadSettings();
  // 上一次规则集同步失败时（例如扩展刚更新）先重试，避免“开关已关但请求仍被拦截”。
  if (!timRulesetSynced) await syncTimRuleset();
  if (currentSettings?.timFixEnabled === false) return;
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

  (async () => {
    try {
      if (currentSettings === undefined) await loadSettings();
      // TIM 卡片跳转链接换成真实目标地址（该开关关闭时保持原样）。
      const targetUrl = currentSettings?.timFixEnabled !== false
        ? (LinkTabsRules.decodeTimJumpUrl(parsed.href) ?? parsed.href)
        : parsed.href;
      await chrome.tabs.create({
        url: targetUrl,
        active: message.action === "foreground"
      });
      sendResponse({ ok: true });
    } catch (error) {
      sendResponse({ ok: false, error: String(error) });
    }
  })();
  return true;
});
