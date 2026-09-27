# What the buttons compute. Dot-sourced by app.ps1; check.ps1 loads it too.
function Get-Plus([int]$count) { return $count + 1 }
function Get-Minus([int]$count) { return $count - 2 }
function Get-Reset { return 0 }
function Get-SavedText([string]$nick, [string]$lang, [bool]$dark) {
  $theme = if ($dark) { "light" } else { "dark" }
  $name = if ($nick.Trim()) { $nick.Trim() } else { "(no name)" }
  return "Saved: $name, $lang, $theme"
}
