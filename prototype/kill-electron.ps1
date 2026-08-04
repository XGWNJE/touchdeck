Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*ObjectCode*TouchDeck*' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; Write-Output "killed $($_.ProcessId)" } catch {} }
Write-Output "done"
