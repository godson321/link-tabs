"use strict";

const ENGINE_LABELS = {
  bing: "Bing",
  google: "Google",
  baidu: "百度",
  custom: "自定义"
};

const enabledToggle = document.getElementById("enabled-toggle");
const statusText = document.getElementById("status");
const engineSelect = document.getElementById("search-engine");
const urlInput = document.getElementById("search-url");
const searchError = document.getElementById("search-error");
const optionsButton = document.getElementById("open-options");

/** 已加载的设置；读取失败时为 null，此时禁用控件而不是展示不可信的状态。 */
let currentSettings = null;

/** 搜索引擎下拉框由 LinkTabsRules.SEARCH_ENGINES 生成，界面不会出现解析器不支持的值。 */
for (const engine of LinkTabsRules.SEARCH_ENGINES) {
  const option = document.createElement("option");
  option.value = engine;
  option.textContent = ENGINE_LABELS[engine] || engine;
  engineSelect.append(option);
}

function showStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function showSearchError(message) {
  if (message) {
    searchError.textContent = message;
    searchError.hidden = false;
  } else {
    searchError.hidden = true;
  }
}

function render() {
  const loaded = currentSettings !== null;
  enabledToggle.disabled = !loaded;
  engineSelect.disabled = !loaded;
  urlInput.disabled = !loaded;
  if (!loaded) return;

  enabledToggle.checked = currentSettings.enabled;
  // 具体打开方式由设置页的规则决定，此处只描述总开关的效果。
  showStatus(currentSettings.enabled
    ? "已启用：链接按设置页的规则打开"
    : "已停用：链接按浏览器原行为打开");

  engineSelect.value = currentSettings.searchEngine;
  if (currentSettings.searchEngine === "custom") {
    urlInput.value = currentSettings.searchUrl;
    urlInput.readOnly = false;
  } else {
    urlInput.value = LinkTabsRules.SEARCH_ENGINE_URLS[currentSettings.searchEngine];
    urlInput.readOnly = true;
  }
  showSearchError(null);
}

/** 每次打开弹窗都重新读取存储，保证显示的是最新状态。 */
async function loadSettings() {
  try {
    currentSettings = await LinkTabsSettings.load();
  } catch (error) {
    currentSettings = null;
    console.error("Link Tabs:", error);
    showStatus("无法读取设置：" + error, true);
  }
  render();
}

/** 读取最新设置后再应用变更并保存，避免覆盖设置页刚写入的值。 */
async function saveChange(change) {
  try {
    const next = change(await LinkTabsSettings.load());
    await LinkTabsSettings.save(next);
    currentSettings = LinkTabsRules.normalizeSettings(next);
    return true;
  } catch (error) {
    console.error("Link Tabs:", error);
    showStatus("保存失败：" + error, true);
    return false;
  }
}

enabledToggle.addEventListener("change", async () => {
  if (currentSettings === null) return;
  // 保存期间禁止再次切换，避免并发写入互相覆盖。
  enabledToggle.disabled = true;
  const saved = await saveChange(current => ({ ...current, enabled: enabledToggle.checked }));
  if (saved) {
    render();
  } else {
    // 保存失败时恢复真实状态，不伪装为切换成功。
    enabledToggle.checked = currentSettings.enabled;
    enabledToggle.disabled = false;
  }
});

engineSelect.addEventListener("change", async () => {
  if (currentSettings === null) return;
  const engine = engineSelect.value;
  if (engine === "custom") {
    // 切到自定义：保留当前地址作为编辑起点，输入有效地址后才保存。
    urlInput.readOnly = false;
    showSearchError(null);
    urlInput.focus();
    return;
  }
  engineSelect.disabled = true;
  const saved = await saveChange(current => ({ ...current, searchEngine: engine }));
  engineSelect.disabled = false;
  if (saved) {
    render();
  } else {
    engineSelect.value = currentSettings.searchEngine;
  }
});

urlInput.addEventListener("input", () => {
  if (currentSettings === null || engineSelect.value !== "custom") return;
  const result = LinkTabsRules.validateSearchUrl(urlInput.value.trim());
  showSearchError(result.valid ? null : result.error);
});

urlInput.addEventListener("change", async () => {
  if (currentSettings === null || engineSelect.value !== "custom") return;
  const searchUrl = urlInput.value.trim();
  const result = LinkTabsRules.validateSearchUrl(searchUrl);
  if (!result.valid) {
    // 无效地址只提示不保存，弹窗关闭后仍显示存储中的值。
    showSearchError(result.error);
    return;
  }
  const saved = await saveChange(current => ({ ...current, searchEngine: "custom", searchUrl }));
  if (saved) {
    render();
    showStatus("已保存");
  } else {
    // 保存失败：恢复为存储中的状态，不把未保存的地址留在界面上。
    render();
    showStatus("保存失败，地址未保存", true);
  }
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage().catch(error => {
    console.error("Link Tabs:", error);
    showStatus("无法打开设置页：" + error, true);
  });
});

loadSettings();
