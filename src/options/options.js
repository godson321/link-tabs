"use strict";

const ACTION_LABELS = {
  background: "后台新标签页",
  foreground: "前台新标签页",
  native: "按浏览器原行为"
};

const ACTION_SHORT = {
  background: "后",
  foreground: "前",
  native: "原"
};

const FLAG_LABELS = {
  click: "点击链接",
  drag: "拖动链接",
  search: "拖动文字搜索"
};

/** 表格三个功能列：列内勾选字段与对应的全局开关字段。 */
const COLUMNS = {
  click: "clickEnabled",
  drag: "linkDragEnabled",
  search: "textDragEnabled"
};

function byId(id) {
  return document.getElementById(id);
}

const pageStatus = byId("page-status");
const defaultActionSelect = byId("default-action");
const rulesTable = byId("rules-table");
const rulesBody = byId("rules-body");
const trashTemplate = byId("trash-icon");
const headerSwitches = {
  click: byId("header-click"),
  drag: byId("header-drag"),
  search: byId("header-search")
};
const addDialog = byId("add-dialog");
const addForm = byId("add-form");
const addSubmit = byId("add-submit");
const dialogError = byId("dialog-error");
const typeSelect = byId("rule-type");
const urlFields = byId("url-fields");
const domainFields = byId("domain-fields");
const subdomainsField = byId("subdomains-field");
const patternInput = byId("rule-pattern");
const domainInput = byId("rule-domain");
const subdomainsCheckbox = byId("rule-subdomains");
const ruleActionSelect = byId("rule-action");
const applyBoxes = {
  click: byId("apply-click"),
  drag: byId("apply-drag"),
  search: byId("apply-search")
};

/** 已加载的设置；读取失败时保持 null，页面控件保持禁用。 */
let settings = null;
let dialogSaving = false;

/** 动作下拉框的选项由 LinkTabsRules.ACTIONS 生成，界面不会出现解析器不支持的动作。 */
for (const select of document.querySelectorAll("select[data-action-select]")) {
  for (const action of LinkTabsRules.ACTIONS) {
    const option = document.createElement("option");
    option.value = action;
    option.textContent = ACTION_LABELS[action];
    select.append(option);
  }
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

function withSwitch(current, name, value) {
  return { ...current, [name]: value };
}

function withAddedRule(current, kind, rule) {
  return { ...current, [kind]: [...current[kind], { ...rule, id: crypto.randomUUID() }] };
}

function withUpdatedRuleFlag(current, kind, id, flag, value) {
  return {
    ...current,
    [kind]: current[kind].map(rule => (rule.id === id ? { ...rule, [flag]: value } : rule))
  };
}

function withDeletedRule(current, kind, id) {
  return { ...current, [kind]: current[kind].filter(rule => rule.id !== id) };
}

/**
 * 先读取存储中的最新设置再应用变更，避免用本页面的旧状态覆盖其他页面
 * （例如弹窗）刚写入的值。保存失败时保留原状态并提示错误。
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

// ===== 规则表格 =====

function describeRule(kind, rule) {
  if (kind === "urlRules") return rule.pattern;
  return rule.includeSubdomains ? `${rule.domain}（含子域名）` : rule.domain;
}

function buildRow(kind, rule) {
  const value = describeRule(kind, rule);
  const row = document.createElement("tr");
  row.dataset.id = rule.id;
  row.dataset.kind = kind;

  const typeCell = document.createElement("td");
  const typeBadge = document.createElement("span");
  typeBadge.className = "badge";
  typeBadge.textContent = kind === "urlRules" ? "网址" : "域名";
  typeCell.append(typeBadge);

  const valueCell = document.createElement("td");
  valueCell.className = "value";
  valueCell.textContent = value;

  const actionCell = document.createElement("td");
  actionCell.className = "center";
  const actionBadge = document.createElement("span");
  actionBadge.className = "action-badge";
  actionBadge.textContent = ACTION_SHORT[rule.action];
  actionBadge.title = ACTION_LABELS[rule.action];
  actionCell.append(actionBadge);

  row.append(typeCell, valueCell, actionCell);

  for (const [flag, switchName] of Object.entries(COLUMNS)) {
    const cell = document.createElement("td");
    cell.className = "center";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = rule[flag] === true;
    // 该功能全局停用时，行内勾选变灰停用（原值保留，重新启用后恢复）。
    box.disabled = settings[switchName] !== true;
    box.dataset.flag = flag;
    box.setAttribute("aria-label", `${value} 的${FLAG_LABELS[flag]}`);
    cell.append(box);
    row.append(cell);
  }

  const actionsCell = document.createElement("td");
  actionsCell.className = "center";
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "icon-button";
  deleteButton.dataset.delete = "true";
  deleteButton.title = "删除";
  deleteButton.setAttribute("aria-label", `删除规则：${value}`);
  deleteButton.append(trashTemplate.content.cloneNode(true));
  actionsCell.append(deleteButton);
  row.append(actionsCell);

  return row;
}

function renderTable() {
  if (settings === null) return;
  for (const [flag, switchName] of Object.entries(COLUMNS)) {
    rulesTable.classList.toggle(`col-${flag}-off`, settings[switchName] !== true);
  }
  rulesBody.textContent = "";

  if (settings.urlRules.length === 0 && settings.domainRules.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.className = "rule-empty";
    cell.textContent = "暂无规则。";
    row.append(cell);
    rulesBody.append(row);
    return;
  }

  for (const rule of settings.urlRules) rulesBody.append(buildRow("urlRules", rule));
  if (settings.urlRules.length > 0 && settings.domainRules.length > 0) {
    const divider = document.createElement("tr");
    divider.className = "group-divider";
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = "以下为域名规则（匹配顺序在全部网址规则之后）";
    divider.append(cell);
    rulesBody.append(divider);
  }
  for (const rule of settings.domainRules) rulesBody.append(buildRow("domainRules", rule));
}

function validateRuleByKind(kind, candidate) {
  return (kind === "urlRules" ? LinkTabsRules.validateUrlRule : LinkTabsRules.validateDomainRule)(candidate);
}

rulesBody.addEventListener("change", async event => {
  const box = event.target.closest("input[type=checkbox][data-flag]");
  if (box === null) return;
  const row = box.closest("tr[data-id]");
  const kind = row.dataset.kind;
  const id = row.dataset.id;
  const flag = box.dataset.flag;
  const checked = box.checked;
  // 校验针对读取到的最新规则：即使另一个标签页刚改过同一条规则，也不会把
  // “一个功能都不勾”的规则写进存储（normalizeSettings 会丢弃这种规则）。
  let invalidMessage = null;
  const saved = await persist(current => {
    const fresh = current[kind].find(candidate => candidate.id === id);
    if (!fresh) return current;
    const candidate = { ...fresh, [flag]: checked };
    const result = validateRuleByKind(kind, candidate);
    if (!result.valid) {
      invalidMessage = result.error;
      return current;
    }
    return withUpdatedRuleFlag(current, kind, id, flag, checked);
  });
  if (!saved || invalidMessage !== null) {
    box.checked = !checked;
  }
  if (invalidMessage !== null) {
    showStatus(invalidMessage, true);
  }
});

rulesBody.addEventListener("click", async event => {
  const button = event.target.closest("button[data-delete]");
  if (button === null) return;
  const row = button.closest("tr[data-id]");
  await persist(current => withDeletedRule(current, row.dataset.kind, row.dataset.id));
});

for (const [flag, box] of Object.entries(headerSwitches)) {
  box.addEventListener("change", async () => {
    const saved = await persist(current => withSwitch(current, COLUMNS[flag], box.checked));
    if (!saved) box.checked = !box.checked;
  });
}

// ===== 添加规则弹窗 =====

function updateTypeFields() {
  const isUrl = typeSelect.value === "urlRules";
  urlFields.hidden = !isUrl;
  domainFields.hidden = isUrl;
  subdomainsField.hidden = isUrl;
}

function showDialogError(message) {
  if (message) {
    dialogError.textContent = message;
    dialogError.hidden = false;
  } else {
    dialogError.hidden = true;
  }
}

function resetDialogForm() {
  typeSelect.value = "urlRules";
  patternInput.value = "";
  domainInput.value = "";
  subdomainsCheckbox.checked = false;
  ruleActionSelect.value = "background";
  for (const box of Object.values(applyBoxes)) box.checked = true;
  updateTypeFields();
  showDialogError(null);
}

byId("open-add-dialog").addEventListener("click", () => {
  resetDialogForm();
  addDialog.showModal();
});

byId("add-cancel").addEventListener("click", () => addDialog.close());

typeSelect.addEventListener("change", () => {
  updateTypeFields();
  showDialogError(null);
});

addForm.addEventListener("submit", async event => {
  event.preventDefault();
  // 保存期间忽略重复提交（例如快速双击），避免同一条规则被追加两次。
  if (dialogSaving) return;
  const kind = typeSelect.value;
  const functions = {
    action: ruleActionSelect.value,
    click: applyBoxes.click.checked,
    drag: applyBoxes.drag.checked,
    search: applyBoxes.search.checked
  };
  const candidate = kind === "urlRules"
    ? { pattern: patternInput.value.trim(), ...functions }
    : {
        domain: domainInput.value.trim().toLowerCase(),
        includeSubdomains: subdomainsCheckbox.checked,
        ...functions
      };
  const validate = kind === "urlRules" ? LinkTabsRules.validateUrlRule : LinkTabsRules.validateDomainRule;
  const result = validate(candidate);
  if (!result.valid) {
    // 无效输入只在弹窗内提示，不写入存储。
    showDialogError(result.error);
    return;
  }
  showDialogError(null);
  dialogSaving = true;
  addSubmit.disabled = true;
  let saved = false;
  try {
    saved = await persist(current => withAddedRule(current, kind, candidate));
  } finally {
    dialogSaving = false;
    addSubmit.disabled = false;
  }
  if (saved) addDialog.close();
});

// ===== 页面装配 =====

function renderAll() {
  if (settings === null) return;
  defaultActionSelect.value = settings.defaultAction;
  for (const [flag, box] of Object.entries(headerSwitches)) {
    box.checked = settings[COLUMNS[flag]] === true;
  }
  renderTable();
}

defaultActionSelect.addEventListener("change", async () => {
  const saved = await persist(current => withDefaultAction(current, defaultActionSelect.value));
  if (!saved) {
    // 保存失败时恢复为存储中的值，不把未保存的选择留在界面上。
    defaultActionSelect.value = settings.defaultAction;
  }
});

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
