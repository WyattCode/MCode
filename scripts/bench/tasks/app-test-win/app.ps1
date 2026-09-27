# A small settings app. Run with: powershell -NoProfile -STA -ExecutionPolicy Bypass -File app.ps1
Add-Type -AssemblyName System.Windows.Forms
. (Join-Path $PSScriptRoot "logic.ps1")
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Settings App"
$form.Width = 460
$form.Height = 340
$form.StartPosition = "CenterScreen"

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = "Fill"
$form.Controls.Add($tabs)

function Add-Page($title) {
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = $title
  $tabs.TabPages.Add($page)
  return $page
}

$homePage = Add-Page "Home"
$greet = New-Object System.Windows.Forms.Button
$greet.Text = "Say hello"
$greet.Left = 20; $greet.Top = 20; $greet.Width = 120
$greeting = New-Object System.Windows.Forms.Label
$greeting.Left = 20; $greeting.Top = 60; $greeting.Width = 300
$greeting.Name = "greeting"
$greet.Add_Click({ $greeting.Text = "Hello there" })
$homePage.Controls.AddRange(@($greet, $greeting))

$count = Add-Page "Count"
$script:value = 0
$shown = New-Object System.Windows.Forms.Label
$shown.Left = 20; $shown.Top = 20; $shown.Width = 200
$shown.Text = "Count: 0"
function Show-Count { $shown.Text = "Count: $script:value" }
$plus = New-Object System.Windows.Forms.Button
$plus.Text = "Plus"; $plus.Left = 20; $plus.Top = 60
$plus.Add_Click({ $script:value = Get-Plus $script:value; Show-Count })
$minus = New-Object System.Windows.Forms.Button
$minus.Text = "Minus"; $minus.Left = 110; $minus.Top = 60
$minus.Add_Click({ $script:value = Get-Minus $script:value; Show-Count })
$reset = New-Object System.Windows.Forms.Button
$reset.Text = "Reset"; $reset.Left = 200; $reset.Top = 60
$reset.Add_Click({ $script:value = Get-Reset; Show-Count })
$count.Controls.AddRange(@($shown, $plus, $minus, $reset))

$settings = Add-Page "Settings"
$dark = New-Object System.Windows.Forms.CheckBox
$dark.Text = "Dark mode"; $dark.Left = 20; $dark.Top = 20; $dark.Width = 150
$langLabel = New-Object System.Windows.Forms.Label
$langLabel.Text = "Language"; $langLabel.Left = 20; $langLabel.Top = 56; $langLabel.Width = 70
$lang = New-Object System.Windows.Forms.ComboBox
$lang.DropDownStyle = "DropDownList"
$lang.Left = 100; $lang.Top = 52; $lang.Width = 150
$lang.AccessibleName = "Language"
[void]$lang.Items.AddRange(@("English", "Chinese", "Japanese"))
$lang.SelectedIndex = 0
$nickLabel = New-Object System.Windows.Forms.Label
$nickLabel.Text = "Nickname"; $nickLabel.Left = 20; $nickLabel.Top = 92; $nickLabel.Width = 70
$nick = New-Object System.Windows.Forms.TextBox
$nick.Left = 100; $nick.Top = 88; $nick.Width = 150
$nick.AccessibleName = "Nickname"
$save = New-Object System.Windows.Forms.Button
$save.Text = "Save"; $save.Left = 20; $save.Top = 124
$saved = New-Object System.Windows.Forms.Label
$saved.Left = 20; $saved.Top = 160; $saved.Width = 400
$save.Add_Click({
  $saved.Text = Get-SavedText $nick.Text ([string]$lang.SelectedItem) $dark.Checked
})
$remove = New-Object System.Windows.Forms.Button
$remove.Text = "Delete account"; $remove.Left = 110; $remove.Top = 124; $remove.Width = 120
$status = New-Object System.Windows.Forms.Label
$status.Left = 20; $status.Top = 190; $status.Width = 400
$remove.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show($form, "Delete the account?", "Confirm", "OKCancel")
  if ($answer -eq "OK") { $status.Text = "Account deleted" }
})
$settings.Controls.AddRange(@($dark, $langLabel, $lang, $nickLabel, $nick, $save, $saved, $remove, $status))

[void]$form.ShowDialog()
