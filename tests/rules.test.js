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

// 回归：authority 结构必须合法，`*` 占位符仍被接受。
test("拒绝主机名、端口或 IPv6 非法的网址规则", () => {
  for (const pattern of [
    "https://exa mple.com/*",
    "https://example.com:bad/*",
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
test("网址规则接受可展开为合法 IPv6 authority 的通配符", () => {
  const pattern = "https://[*]/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  assert.equal(resolveAction("https://[2001:db8::1]/private", {
    ...base,
    urlRules: [{ pattern, action: "native" }]
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
