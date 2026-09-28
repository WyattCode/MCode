$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "logic.ps1")
function Expect($actual, $expected, $what) {
  if ($actual -ne $expected) { Write-Output "FAIL ${what}: expected '$expected', got '$actual'"; exit 1 }
}
Expect (Get-Plus 3) 4 "Plus"
Expect (Get-Minus 5) 4 "Minus subtracts one"
Expect (Get-Reset) 0 "Reset"
Expect (Get-SavedText "Wang" "Japanese" $true) "Saved: Wang, Japanese, dark" "dark mode checked says dark"
Expect (Get-SavedText "" "English" $false) "Saved: (no name), English, light" "unchecked says light"
$app = Get-Content (Join-Path $PSScriptRoot "app.ps1") -Raw
if ($app -notmatch "logic\.ps1") { Write-Output "FAIL the app no longer loads logic.ps1"; exit 1 }
Write-Output "check passed"
