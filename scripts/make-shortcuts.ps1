# Create TouchDeck desktop shortcut (idempotent: overwrites existing).
# Usage: powershell -ExecutionPolicy Bypass -File scripts/make-shortcuts.ps1
$ErrorActionPreference = "Stop"

$project = "D:\ObjectCode\TouchDeck"
$electron = Join-Path $project "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "electron.exe not found: $electron" }

$ws = New-Object -ComObject WScript.Shell
$desktop = [Environment]::GetFolderPath("Desktop")

$lnk = $ws.CreateShortcut((Join-Path $desktop "TouchDeck.lnk"))
$lnk.TargetPath = $electron
$lnk.Arguments = "`"$project`""
$lnk.WorkingDirectory = $project
$lnk.Description = "TouchDeck touch shortcut panel (console + panel)"
$lnk.Save()

Write-Output "Created: $desktop\TouchDeck.lnk -> $electron"
