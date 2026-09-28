"use strict";

/**
 * 共享链接规则解析模块。
 *
 * 纯逻辑，无第三方依赖。Node 环境通过 `module.exports` 导出，
 * 浏览器扩展环境把同一对象挂到 `globalThis.LinkTabsRules`。
 */

const ACTIONS = Object.freeze(["background", "foreground", "native"]);

/** DNS 长度上限：主机名总长 253，单个标签 63（RFC 1035 / RFC 1123）。 */
const MAX_DOMAIN_LENGTH = 253;
const MAX_DOMAIN_LABEL_LENGTH = 63;

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

/**
 * 校验域名规则。错误信息直接展示在设置页，故使用中文。
 * 长度上限与 URL 主机名一致：超长域名不可能出现在任何网址中，必须判为无效而不是静默保存。
 */
function validateDomainRule(rule) {
  if (!isPlainObject(rule)) return { valid: false, error: "域名规则格式不正确" };
  const domain = typeof rule.domain === "string" ? rule.domain.trim() : "";
  if (!domain) return { valid: false, error: "请填写域名" };
  if (
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(domain)
  ) {
    return { valid: false, error: "域名格式不正确" };
  }
  if (domain.length > MAX_DOMAIN_LENGTH) {
    return { valid: false, error: `域名过长（最多 ${MAX_DOMAIN_LENGTH} 个字符）` };
  }
  for (const label of domain.split(".")) {
    if (label.length > MAX_DOMAIN_LABEL_LENGTH) {
      return { valid: false, error: `域名的一段过长（每段最多 ${MAX_DOMAIN_LABEL_LENGTH} 个字符）` };
    }
  }
  if (typeof rule.includeSubdomains !== "boolean") {
    return { valid: false, error: "“包含子域名”选项必须为布尔值" };
  }
  if (!isSupportedAction(rule.action)) return { valid: false, error: "动作选项无效" };
  return { valid: true };
}

/** 创建有限状态自动机并追加 IPv6 形状语法。 */
function addNfaState(nfa) {
  nfa.edges.push([]);
  return nfa.edges.length - 1;
}

function addNfaEdge(nfa, from, to, type = null, value = null) {
  nfa.edges[from].push({ to, type, value });
}

function addNfaLiteral(nfa, from, to, value) {
  addNfaEdge(nfa, from, to, "literal", value);
}

function addIpv6Hextet(nfa, from, to) {
  let previous = from;
  for (let length = 1; length <= 4; length += 1) {
    const current = addNfaState(nfa);
    addNfaEdge(nfa, previous, current, "hex");
    addNfaEdge(nfa, current, to);
    previous = current;
  }
}

function appendIpv6Groups(nfa, current, count) {
  for (let index = 0; index < count; index += 1) {
    const next = addNfaState(nfa);
    addIpv6Hextet(nfa, current, next);
    current = next;
    if (index + 1 < count) {
      const colon = addNfaState(nfa);
      addNfaLiteral(nfa, current, colon, ":");
      current = colon;
    }
  }
  return current;
}

function addIpv6Template(nfa, start, accept, leftCount, rightCount, compressed) {
  const branchStart = addNfaState(nfa);
  addNfaEdge(nfa, start, branchStart);
  let current = appendIpv6Groups(nfa, branchStart, leftCount);
  if (compressed) {
    for (let index = 0; index < 2; index += 1) {
      const colon = addNfaState(nfa);
      addNfaLiteral(nfa, current, colon, ":");
      current = colon;
    }
  }
  current = appendIpv6Groups(nfa, current, rightCount);
  addNfaEdge(nfa, current, accept);
}

/** 有限状态机与 glob 模式的乘积搜索；状态数对模式长度线性，且无递归。 */
function nfaEdgeMatches(edge, character) {
  if (edge.type === "literal") return edge.value === character;
  if (edge.type === "hex") return /^[0-9a-f]$/i.test(character);
  if (edge.type === "rawHost") {
    const code = character.codePointAt(0);
    return code > 0x20 && character !== "%" && !["#", "/", ":", "<", ">", "?", "@", "[", "\\", "]", "^", "|"].includes(character);
  }
  if (edge.type === "userinfo") {
    const code = character.codePointAt(0);
    return code > 0x20 && character !== "\\" && character !== "/" && character !== "?" && character !== "#";
  }
  if (edge.type === "digit") return /^[0-9]$/.test(character);
  if (edge.type === "zeroDigit") return character === "0";
  if (edge.type === "nonzeroDigit") return /^[1-9]$/.test(character);
  if (edge.type === "1to5") return /^[1-5]$/.test(character);
  if (edge.type === "0to4") return /^[0-4]$/.test(character);
  if (edge.type === "0to2") return /^[0-2]$/.test(character);
  if (edge.type === "0to5") return /^[0-5]$/.test(character);
  return false;
}

function wildcardSample(edge) {
  if (edge.type === "literal") return edge.value;
  if (edge.type === "hex") return "6";
  if (edge.type === "rawHost" || edge.type === "userinfo") return "a";
  if (edge.type === "zeroDigit" || edge.type === "digit") return "0";
  if (edge.type === "nonzeroDigit" || edge.type === "1to5") return "1";
  if (["0to4", "0to2", "0to5"].includes(edge.type)) return "0";
  return "";
}

function findGlobWitness(pattern, nfa, options = {}) {
  const glob = pattern.replace(/\*+/g, "*");
  const hexSequence = options.hexSequence || "6";
  const nodes = [];
  const visited = new Set();
  const queue = [];

  function enqueue(patternIndex, state, previous, output, usedWildcard, hexCount) {
    const boundedHexCount = Math.min(hexCount, 16);
    const key = `${patternIndex}:${state}:${options.requireWildcard ? Number(usedWildcard) : 0}:${boundedHexCount}`;
    if (visited.has(key)) return;
    visited.add(key);
    nodes.push({ patternIndex, state, previous, output, usedWildcard, hexCount: boundedHexCount });
    queue.push(nodes.length - 1);
  }

  enqueue(0, nfa.start, -1, "", false, 0);
  let cursor = 0;
  while (cursor < queue.length) {
    const nodeIndex = queue[cursor++];
    const node = nodes[nodeIndex];
    if (
      node.patternIndex === glob.length && node.state === nfa.accept &&
      (!options.requireWildcard || node.usedWildcard) &&
      node.hexCount >= (options.minimumHexCount || 0)
    ) {
      const output = [];
      let previous = nodeIndex;
      while (previous !== -1) {
        output.push(nodes[previous].output);
        previous = nodes[previous].previous;
      }
      return output.reverse().join("");
    }

    const patternCharacter = glob[node.patternIndex];
    for (const edge of nfa.edges[node.state]) {
      if (edge.type === null) {
        enqueue(node.patternIndex, edge.to, nodeIndex, "", node.usedWildcard, node.hexCount);
      } else if (patternCharacter === "*") {
        // A glob star may supply any character; the NFA path and URL parser,
        // not the pattern's literal delimiters, determine authority validity.
        if (options.percentOnly && !(edge.type === "hex" || (edge.type === "literal" && edge.value === "%"))) continue;
        const output = edge.type === "hex"
          ? hexSequence[node.hexCount % hexSequence.length]
          : wildcardSample(edge);
        enqueue(
          node.patternIndex,
          edge.to,
          nodeIndex,
          output,
          true,
          node.hexCount + Number(edge.type === "hex")
        );
      } else if (patternCharacter !== undefined && nfaEdgeMatches(edge, patternCharacter)) {
        enqueue(node.patternIndex + 1, edge.to, nodeIndex, patternCharacter, node.usedWildcard, node.hexCount);
      }
    }
    if (patternCharacter === "*") {
      enqueue(node.patternIndex + 1, node.state, nodeIndex, "", node.usedWildcard, node.hexCount);
    }
  }
  return null;
}

function createIpv6Nfa() {
  const nfa = { edges: [] };
  const start = addNfaState(nfa);
  const accept = addNfaState(nfa);
  addIpv6Template(nfa, start, accept, 8, 0, false);
  for (let left = 0; left <= 7; left += 1) {
    for (let right = 0; right <= 7 - left; right += 1) {
      addIpv6Template(nfa, start, accept, left, right, true);
    }
  }
  return { edges: nfa.edges, start, accept };
}

const IPV6_NFA = createIpv6Nfa();

function createDomainHostNfa() {
  const nfa = { edges: [] };
  const start = addNfaState(nfa);
  const accept = addNfaState(nfa);
  const firstHex = addNfaState(nfa);
  const secondHex = addNfaState(nfa);
  addNfaEdge(nfa, start, accept, "rawHost");
  addNfaEdge(nfa, accept, accept, "rawHost");
  addNfaLiteral(nfa, start, firstHex, "%");
  addNfaLiteral(nfa, accept, firstHex, "%");
  addNfaEdge(nfa, firstHex, secondHex, "hex");
  addNfaEdge(nfa, secondHex, accept, "hex");
  return { edges: nfa.edges, start, accept };
}

const DOMAIN_HOST_NFA = createDomainHostNfa();

function copyNfaInto(target, source) {
  const offset = target.edges.length;
  for (let index = 0; index < source.edges.length; index += 1) addNfaState(target);
  for (let state = 0; state < source.edges.length; state += 1) {
    for (const edge of source.edges[state]) {
      addNfaEdge(target, state + offset, edge.to + offset, edge.type, edge.value);
    }
  }
  return { start: source.start + offset, accept: source.accept + offset };
}

function addAuthorityPort(nfa, hostEnd, accept) {
  const portStart = addNfaState(nfa);
  addNfaEdge(nfa, hostEnd, accept);
  addNfaLiteral(nfa, hostEnd, portStart, ":");
  addNfaEdge(nfa, portStart, accept); // Empty ports are valid URL authority expansions.
  addNfaEdge(nfa, portStart, portStart, "zeroDigit");

  function addPortTemplate(types) {
    let current = portStart;
    for (const type of types) {
      const next = addNfaState(nfa);
      if (type.startsWith("=")) addNfaLiteral(nfa, current, next, type.slice(1));
      else addNfaEdge(nfa, current, next, type);
      current = next;
    }
    addNfaEdge(nfa, current, accept);
  }

  for (let length = 1; length <= 4; length += 1) {
    addPortTemplate(["nonzeroDigit", ...Array(length - 1).fill("digit")]);
  }
  addPortTemplate(["1to5", "digit", "digit", "digit", "digit"]);
  addPortTemplate(["=6", "0to4", "digit", "digit", "digit"]);
  addPortTemplate(["=6", "=5", "0to4", "digit", "digit"]);
  addPortTemplate(["=6", "=5", "=5", "0to2", "digit"]);
  addPortTemplate(["=6", "=5", "=5", "=3", "0to5"]);
}

function createAuthorityNfa() {
  const nfa = { edges: [] };
  const start = addNfaState(nfa);
  const accept = addNfaState(nfa);
  const hostStart = addNfaState(nfa);
  const userinfoStart = addNfaState(nfa);

  addNfaEdge(nfa, start, hostStart);
  addNfaEdge(nfa, start, userinfoStart);
  addNfaEdge(nfa, userinfoStart, userinfoStart, "userinfo");
  addNfaLiteral(nfa, userinfoStart, hostStart, "@");

  const domain = copyNfaInto(nfa, DOMAIN_HOST_NFA);
  addNfaEdge(nfa, hostStart, domain.start);
  addAuthorityPort(nfa, domain.accept, accept);

  const ipv6 = copyNfaInto(nfa, IPV6_NFA);
  const bracketEnd = addNfaState(nfa);
  addNfaLiteral(nfa, hostStart, ipv6.start, "[");
  addNfaLiteral(nfa, ipv6.accept, bracketEnd, "]");
  addAuthorityPort(nfa, bracketEnd, accept);

  return { edges: nfa.edges, start, accept };
}

const AUTHORITY_NFA = createAuthorityNfa();

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

/** 校验 URL 模式 authority：glob 与固定 HTTP(S) authority grammar 求交，再由 URL 确认见证。 */
function isValidUrlAuthority(authority) {
  if (!authority || /[\s\\]/.test(authority)) return false;
  if (!authority.includes("*")) {
    try {
      return new URL("http://" + authority + "/").hostname !== "";
    } catch {
      return false;
    }
  }

  // 保留 URL 解析器对字面 IPv6（包括 IPv4-embedded 形式）的完整识别。
  const bracketed = /^(.*@)?\[([^\]]*)\](?::([^:]*))?$/.exec(authority);
  if (bracketed && !bracketed[2].includes("*")) {
    const portExpansion = bracketed[3] === undefined
      ? null
      : findValidPortExpansion(bracketed[3]);
    if (bracketed[3] !== undefined && portExpansion === null) return false;
    const userinfo = (bracketed[1] || "").replace(/\*/g, "");
    const port = bracketed[3] === undefined ? "" : ":" + portExpansion;
    try {
      return new URL("http://" + userinfo + "[" + bracketed[2] + "]" + port + "/").hostname !== "";
    } catch {
      return false;
    }
  }

  function parsesAuthority(candidate) {
    if (candidate === null) return false;
    try {
      return new URL("http://" + candidate + "/").hostname !== "";
    } catch {
      return false;
    }
  }

  const expansion = findGlobWitness(authority, AUTHORITY_NFA);
  if (parsesAuthority(expansion)) return true;

  // If fixed percent escapes introduce an incomplete UTF-8 sequence, try valid
  // percent-byte completions through wildcard transitions before rejecting it.
  for (const { hexSequence, minimumHexCount } of [
    { hexSequence: "80", minimumHexCount: 2 },
    { hexSequence: "A080", minimumHexCount: 4 },
    { hexSequence: "8080", minimumHexCount: 4 },
    { hexSequence: "80A0", minimumHexCount: 4 },
    { hexSequence: "908080", minimumHexCount: 6 },
    { hexSequence: "9F92A9", minimumHexCount: 6 }
  ]) {
    const candidate = findGlobWitness(authority, AUTHORITY_NFA, {
      requireWildcard: true,
      percentOnly: true,
      hexSequence,
      minimumHexCount
    });
    if (parsesAuthority(candidate)) return true;
  }
  return false;
}

/** 校验网址规则；错误信息直接展示在设置页，故使用中文。 */
function validateUrlRule(rule) {
  if (!isPlainObject(rule)) return { valid: false, error: "网址规则格式不正确" };
  const pattern = typeof rule.pattern === "string" ? rule.pattern.trim() : "";
  if (!pattern) return { valid: false, error: "请填写网址模式" };
  const match = /^(https?):\/\/([^/?#]*)([\s\S]*)$/i.exec(pattern);
  if (!match) return { valid: false, error: "网址模式必须使用 http:// 或 https:// 开头" };
  if (match[2] === "") return { valid: false, error: "网址模式必须包含主机名" };
  if (!isValidUrlAuthority(match[2])) {
    return { valid: false, error: "网址模式的主机名、端口或 IPv6 地址无效" };
  }
  if (!isSupportedAction(rule.action)) return { valid: false, error: "动作选项无效" };
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
  // Keep the validated source spelling too: URL serialization drops valid
  // syntax such as an empty password's colon, which a glob may intentionally match.
  const rawTarget = typeof url === "string" ? normalizeUrlForMatch(url) : null;
  if (target === null) return "native";

  for (const rule of normalized.urlRules) {
    const pattern = normalizeUrlForMatch(rule.pattern);
    if (pattern !== null) {
      const matcher = compileWildcard(pattern);
      if (matcher.test(target) || (rawTarget !== null && matcher.test(rawTarget))) {
        return rule.action;
      }
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
