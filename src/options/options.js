"use strict";

const ACTION_LABELS = {
  background: "后台新标签页",
  foreground: "前台新标签页",
  native: "按浏览器原行为"
};

const SEARCH_ENGINE_LABELS = {
  bing: "Bing",
  google: "Google",
  baidu: "百度"
};

function byId(id) {
  return document.getElementById(id);
}

const pageStatus = byId("page-status");
const defaultActionSelect = byId("default-action");
const searchEngineSelect = byId("search-engine");
const toggleClick = byId("toggle-click");
const toggleLinkDrag = byId("toggle-link-drag");
const toggleTextDrag = byId("toggle-text-drag");

/** 已加载的设置；读取失败时保持 null，页面控件保持禁用。 */
let settings = null;

/** 动作下拉框的选项由 LinkTabsRules.ACTIONS 生成，界面不会出现解析器不支持的动作。 */
for (const select of document.querySelectorAll("select[data-action-select]")) {
  for (const action of LinkTabsRules.ACTIONS) {
    const option = document.createElement("option");
    option.value = action;
    option.textContent = ACTION_LABELS[action];
    select.append(option);
  }
}

/** 搜索引擎下拉框由 LinkTabsRules.SEARCH_ENGINES 生成，界面不会出现解析器不支持的值。 */
for (const engine of LinkTabsRules.SEARCH_ENGINES) {
  const option = document.createElement("option");
  option.value = engine;
  option.textContent = SEARCH_ENGINE_LABELS[engine] || engine;
  searchEngineSelect.append(option);
}

function showStatus(message, isError = false) {
  pageStatus.textContent = message;
  pageStatus.classList.toggle("error", isError);
}

function setControlsEnabled(enabled) {
  for (const control of document.querySelectorAll("input, select, button")) {
    control.disabled = !enabled;
  }
}

// ===== 设置变更：纯函数，作用于最新的设置对象 =====

function withDefaultAction(current, action) {
  return { ...current, defaultAction: action };
}

function withSearchEngine(current, engine) {
  return { ...current, searchEngine: engine };
}

function withSwitch(current, name, value) {
  return { ...current, [name]: value };
}

function withAddedRule(current, kind, rule) {
  return { ...current, [kind]: [...current[kind], { ...rule, id: crypto.randomUUID() }] };
}

function withUpdatedRule(current, kind, id, rule) {
  return {
    ...current,
    [kind]: current[kind].map(item => (item.id === id ? { ...rule, id } : item))
  };
}

function withDeletedRule(current, kind, id) {
  return { ...current, [kind]: current[kind].filter(item => item.id !== id) };
}

function withMovedRule(current, kind, id, offset) {
  const rules = [...current[kind]];
  const index = rules.findIndex(item => item.id === id);
  const target = index + offset;
  if (index === -1 || target < 0 || target >= rules.length) return current;
  [rules[index], rules[target]] = [rules[target], rules[index]];
  return { ...current, [kind]: rules };
}

/**
 * 先读取存储中的最新设置再应用变更，避免用本页面的旧状态覆盖其他页面
 * （例如弹窗总开关）刚写入的值。保存失败时保留原状态并提示错误。
 */
async function persist(change) {
  try {
    const next = change(await LinkTabsSettings.load());
    await LinkTabsSettings.save(next);
    settings = LinkTabsRules.normalizeSettings(next);
  } catch (error) {
    console.error("Link Tabs:", error);
    showStatus("保存失败：" + error, true);
    return false;
  }
  renderAll();
  showStatus("已保存");
  return true;
}

// ===== 规则列表控制器 =====

/** 规则勾选的功能；三项全勾时不显示后缀。 */
function describeRuleFunctions(rule) {
  const labels = [];
  if (rule.click) labels.push("点击");
  if (rule.drag) labels.push("拖动");
  if (rule.search) labels.push("搜索");
  if (labels.length === 3) return "";
  return `（仅${labels.join("、")}）`;
}

function createRuleController(config) {
  let editingId = null;
  let saving = false;

  function updateFormMode() {
    config.submit.textContent = editingId === null ? "添加规则" : "保存修改";
    config.cancel.hidden = editingId === null;
  }

  function clearFieldError() {
    config.error.textContent = "";
    config.error.hidden = true;
  }

  function showFieldError(message) {
    config.error.textContent = message;
    config.error.hidden = false;
  }

  function resetForm() {
    editingId = null;
    config.clear();
    clearFieldError();
    updateFormMode();
    render();
  }

  function startEdit(rule) {
    editingId = rule.id;
    config.apply(rule);
    clearFieldError();
    updateFormMode();
    config.focus();
    render();
  }

  function buildButton(operation, label, rule, disabled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rule-button";
    button.dataset.operation = operation;
    button.textContent = label;
    button.disabled = disabled;
    button.setAttribute("aria-label", `${label}：${config.describe(rule)}`);
    return button;
  }

  function render() {
    if (settings === null) return;
    const rules = settings[config.kind];
    if (editingId !== null && !rules.some(rule => rule.id === editingId)) {
      // 正在编辑的规则已不存在（例如在另一个标签页中被删除），退出编辑状态。
      editingId = null;
      config.clear();
      clearFieldError();
      updateFormMode();
    }
    config.list.textContent = "";
    if (rules.length === 0) {
      const empty = document.createElement("li");
      empty.className = "rule-empty";
      empty.textContent = config.emptyText;
      config.list.append(empty);
      return;
    }
    rules.forEach((rule, index) => {
      const item = document.createElement("li");
      item.className = "rule";
      item.dataset.id = rule.id;
      if (rule.id === editingId) item.classList.add("editing");

      const text = document.createElement("span");
      text.className = "rule-text";
      const value = document.createElement("span");
      value.className = "rule-value";
      value.textContent = config.describe(rule) + describeRuleFunctions(rule);
      const action = document.createElement("span");
      action.className = "rule-action";
      action.textContent = ACTION_LABELS[rule.action] || rule.action;
      text.append(value, action);

      const actions = document.createElement("span");
      actions.className = "rule-actions";
      actions.append(
        buildButton("edit", "编辑", rule, false),
        buildButton("up", "上移", rule, index === 0),
        buildButton("down", "下移", rule, index === rules.length - 1),
        buildButton("delete", "删除", rule, false)
      );

      item.append(text, actions);
      config.list.append(item);
    });
  }

  config.list.addEventListener("click", async event => {
    const button = event.target.closest("button[data-operation]");
    const item = button === null ? null : button.closest("li[data-id]");
    if (item === null) return;
    const id = item.dataset.id;
    const operation = button.dataset.operation;
    if (operation === "edit") {
      const rule = settings[config.kind].find(candidate => candidate.id === id);
      if (rule) startEdit(rule);
    } else if (operation === "up" || operation === "down") {
      await persist(current => withMovedRule(current, config.kind, id, operation === "up" ? -1 : 1));
    } else if (operation === "delete") {
      await persist(current => withDeletedRule(current, config.kind, id));
    }
  });

  config.form.addEventListener("submit", async event => {
    event.preventDefault();
    // 保存期间忽略重复提交（例如快速双击），避免同一条规则被追加两次。
    if (saving) return;
    const candidate = config.collect();
    const result = config.validate(candidate);
    if (!result.valid) {
      // 无效输入只提示原因，不写入存储。
      showFieldError(result.error);
      return;
    }
    clearFieldError();
    const id = editingId;
    saving = true;
    config.submit.disabled = true;
    let saved = false;
    try {
      saved = await persist(current => (id === null
        ? withAddedRule(current, config.kind, candidate)
        : withUpdatedRule(current, config.kind, id, candidate)));
    } finally {
      saving = false;
      config.submit.disabled = false;
    }
    if (saved) resetForm();
  });

  config.cancel.addEventListener("click", () => resetForm());

  updateFormMode();
  return { render };
}

const domainFields = {
  input: byId("domain-input"),
  subdomains: byId("domain-subdomains"),
  action: byId("domain-action"),
  click: byId("domain-click"),
  drag: byId("domain-drag"),
  search: byId("domain-search")
};

const urlFields = {
  pattern: byId("url-pattern"),
  action: byId("url-action"),
  click: byId("url-click"),
  drag: byId("url-drag"),
  search: byId("url-search")
};

const controllers = [
  createRuleController({
    kind: "domainRules",
    list: byId("domain-list"),
    form: byId("domain-form"),
    submit: byId("domain-submit"),
    cancel: byId("domain-cancel"),
    error: byId("domain-error"),
    emptyText: "暂无域名规则。",
    validate: LinkTabsRules.validateDomainRule,
    collect() {
      // 域名不区分大小写，统一小写后再校验，界面与存储保持一致。
      return {
        domain: domainFields.input.value.trim().toLowerCase(),
        includeSubdomains: domainFields.subdomains.checked,
        action: domainFields.action.value,
        click: domainFields.click.checked,
        drag: domainFields.drag.checked,
        search: domainFields.search.checked
      };
    },
    apply(rule) {
      domainFields.input.value = rule.domain;
      domainFields.subdomains.checked = rule.includeSubdomains === true;
      domainFields.action.value = rule.action;
      domainFields.click.checked = rule.click;
      domainFields.drag.checked = rule.drag;
      domainFields.search.checked = rule.search;
    },
    clear() {
      domainFields.input.value = "";
      domainFields.subdomains.checked = false;
      domainFields.action.value = "background";
      domainFields.click.checked = true;
      domainFields.drag.checked = true;
      domainFields.search.checked = true;
    },
    focus() {
      domainFields.input.focus();
    },
    describe(rule) {
      return rule.includeSubdomains ? `${rule.domain}（含子域名）` : rule.domain;
    }
  }),
  createRuleController({
    kind: "urlRules",
    list: byId("url-list"),
    form: byId("url-form"),
    submit: byId("url-submit"),
    cancel: byId("url-cancel"),
    error: byId("url-error"),
    emptyText: "暂无网址规则。",
    validate: LinkTabsRules.validateUrlRule,
    collect() {
      // 路径区分大小写，只去掉首尾空白。
      return {
        pattern: urlFields.pattern.value.trim(),
        action: urlFields.action.value,
        click: urlFields.click.checked,
        drag: urlFields.drag.checked,
        search: urlFields.search.checked
      };
    },
    apply(rule) {
      urlFields.pattern.value = rule.pattern;
      urlFields.action.value = rule.action;
      urlFields.click.checked = rule.click;
      urlFields.drag.checked = rule.drag;
      urlFields.search.checked = rule.search;
    },
    clear() {
      urlFields.pattern.value = "";
      urlFields.action.value = "background";
      urlFields.click.checked = true;
      urlFields.drag.checked = true;
      urlFields.search.checked = true;
    },
    focus() {
      urlFields.pattern.focus();
    },
    describe(rule) {
      return rule.pattern;
    }
  })
];

// ===== 页面装配 =====

function renderAll() {
  defaultActionSelect.value = settings.defaultAction;
  searchEngineSelect.value = settings.searchEngine;
  toggleClick.checked = settings.clickEnabled;
  toggleLinkDrag.checked = settings.linkDragEnabled;
  toggleTextDrag.checked = settings.textDragEnabled;
  for (const controller of controllers) controller.render();
}

defaultActionSelect.addEventListener("change", async () => {
  const saved = await persist(current => withDefaultAction(current, defaultActionSelect.value));
  if (!saved) {
    // 保存失败时恢复为存储中的值，不把未保存的选择留在界面上。
    defaultActionSelect.value = settings.defaultAction;
  }
});

searchEngineSelect.addEventListener("change", async () => {
  const saved = await persist(current => withSearchEngine(current, searchEngineSelect.value));
  if (!saved) {
    searchEngineSelect.value = settings.searchEngine;
  }
});

/** 绑定一个功能开关复选框；保存失败时恢复为存储中的值。 */
function bindToggle(element, settingName) {
  element.addEventListener("change", async () => {
    const saved = await persist(current => withSwitch(current, settingName, element.checked));
    if (!saved) element.checked = settings[settingName];
  });
}

bindToggle(toggleClick, "clickEnabled");
bindToggle(toggleLinkDrag, "linkDragEnabled");
bindToggle(toggleTextDrag, "textDragEnabled");

async function loadSettings() {
  try {
    settings = await LinkTabsSettings.load();
  } catch (error) {
    console.error("Link Tabs:", error);
    showStatus("无法读取设置：" + error, true);
    return;
  }
  setControlsEnabled(true);
  renderAll();
}

// 读取成功前禁用所有控件，避免在未知状态下修改设置。
setControlsEnabled(false);
loadSettings();
