"use strict";

const enabledToggle = document.getElementById("enabled-toggle");
const statusText = document.getElementById("status");
const optionsButton = document.getElementById("open-options");

/** 已加载的设置；读取失败时为 null，此时禁用总开关而不是展示不可信的状态。 */
let currentSettings = null;

function showStatus(message, isError = false) {
  statusText.textContent = message;
  statusText.classList.toggle("error", isError);
}

function render() {
  if (currentSettings === null) {
    enabledToggle.disabled = true;
    return;
  }
  enabledToggle.disabled = false;
  enabledToggle.checked = currentSettings.enabled;
  // 具体打开方式由设置页的规则决定，此处只描述总开关的效果。
  showStatus(currentSettings.enabled
    ? "已启用：链接按设置页的规则打开"
    : "已停用：链接按浏览器原行为打开");
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

enabledToggle.addEventListener("change", async () => {
  if (currentSettings === null) return;
  const enabled = enabledToggle.checked;
  // 保存期间禁止再次切换，避免并发写入互相覆盖。
  enabledToggle.disabled = true;
  try {
    await LinkTabsSettings.save({ ...currentSettings, enabled });
    currentSettings = { ...currentSettings, enabled };
  } catch (error) {
    // 保存失败时恢复真实状态并提示错误，不伪装为切换成功。
    console.error("Link Tabs:", error);
    enabledToggle.checked = currentSettings.enabled;
    enabledToggle.disabled = false;
    showStatus("保存失败：" + error, true);
    return;
  }
  render();
});

optionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage().catch(error => {
    console.error("Link Tabs:", error);
    showStatus("无法打开设置页：" + error, true);
  });
});

loadSettings();
