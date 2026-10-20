# Prints the NetEase Cloud Music window title (NDJSON, one line per tick).
# ASCII only: Windows PowerShell 5.1 reads BOM-less scripts as ANSI.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
while ($true) {
  $title = ''
  $proc = Get-Process cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object -First 1
  if ($null -ne $proc) { $title = [string]$proc.MainWindowTitle }
  $json = $title | ConvertTo-Json -Compress
  [Console]::Out.WriteLine('{"t":"title","title":' + $json + '}')
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 900
}
