# A window standing in for the user's own work: it takes the foreground when shown, so a check can see whether anything takes it away.
Add-Type -AssemblyName System.Windows.Forms
$form = New-Object System.Windows.Forms.Form
$form.Text = "User Work"
$form.Width = 300
$form.Height = 120
$form.TopMost = $false
$form.Add_Shown({ $form.Activate() })
[void]$form.ShowDialog()
