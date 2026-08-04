$ErrorActionPreference = 'Stop'
if (-not $env:GRSAI_API_KEY) { throw 'Missing GRSAI_API_KEY' }

$prompt = @'
A 4x3 grid of 12 minimalist app icons on a pure solid black background. Each icon is a clean white glyph, perfectly centered in its own equal square cell with generous padding and no grid lines. Flat modern line-icon style, consistent stroke weight, rounded geometry, no text, no shadows, no color, high contrast.
Row 1: microphone, lightning bolt, raised open palm (stop), clipboard with checklist.
Row 2: dashed selection square, paper plane (send), bent arrow turning down-left (enter key symbol), forward slash symbol.
Row 3: at sign, two overlapping rectangles (copy), clipboard with a right arrow (paste), backspace key outline with an X.
All 12 glyphs uniform in size, alignment and visual weight.
'@

$body = @{
  model       = 'gpt-image-2'
  prompt      = $prompt
  images      = @()
  aspectRatio = '1024x1024'
  replyType   = 'async'
} | ConvertTo-Json -Depth 8

$headers = @{
  Authorization  = "Bearer $env:GRSAI_API_KEY"
  'Content-Type' = 'application/json'
}

$submit = Invoke-RestMethod -Uri 'https://grsaiapi.com/v1/api/generate' -Method Post -Headers $headers -Body $body -TimeoutSec 120
$taskId = $submit.id
if (-not $taskId) { throw "No task id returned" }
Write-Output "submitted: $taskId"

$final = $null
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Seconds 10
  $result = Invoke-RestMethod -Uri "https://grsaiapi.com/v1/api/result?id=$taskId" -Method Get -Headers $headers -TimeoutSec 60
  if ($result.status -in @('succeeded','failed','violation')) { $final = $result; break }
}
if (-not $final) { throw "Task $taskId still running after 30 polls" }
if ($final.status -ne 'succeeded') { throw "Task $taskId status: $($final.status)" }

$imageUrl = $final.results[0].url
$out = 'D:\ObjectCode\TouchDeck\prototype\icons-gen\sheet.png'
New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
Invoke-WebRequest -Uri $imageUrl -OutFile $out
Write-Output "saved: $out"
