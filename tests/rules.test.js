const test = require("node:test");
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const {
  DEFAULT_SETTINGS,
  normalizeSettings,
  resolveAction,
  validateDomainRule,
  validateUrlRule,
  validateSearchUrl,
  SEARCH_ENGINES,
  buildSearchUrl
} = require("../src/shared/rules.js");

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
  assert.equal(resolveAction(new URL("https://[::1]/x").href, {
    ...base,
    urlRules: [{ pattern, action: "native" }]
  }), "native");
});
test("拒绝无法匹配任何序列化 href 的 authority 模式", () => {
  for (const pattern of [
    // 序列化后的 authority 里字面 `[` 只能作为 IPv6 方括号出现，`invalid` 不是合法的
    // IPv6 内容，因此 `[invalid*]` 无论星号展开成什么都无法出现在任何 href 中。
    "https://[invalid*]/*",
    // 主机名里的百分号转义会被解析器解码改写，序列化结果中不会留下 `%41`。
    "https://a%41b.com/*",
    // 字面 IPv6 会被规范化：前导零被压缩、IPv4-embedded 形式改写为十六进制。
    "https://[0:0:0:0:0:0:0:1]/*",
    "https://[::ffff:1.2.3.4]/*",
    // IPv4 字面同样会被规范化（十六进制、前导零写法都会被改写）。
    "https://192.168.001.1/*",
    "https://0x7f.1/*"
  ]) {
    assert.equal(validateUrlRule({ pattern, action: "native" }).valid, false, pattern);
  }
  // 这类规则在旧实现里被接受但永远不会命中，现在必须被丢弃。
  assert.deepEqual(normalizeSettings({
    ...base,
    urlRules: [{ pattern: "https://[invalid*]/*", action: "native" }]
  }).urlRules, []);
});
test("星号可提供 authority 中的 @ 分隔符", () => {
  const pattern = "https://user:*example.com/*";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  const settings = { ...base, urlRules: [{ pattern, action: "native" }] };
  // 生产契约是序列化后的 href：星号在这里提供密码与 `@` 分隔符（`pass@`）。
  assert.equal(resolveAction(new URL("https://user:pass@example.com/x").href, settings), "native");
  // 序列化会丢弃空密码的冒号（`https://user:@example.com/x` 序列化为
  // `https://user@example.com/x`），所以这种写法不可能命中规则。
  assert.equal(resolveAction(new URL("https://user:@example.com/x").href, settings), "background");
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
  for (const [pattern, href] of [
    // 星号在 userinfo 里补出 `@` 与主机名；`%` 在序列化后的 userinfo 中保持原样。
    ["https://*%*/*", "https://%41@a/x"],
    ["https://*%*@example.com/*", "https://%41@example.com/x"],
    ["https://%C3*/*", "https://%c3@a/x"]
  ]) {
    assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true, pattern);
    assert.equal(new URL(href).href, href, href);
    assert.equal(resolveAction(href, {
      ...base,
      urlRules: [{ pattern, action: "native" }]
    }), "native", pattern);
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

// 不变式：validateUrlRule 接受的每个模式都必须能命中某个序列化后的 href，
// 否则规则会被保存下来却永远不会生效。下面的 href 都已通过 new URL 往返验证，
// 与内容脚本实际传入的 target.href 形式一致。
test("接受的网址模式都能命中某个序列化后的 href", () => {
  for (const [pattern, href] of [
    ["https://*/*", "https://a/x"],
    ["https://*.example.com/*", "https://a.example.com/x"],
    ["https://*.com/*", "https://a.com/x"],
    ["https://*:8080/*", "https://a:8080/x"],
    ["https://*::1*/*", "https://[::1]/x"],
    ["https://*@example.com/*", "https://a@example.com/x"],
    ["https://*[::1]*/*", "https://a@[::1]/x"],
    ["https://*%*/*", "https://%41@a/x"],
    ["https://%C3*/*", "https://%c3@a/x"],
    ["https://[*]/*", "https://[2001:db8::1]/x"],
    ["https://[::*]/*", "https://[::]/x"],
    ["https://[::*]:*/", "https://[::]:8080/"],
    ["https://user:*/*", "https://user:pass@example.com/x"],
    ["https://user:*example.com/*", "https://user:pass@example.com/x"],
    ["https://x*@y*/*", "https://xa@ya/x"],
    ["https://example.com:*/", "https://example.com:8080/"],
    ["https://example.com:0*/*", "https://example.com:0/x"],
    ["https://example.com:65535*/*", "https://example.com:65535/x"],
    ["https://example.com:65536*/*", "https://example.com:65536@foo/x"],
    ["https://[*]:65535*/*", "https://[2001:db8::1]:65535/x"],
    ["https://**:*/*", "https://a:8080/x"],
    // 数字主机：星号展开为空会被解析成 IPv4，因此校验时会要求星号至少展开一个字符。
    ["https://0*/*", "https://0.0.0.0/x"],
    ["https://192.168.1*/*", "https://192.168.1.5/x"],
    // 无星号的模式：字面 authority 必须本身就是序列化结果。
    ["https://example.com/*", "https://example.com/x"],
    ["https://example.com./*", "https://example.com./x"],
    ["https://localhost/*", "https://localhost/x"],
    ["https://a_b.com/*", "https://a_b.com/x"],
    ["https://a~b.com/*", "https://a~b.com/x"],
    ["https://a;b.com/*", "https://a;b.com/x"],
    ["https://a=b.com/*", "https://a=b.com/x"],
    ["https://xn--fsqu00a.com/*", "https://xn--fsqu00a.com/x"],
    ["https://[2001:db8::1]/*", "https://[2001:db8::1]/x"],
    ["https://user:pass@example.com/*", "https://user:pass@example.com/x"],
    ["https://example.com:8080/private/*", "https://example.com:8080/private/x"],
    ["https://Example.com/Private/*", "https://example.com/Private/a"]
  ]) {
    assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true, pattern);
    // href 必须本身就是浏览器序列化的结果，即内容脚本实际传入的形式。
    assert.equal(new URL(href).href, href, href);
    assert.equal(resolveAction(href, {
      ...base,
      urlRules: [{ pattern, action: "native" }]
    }), "native", `${pattern} should match ${href}`);
  }
});

// 回归：匹配改为线性通配符匹配。旧实现按 `*` 分段编译回溯正则，
// 该模式对一长串不匹配的 `a` 需要十几秒，会冻结点击处理。
test("病态通配符模式的匹配保持线性且不阻塞点击", () => {
  const pattern = "https://example.com/" + "a*".repeat(9) + "b";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  const href = "https://example.com/" + "a".repeat(20000);
  const startedAt = performance.now();
  const action = resolveAction(href, { ...base, urlRules: [{ pattern, action: "native" }] });
  const elapsedMs = performance.now() - startedAt;
  assert.equal(action, "background");
  assert.ok(elapsedMs < 250, `matching took ${elapsedMs.toFixed(1)}ms`);
});
// 回归：旧实现在约 1 万颗星时会因 new RegExp 抛出 SyntaxError，异常会逃出点击监听。
test("超长星号序列的网址规则可正常校验和匹配且不抛错", () => {
  const pattern = "https://example.com/" + "*".repeat(12000) + "tail";
  assert.equal(validateUrlRule({ pattern, action: "native" }).valid, true);
  const settings = { ...base, urlRules: [{ pattern, action: "native" }] };
  assert.doesNotThrow(() => {
    assert.equal(resolveAction("https://example.com/tail", settings), "native");
    assert.equal(resolveAction("https://example.com/other", settings), "background");
  });
});
// 匹配语义：`*` 匹配零个或多个字符，其余字符按字面比较。
// 旧实现把模式编译成正则，这里确认正则元字符不再有特殊含义。
test("通配符匹配按字面处理正则元字符且星号可匹配空串", () => {
  const settings = {
    ...base,
    defaultAction: "native",
    urlRules: [
      { pattern: "https://example.com/a.b/*", action: "foreground" },
      { pattern: "https://example.com/(x)+/*", action: "background" },
      { pattern: "https://example.com/a*/b", action: "foreground" }
    ]
  };
  assert.equal(resolveAction("https://example.com/a.b/c", settings), "foreground");
  assert.equal(resolveAction("https://example.com/(x)+/c", settings), "background");
  // `.` 不再匹配任意字符，`(x)+` 也不再表示重复。
  assert.equal(resolveAction("https://example.com/axb/c", settings), "native");
  assert.equal(resolveAction("https://example.com/xx/c", settings), "native");
  // 星号匹配零个或多个字符。
  assert.equal(resolveAction("https://example.com/a/b", settings), "foreground");
  assert.equal(resolveAction("https://example.com/aXXb/b", settings), "foreground");
});
// 回归：模式中的 `*` 与 href 中的字面 `*` 对齐时，星号必须展开匹配，而不是被当作字面字符消费。
test("星号与 href 中的字面星号对齐时仍可展开匹配", () => {
  const settings = { ...base, defaultAction: "native",
    urlRules: [{ pattern: "https://example.com/*", action: "foreground" }] };
  assert.equal(resolveAction("https://example.com/*foo", settings), "foreground");
  assert.equal(resolveAction("https://example.com/**", settings), "foreground");
  assert.equal(resolveAction("https://example.com/a*b", settings), "foreground");
  assert.equal(resolveAction("https://example.com/plain", settings), "foreground");
  assert.equal(resolveAction("https://other.example/*foo", settings), "native");
});
// 匹配语义的随机对照：与参考实现（其余字符字面转义、`*` 转为 `.*`）在含字面星号的输入上保持一致。
test("通配符匹配在含字面星号的输入上与参考实现一致", () => {
  assert.equal(new URL("https://example.com/a*b**").href, "https://example.com/a*b**");
  const chars = "ab*";
  let seed = 1;
  const next = (bound) => {
    seed = (seed * 48271) % 2147483647;
    return seed % bound;
  };
  const randomText = (maxLength) => {
    let text = "";
    const length = 1 + next(maxLength);
    for (let index = 0; index < length; index += 1) text += chars[next(chars.length)];
    return text;
  };
  const referenceMatches = (pattern, value) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? ".*" : "\\" + ch));
    return new RegExp("^" + escaped + "$").test(value);
  };
  for (let round = 0; round < 2000; round += 1) {
    const pattern = "https://example.com/" + randomText(8);
    const href = "https://example.com/" + randomText(16);
    const settings = { ...base, defaultAction: "native",
      urlRules: [{ pattern, action: "foreground" }] };
    const expected = referenceMatches(pattern, href) ? "foreground" : "native";
    assert.equal(resolveAction(href, settings), expected, `${pattern} vs ${href}`);
  }
});
test("normalizeSettings 丢弃 authority 非法的网址规则", () => {
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
    { pattern: "https://*.example.com/*", action: "native", click: true, drag: true, search: true }
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
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const normalized = normalizeSettings({
    enabled: false,
    defaultAction: "bogus",
    domainRules: [{ domain: "example.com", includeSubdomains: false, action: "foreground" }, { domain: "", action: "background" }],
    urlRules: [{ pattern: "ftp://example.com/*", action: "background" }, { pattern: "https://example.com/*", action: "native" }]
  });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.defaultAction, "background");
  assert.deepEqual(normalized.domainRules, [{ domain: "example.com", includeSubdomains: false, action: "foreground", click: true, drag: true, search: true }]);
  assert.deepEqual(normalized.urlRules, [{ pattern: "https://example.com/*", action: "native", click: true, drag: true, search: true }]);
});

// ===== Task 3：设置页规则输入的边界校验 =====

const domainRule = (domain, includeSubdomains = false, action = "background") => (
  validateDomainRule({ domain, includeSubdomains, action })
);
const urlRule = (pattern, action = "background") => validateUrlRule({ pattern, action });
const errorOf = result => {
  assert.equal(result.valid, false);
  assert.equal(typeof result.error, "string");
  assert.notEqual(result.error.trim(), "");
  return result.error;
};

test("规则校验只返回 { valid: true } 或带具体原因的失败对象", () => {
  assert.deepEqual(domainRule("example.com"), { valid: true });
  assert.deepEqual(urlRule("https://example.com/*"), { valid: true });
  for (const result of [
    validateDomainRule(null),
    validateUrlRule(null),
    validateDomainRule([{ domain: "example.com", includeSubdomains: false, action: "background" }]),
    validateUrlRule([])
  ]) {
    errorOf(result);
  }
});

test("域名规则接受规范域名格式", () => {
  for (const domain of [
    "example.com",
    "sub.example.com",
    "Example.COM",
    "my-host.example.co.uk",
    "localhost",
    "xn--fiq228c.cn",
    "192.168.1.1"
  ]) {
    assert.equal(domainRule(domain).valid, true, domain);
  }
});

test("域名规则拒绝非法域名格式", () => {
  for (const domain of [
    "",
    "   ",
    "exa mple.com",
    "-example.com",
    "example-.com",
    "example..com",
    ".example.com",
    "example.com.",
    "*.example.com",
    "http://example.com",
    "example.com/path",
    "example.com:8080",
    "例子.com"
  ]) {
    errorOf(domainRule(domain));
  }
});

test("域名规则要求包含子域名选项为布尔值", () => {
  for (const includeSubdomains of [undefined, null, "true", "false", 0, 1]) {
    errorOf(validateDomainRule({ domain: "example.com", includeSubdomains, action: "background" }));
  }
  assert.equal(domainRule("example.com", true).valid, true);
});

test("域名规则拒绝超出 DNS 长度上限的域名", () => {
  const maxLabel = "a".repeat(63) + ".example.com";
  const tooLongLabel = "a".repeat(64) + ".example.com";
  const maxDomain = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)].join(".");
  const tooLongDomain = ["a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)].join(".");
  assert.equal(maxDomain.length, 253);
  assert.equal(tooLongDomain.length, 254);
  assert.equal(domainRule(maxLabel).valid, true);
  assert.equal(domainRule(maxDomain).valid, true);
  errorOf(domainRule(tooLongLabel));
  errorOf(domainRule(tooLongDomain));
  // 超过上限的域名不可能出现在任何网址主机名中，规则必须被判为无效而不能静默存入。
  assert.deepEqual(
    normalizeSettings({ domainRules: [{ domain: tooLongLabel, includeSubdomains: false, action: "background" }] }).domainRules,
    []
  );
});

test("规则动作必须是受支持的枚举值", () => {
  for (const action of ["background", "foreground", "native"]) {
    assert.equal(domainRule("example.com", false, action).valid, true, action);
    assert.equal(urlRule("https://example.com/*", action).valid, true, action);
  }
  for (const action of ["Background", "back", "activate", "", null, undefined, 1]) {
    // 直接构造规则对象，避免测试辅助函数的默认参数把 undefined 变成合法值。
    errorOf(validateDomainRule({ domain: "example.com", includeSubdomains: false, action }));
    errorOf(validateUrlRule({ pattern: "https://example.com/*", action }));
  }
});

test("网址规则只接受 HTTP 与 HTTPS 模式", () => {
  for (const pattern of [
    "http://example.com/*",
    "https://example.com/*",
    "HTTPS://example.com/*",
    "https://example.com:8080/path?q=1#frag",
    "https://*.example.com/*"
  ]) {
    assert.equal(urlRule(pattern).valid, true, pattern);
  }
  for (const pattern of [
    "ftp://example.com/*",
    "javascript:alert(1)",
    "chrome://settings/*",
    "file:///c:/x/*",
    "//example.com/*",
    "example.com/*",
    "https:/example.com/*"
  ]) {
    errorOf(urlRule(pattern));
  }
});

test("网址规则拒绝缺少主机名的模式", () => {
  for (const pattern of ["", "   ", "https://", "https:///path", "https://?q", "https://#f", "https:///*", "https://:8080/*"]) {
    errorOf(urlRule(pattern));
  }
});

// href 一律是序列化后的形式：IDN 主机是 punycode，非 ASCII 字符会被百分号编码，
// 因此含非 ASCII 的模式永远匹配不到任何链接，必须直接拒绝并给出可操作的提示。
test("网址规则拒绝非 ASCII 字符并提示改用 punycode", () => {
  for (const pattern of [
    "https://例子.com/*",
    "https://example.com/中文/*",
    "https://example.com/*?q=中文"
  ]) {
    const error = errorOf(urlRule(pattern));
    assert.match(error, /punycode/);
    assert.match(error, /xn--/);
  }
  assert.deepEqual(normalizeSettings({
    ...base,
    urlRules: [{ pattern: "https://例子.com/*", action: "native" }]
  }).urlRules, []);
  // punycode 形式照常可用，并且能命中同一域名真实的序列化 href。
  const pattern = "https://xn--fsqu00a.com/*";
  assert.equal(urlRule(pattern).valid, true);
  const href = new URL("https://例子.com/x").href;
  assert.equal(href, "https://xn--fsqu00a.com/x");
  assert.equal(resolveAction(href, { ...base, urlRules: [{ pattern, action: "native" }] }), "native");
});

test("校验失败给出可区分的具体原因", () => {
  const domainErrors = new Set([
    errorOf(validateDomainRule(null)),
    errorOf(domainRule("")),
    errorOf(domainRule("exa mple.com")),
    errorOf(domainRule("a".repeat(64) + ".example.com")),
    errorOf(validateDomainRule({ domain: "example.com", includeSubdomains: "yes", action: "background" })),
    errorOf(domainRule("example.com", false, "bogus"))
  ]);
  assert.equal(domainErrors.size, 6);
  const urlErrors = new Set([
    errorOf(validateUrlRule(null)),
    errorOf(urlRule("")),
    errorOf(urlRule("ftp://example.com/*")),
    errorOf(urlRule("https://")),
    errorOf(urlRule("https://exa mple.com/*")),
    errorOf(urlRule("https://例子.com/*")),
    errorOf(urlRule("https://example.com/*", "bogus"))
  ]);
  assert.equal(urlErrors.size, 7);
});

test("搜索引擎默认为 Bing 且非法取值回退", () => {
  assert.equal(DEFAULT_SETTINGS.searchEngine, "bing");
  assert.equal(DEFAULT_SETTINGS.searchUrl, "");
  assert.deepEqual(SEARCH_ENGINES, ["bing", "google", "baidu", "custom"]);
  assert.equal(normalizeSettings({}).searchEngine, "bing");
  assert.equal(normalizeSettings({ searchEngine: "baidu" }).searchEngine, "baidu");
  assert.equal(normalizeSettings({ searchEngine: "duckduckgo" }).searchEngine, "bing");
});
test("按所选搜索引擎构造搜索网址并编码查询", () => {
  const preset = name => normalizeSettings({ searchEngine: name });
  assert.equal(buildSearchUrl("hello world", preset("bing")), "https://www.bing.com/search?q=hello%20world");
  assert.equal(buildSearchUrl("中文&词", preset("google")), "https://www.google.com/search?q=" + encodeURIComponent("中文&词"));
  assert.equal(buildSearchUrl("测试", preset("baidu")), "https://www.baidu.com/s?wd=" + encodeURIComponent("测试"));
});
test("自定义搜索引擎使用自定义地址模板", () => {
  const settings = normalizeSettings({ searchEngine: "custom", searchUrl: "https://s.example.com/find?query=%s&lang=zh" });
  assert.equal(settings.searchEngine, "custom");
  assert.equal(buildSearchUrl("a b", settings), "https://s.example.com/find?query=a%20b&lang=zh");
});
test("自定义地址非法时回退默认引擎", () => {
  assert.equal(normalizeSettings({ searchEngine: "custom", searchUrl: "https://s.example.com/find" }).searchEngine, "bing");
  assert.equal(normalizeSettings({ searchEngine: "custom", searchUrl: "ftp://s.example.com/?q=%s" }).searchEngine, "bing");
  assert.equal(normalizeSettings({ searchEngine: "custom", searchUrl: "" }).searchEngine, "bing");
  assert.equal(validateSearchUrl("https://s.example.com/?q=%s").valid, true);
  assert.equal(validateSearchUrl("https://s.example.com/?q=").valid, false);
  assert.equal(validateSearchUrl(42).valid, false);
});
test("自定义模板只替换第一个 %s，预设引擎保留存储的 searchUrl", () => {
  const custom = normalizeSettings({ searchEngine: "custom", searchUrl: "https://s.example.com/?q=%s&x=%s" });
  // 约定：只替换第一个 %s，其余保持字面（写多个占位符没有额外含义）。
  assert.equal(buildSearchUrl("a", custom), "https://s.example.com/?q=a&x=%s");
  const preset = normalizeSettings({ searchEngine: "google", searchUrl: "https://kept.example.com/?q=%s" });
  assert.equal(preset.searchEngine, "google");
  assert.equal(preset.searchUrl, "https://kept.example.com/?q=%s");
});
test("本地页面（file://）上拖动文字搜索按全局默认行为处理", () => {
  // 链接目标仍限 HTTP(S)；拖动文字搜索按当前页面匹配，本地页面命中不到规则时用默认行为。
  assert.equal(resolveAction("file:///E:/doc/test.html", base, "search"), "background");
  assert.equal(resolveAction("file:///E:/doc/test.html", base, "click"), "native");
  assert.equal(resolveAction("file:///E:/doc/test.html", base, "drag"), "native");
  assert.equal(resolveAction("file:///E:/doc/test.html", { ...base, textDragEnabled: false }, "search"), "native");
});

// ===== 三块功能独立配置（点击链接 / 拖动链接 / 拖动文字搜索） =====

test("三块功能开关各自独立", () => {
  const settings = { ...base, urlRules: [{ pattern: "https://example.com/*", action: "foreground" }] };
  // 关闭“点击链接”后点击不再拦截，拖动链接照常。
  assert.equal(resolveAction("https://example.com/x", { ...settings, clickEnabled: false }, "click"), "native");
  assert.equal(resolveAction("https://example.com/x", { ...settings, clickEnabled: false }, "drag"), "foreground");
  // 关闭“拖动链接”后拖动不再拦截，点击照常。
  assert.equal(resolveAction("https://example.com/x", { ...settings, linkDragEnabled: false }, "drag"), "native");
  assert.equal(resolveAction("https://example.com/x", { ...settings, linkDragEnabled: false }, "click"), "foreground");
  // 关闭“拖动文字搜索”后搜索按原行为处理，其他功能不受影响。
  assert.equal(resolveAction("https://example.com/x", { ...settings, textDragEnabled: false }, "search"), "native");
  assert.equal(resolveAction("https://example.com/x", { ...settings, textDragEnabled: false }, "click"), "foreground");
});
test("规则按功能勾选分别生效，搜索按当前页面匹配", () => {
  const clickOnly = { pattern: "https://example.com/*", action: "native", click: true, drag: false, search: false };
  const settings = { ...base, urlRules: [clickOnly] };
  // 点击命中该规则 → 原行为；拖动与搜索不命中它 → 使用全局默认。
  assert.equal(resolveAction("https://example.com/x", settings, "click"), "native");
  assert.equal(resolveAction("https://example.com/x", settings, "drag"), "background");
  assert.equal(resolveAction("https://example.com/x", settings, "search"), "background");
  // 只勾选搜索的规则按“当前所在页面”生效。
  const searchOnly = { pattern: "https://example.com/*", action: "native", click: false, drag: false, search: true };
  assert.equal(resolveAction("https://example.com/page", { ...base, urlRules: [searchOnly] }, "search"), "native");
  assert.equal(resolveAction("https://other.example/page", { ...base, urlRules: [searchOnly] }, "search"), "background");
});
test("旧规则缺少功能勾选时三项全开，全不勾的规则被丢弃", () => {
  const normalized = normalizeSettings({
    ...base,
    urlRules: [
      { pattern: "https://example.com/*", action: "native" },
      { pattern: "https://off.example.com/*", action: "native", click: false, drag: false, search: false }
    ]
  });
  assert.deepEqual(normalized.urlRules, [
    { pattern: "https://example.com/*", action: "native", click: true, drag: true, search: true }
  ]);
  assert.equal(resolveAction("https://example.com/x", { ...base, urlRules: normalized.urlRules }, "drag"), "native");
});
test("功能勾选必须是布尔值且至少选择一项", () => {
  assert.equal(validateUrlRule({ pattern: "https://example.com/*", action: "native", click: "yes", drag: true, search: true }).valid, false);
  assert.equal(validateDomainRule({ domain: "example.com", includeSubdomains: false, action: "native", click: false, drag: false, search: false }).valid, false);
  assert.equal(validateUrlRule({ pattern: "https://example.com/*", action: "native", click: false, drag: true, search: false }).valid, true);
});
test("未知的功能参数不拦截", () => {
  assert.equal(resolveAction("https://example.com/", base, "bogus"), "native");
});
// 回归：1.1.0 形态的旧设置（无功能开关、无搜索项、规则无勾选）升级后行为与升级前一致。
test("旧设置升级后点击与拖动行为不变", () => {
  const legacy = {
    enabled: true,
    defaultAction: "background",
    domainRules: [{ id: "d1", domain: "example.com", includeSubdomains: false, action: "native" }],
    urlRules: [{ id: "u1", pattern: "https://example.com/private/*", action: "foreground" }]
  };
  const normalized = normalizeSettings(legacy);
  assert.equal(normalized.clickEnabled, true);
  assert.equal(normalized.linkDragEnabled, true);
  assert.equal(normalized.textDragEnabled, true);
  assert.equal(normalized.searchEngine, "bing");
  assert.equal(resolveAction("https://example.com/", normalized, "click"), "native");
  assert.equal(resolveAction("https://example.com/", normalized, "drag"), "native");
  assert.equal(resolveAction("https://example.com/private/a", normalized, "click"), "foreground");
  assert.equal(resolveAction("https://example.com/private/a", normalized, "drag"), "foreground");
});
