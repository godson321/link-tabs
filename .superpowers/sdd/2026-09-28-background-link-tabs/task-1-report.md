# Task 1 报告：项目骨架与规则解析（TDD）

- 状态：DONE
- 分支：`feature/background-link-tabs`
- BASE：`50f4b62a4f5dd74c6cd6af2bfb703e5aa37922bb`
- 提交：`0ff399c` — `feat: add tested link rule resolver`
- 工作区：`E:/90 AI/浏览器扩展/.worktrees/background-link-tabs`

## 变更内容

严格按 task-1-brief.md 实现，无范围外改动。

| 文件 | 说明 |
|---|---|
| `package.json`（新增） | `edge-background-link-tabs`，`private: true`，`type: commonjs`，`scripts.test = "node --test"`，无第三方依赖。 |
| `src/shared/rules.js`（新增） | 纯规则模块：默认配置、动作枚举、域名/网址规则校验、通配符 URL 匹配、域名边界匹配、设置归一化、`resolveAction`。Node 用 `module.exports`，同时挂 `globalThis.LinkTabsRules`。 |
| `tests/rules.test.js`（新增） | `node:test` + `node:assert/strict`，包含 brief 中原样 6 个测试、预检裁定回归测试，以及 2 个补充测试（域名精确匹配、`normalizeSettings`）。 |

公开接口（与计划一致）：`DEFAULT_SETTINGS`、`normalizeSettings`、`validateDomainRule`、`validateUrlRule`、`resolveAction`；另导出 `ACTIONS`。

实现要点：
- 域名匹配：`hostname === domain || hostname.endsWith("." + domain)`，`includeSubdomains` 为 `true` 时才启用子域部分，不误匹配 `notexample.com`。
- 网址规则：仅接受 `http://`/`https://` 模式，`*` → `.*`（匹配零个或多个字符），按数组顺序取第一条。
- 大小写裁定：仅把 scheme 与 authority 中的主机名（`@` 之后）转小写，路径/查询原样保留，未对完整 URL 做忽略大小写匹配。
- `resolveAction` 顺序：归一化 → 停用返回 `native` → URL 无效或协议非 HTTP/HTTPS 返回 `native` → 第一条网址规则 → 第一条域名规则 → 全局默认行为。
- `normalizeSettings` 对缺失/非法字段回退默认值，并过滤无效规则；`includeSubdomains` 缺失时归一化为 `false`（保持归一化宽松，校验器严格）。

## TDD 证据

### RED（步骤 2）

命令：`npm test`，退出码 1。模块尚不存在：

```
Error: Cannot find module '../src/shared/rules.js'
Require stack:
- ...\tests\rules.test.js
code: 'MODULE_NOT_FOUND'
...
✖ tests\rules.test.js
ℹ tests 1
ℹ pass 0
ℹ fail 1
```

### GREEN（步骤 4，提交后复跑一致）

命令：`npm test`，退出码 0：

```
✔ 默认行为是在后台打开
✔ 可配置全局默认行为
✔ 网址规则覆盖域名规则，且网址规则按列表顺序匹配
✔ 域名规则按边界匹配子域
✔ 禁用和非网页协议不拦截
✔ 拒绝非 HTTP/HTTPS 网址规则
✔ 网址规则主机名不区分大小写但路径区分大小写
✔ 域名规则默认只匹配完整主机名
✔ normalizeSettings 填充默认值并过滤无效规则
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

预检回归测试内容（`tests/rules.test.js`）：
```js
test("网址规则主机名不区分大小写但路径区分大小写", () => {
  const settings = { ...base, urlRules: [
    { pattern: "https://Example.com/Private/*", action: "native" }
  ] };
  assert.equal(resolveAction("https://example.com/Private/a", settings), "native");
  assert.equal(resolveAction("https://example.com/private/a", settings), "background");
});
```
大写规则主机名匹配规范化后的小写 URL 主机名；路径大小写不同则不匹配并回落到默认行为。

## 验证

- `git diff --check`：无空白错误。
- 提交后 `git status`：工作区干净。
- BASE→HEAD 仅 3 个新增文件，均在本任务范围内。
- 额外人工探测（不写入测试文件）全部符合预期：零长度通配符、查询大小写敏感、URL 主机大写、scheme 大写、相似后缀、多级子域、`javascript:`、`globalThis.LinkTabsRules` 表面、两个校验器有效/无效用例。
- 唯一一次探测“FAIL”为探测脚本自身预期写错：`new URL("/path")` 会抛错，按规范应返回 `native`，实现正确。

## 自审发现

- 归一化器会把缺失的 `includeSubdomains` 视为 `false` 并保留规则；校验器则要求显式布尔值。这是有意分层：UI/校验严格，读取旧配置宽松。Task 3 可在此基础上收紧校验器。
- `normalizeAuthority` 只对 `@` 之后的主机部分做小写，保留 userinfo 原样，避免把用户信息误作不区分大小写。
- `globalThis.LinkTabsRules` 在 Node 中也会被赋值，方便测试与浏览器环境行为一致，符合计划“同一对象”的要求。

## 关注点

- 无阻塞项。后续 Task 3 将在本测试文件中补充域名格式、`includeSubdomains` 布尔值、动作枚举与网址模式边界测试，并可能收紧校验器；当前实现为此留有余地。
- Git 提示 LF→CRLF 换行转换（Windows 环境），不影响功能或测试。

---

# Task 1 修复报告（fix round 1/5）

- 状态：DONE
- FIX_BASE：`0ff399cb819be51f9c492fc61eda2adec632f763`
- 修复提交：`bc1c4d5` — `fix: validate url rule authority structure`
- 覆盖文件：`src/shared/rules.js`、`tests/rules.test.js`

## 修复的发现

### 发现 1：`validateUrlRule` 接受非法 authority

- 变更：新增 `isValidUrlAuthority(authority)`。它先拒绝含空白或反斜杠的 authority，再把每个 `*` 替换为在主机/端口位置都合法的占位字符 `0`，用 `new URL("http://" + probe + "/")` 校验整体结构并要求 hostname 非空。`validateUrlRule` 在原 host 非空检查之后调用该函数，非法 authority 返回 `{ valid: false, error: "Pattern authority is invalid" }`。
- 原理：`*` 匹配零个或多个字符，用具体字符串 `0` 代入后若 URL 解析器仍接受，则说明存在合法实例；解析器会拒绝空格、非法端口、非法 IPv6 等结构。
- 效果：`https://exa mple.com/*`、`https://example.com:bad/*`、`https://[invalid]/*` 现在均为无效，`normalizeSettings` 会将其过滤；`https://*.example.com/*`、`https://example.com:8080/private/*`、`https://[2001:db8::1]/*` 仍为有效，通配符端口（如 `:80*`）与通配符 IPv6（如 `[::*]`）也仍被接受。

### 发现 2：域名规则首条匹配顺序未测试

- 变更：在 `tests/rules.test.js` 新增回归测试「域名规则按列表顺序匹配，第一条匹配生效」。使用两条都匹配 `https://shop.example.com/` 的域名规则（第一条 `native`，第二条 `foreground`），断言第一条生效；并单独用第二条规则证明其本身可匹配，从而证明是顺序而非匹配失败。
- 说明：实现本就按数组顺序返回首个匹配，因此该测试在修复前即通过，属于覆盖缺口，不涉及实现变更。

## TDD 证据

### RED（先加测试，未改实现）

命令：`npm test`，退出码 1：

```
✖ 拒绝主机名、端口或 IPv6 非法的网址规则
✖ normalizeSettings 丢弃 authority 非法的网址规则
ℹ tests 13
ℹ pass 11
ℹ fail 2
```

两个失败均为既有实现把非法 authority 判为有效/保留所致，正是发现 1 所描述的行为。

### GREEN（修复后，提交后复跑一致）

命令：`npm test`，退出码 0：

```
✔ 默认行为是在后台打开
✔ 可配置全局默认行为
✔ 网址规则覆盖域名规则，且网址规则按列表顺序匹配
✔ 域名规则按边界匹配子域
✔ 禁用和非网页协议不拦截
✔ 拒绝非 HTTP/HTTPS 网址规则
✔ 拒绝主机名、端口或 IPv6 非法的网址规则
✔ 网址规则接受合法主机、端口与通配符
✔ normalizeSettings 丢弃 authority 非法的网址规则
✔ 网址规则主机名不区分大小写但路径区分大小写
✔ 域名规则默认只匹配完整主机名
✔ 域名规则按列表顺序匹配，第一条匹配生效
✔ normalizeSettings 填充默认值并过滤无效规则
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

## 自审

- `git diff --check`：无空白错误；提交后 `git status`：工作区干净。
- 修复范围仅两个文件，只覆盖两个发现，未扩大范围。
- 未改动 `resolveAction`、域名匹配、大小写归一化等既有行为；新增测试不会引入对完整 URL 忽略大小写的匹配。
- 提交后复跑 `npm test` 仍为 13/13 通过。

## 关注点

- 校验器现为 ASCII 主机 + URL 解析器双重约束，会被拒绝的合法但少见的模式：IDN（如 `https://münchen.de/*`）与尾点 FQDN（`https://example.com./*`）。这与既有 `validateDomainRule` 的严格 ASCII 风格一致，且 `normalizeUrlForMatch` 不做 punycode，故接受它们本也不会匹配真实 URL。
- 未直接实现显式标签级结构校验，而是用「`*`→`0` 代入 + URL 解析器」作为结构判定；好处是与浏览器 URL 规范一致，风险是极少数解析器怪癖（如 `.`、`..` 作为主机被接受）会保留，但这不属于本次发现范围且不影响匹配安全。
- 仅使用 Node 内置 `node:test`，无第三方依赖。

---

# Task 1 修复报告（fix round 2/5）

- 状态：DONE
- FIX_BASE：`bc1c4d5e32fb36045122a3fd261d03c04b2ed34d`
- 修复提交：`b36184c` — `fix: accept wildcard IPv6 authorities`
- 覆盖文件：`src/shared/rules.js`、`tests/rules.test.js`

## 修复内容

- 新增聚焦回归：`https://[*]/*` 通过校验并匹配 `https://[2001:db8::1]/private`。
- 普通 authority 保留 URL 解析器严格校验；仅对含通配符的 bracketed IPv6 检查是否存在合法的 8-hextet 或 `::` 压缩展开，再独立校验 userinfo/端口后缀。
- 继续拒绝空白、反斜杠、非法端口、非法 bracketed IPv6；未改动匹配顺序、大小写或域名行为。

## TDD 证据

### RED

命令：`node --test tests/rules.test.js`，退出码 1：

```text
✖ 网址规则接受可展开为合法 IPv6 authority 的通配符
ℹ tests 14
ℹ pass 13
ℹ fail 1
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
false !== true
```

### GREEN（提交后全量复跑）

命令：`npm test`，退出码 0：

```text
> test
> node --test
✔ 默认行为是在后台打开
✔ 可配置全局默认行为
✔ 网址规则覆盖域名规则，且网址规则按列表顺序匹配
✔ 域名规则按边界匹配子域
✔ 禁用和非网页协议不拦截
✔ 拒绝非 HTTP/HTTPS 网址规则
✔ 拒绝主机名、端口或 IPv6 非法的网址规则
✔ 网址规则接受合法主机、端口与通配符
✔ 网址规则接受可展开为合法 IPv6 authority 的通配符
✔ normalizeSettings 丢弃 authority 非法的网址规则
✔ 网址规则主机名不区分大小写但路径区分大小写
✔ 域名规则默认只匹配完整主机名
✔ 域名规则按列表顺序匹配，第一条匹配生效
✔ normalizeSettings 填充默认值并过滤无效规则
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 347.9524
```

## 自审

- 测试覆盖 validation 与 resolver；恢复单一 `*`→`0` 探针会失败。
- 新分支仅处理 bracketed IPv6 通配符，普通 authority 仍走既有 URL parser。
- 手工边界探测：`[::*]`、`[2001:*]`、`[*::1]` 接受；`[invalid*]` 与 `[*]:bad` 拒绝。
- `git diff --check HEAD^ HEAD` 无输出；提交后工作区干净。

## 关注点

- 存在性检查覆盖纯十六进制 hextet 与 `::` 压缩形式；未新增 IPv4-embedded IPv6 通配符支持，避免超出最小修复。
- Windows Git 的 LF→CRLF 提示不影响当前 diff 或测试。

---

# Task 1 修复报告（fix round 3/5）

- 状态：DONE
- FIX_BASE：`b36184c2d95ccbb37978bf1b399f3f325f841202`
- 修复提交：`3d463b4` — `fix: honor wildcard authority expansions`
- 覆盖文件：`src/shared/rules.js`、`tests/rules.test.js`

## 根因与修复

- 根因：普通 authority 和 bracketed IPv6 后缀都将每个 `*` 固定替换成 `0`，没有检查零长度或其他合法展开；IPv6 shape 匹配器又通过每个 pattern 字符递归，超长通配符串会耗尽调用栈。
- 将 IPv6 shape 匹配改为迭代式 glob 算法，保留 `*` 的零或多字符语义且不依赖调用栈。
- 对端口模式查找 `0..65535` 中真实可匹配的合法展开，允许 `65535*` 取空展开，同时继续拒绝无合法展开的端口。
- 普通和 bracketed IPv6 authority 分别校验 userinfo、host、port 的独立展开，再交由 `URL` 解析器确认组合结构；没有移除 malformed-authority 校验或设置长度上限。

## TDD 证据

### RED（只新增测试、未改生产代码）

命令：`node --test tests/rules.test.js`，退出码 1：

```text
✖ authority 通配符可用空展开保留有效端口
✖ IPv6 authority 与端口通配符可分别选择有效展开
✖ 超长 IPv6 通配符串的校验不会抛出
ℹ tests 17
ℹ pass 14
ℹ fail 3
RangeError: Maximum call stack size exceeded
```

### GREEN（修复后全量）

命令：`npm test`，退出码 0：

```text
> test
> node --test
✔ 默认行为是在后台打开
✔ 可配置全局默认行为
✔ 网址规则覆盖域名规则，且网址规则按列表顺序匹配
✔ 域名规则按边界匹配子域
✔ 禁用和非网页协议不拦截
✔ 拒绝非 HTTP/HTTPS 网址规则
✔ 拒绝主机名、端口或 IPv6 非法的网址规则
✔ 网址规则接受合法主机、端口与通配符
✔ 网址规则接受可展开为合法 IPv6 authority 的通配符
✔ authority 通配符可用空展开保留有效端口
✔ IPv6 authority 与端口通配符可分别选择有效展开
✔ 超长 IPv6 通配符串的校验不会抛出
✔ normalizeSettings 丢弃 authority 非法的网址规则
✔ 网址规则主机名不区分大小写但路径区分大小写
✔ 域名规则默认只匹配完整主机名
✔ 域名规则按列表顺序匹配，第一条匹配生效
✔ normalizeSettings 填充默认值并过滤无效规则
ℹ tests 17
ℹ suites 0
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 112.8996
```

## 变更文件与回归覆盖

- `tests/rules.test.js`：新增 `https://example.com:65535*/*`、组合 `https://[*]:65535*/*` 的 validation/resolution 回归，以及 20,000 个 `*` 的不抛异常、结构化成功结果测试。
- `src/shared/rules.js`：迭代式 IPv6 glob 匹配、迭代式普通 glob 匹配、合法端口展开查找及按 authority 组件验证。
- 额外 malformed 探测继续拒绝：`:65536*`、`[invalid*]`、IPv6 `:bad` 和含空格 host。

## 自审与关注点

- `git diff --check` 无空白错误（仅 Windows LF→CRLF 提示）。
- 修复未改变规则匹配顺序、hostname/path 大小写规则或 domain 行为。
- 端口存在性检查最多扫描 65,536 个短字符串；这是有限协议域的完整判定，不是输入长度上限。当前测试运行约 113 ms，无阻塞关注点。
- 修复提交 `3d463b4` 包含生产代码、回归测试及本轮报告初稿；后续仅以文档提交补录该哈希。
