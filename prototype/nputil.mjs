// 原型期验证工具：按进程名聚焦窗口 / 读前台窗口文本（Ctrl+A Ctrl+C + 剪贴板）
// 用法:
//   node prototype/nputil.mjs focus notepad.exe        聚焦记事本（真实鼠标点击，绕过前台锁）
//   node prototype/nputil.mjs focus "TouchDeck 控制台"  按标题聚焦
//   node prototype/nputil.mjs readtext                 前台窗口全选复制，把剪贴板原样输出
import koffi from "koffi";

const user32 = koffi.load("user32.dll");
const kernel32 = koffi.load("kernel32.dll");
const EnumWindows = user32.func("__stdcall", "EnumWindows", "bool", ["void *", "intptr_t"]);
const IsWindowVisible = user32.func("__stdcall", "IsWindowVisible", "bool", ["uintptr_t"]);
const GetWindowTextW = user32.func("__stdcall", "GetWindowTextW", "int", ["uintptr_t", "uint16_t *", "int"]);
const GetWindowThreadProcessId = user32.func("__stdcall", "GetWindowThreadProcessId", "uint32_t", ["uintptr_t", "uint32_t *"]);
const GetWindowRect = user32.func("__stdcall", "GetWindowRect", "bool", ["uintptr_t", "void *"]);
// 强制置前台（UU 远程会话下合成点击不改前台，需 AttachThreadInput 借道）
const GetForegroundWindow = user32.func("__stdcall", "GetForegroundWindow", "uintptr_t", []);
const SetForegroundWindow = user32.func("__stdcall", "SetForegroundWindow", "bool", ["uintptr_t"]);
const AttachThreadInput = user32.func("__stdcall", "AttachThreadInput", "bool", ["uint32_t", "uint32_t", "bool"]);
const BringWindowToTop = user32.func("__stdcall", "BringWindowToTop", "bool", ["uintptr_t"]);
const GetCurrentThreadId = kernel32.func("__stdcall", "GetCurrentThreadId", "uint32_t", []);
const OpenProcess = kernel32.func("__stdcall", "OpenProcess", "uintptr_t", ["uint32_t", "bool", "uint32_t"]);
const QueryFullProcessImageNameW = kernel32.func("__stdcall", "QueryFullProcessImageNameW", "bool", ["uintptr_t", "uint32_t", "uint16_t *", "uint32_t *"]);
const CloseHandle = kernel32.func("__stdcall", "CloseHandle", "bool", ["uintptr_t"]);

function processName(pid) {
  const h = OpenProcess(0x1000, false, pid);
  if (!h) return "";
  const buf = new Uint16Array(512);
  const sz = new Uint32Array([buf.length]);
  let name = "";
  if (QueryFullProcessImageNameW(h, 0, buf, sz)) {
    name = String.fromCharCode(...buf.slice(0, sz[0])).split(/[\\/]/).pop();
  }
  CloseHandle(h);
  return name;
}

function findWindows() {
  const out = [];
  koffi.proto("int __stdcall EnumWindowsProc(uintptr_t hwnd, intptr_t lParam)");
  const cb = koffi.register((hwnd) => {
    if (!IsWindowVisible(hwnd)) return 1;
    const tbuf = new Uint16Array(512);
    const tn = GetWindowTextW(hwnd, tbuf, tbuf.length);
    const title = String.fromCharCode(...tbuf.slice(0, tn));
    const pidArr = new Uint32Array(1);
    GetWindowThreadProcessId(hwnd, pidArr);
    const rect = Buffer.alloc(16);
    GetWindowRect(hwnd, rect);
    out.push({
      hwnd, title, pid: pidArr[0], process: processName(pidArr[0]),
      x: rect.readInt32LE(0), y: rect.readInt32LE(4), r: rect.readInt32LE(8), b: rect.readInt32LE(12),
    });
    return 1;
  }, "EnumWindowsProc *");
  EnumWindows(cb, 0);
  return out;
}

const [cmd, arg] = process.argv.slice(2);

if (cmd === "focus" || cmd === "forcefocus") {
  const wins = findWindows();
  const w = wins.find((w) => w.process.toLowerCase() === arg.toLowerCase())
    || wins.find((w) => w.title.includes(arg));
  if (!w) {
    console.error("window not found:", arg, "candidates:", wins.map((x) => `${x.process}|${x.title}`).join(" ; "));
    process.exit(1);
  }
  if (cmd === "forcefocus") {
    // AttachThreadInput 借道：把本线程输入队列挂到当前前台线程，再 SetForegroundWindow
    const fg = GetForegroundWindow();
    const fgTid = GetWindowThreadProcessId(fg, new Uint32Array(1));
    const myTid = GetCurrentThreadId();
    AttachThreadInput(myTid, fgTid, true);
    BringWindowToTop(w.hwnd);
    const ok = SetForegroundWindow(w.hwnd);
    AttachThreadInput(myTid, fgTid, false);
    console.log("forcefocused:", w.process, JSON.stringify(w.title), "SetForegroundWindow:", ok);
  } else {
    const nut = await import("@nut-tree/nut-js");
    nut.mouse.config.autoDelayMs = 50;
    await nut.mouse.setPosition(new nut.Point(Math.round((w.x + w.r) / 2), Math.round((w.y + w.b) / 2)));
    await nut.mouse.leftClick();
    await new Promise((r) => setTimeout(r, 400));
    console.log("focused:", w.process, JSON.stringify(w.title), `(${w.x},${w.y})-(${w.r},${w.b})`);
  }
} else if (cmd === "readtext") {
  const nut = await import("@nut-tree/nut-js");
  nut.keyboard.config.autoDelayMs = 30;
  const combo = async (key) => {
    await nut.keyboard.pressKey(nut.Key.LeftControl);
    await nut.keyboard.type(key);
    await nut.keyboard.releaseKey(nut.Key.LeftControl);
  };
  await combo(nut.Key.A);
  await new Promise((r) => setTimeout(r, 200));
  await combo(nut.Key.C);
  await new Promise((r) => setTimeout(r, 300));
  // 复制后直接读剪贴板原文输出（前 200 字），验证链路要用
  const { execSync } = await import("child_process");
  const out = execSync('powershell -NoProfile -Command "Get-Clipboard -Raw"', { encoding: "utf-8" });
  console.log("copied", JSON.stringify(out.length > 200 ? out.slice(0, 200) + "…(截断)" : out));
} else {
  console.error("usage: focus <process|title> | readtext");
  process.exit(1);
}
