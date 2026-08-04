$procs = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -like '*ObjectCode*TouchDeck*' }
$count = ($procs | Measure-Object).Count
Write-Output "touchdeck electron processes: $count"
$procs | ForEach-Object { Write-Output ("pid={0}" -f $_.ProcessId) }
