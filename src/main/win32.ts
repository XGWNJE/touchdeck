// Win32 函数层（koffi 懒加载）：窗口移动/前台探测/按键状态。
// koffi：调 Win32 SetWindowPos 做主进程轮询拖拽，
// 渲染进程 IPC setPosition 拖拽会导致透明窗面变形，禁走那条路
import koffi from "koffi";

// 以下 koffi func 均为任意签名的可调用对象，用 any 承载
/* eslint-disable @typescript-eslint/no-explicit-any */
export let SendMessageW: any = null;
export let ReleaseCapture: any = null;
export let SetWindowPos: any = null;
export let GetAsyncKeyState: any = null;
export let DwmFlush: any = null;
// 前台窗口探测（目标绑定/场景切换用）：进程名 + 窗口标题
export let GetForegroundWindow: any = null;
export let GetWindowTextW: any = null;
export let GetWindowThreadProcessId: any = null;
export let OpenProcess: any = null;
export let QueryFullProcessImageNameW: any = null;
export let CloseHandle: any = null;

export function ensureWin32(): void {
  if (!SetWindowPos) {
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    const dwmapi = koffi.load("dwmapi.dll");
    // HWND 必须按数值传（getNativeWindowHandle 返回的 Buffer 内容是句柄值，
    // 直接传 Buffer 会把「缓冲区地址」当句柄，调用静默失败——2026-08-02 实证）
    SendMessageW = user32.func("__stdcall", "SendMessageW", "long", ["uintptr_t", "uint", "uintptr_t", "long"]);
    ReleaseCapture = user32.func("__stdcall", "ReleaseCapture", "bool", []);
    SetWindowPos = user32.func("__stdcall", "SetWindowPos", "bool",
      ["uintptr_t", "uintptr_t", "int", "int", "int", "int", "uint"]);
    // 拖球松手检测兜底：SetWindowPos 移动窗口会中断渲染端 pointer capture
    // （pointerup 丢失），本地鼠标场景用左键状态补一个可靠的收尾信号
    GetAsyncKeyState = user32.func("__stdcall", "GetAsyncKeyState", "short", ["int"]);
    // 等待 DWM 完成下一次合成，用桌面实际刷新节拍驱动透明悬浮窗拖动。
    // 普通 setInterval(16) 固定在约 62.5Hz，且不与 90/120/144Hz 桌面同步。
    DwmFlush = dwmapi.func("__stdcall", "DwmFlush", "long", []);
    GetForegroundWindow = user32.func("__stdcall", "GetForegroundWindow", "uintptr_t", []);
    GetWindowTextW = user32.func("__stdcall", "GetWindowTextW", "int", ["uintptr_t", "uint16_t *", "int"]);
    GetWindowThreadProcessId = user32.func("__stdcall", "GetWindowThreadProcessId", "uint32_t", ["uintptr_t", "uint32_t *"]);
    // PROCESS_QUERY_LIMITED_INFORMATION = 0x1000（权限要求最低，读进程映像名足够）
    OpenProcess = kernel32.func("__stdcall", "OpenProcess", "uintptr_t", ["uint32_t", "bool", "uint32_t"]);
    QueryFullProcessImageNameW = kernel32.func("__stdcall", "QueryFullProcessImageNameW", "bool", ["uintptr_t", "uint32_t", "uint16_t *", "uint32_t *"]);
    CloseHandle = kernel32.func("__stdcall", "CloseHandle", "bool", ["uintptr_t"]);
  }
}
