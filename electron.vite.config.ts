// electron-vite 配置：主/preload/渲染三端统一构建，渲染层四页多入口。
// preload 必须 CJS（渲染进程默认 sandbox，ESM preload 不兼容）→ 强制 cjs 输出 + .cjs 后缀。
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

const root = import.meta.dirname;

export default defineConfig({
  main: {
    build: {
      outDir: "out/main",
      rollupOptions: { input: { index: resolve(root, "src/main/index.ts") } },
    },
  },
  preload: {
    build: {
      outDir: "out/preload",
      rollupOptions: {
        input: { index: resolve(root, "src/preload/index.ts") },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    build: {
      outDir: "out/renderer",
      rollupOptions: {
        input: {
          console: resolve(root, "src/renderer/console/index.html"),
          bubble: resolve(root, "src/renderer/bubble/index.html"),
          menu: resolve(root, "src/renderer/menu/index.html"),
          peer: resolve(root, "src/renderer/peer/index.html"),
        },
      },
    },
  },
});
