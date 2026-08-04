Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
}
"@
# window (425,249); selectall button center (499,587)
[M]::SetCursorPos(499, 587) | Out-Null
Start-Sleep -Milliseconds 300
[M]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)  # LEFTDOWN
Start-Sleep -Milliseconds 200
for ($i = 1; $i -le 8; $i++) {
  [M]::SetCursorPos(499 + 20 * $i, 587 + 5 * $i) | Out-Null
  Start-Sleep -Milliseconds 90
}
Start-Sleep -Milliseconds 300
[M]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)  # LEFTUP
Start-Sleep -Milliseconds 500
Write-Output "drag simulated"
