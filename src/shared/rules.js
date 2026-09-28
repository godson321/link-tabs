"use strict";

/**
 * 共享链接规则解析模块。
 *
 * 纯逻辑，无第三方依赖。Node 环境通过 `module.exports` 导出，
 * 浏览器扩展环境把同一对象挂到 `globalThis.LinkTabsRules`。
 */

const ACTIONS = Object.freeze(["background", "foreground", "native"]);

const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  defaultAction: "background",
  domainRules: Object.freeze([]),
  urlRules: Object.freeze([])
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedAction(action) {
  return ACTIONS.includes(action);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 把含 `*` 通配符的模式编译为锚定的正则，`*` 匹配零个或多个字符。 */
function compileWildcard(pattern) {
  const parts = pattern.split("*").map(escapeRegExp);
  return new RegExp("^" + parts.join(".*") + "$");
}

/**
 * 仅把 authority 中的主机名部分转小写，保留 userinfo 原样。
 * 这样主机名比较不区分大小写，而路径/查询保持区分大小写。
 */
function normalizeAuthority(authority) {
  const at = authority.lastIndexOf("@");
  if (at === -1) return authority.toLowerCase();
  return authority.slice(0, at + 1) + authority.slice(at + 1).toLowerCase();
}

/**
 * 归一化 URL（或 URL 模式）以便匹配：scheme 与主机名转小写，其余原样保留。
 * 返回 null 表示不是带 authority 的绝对 URL。
 */
function normalizeUrlForMatch(value) {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/.exec(value);
  if (!match) return null;
  return match[1].toLowerCase() + "://" + normalizeAuthority(match[2]) + match[3];
}

function validateDomainRule(rule) {
  if (!isPlainObject(rule)) return { valid: false, error: "Domain rule must be an object" };
  const domain = typeof rule.domain === "string" ? rule.domain.trim() : "";
  if (!domain) return { valid: false, error: "Domain is required" };
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain)
  ) {
    return { valid: false, error: "Domain format is invalid" };
  }
  if (typeof rule.includeSubdomains !== "boolean") {
    return { valid: false, error: "includeSubdomains must be a boolean" };
  }
  if (!isSupportedAction(rule.action)) return { valid: false, error: "Action is invalid" };
  return { valid: true };
}

/**
 * 校验 URL 模式的 authority 结构，同时容纳 `*` 占位符。
 *
 * `*` 可以出现在主机或端口中，因此先把每个 `*` 替换为在这些位置都合法的
 * 占位字符，再交给 URL 解析器校验整体结构：空格、非法端口、非法 IPv6 等
 * 都会被解析器拒绝。
 */
function isValidUrlAuthority(authority) {
  if (!authority || /[\s\\]/.test(authority)) return false;
  try {
    const probe = new URL("http://" + authority.replace(/\*/g, "0") + "/");
    return probe.hostname !== "";
  } catch {
    return false;
  }
}

function validateUrlRule(rule) {
  if (!isPlainObject(rule)) return { valid: false, error: "URL rule must be an object" };
  const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
  if (!pattern) return { valid: false, error: "Pattern is required" };
  const match = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i.exec(pattern);
  if (!match) return { valid: false, error: "Pattern must be an HTTP or HTTPS URL" };
  if (match[2] === "") return { valid: false, error: "Pattern must include a host" };
  if (!isValidUrlAuthority(match[2])) {
    return { valid: false, error: "Pattern authority is invalid" };
  }
  if (!isSupportedAction(rule.action)) return { valid: false, error: "Action is invalid" };
  return { valid: true };
}

function normalizeDomainRule(rule) {
  if (!isPlainObject(rule)) return null;
  const candidate = {
    domain: typeof rule.domain === "string" ? rule.domain.trim().toLowerCase() : "",
    includeSubdomains: rule.includeSubdomains === true,
    action: rule.action
  };
  if (typeof rule.id === "string" && rule.id) candidate.id = rule.id;
  return validateDomainRule(candidate).valid ? candidate : null;
}

function normalizeUrlRule(rule) {
  if (!isPlainObject(rule)) return null;
  const candidate = {
    pattern: typeof rule.pattern === "string" ? rule.pattern.trim() : "",
    action: rule.action
  };
  if (typeof rule.id === "string" && rule.id) candidate.id = rule.id;
  return validateUrlRule(candidate).valid ? candidate : null;
}

/** 把任意外部输入归一化为完整、有效的设置对象。 */
function normalizeSettings(rawSettings) {
  const raw = isPlainObject(rawSettings) ? rawSettings : {};
  const enabled = typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SETTINGS.enabled;
  const defaultAction = isSupportedAction(raw.defaultAction)
    ? raw.defaultAction
    : DEFAULT_SETTINGS.defaultAction;
  const domainRules = Array.isArray(raw.domainRules)
    ? raw.domainRules.map(normalizeDomainRule).filter(Boolean)
    : [];
  const urlRules = Array.isArray(raw.urlRules)
    ? raw.urlRules.map(normalizeUrlRule).filter(Boolean)
    : [];
  return { enabled, defaultAction, domainRules, urlRules };
}

/**
 * 域名边界匹配：完整相等，或（启用 includeSubdomains 时）以 `.domain` 结尾。
 * 不会误匹配相似后缀，例如 `notexample.com`。
 */
function matchesDomain(hostname, rule) {
  const domain = rule.domain.toLowerCase();
  if (hostname === domain) return true;
  return rule.includeSubdomains === true && hostname.endsWith("." + domain);
}

/**
 * 解析链接应执行的动作。
 * 顺序：归一化设置 → 停用返回 native → 非 HTTP/HTTPS 返回 native
 * → 第一条匹配的网址规则 → 第一条匹配的域名规则 → 全局默认行为。
 */
function resolveAction(url, settings) {
  const normalized = normalizeSettings(settings);
  if (!normalized.enabled) return "native";

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "native";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "native";

  const target = normalizeUrlForMatch(parsed.href);
  if (target === null) return "native";

  for (const rule of normalized.urlRules) {
    const pattern = normalizeUrlForMatch(rule.pattern);
    if (pattern !== null && compileWildcard(pattern).test(target)) {
      return rule.action;
    }
  }

  const hostname = parsed.hostname.toLowerCase();
  for (const rule of normalized.domainRules) {
    if (matchesDomain(hostname, rule)) return rule.action;
  }

  return normalized.defaultAction;
}

const LinkTabsRules = {
  ACTIONS,
  DEFAULT_SETTINGS,
  normalizeSettings,
  validateDomainRule,
  validateUrlRule,
  resolveAction
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = LinkTabsRules;
}
if (typeof globalThis !== "undefined") {
  globalThis.LinkTabsRules = LinkTabsRules;
}
