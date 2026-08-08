// Windows 端菜单截图：Win+D 清场 → 点悬浮球展开菜单 → WGC 截全屏 → 点空处收菜单 → Win+D 恢复
// 用法：npx electron prototype/win-menu-shot.mjs <输出路径>
import { app, desktopCapturer, screen } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mouse, keyboard, Key, Point } from "@nut-tree/nut-js";

const out = process.argv[2] || "prototype/win-menu.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  await sleep(1000);
  // 悬浮球心（逻辑像素）：userData 状态有 x/y 用之，否则按默认右缘居中算（ballSize=100）
  const disp = screen.getPrimaryDisplay();
  const area = disp.workArea;
  let st = {};
  try { st = JSON.parse(fs.readFileSync(path.join(os.homedir(), "AppData/Roaming/touchdeck/touchdeck.state.json"), "utf8")); } catch {}
  const ball = 100;
  const bx = st.x ?? (area.x + area.width - ball - 24);
  const by = st.y ?? Math.round(area.y + (area.height - ball) / 2);
  // nut-js 用物理像素，Electron 是逻辑像素 → 乘 scaleFactor
  const sf = disp.scaleFactor;
  const cx = (bx + ball / 2) * sf, cy = (by + ball / 2) * sf;
  console.log("bubble center", cx, cy, "logical screen", disp.size);

  // Win+D 显示桌面（清掉私人窗口内容）
  await keyboard.pressKey(Key.LeftSuper, Key.D);
  await keyboard.releaseKey(Key.LeftSuper, Key.D);
  await sleep(1200);
  // 点球展开菜单
  await mouse.setPosition(new Point(cx, cy));
  await sleep(300);
  await mouse.leftClick();
  await sleep(1200);
  // WGC 截全屏（能抓透明分层窗口）
  const phys = { width: Math.round(disp.size.width * disp.scaleFactor), height: Math.round(disp.size.height * disp.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: phys });
  fs.writeFileSync(out, sources[0].thumbnail.toPNG());
  console.log("saved", out);
  // 点远离菜单的空处收起（hit=-1 → dismiss）
  await mouse.setPosition(new Point(Math.round(disp.size.width / 2) * sf, 100 * sf));
  await sleep(200);
  await mouse.leftClick();
  await sleep(600);
  // Win+D 恢复窗口
  await keyboard.pressKey(Key.LeftSuper, Key.D);
  await keyboard.releaseKey(Key.LeftSuper, Key.D);
  app.exit(0);
});
