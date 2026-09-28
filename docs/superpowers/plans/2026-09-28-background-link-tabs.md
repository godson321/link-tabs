# 后台新标签页扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个 Edge 扩展：普通左键点击网页链接时按配置新建后台标签页，默认不切离当前标签页，并提供总开关及域名/网址规则。

**Architecture:** 使用 Manifest V3 内容脚本捕获符合条件的链接点击，Service worker 通过 `chrome.tabs.create` 创建前台或后台标签页；工具栏弹窗负责总开关，设置页编辑默认行为和规则。纯规则逻辑与存储模型集中在共享模块中，使用 Node 内置测试运行器验证，无打包器和第三方运行时依赖。

**Tech Stack:** Microsoft Edge Manifest V3、原生 JavaScript、HTML/CSS、Node.js `node:test`。

**Spec:** `docs/superpowers/specs/2026-09-28-background-link-tabs-design.md`

## Global Constraints

- 安装后默认启用，全局默认行为为后台新标签页，创建的标签页保持未激活，当前标签页保持选中。
- 扩展停用或规则选择“按浏览器原行为”时，不拦截链接导航。
- 只处理普通 `<a href>` 上未按修饰键的主键点击，目标限 HTTP/HTTPS。
- Ctrl/Shift/Alt 点击、中键/右键、下载、非网页协议及同文档片段导航保留原生行为。
- 网址规则优先于域名规则；同一类规则按用户排序，第一条匹配规则生效。
- 使用 `chrome.storage.local`；无分析、远程请求或浏览历史收集。
- 为覆盖所有普通网站，内容脚本需要 HTTP/HTTPS 全站 host access；扩展页面和浏览器受保护页面不在范围内。
- 不引入第三方运行时依赖；规则和配置逻辑须有自动化测试，交付前须在 Edge 手动验收。

---

## 文件结构

- `manifest.json`：Manifest V3、网站权限、内容脚本、弹窗和设置页注册。
- `package.json`：项目元数据和 `npm test` 脚本，仅使用 Node 内置测试运行器。
- `src/shared/rules.js`：默认设置、规则验证、域名/网址匹配和行为解析；Node 环境导出 CommonJS，在扩展环境挂到 `globalThis.LinkTabsRules`。
- `src/shared/settings.js`：统一读写 `chrome.storage.local` 中的 `settings` 对象及提供默认设置。
- `src/content/link-interceptor.js`：过滤普通链接点击、读取当前设置并发送打开标签页请求。
- `src/background/service-worker.js`：初始化默认设置、验证扩展消息、调用 `chrome.tabs.create`。
- `src/popup/popup.html`、`src/popup/popup.js`、`src/popup/popup.css`：工具栏总开关和进入设置页的入口。
- `src/options/options.html`、`src/options/options.js`、`src/options/options.css`：全局行为与域名/网址规则管理界面。
- `tests/rules.test.js`：Node 内置测试，覆盖默认值、规则验证、匹配及优先级。
- `README.md`：功能、权限说明、测试命令和 Edge“加载已解压的扩展”步骤。

## 配置与接口约定

共享设置保存在 `chrome.storage.local` 的 `settings` 键中：

```js
{
  enabled: true,
  defaultAction: "background", // "background" | "foreground" | "native"
  domainRules: [
    { id: "...", domain: "example.com", includeSubdomains: false, action: "background" }
  ],
  urlRules: [
    { id: "...", pattern: "https://example.com/path/*", action: "native" }
  ]
}
```

`src/shared/rules.js` 必须公开以下接口：

```js
LinkTabsRules.DEFAULT_SETTINGS
LinkTabsRules.normalizeSettings(rawSettings)
LinkTabsRules.validateDomainRule(rule) // { valid: true } 或 { valid: false, error: string }
LinkTabsRules.validateUrlRule(rule)    // { valid: true } 或 { valid: false, error: string }
LinkTabsRules.resolveAction(url, settings) // "background" | "foreground" | "native"
```

内容脚本向 Service worker 发送 `{ type: "OPEN_LINK_TAB", url, action }`；其中 `action` 只允许 `background` 或 `foreground`。Service worker 响应 `{ ok: true }` 或 `{ ok: false, error: string }`。无效消息或非 HTTP/HTTPS 目标不得创建标签页。

---

### Task 1：项目骨架与规则解析（TDD）

**Files:**
- Create: `package.json`
- Create: `src/shared/rules.js`
- Create: `tests/rules.test.js`

**Interfaces:**
- 提供上述 `LinkTabsRules` 接口。
- 域名规则默认只匹配完全相同的主机名；`includeSubdomains: true` 时也匹配子域名，但不匹配相似后缀（如 `notexample.com`）。
- 网址规则仅允许 HTTP/HTTPS URL 模式，`*` 匹配零个或多个字符，规则按数组顺序优先。
- `resolveAction` 先检查设置是否启用，再检查网址规则，然后域名规则，最后使用全局默认值；不支持的协议返回 `native`。

- [ ] **步骤 1：先创建测试脚本并写失败测试**

先创建 `package.json`，内容至少包含 `{ "name": "edge-background-link-tabs", "private": true, "type": "commonjs", "scripts": { "test": "node --test" } }`，再创建 `tests/rules.test.js`。使用 `node:test` 和 `node:assert/strict`，写出下列测试，测试通过 `require("../src/shared/rules.js")` 读取尚未实现的模块：

```js
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_SETTINGS, resolveAction, validateUrlRule } = require("../src/shared/rules.js");

const base = { ...DEFAULT_SETTINGS, enabled: true };
test("默认行为是在后台打开", () => {
  assert.equal(DEFAULT_SETTINGS.enabled, true);
  assert.equal(resolveAction("https://example.com/", DEFAULT_SETTINGS), "background");
});
test("可配置全局默认行为", () => {
  assert.equal(resolveAction("https://other.example/", { ...base, defaultAction: "foreground" }), "foreground");
});
test("网址规则覆盖域名规则，且网址规则按列表顺序匹配", () => {
  const settings = { ...base, domainRules: [{ domain: "example.com", includeSubdomains: false, action: "foreground" }],
    urlRules: [{ pattern: "https://example.com/private/*", action: "native" }, { pattern: "https://example.com/*", action: "background" }] };
  assert.equal(resolveAction("https://example.com/private/a", settings), "native");
  assert.equal(resolveAction("https://example.com/public/a", settings), "background");
});
test("域名规则按边界匹配子域", () => {
  const settings = { ...base, domainRules: [{ domain: "example.com", includeSubdomains: true, action: "foreground" }] };
  assert.equal(resolveAction("https://shop.example.com/", settings), "foreground");
  assert.equal(resolveAction("https://notexample.com/", settings), "background");
});
test("禁用和非网页协议不拦截", () => {
  assert.equal(resolveAction("https://example.com/", { ...base, enabled: false }), "native");
  assert.equal(resolveAction("mailto:user@example.com", base), "native");
});
test("拒绝非 HTTP/HTTPS 网址规则", () => {
  assert.equal(validateUrlRule({ pattern: "javascript:alert(1)", action: "background" }).valid, false);
});
```

- [ ] **步骤 2：运行测试确认先失败**

运行：`npm test`
预期：失败，提示规则模块尚不存在或预期导出缺失。

- [ ] **步骤 3：实现最小规则模块和测试脚本**

在 `rules.js` 实现默认配置、动作枚举、规则校验、URL 模式通配符匹配、域名边界匹配、设置归一化和 `resolveAction`。域名子域匹配须使用 `hostname === domain || hostname.endsWith("." + domain)`，不得误匹配相似后缀；网址规则只编译 HTTP/HTTPS 模式并将 `*` 转为匹配任意长度字符的通配符。在 Node 中通过 `module.exports` 导出同一对象，并在浏览器环境赋给 `globalThis.LinkTabsRules`。`resolveAction` 顺序固定为：归一化设置 → 设置停用返回 `native` → URL 无效或协议非 HTTP/HTTPS 返回 `native` → 第一条匹配的网址规则 → 第一条匹配的域名规则 → 全局默认行为。

- [ ] **步骤 4：运行规则测试确认通过**

运行：`npm test`
预期：所有规则测试通过，无第三方依赖安装需求。

- [ ] **步骤 5：提交任务**

```bash
git add package.json src/shared/rules.js tests/rules.test.js
git commit -m "feat: add tested link rule resolver"
```

### Task 2：扩展清单与链接拦截运行时

**Files:**
- Create: `manifest.json`
- Create: `src/shared/settings.js`
- Create: `src/background/service-worker.js`
- Create: `src/content/link-interceptor.js`

**Interfaces:**
- `settings.js` 暴露 `LinkTabsSettings.load()`、`LinkTabsSettings.save(settings)`，读写 `chrome.storage.local` 的 `settings` 键，并使用 `LinkTabsRules.normalizeSettings` 归一化。
- Service worker 仅接受 `{ type: "OPEN_LINK_TAB", url, action }`，目标必须为 HTTP/HTTPS，行为必须为 `background` 或 `foreground`；后台时调用 `chrome.tabs.create({ url, active: false })`，前台时 `active: true`。
- 内容脚本依赖 Task 1 的 `LinkTabsRules`，并在设置读取完成后处理点击；设置加载失败时不拦截原生导航。

- [ ] **步骤 1：创建最小 Manifest V3 清单**

在 `manifest.json` 建立下列 Manifest V3 基础结构；内容脚本在 `document_start` 按顺序加载三个脚本，此阶段 action 使用默认标题，Task 3 再注册弹窗和选项页：

```json
{
  "manifest_version": 3,
  "name": "后台新标签页",
  "version": "1.0.0",
  "permissions": ["storage"],
  "host_permissions": ["http://*/*", "https://*/*"],
  "background": { "service_worker": "src/background/service-worker.js" },
  "content_scripts": [{
    "matches": ["http://*/*", "https://*/*"],
    "js": ["src/shared/rules.js", "src/shared/settings.js", "src/content/link-interceptor.js"],
    "run_at": "document_start"
  }],
  "action": { "default_title": "后台新标签页" }
}
```

- [ ] **步骤 2：编写配置存储和默认初始化**

实现 `settings.js` 的 Promise 接口，并通过 UMD 方式将 `LinkTabsSettings` 暴露给扩展页面；缺少存储值时 `load()` 返回归一化默认配置。接口形状如下：

```js
globalThis.LinkTabsSettings = {
  async load() {
    const { settings } = await chrome.storage.local.get("settings");
    return LinkTabsRules.normalizeSettings(settings);
  },
  async save(settings) {
    await chrome.storage.local.set({ settings: LinkTabsRules.normalizeSettings(settings) });
  }
};
```

Service worker 文件顶部使用 `importScripts("../shared/rules.js", "../shared/settings.js")`。在 `runtime.onInstalled` 时仅当 `settings` 不存在才调用 `LinkTabsSettings.save({ enabled: true, defaultAction: "background", domainRules: [], urlRules: [] })`，不得覆盖既有用户配置。

- [ ] **步骤 3：编写标签页消息处理器**

在 Service worker 校验消息对象、动作、URL 协议；合法消息使用对应的 `active` 值创建标签页并返回 `{ ok: true }`。捕获创建失败并返回错误响应，不创建非 HTTP/HTTPS 标签页。监听器按以下消息与响应契约实现，并用 `return true` 保持异步响应通道：

```js
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "OPEN_LINK_TAB") return false;
  let parsed;
  try { parsed = new URL(message.url); } catch {
    sendResponse({ ok: false, error: "Invalid URL" });
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol) ||
      !["background", "foreground"].includes(message.action)) {
    sendResponse({ ok: false, error: "Invalid link request" });
    return false;
  }
  chrome.tabs.create({ url: parsed.href, active: message.action === "foreground" })
    .then(() => sendResponse({ ok: true }))
    .catch(error => sendResponse({ ok: false, error: String(error) }));
  return true;
});
```

- [ ] **步骤 4：编写内容脚本点击拦截器**

使用捕获阶段的 `document` 点击监听器；仅处理未按 Ctrl/Shift/Alt/Meta、`button === 0` 的普通点击。通过 `closest('a[href]')` 找链接，排除下载链接、非 HTTP/HTTPS 目标、同文档片段跳转和内容可编辑区域。根据设置调用 `resolveAction`；`native` 不拦截。后台/前台行为下同步阻止默认导航和该链接事件继续传播，再发送 `OPEN_LINK_TAB` 消息；消息失败时记录扩展控制台诊断，不把后台动作改为前台动作。通过 `chrome.storage.onChanged` 更新已加载配置。核心处理结构如下：

```js
document.addEventListener("click", event => {
  if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor || anchor.hasAttribute("download") || anchor.closest('[contenteditable="true"]')) return;
  const target = new URL(anchor.href, location.href);
  if (!["http:", "https:"].includes(target.protocol) || isSameDocumentFragment(target)) return;
  const action = LinkTabsRules.resolveAction(target.href, currentSettings);
  if (action === "native") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  chrome.runtime.sendMessage({ type: "OPEN_LINK_TAB", url: target.href, action })
    .then(response => { if (!response?.ok) console.error("Link Tabs:", response?.error); })
    .catch(error => console.error("Link Tabs:", error));
}, true);
```

`isSameDocumentFragment` 比较目标与当前页的 origin、pathname、search；只有三者相同且目标含片段时返回 `true`。设置加载成功前不执行拦截逻辑。

- [ ] **步骤 5：运行自动测试并加载扩展验证运行时**

运行：`npm test`。随后在 Edge 打开 `edge://extensions`，启用“开发人员模式”，加载项目根目录。访问普通 HTTP/HTTPS 页面，点击普通链接，确认产生非激活新标签页且当前页不切换；再确认 Ctrl+点击、下载、`mailto:` 和同页片段仍保持原行为。

- [ ] **步骤 6：提交任务**

```bash
git add manifest.json src/shared/settings.js src/background/service-worker.js src/content/link-interceptor.js
git commit -m "feat: intercept web links into background tabs"
```

### Task 3：总开关弹窗和规则设置页

**Files:**
- Create: `src/popup/popup.html`
- Create: `src/popup/popup.js`
- Create: `src/popup/popup.css`
- Create: `src/options/options.html`
- Create: `src/options/options.js`
- Create: `src/options/options.css`
- Modify: `manifest.json`
- Test: `tests/rules.test.js`（为新增验证边界补测试）

**Interfaces:**
- 弹窗通过 `LinkTabsSettings.load/save` 更新 `settings.enabled`，关闭再打开弹窗显示最新状态。
- 选项页通过相同存储接口维护 `defaultAction`、`domainRules` 和 `urlRules`；新增规则分配稳定 ID，排序按钮改变数组顺序。
- 无效输入显示在对应表单附近，不写入存储；删除、上移、下移后即时保存。

- [ ] **步骤 1：为规则输入写边界测试**

在 `tests/rules.test.js` 增加域名格式校验、子域选项布尔值、动作枚举、HTTP/HTTPS 网址模式和非法模式测试；先运行 `npm test` 确认新用例失败。

- [ ] **步骤 2：补全纯规则校验并跑测试**

更新 `validateDomainRule` 和 `validateUrlRule`，只返回 `{ valid: true }` 或 `{ valid: false, error: '具体原因' }`；运行 `npm test`，所有规则测试须通过。

- [ ] **步骤 3：实现工具栏弹窗**

创建带有可访问名称的启用复选框、状态文字和“设置”按钮。弹窗 HTML 按顺序加载 `../shared/rules.js`、`../shared/settings.js` 和 `popup.js`；打开时读设置；切换复选框后保存 `enabled`；设置按钮调用 `chrome.runtime.openOptionsPage()`。在保存或读取失败时显示错误状态，不伪装为切换成功。

- [ ] **步骤 4：实现全局设置和规则列表界面**

设置页 HTML 按顺序加载 `../shared/rules.js`、`../shared/settings.js` 和 `options.js`。设置页提供全局默认动作下拉框（后台新标签、前台新标签、按浏览器原行为），域名规则表单（域名、包含子域名、动作），网址规则表单（通配模式、动作），以及分别展示两类规则的列表。每条列表项提供编辑、上移、下移、删除操作；按 Task 1 的顺序规则执行。输入校验调用 `LinkTabsRules.validateDomainRule` 或 `validateUrlRule`，有效规则使用 `crypto.randomUUID()` 生成 ID 后写入 `LinkTabsSettings.save(settings)`。

- [ ] **步骤 5：连接存储并验证 UI 行为**

页面加载时读取配置并渲染；所有新增/编辑/删除/排序/默认值变化都先校验再保存。手动验证总开关即时生效、规则顺序持久化、刷新选项页后设置仍在、错误规则不会保存。

- [ ] **步骤 6：注册 UI 并提交任务**

更新 `manifest.json` 的 `action.default_popup` 和 `options_page`；运行 `npm test`，重新从 `edge://extensions` 加载扩展，验证弹窗与设置页。然后提交：

```bash
git add manifest.json src/popup src/options src/shared/rules.js tests/rules.test.js
git commit -m "feat: add extension controls and link rules UI"
```

### Task 4：安装文档与验收

**Files:**
- Create: `README.md`
- Verify: `manifest.json`、`src/`、`tests/`

- [ ] **步骤 1：编写中文 README**

说明扩展默认行为、后台/前台/原行为三种动作、域名与网址规则优先级、所有网站访问权限的原因与隐私边界、Node.js 测试命令，以及 Edge 加载步骤：打开 `edge://extensions` → 开启“开发人员模式” →“加载解压缩的扩展”→ 选择项目根目录。

- [ ] **步骤 2：执行完整自动化测试和静态检查**

运行 `npm test` 和 `git diff --check`，再用以下 Node 命令解析 Manifest 并确认注册的脚本/UI 文件存在：

```bash
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('manifest.json','utf8')); const paths=[m.background.service_worker,...m.content_scripts.flatMap(s=>s.js),m.action.default_popup,m.options_page].filter(Boolean); for(const p of paths) if(!fs.existsSync(p)) throw new Error('Missing: '+p); console.log('manifest resources OK')"
```

- [ ] **步骤 3：按验收矩阵在 Edge 手动验证**

验证全新默认行为；域名规则的精确匹配和包含子域名；URL 规则优先于域名规则及同类规则顺序；后台/前台/原行为三种动作；关闭和重新开启扩展；修饰键、下载、非 HTTP(S)、同页片段例外。确认当前标签页仅在“前台新标签”动作下切换。

- [ ] **步骤 4：提交文档并记录验收结果**

```bash
git add README.md
git commit -m "docs: add Edge extension setup and privacy guide"
```

在最终交付摘要中列出项目路径、加载步骤、测试结果及任何未通过的手动验收项。
