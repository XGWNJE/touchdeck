// 生成 Android 原生面板资源：panel.json（布局+主题+按钮）+ 主题 PNG 图标副本。
// 产物进 android assets，App 离线用原生 View 渲染（未连接兜底）；连接后按钮集由 host 经 DataChannel 下发。
// 运行方式：npm run build:assets（tsx 直跑本文件，与主进程共用 src/shared/config-resolve.ts 单一事实源）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, resolveIcon, type PanelButton } from "../src/shared/config-resolve";
import { defaultActionBindings } from "../src/shared/action-bindings";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = resolveConfig();
const defaultBindings = defaultActionBindings().bindings;
const assetsDir = path.join(ROOT, "android", "app", "src", "main", "assets");
const iconsDir = path.join(assetsDir, "icons");
fs.mkdirSync(iconsDir, { recursive: true });

// 平板原生端尺寸系数：Windows 120px 基线在 8.8 寸屏实测偏大（v0.2.0 反馈），减半。
const ANDROID_SCALE = 0.5;
const scaled = (n: number) => Math.max(1, Math.round(n * ANDROID_SCALE));

const panel = {
  behavior: { confirmSeconds: config.behavior.confirmSeconds ?? 2.5 },
  layout: {
    columns: config.layout.columns,
    gap: scaled(config.layout.gap),
    padding: scaled(config.layout.padding),
    buttonSize: scaled(config.layout.buttonSize),
    showLabel: config.layout.showLabel !== false,
    showSub: config.layout.showSub !== false,
  },
  theme: {
    ...config.theme,
    bar: { ...config.theme.bar, borderRadius: scaled(config.theme.bar.borderRadius) },
    button: {
      ...config.theme.button,
      borderRadius: scaled(config.theme.button.borderRadius),
      iconSize: scaled(config.theme.button.iconSize),
      labelSize: scaled(config.theme.button.labelSize),
      subSize: scaled(config.theme.button.subSize),
    },
  },
  // aux 常驻键在前（占内环起始槽位），与布局按钮同 id 去重（aux 优先）——与 Windows 端同规则
  buttons: [...config.auxButtons, ...config.buttons.filter((lb: PanelButton) => !config.auxButtons.some((a) => a.id === lb.id))]
    .map((b: PanelButton) => ({
      id: b.id, icon: b.icon, label: b.label, sub: b.sub,
      group: b.group || "edit", confirm: !!b.confirm, aux: !!b.aux,
      triggerMode: (defaultBindings as Record<string, { triggerMode: "tap" | "hold" }>)[b.id]?.triggerMode || "tap",
    })),
};

let copied = 0;
for (const b of panel.buttons) {
  const res = resolveIcon(config.themeName, b.icon!);
  if (res && res.kind === "png") {
    const base64 = res.data.replace(/^data:image\/png;base64,/, "");
    fs.writeFileSync(path.join(iconsDir, `${b.icon}.png`), Buffer.from(base64, "base64"));
    copied++;
  } // svg 或缺失：App 端回退文字图标（正式版可在生成期预栅格化）
}

fs.writeFileSync(path.join(assetsDir, "panel.json"), JSON.stringify(panel, null, 2));
console.log(`[panel] panel.json + ${copied}/${panel.buttons.length} 个 PNG 图标 → android assets`);
