const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
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

// 回归：authority 结构必须合法，`*` 占位符仍被接受。
test("拒绝主机名、端口或 IPv6 非法的网址规则", () => {
  for (const pattern of [
    "https://exa mple.com/*",
    "https://example.com:bad/*",
    "https://example.com:65536/*",
    "https://[invalid]/*"
  ]) {
    assert.equal(validateUrlRule({ pattern, action: "background" }).valid, false, pattern);
  }
});
test("网址规则接受合法主机、端口与通配符", () => {
  for (const pattern of [
    "https://example.com/*",
    "https://*.example.com/*",
    "https://example.com:8080/private/*",
    "https://[2001:db8::1]/*"
  ]) {
    assert.equal(validateUrlRule({ pattern, action: "background" }).valid, true, pattern);
  }
});
test("星号可提供 IPv6 authority 所需的方括号", () => {
  const pattern = "https://*::1*/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://[::1]/x", {
    ...base,
    urlRules: [{ pattern, action: "native" }]
  }), "native");

  // The star can supply userinfo's @ and an IPv6 bracket, making this a valid
  // URL expansion even though the literal-only authority would be malformed.
  const expandedPattern = "https://[invalid*]/*";
  assert.equal(validateUrlRule({ pattern: expandedPattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://[invalid@[::]/x", {
    ...base,
    urlRules: [{ pattern: expandedPattern, action: "native" }]
  }), "native");
});
test("星号可提供 authority 中的 @ 分隔符", () => {
  const pattern = "https://user:*example.com/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://user:@example.com/x", {
    ...base,
    urlRules: [{ pattern, action: "native" }]
  }), "native");
});
test("星号可将非法端口字面变为 userinfo，固定非法端口仍拒绝", () => {
  const wildcardPattern = "https://example.com:65536*/*";
  assert.equal(validateUrlRule({ pattern: wildcardPattern, action: "foreground" }).valid, true);
  assert.equal(resolveAction("https://example.com:65536@foo/x", {
    ...base,
    urlRules: [{ pattern: wildcardPattern, action: "foreground" }]
  }), "foreground");
  assert.equal(validateUrlRule({ pattern: "https://example.com:65536/*", action: "foreground" }).valid, false);
});
test("网址规则支持独立通配符形成合法的普通主机和 userinfo", () => {
  for (const pattern of [
    // %61 是合法的主机名展开；两颗星分别需匹配空串和 "61"。
    "https://*%*/*",
    "https://*%*@example.com/*",
    // URL parser 接受 %C3%80；星号需补上完整的百分号编码字节。
    "https://%C3*/*"
  ]) {
    assert.equal(validateUrlRule({ pattern, action: "background" }).valid, true, pattern);
  }
});
test("网址规则接受可展开为合法 IPv6 authority 的通配符", () => {
  const pattern = "https://[*]/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://[2001:db8::1]/private", {
    ...base,
    urlRules: [{ pattern, action: "native" }]
  }), "native");
  const emptyExpansionPattern = "https://[::*]/*";
  assert.equal(validateUrlRule({ pattern: emptyExpansionPattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://[::]/private", {
    ...base,
    urlRules: [{ pattern: emptyExpansionPattern, action: "native" }]
  }), "native");
});
test("authority 通配符可用空展开保留有效端口", () => {
  const pattern = "https://example.com:65535*/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://example.com:65535/private", {
    ...base,
    urlRules: [{ pattern, action: "native" }]
  }), "native");
});
test("IPv6 authority 与端口通配符可分别选择有效展开", () => {
  const pattern = "https://[*]:65535*/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://[2001:db8::1]:65535/private", {
    ...base,
    urlRules: [{ pattern, action: "native" }]
  }), "native");
});
test("拒绝包含长通配符序列和不可能字面的 IPv6 模式且校验及时", () => {
  const pattern = `https://[${"*".repeat(1000)}g]/*`;
  const startedAt = performance.now();
  const result = validateUrlRule({ pattern, action: "background" });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(result.valid, false);
  assert.ok(elapsedMs < 500, `validation took ${elapsedMs.toFixed(1)}ms`);
});
test("超长 IPv6 通配符串的校验不会抛出", () => {
  const pattern = "https://[" + "*".repeat(20000) + "]/*";
  let result;
  assert.doesNotThrow(() => {
    result = validateUrlRule({ pattern, action: "native" });
  });
  assert.deepEqual(result, { valid: true });
});
test("normalizeSettings 丢弃 authority 非法的网址规则", () => {
  const { normalizeSettings } = require("../src/shared/rules.js");
  const normalized = normalizeSettings({
    ...base,
    urlRules: [
      { pattern: "https://exa mple.com/*", action: "background" },
      { pattern: "https://example.com:bad/*", action: "background" },
      { pattern: "https://[invalid]/*", action: "background" },
      { pattern: "https://*.example.com/*", action: "native" }
    ]
  });
  assert.deepEqual(normalized.urlRules, [
    { pattern: "https://*.example.com/*", action: "native" }
  ]);
});

// 预检裁定回归：网址规则主机名不区分大小写，路径/查询仍区分大小写。
test("网址规则主机名不区分大小写但路径区分大小写", () => {
  const settings = { ...base, urlRules: [
    { pattern: "https://Example.com/Private/*", action: "native" }
  ] };
  assert.equal(resolveAction("https://example.com/Private/a", settings), "native");
  assert.equal(resolveAction("https://example.com/private/a", settings), "background");
});
test("域名规则默认只匹配完整主机名", () => {
  const settings = { ...base, domainRules: [{ domain: "example.com", includeSubdomains: false, action: "foreground" }] };
  assert.equal(resolveAction("https://example.com/", settings), "foreground");
  assert.equal(resolveAction("https://shop.example.com/", settings), "background");
});

// 回归：同一类别规则按用户顺序匹配，第一条匹配的规则生效。
test("域名规则按列表顺序匹配，第一条匹配生效", () => {
  const rules = [
    { domain: "example.com", includeSubdomains: true, action: "native" },
    { domain: "shop.example.com", includeSubdomains: false, action: "foreground" }
  ];
  const settings = { ...base, domainRules: rules };
  assert.equal(resolveAction("https://shop.example.com/", settings), "native");
  assert.equal(resolveAction("https://www.example.com/", settings), "native");
  // 第二条规则本身也匹配，只是顺序在后，证明是顺序而非匹配失败。
  assert.equal(resolveAction("https://shop.example.com/", { ...base, domainRules: [rules[1]] }), "foreground");
});
test("normalizeSettings 填充默认值并过滤无效规则", () => {
  const { normalizeSettings } = require("../src/shared/rules.js");
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const normalized = normalizeSettings({
    enabled: false,
    defaultAction: "bogus",
    domainRules: [{ domain: "example.com", includeSubdomains: false, action: "foreground" }, { domain: "", action: "background" }],
    urlRules: [{ pattern: "ftp://example.com/*", action: "background" }, { pattern: "https://example.com/*", action: "native" }]
  });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.defaultAction, "background");
  assert.deepEqual(normalized.domainRules, [{ domain: "example.com", includeSubdomains: false, action: "foreground" }]);
  assert.deepEqual(normalized.urlRules, [{ pattern: "https://example.com/*", action: "native" }]);
});
