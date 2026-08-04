Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M2 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
[M2]::SetCursorPos(264, 417) | Out-Null
Start-Sleep -Milliseconds 300
[M2]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800
for ($i = 1; $i -le 10; $i++) {
  [M2]::SetCursorPos(264 + 15 * $i, 417 + 6 * $i) | Out-Null
  Start-Sleep -Milliseconds 80
}
Start-Sleep -Milliseconds 300
[M2]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 500
Write-Output "grab drag simulated"
