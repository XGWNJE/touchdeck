#!/usr/bin/env node
// 发包引导脚本：三处版本号一致性检查 + 可选一键同步 + 发包步骤提示
// 用法：
//   node scripts/release.mjs              # 检查三处版本号是否一致
//   node scripts/release.mjs --sync 0.1.7 # 同步三处版本号为 0.1.7（安卓 versionCode 自动 +1）
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), "utf8"));
}

const pkg = readJson("package.json");
const server = readJson("server/package.json");
const gradle = readFileSync(join(root, "android/app/build.gradle.kts"), "utf8");

const gradleVersion = gradle.match(/versionName\s*=\s*"([^"]+)"/)?.[1] ?? null;
const gradleCode = gradle.match(/versionCode\s*=\s*(\d+)/)?.[1] ?? null;

const versions = [
  { name: "package.json（主程序）", value: pkg.version },
  { name: "android versionName", value: gradleVersion },
  { name: "server/package.json（信令服务）", value: server.version },
];

const allMatch = versions.every((v) => v.value === pkg.version);

console.log("=== 版本号一致性检查 ===");
for (const v of versions) console.log(`  ${v.name}: ${v.value}`);
console.log(`  安卓 versionCode: ${gradleCode}`);

const syncIdx = process.argv.indexOf("--sync");
if (syncIdx !== -1) {
  const target = process.argv[syncIdx + 1];
  if (!target) {
    console.error("用法：node scripts/release.mjs --sync <版本号>，如 --sync 0.1.7");
    process.exit(1);
  }
  if (!/^\d+\.\d+\.\d+$/.test(target)) {
    console.error(`版本号格式不对：${target}（需要 x.y.z，如 0.1.7）`);
    process.exit(1);
  }
  const nextCode = gradleCode === null ? null : Number(gradleCode) + 1;

  pkg.version = target;
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg, null, 4) + "\n");

  server.version = target;
  writeFileSync(join(root, "server/package.json"), JSON.stringify(server, null, 4) + "\n");

  const gradleNext = gradle
    .replace(/versionName\s*=\s*"[^"]+"/, `versionName = "${target}"`)
    .replace(/versionCode\s*=\s*\d+/, `versionCode = ${nextCode}`);
  writeFileSync(join(root, "android/app/build.gradle.kts"), gradleNext);

  console.log(`\n已同步三处版本号为 ${target}（安卓 versionCode ${gradleCode} → ${nextCode}）。`);
} else if (allMatch) {
  console.log("\n✔ 三处版本号一致，可以发包。");
  console.log("后续步骤：");
  console.log("  1. npm run build:assets   （改过配置/图标时重新生成安卓离线资源）");
  console.log("  2. git add -A && git commit -m 'release: v" + pkg.version + "'");
  console.log(`  3. git tag v${pkg.version} && git push origin v${pkg.version}`);
  console.log("  4. 打开 GitHub Actions 与 Releases 页核验三端产物。");
} else {
  console.log("\n✘ 三处版本号不一致，禁止发包。");
  console.log("处理：node scripts/release.mjs --sync <版本号> 一键同步后再走发包流程。");
  process.exit(1);
}
