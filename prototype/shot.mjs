// 全屏截图工具（desktopCapturer 走 WGC，能抓透明分层窗口；普通 GDI 截图抓不到）
// 用法：npx electron prototype/shot.mjs <输出路径>
import { app, desktopCapturer, screen } from "electron";
import fs from "node:fs";

const out = process.argv[2] || "prototype/shot.png";

app.whenReady().then(async () => {
  // 等 TouchDeck 窗口绘制稳定
  await new Promise((r) => setTimeout(r, Number(process.argv[3] || 1500)));
  const d = screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
  fs.writeFileSync(out, sources[0].thumbnail.toPNG());
  console.log("saved", out, size);
  app.exit(0);
});
