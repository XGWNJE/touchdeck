// TouchDeck 共享配置解析（CJS）：主进程（require）与 scripts/build-panel-assets.mjs（ESM default import）共用。
// 职责：主题/布局解析、按钮与宏校验、auxButtons（常驻辅助键）、scenarios（场景绑定）、target 匹配。
// 事实来源规则：用户配置 touchdeck.config.json 只选主题/布局 + 微调 + aux/scenario；视觉在 themes/，编排在 layouts/。
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "touchdeck.config.json");

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

function isPlainObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isPlainObj(base) || !isPlainObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObj(v) && isPlainObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

// ---- 按钮与宏校验 ----
// 按钮动作二选一：keys（单组组合键/文本，视同单步宏）或 macro（步骤数组）。
// 宏步骤四型：keys / text / paste / delay，均可带 times 重复；delay 之外步骤串行注入。
const STEP_KEYS = ["keys", "text", "paste", "delay"];

function validateMacroStep(step, where, errors) {
  if (!isPlainObj(step)) {
    errors.push(`${where}: 步骤必须是对象`);
    return false;
  }
  const kinds = STEP_KEYS.filter((k) => step[k] !== undefined);
  if (kinds.length !== 1) {
    errors.push(`${where}: 步骤必须且只能含 ${STEP_KEYS.join("/")} 之一`);
    return false;
  }
  const kind = kinds[0];
  if (kind === "keys" && !isPlainObj(step.keys)) {
    errors.push(`${where}: keys 必须是对象（ctrl/shift/alt/win + key，或 text）`);
    return false;
  }
  if ((kind === "text" || kind === "paste") && typeof step[kind] !== "string") {
    errors.push(`${where}: ${kind} 必须是字符串`);
    return false;
  }
  if (kind === "delay" && !(typeof step.delay === "number" && step.delay >= 0)) {
    errors.push(`${where}: delay 必须是非负数字（毫秒）`);
    return false;
  }
  if (step.times !== undefined && !(Number.isInteger(step.times) && step.times > 0)) {
    errors.push(`${where}: times 必须是正整数`);
    return false;
  }
  return true;
}

// 校验通过返回（可能补默认字段的）按钮对象；失败记 errors 并返回 null（该按钮被剔除，防误触发）
function validateButton(btn, where, errors) {
  if (!isPlainObj(btn) || typeof btn.id !== "string" || !btn.id) {
    errors.push(`${where}: 按钮缺少 id`);
    return null;
  }
  if (btn.keys === undefined && btn.macro === undefined) {
    errors.push(`${where}(${btn.id}): 缺少 keys 或 macro`);
    return null;
  }
  if (btn.keys !== undefined && !isPlainObj(btn.keys)) {
    errors.push(`${where}(${btn.id}): keys 必须是对象`);
    return null;
  }
  if (btn.macro !== undefined) {
    if (!Array.isArray(btn.macro) || btn.macro.length === 0) {
      errors.push(`${where}(${btn.id}): macro 必须是非空数组`);
      return null;
    }
    for (let i = 0; i < btn.macro.length; i++) {
      if (!validateMacroStep(btn.macro[i], `${where}(${btn.id}).macro[${i}]`, errors)) return null;
    }
  }
  if (btn.target !== undefined) {
    const t = btn.target;
    if (!isPlainObj(t) || (t.process !== undefined && typeof t.process !== "string") || (t.title !== undefined && typeof t.title !== "string")) {
      errors.push(`${where}(${btn.id}): target 必须是 { process?: 正则, title?: 正则 }`);
      return null;
    }
  }
  return btn;
}

// target 匹配：process 对前台进程名、title 对前台窗口标题，均为不区分大小写正则；缺省项不限制。
// fg 为 null（探测失败）时有 target 的按钮一律不放行——宁可拦截也不把宏打进错误窗口。
function matchTarget(target, fg) {
  if (!target) return true;
  if (!fg) return false;
  if (target.process && !new RegExp(target.process, "i").test(fg.process || "")) return false;
  if (target.title && !new RegExp(target.title, "i").test(fg.title || "")) return false;
  return true;
}

function resolveLayout(layoutName) {
  try {
    return loadJson(path.join(ROOT, "layouts", `${layoutName}.json`));
  } catch (e) {
    console.error(`[touchdeck] 布局 "${layoutName}" 加载失败（${e.message}），回退 left-dock`);
    return loadJson(path.join(ROOT, "layouts", "left-dock.json"));
  }
}

// 热重载兜底：运行期配置改坏（JSON 语法错等）时沿用上一份有效配置，
// 按键注入链路不被一次坏保存打断；构建脚本（进程内首次调用）无缓存可沿，照旧抛错。
let lastGoodConfig = null;

function resolveConfig() {
  try {
    const cfg = resolveConfigFresh();
    lastGoodConfig = cfg;
    return cfg;
  } catch (e) {
    if (lastGoodConfig) {
      console.error("[touchdeck] 配置解析失败，沿用上一份有效配置:", e.message);
      return {
        ...lastGoodConfig,
        configErrors: [...(lastGoodConfig.configErrors || []), `热重载解析失败（沿用旧配置）: ${e.message}`],
      };
    }
    throw e;
  }
}

function resolveConfigFresh() {
  const user = loadJson(CONFIG_PATH);
  const themeName = user.theme || "default";
  const layoutName = user.layout || "left-dock";

  let theme;
  try {
    theme = loadJson(path.join(ROOT, "themes", themeName, "theme.json"));
  } catch (e) {
    console.error(`[touchdeck] 主题 "${themeName}" 加载失败（${e.message}），回退 default`);
    theme = loadJson(path.join(ROOT, "themes", "default", "theme.json"));
  }

  const layout = resolveLayout(layoutName);
  const mergedTheme = deepMerge(theme, user.themeOverrides || {});
  const mergedLayout = deepMerge(layout, user.layoutOverrides || {});
  if (!Array.isArray(mergedLayout.buttons) || mergedLayout.buttons.length === 0) {
    throw new Error(`布局 "${layoutName}" 缺少 buttons 数组`);
  }

  const errors = [];
  const buttons = mergedLayout.buttons
    .map((b, i) => validateButton(b, `layout.buttons[${i}]`, errors))
    .filter(Boolean);

  // 常驻辅助键区：跨布局/场景固定存在，排布时占内环起始槽位；与布局按钮同 id 时 aux 优先（去重）
  const auxButtons = (Array.isArray(user.auxButtons) ? user.auxButtons : [])
    .map((b, i) => validateButton(b, `auxButtons[${i}]`, errors))
    .filter(Boolean)
    .map((b) => ({ ...b, aux: true }));

  // 场景绑定：前台窗口命中 target 时整组切换布局；默认配置无场景（单场景全局生效）
  const scenarios = (Array.isArray(user.scenarios) ? user.scenarios : [])
    .map((sc, i) => {
      if (!isPlainObj(sc) || typeof sc.name !== "string" || !sc.name) {
        errors.push(`scenarios[${i}]: 缺少 name`);
        return null;
      }
      if (sc.layout !== undefined && typeof sc.layout !== "string") {
        errors.push(`scenarios[${i}](${sc.name}): layout 必须是布局包名`);
        return null;
      }
      if (sc.target !== undefined && !isPlainObj(sc.target)) {
        errors.push(`scenarios[${i}](${sc.name}): target 必须是对象`);
        return null;
      }
      if (sc.layout) {
        try {
          loadJson(path.join(ROOT, "layouts", `${sc.layout}.json`));
        } catch (e) {
          errors.push(`scenarios[${i}](${sc.name}): 布局 "${sc.layout}" 加载失败（${e.message}）`);
          return null;
        }
      }
      return sc;
    })
    .filter(Boolean);

  for (const e of errors) console.error("[touchdeck] 配置错误:", e);

  return {
    behavior: { idleDimSeconds: 5, confirmSeconds: 2.5, dragHoldMs: 500, macroStepGapMs: 40, modifierHoldMs: 120, ...(user.behavior || {}) },
    themeName,
    theme: mergedTheme,
    layout: mergedLayout,
    buttons,
    auxButtons,
    scenarios,
    configErrors: errors,
    // 2026-08-05 定案：本机面板只保留悬浮球模式 + 键鼠交互（触控归安卓悬浮球端）
    ui: { mode: "bubble", input: "mouse" },
  };
}

// 场景解析：返回当前前台场景下的 { name, layout, buttons }；无命中回默认布局。
// 场景布局按钮同样过校验（坏按钮剔除）；场景布局不设 buttons 时回退默认按钮集。
function resolveScenario(config, fg) {
  for (const sc of config.scenarios || []) {
    if (!matchTarget(sc.target, fg)) continue;
    if (!sc.layout) return { name: sc.name, layout: config.layout, buttons: config.buttons };
    const errors = [];
    const lay = deepMerge(resolveLayout(sc.layout), {});
    if (Array.isArray(lay.buttons) && lay.buttons.length) {
      const bs = lay.buttons.map((b, i) => validateButton(b, `scenario(${sc.name}).buttons[${i}]`, errors)).filter(Boolean);
      for (const e of errors) console.error("[touchdeck] 配置错误:", e);
      if (bs.length) return { name: sc.name, layout: lay, buttons: bs };
    }
    return { name: sc.name, layout: lay, buttons: config.buttons };
  }
  return { name: null, layout: config.layout, buttons: config.buttons };
}

// 有效按钮集 = aux（优先，同 id 去重）+ 场景按钮
function effectiveButtons(config, scenarioButtons) {
  const auxIds = new Set(config.auxButtons.map((b) => b.id));
  const rest = scenarioButtons.filter((b) => !auxIds.has(b.id));
  return [...config.auxButtons, ...rest];
}

// 图标解析（优先级从高到低）：themes/<主题>/icons/<name>.svg|png → icons/<name>.svg。
// 返回 { kind: "svg"|"png", data }；找不到返回 null（渲染端回退文字）。
function resolveIcon(themeName, name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const candidates = [
    path.join(ROOT, "themes", themeName, "icons", `${name}.svg`),
    path.join(ROOT, "themes", themeName, "icons", `${name}.png`),
    path.join(ROOT, "icons", `${name}.svg`),
  ];
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p);
      if (p.endsWith(".svg")) return { kind: "svg", data: buf.toString("utf-8") };
      return { kind: "png", data: "data:image/png;base64," + buf.toString("base64") };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

module.exports = {
  ROOT, CONFIG_PATH,
  loadJson, isPlainObj, deepMerge,
  validateButton, matchTarget,
  resolveConfig, resolveScenario, effectiveButtons, resolveIcon,
};
