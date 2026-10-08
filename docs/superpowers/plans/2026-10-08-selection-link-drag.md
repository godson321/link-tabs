# 选区完整链接拖动直开 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让选区完整覆盖可拦截链接或选中文字本身是完整 HTTP(S) URL 的拖动直接打开链接，其余文字继续搜索。

**Architecture:** 在内容脚本的 `dragstart` 入口增加两个局部 DOM/URL 辅助函数。完整 `<a>` 选区使用 Range 边界比较并复用 `resolveLinkTarget`；非 `<a>` 完整选区使用 `new URL` 识别绝对 HTTP(S) 地址。两类目标都写入已有的 `{ kind: "link", href }` 状态，继续使用现有链接拖动动作解析和 Service worker 通道。

**Tech Stack:** Manifest V3 content script, 原生 DOM `Selection`/`Range`/`URL`, Node.js >= 18, CommonJS 单元测试基础设施（本次不新增或运行测试用例）。

**Spec:** `docs/superpowers/specs/2026-10-08-selection-link-drag-design.md`

## Global Constraints

- 仅接受绝对 `http:` 和 `https:` URL；相对地址、脚本协议、邮件协议和混入普通文本的选区继续按普通选区处理。
- 完整 `<a>` 选区的目标必须通过现有 `resolveLinkTarget(anchor)`，不绕过下载链接、非 HTTP(S) 和同文档片段过滤。
- 直开目标统一使用 `kind: "link"` 和 `"drag"` 规则；普通选区继续使用 `kind: "search"` 和 `"search"` 规则。
- 保留现有可信事件、修饰键、输入框/编辑器、页面放置区、窗口失焦、内嵌框架和视口边界行为。
- 不引入第三方依赖，不改动 Service worker、共享规则模块或设置格式。
- 根据会话约束，不新增或运行测试用例；使用 `node --check` 与 `git diff --check` 做本次验证。

---

### Task 1: 在拖动入口识别完整链接选区和纯 URL 选区

**Files:**
- Modify: `src/content/link-interceptor.js:14-35`（链接目标辅助函数附近）
- Modify: `src/content/link-interceptor.js:145-197`（`dragstart` 识别分支）

**Interfaces:**
- Produces `isCompleteAnchorSelection(selection, anchor): boolean`，仅供本内容脚本使用。
- Produces `resolveSelectedHttpUrl(text): URL | null`，仅供本内容脚本使用。
- Existing consumer remains `draggedTarget = { kind: "link", href: target.href }` and the existing `dragend` branch.

- [ ] **Step 1: Add the complete anchor selection helper**

在 `resolveLinkTarget` 附近加入以下逻辑。必须要求只有一个 Range，并要求选区的起止边界都与链接内容边界相同；这样可支持嵌套元素，同时不会把“链接加周围文本”的大选区误判成完整链接。

```js
function isCompleteAnchorSelection(selection, anchor) {
  if (selection === null || anchor === null || selection.rangeCount !== 1) return false;

  try {
    const selectedRange = selection.getRangeAt(0);
    const anchorRange = document.createRange();
    anchorRange.selectNodeContents(anchor);
    return selectedRange.compareBoundaryPoints(Range.START_TO_START, anchorRange) === 0 &&
      selectedRange.compareBoundaryPoints(Range.END_TO_END, anchorRange) === 0;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: Add the absolute HTTP(S) URL helper**

在同一区域加入严格的文本 URL解析。先去除选区两端空白，再拒绝剩余空白字符，最后只返回 HTTP(S) `URL` 对象。

```js
function resolveSelectedHttpUrl(text) {
  const value = typeof text === "string" ? text.trim() : "";
  if (value === "" || /\s/.test(value)) return null;

  try {
    const target = new URL(value);
    return ["http:", "https:"].includes(target.protocol) ? target : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Preserve raw selection text for URL detection**

在 `dragstart` 中同时保留未截断的选区文本和现有用于搜索的规范化文本，避免 URL 判断误用搜索文本的 500 字符上限：

```js
const selection = window.getSelection();
const rawSelectionText = selection === null ? "" : selection.toString();
const selectionText = LinkTabsDrag.normalizeSelectionText(rawSelectionText);
```

把 `const anchor = source === null ? null : source.closest("a[href]");` 移到 `searchArmed` 判断之前，供链接选区优先级判断使用。

- [ ] **Step 4: Make direct-link recognition precede search classification**

保留现有 `searchArmed` 条件不变，仅替换其分支内容：完整 `<a>` 先取真实 `href`；选区没有完整覆盖 `<a>` 时再尝试把原始选区解析成 HTTP(S) URL；两者都失败时才进入原有搜索状态。

```js
if (searchArmed) {
  const completeAnchor = isCompleteAnchorSelection(selection, anchor);
  const target = completeAnchor
    ? resolveLinkTarget(anchor)
    : resolveSelectedHttpUrl(rawSelectionText);

  if (target !== null) {
    draggedTarget = { kind: "link", href: target.href };
    return;
  }

  draggedTarget = { kind: "search", text: selectionText };
  return;
}
```

不改动后面的 `linkArmed` 分支和 `dragend` 分支。这样完整 `<a>` 使用 `"drag"` 规则，纯 URL 选区也通过相同的链接目标状态进入 `"drag"` 规则。

- [ ] **Step 5: Run syntax and diff checks for the implementation**

Run:

```powershell
node --check src/content/link-interceptor.js
git diff --check
```

Expected: 两条命令都成功退出且没有语法或空白错误。

- [ ] **Step 6: Commit the focused behavior change**

```powershell
git add -- src/content/link-interceptor.js
git commit -m "feat: open selected links directly"
```

### Task 2: Synchronize the user-facing behavior description

**Files:**
- Modify: `README.md:7-12`（功能行为表）
- Modify: `README.md:22`（原生行为说明，如需补充选区例外）

**Interfaces:**
- Consumes the behavior implemented by Task 1.
- Produces documentation that distinguishes direct opening of complete selected links/URLs from search of other text.

- [ ] **Step 1: Update the drag-text row**

将功能表中的“拖动选中的文字到空白处松手”改为明确描述：完整覆盖可拦截链接的选区和选中文字本身为完整 HTTP(S) URL 时直接打开；其他文字使用所选搜索引擎搜索。

- [ ] **Step 2: Keep existing native exceptions explicit**

保留下载链接、非 HTTP(S) 链接、同页片段和输入框/编辑器的原生行为说明；只补充“完整 `<a>` 选区复用链接拖动规则”的用户可见描述，不修改设置项名称或配置格式。

- [ ] **Step 3: Run documentation checks**

Run:

```powershell
git diff --check
```

Expected: 成功退出。

- [ ] **Step 4: Commit the documentation synchronization**

```powershell
git add -- README.md
git commit -m "docs: describe direct opening for selected links"
```

### Task 3: Perform final behavior review

**Files:**
- Inspect: `src/content/link-interceptor.js`
- Inspect: `README.md`
- Inspect: `docs/superpowers/specs/2026-10-08-selection-link-drag-design.md`

**Interfaces:**
- Confirms the implementation satisfies the approved spec without changing unrelated drag/drop behavior.

- [ ] **Step 1: Review the final diff**

Run:

```powershell
git diff HEAD~2..HEAD -- src/content/link-interceptor.js README.md
git status --short --branch
```

Confirm the only product changes are selection classification and its documentation, and the worktree is clean after the two focused commits.

- [ ] **Step 2: Check the required scenarios by code path**

Confirm each case maps to the intended branch:

```text
完整 <a> 选区              -> resolveLinkTarget -> kind=link -> use=drag
完整 http(s) 文本选区       -> resolveSelectedHttpUrl -> kind=link -> use=drag
部分链接文字/普通文本        -> kind=search -> buildSearchUrl -> use=search
修饰键/输入框/编辑器          -> existing native path
下载/非 HTTP(S)/同页片段链接  -> resolveLinkTarget returns null
```

- [ ] **Step 3: Run final static verification**

Run:

```powershell
node --check src/content/link-interceptor.js
git diff --check
git status --short --branch
```

Expected: syntax and diff checks pass, and the worktree status is clean.
