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
 * 迭代式 glob 匹配，避免通配符数量受 JavaScript 调用栈限制。
 * shape 中的 `h` 代表任意十六进制字符，其余字符按字面比较。
 */
function wildcardFitsIpv6Shape(pattern, shape) {
  let patternIndex = 0;
  let shapeIndex = 0;
  let starIndex = -1;
  let starShapeIndex = -1;

  while (shapeIndex < shape.length) {
    const patternChar = pattern[patternIndex];
    const shapeChar = shape[shapeIndex];
    const matches = shapeChar === "h"
      ? typeof patternChar === "string" && /^[0-9a-f]$/i.test(patternChar)
      : patternChar === shapeChar;
    if (matches) {
      patternIndex += 1;
      shapeIndex += 1;
    } else if (patternChar === "*") {
      starIndex = patternIndex;
      starShapeIndex = shapeIndex;
      patternIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starShapeIndex += 1;
      shapeIndex = starShapeIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

/** 判断模式是否至少有一种合法的纯十六进制 IPv6 展开。 */
function hasValidIpv6Expansion(pattern) {
  function matchesHextets(leftCount, rightCount, compressed) {
    const groups = [];
    const total = leftCount + rightCount;
    function visit(index) {
      if (index === total) {
        const left = groups.slice(0, leftCount).join(":");
        const right = groups.slice(leftCount).join(":");
        const shape = compressed ? left + "::" + right : left;
        return wildcardFitsIpv6Shape(pattern, shape);
      }
      for (let length = 1; length <= 4; length += 1) {
        groups.push("h".repeat(length));
        if (visit(index + 1)) return true;
        groups.pop();
      }
      return false;
    }
    return visit(0);
  }

  if (matchesHextets(8, 0, false)) return true;
  for (let left = 0; left <= 7; left += 1) {
    for (let right = 0; right <= 7 - left; right += 1) {
      if (matchesHextets(left, right, true)) return true;
    }
  }
  return false;
}

function wildcardMatches(pattern, value) {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let starValueIndex = -1;
  while (valueIndex < value.length) {
    if (pattern[patternIndex] === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
    } else if (pattern[patternIndex] === "*") {
      starIndex = patternIndex;
      starValueIndex = valueIndex;
      patternIndex += 1;
    } else if (starIndex !== -1) {
      patternIndex = starIndex + 1;
      starValueIndex += 1;
      valueIndex = starValueIndex;
    } else {
      return false;
    }
  }
  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

/** 返回一个 URL 解析器可接受的端口展开；null 表示不存在。 */
function findValidPortExpansion(pattern) {
  if (!pattern.includes("*")) {
    return /^\d+$/.test(pattern) && Number(pattern) <= 65535 ? pattern : null;
  }
  if (wildcardMatches(pattern, "")) return "";
  for (let port = 0; port <= 65535; port += 1) {
    const candidate = String(port);
    if (wildcardMatches(pattern, candidate)) return candidate;
  }
  return null;
}

/** 校验 userinfo、主机和端口；各位置的通配符可独立选择空或非空展开。 */
function hasValidOrdinaryAuthorityExpansion(authority) {
  const at = authority.lastIndexOf("@");
  const userinfo = at === -1 ? "" : authority.slice(0, at + 1);
  const hostAndPort = authority.slice(at + 1);
  const colon = hostAndPort.lastIndexOf(":");
  if (colon !== -1 && hostAndPort.slice(0, colon).includes(":")) return false;
  const host = colon === -1 ? hostAndPort : hostAndPort.slice(0, colon);
  const port = colon === -1 ? null : hostAndPort.slice(colon + 1);
  const portExpansion = port === null ? null : findValidPortExpansion(port);
  if (!host || (port !== null && portExpansion === null)) return false;

  for (const userProbe of userinfo.includes("*") ? [userinfo.replace(/\*/g, ""), userinfo.replace(/\*/g, "0")] : [userinfo]) {
    for (const hostProbe of host.includes("*") ? [host.replace(/\*/g, ""), host.replace(/\*/g, "0")] : [host]) {
      const portProbe = port === null ? "" : ":" + portExpansion;
      try {
        const probe = new URL("http://" + userProbe + hostProbe + portProbe + "/");
        if (probe.hostname !== "") return true;
      } catch {
        // Try the next independent wildcard expansion.
      }
    }
  }
  return false;
}

/** 校验 URL 模式的 authority 结构，同时容纳任意位置的 `*`。 */
function isValidUrlAuthority(authority) {
  if (!authority || /[\s\\]/.test(authority)) return false;
  const bracketed = /^(.*@)?\[([^\]]*)\](?::([^:]*))?$/.exec(authority);
  if (bracketed) {
    if (!bracketed[2].includes("*") || !hasValidIpv6Expansion(bracketed[2])) {
      try {
        return new URL("http://" + authority + "/").hostname !== "";
      } catch {
        return false;
      }
    }
    const portExpansion = bracketed[3] === undefined
      ? null
      : findValidPortExpansion(bracketed[3]);
    if (bracketed[3] !== undefined && portExpansion === null) return false;
    const userProbe = (bracketed[1] || "").replace(/\*/g, "");
    const portProbe = bracketed[3] === undefined ? "" : ":" + portExpansion;
    try {
      return new URL("http://" + userProbe + "[::1]" + portProbe + "/").hostname !== "";
    } catch {
      return false;
    }
  }
  return hasValidOrdinaryAuthorityExpansion(authority);
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
