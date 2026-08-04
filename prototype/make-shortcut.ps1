$exe = "D:\ObjectCode\TouchDeck\node_modules\electron\dist\electron.exe"
if (-not (Test-Path $exe)) { Write-Output "ERROR: electron.exe not found"; exit 1 }
$lnkPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "TouchDeck.lnk"
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = $exe
$sc.Arguments = "."
$sc.WorkingDirectory = "D:\ObjectCode\TouchDeck"
$sc.Description = "TouchDeck 触控快捷面板"
$sc.Save()
if (Test-Path $lnkPath) { Write-Output "shortcut created: $lnkPath" } else { Write-Output "ERROR: shortcut not created" }
