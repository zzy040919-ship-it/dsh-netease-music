param([Parameter(Mandatory=$true)][string]$Prefs)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$json = Get-Content -LiteralPath $Prefs -Raw | ConvertFrom-Json
$bytes = [Convert]::FromBase64String($json.os_crypt.encrypted_key)
if ($bytes.Length -le 5) { throw 'encrypted_key too short' }
$blob = New-Object byte[] ($bytes.Length - 5)
[Array]::Copy($bytes, 5, $blob, 0, $blob.Length)
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
Write-Output ([Convert]::ToBase64String($key))
