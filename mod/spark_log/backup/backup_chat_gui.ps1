Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Import-Module (Join-Path $PSScriptRoot 'ChatBackup.Core.psm1') -Force

$form = New-Object Windows.Forms.Form
$form.Text = 'SPARK ChatLog Backup'
$form.Size = New-Object Drawing.Size(720, 465)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false

$titleLabel = New-Object Windows.Forms.Label
$titleLabel.Text = 'Chat / Work title'
$titleLabel.Location = New-Object Drawing.Point(20, 25)
$titleLabel.AutoSize = $true
$form.Controls.Add($titleLabel)

$titleBox = New-Object Windows.Forms.TextBox
$titleBox.Location = New-Object Drawing.Point(20, 50)
$titleBox.Size = New-Object Drawing.Size(660, 25)
$form.Controls.Add($titleBox)

$destLabel = New-Object Windows.Forms.Label
$destLabel.Text = 'Save folder'
$destLabel.Location = New-Object Drawing.Point(20, 90)
$destLabel.AutoSize = $true
$form.Controls.Add($destLabel)

$destBox = New-Object Windows.Forms.TextBox
# Durable default: never place reusable chat archives in disposable log/.
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
. (Join-Path $repoRoot 'out\spark\script\spark-data-path.ps1')
$privateArchive = Join-Path (Get-SparkUserDataRoot -SourceRoot $repoRoot) 'chatlog'
if (Test-Path -LiteralPath $privateArchive -PathType Container) { $destBox.Text = $privateArchive }
$destBox.Location = New-Object Drawing.Point(20, 115)
$destBox.Size = New-Object Drawing.Size(560, 25)
$form.Controls.Add($destBox)

$browse = New-Object Windows.Forms.Button
$browse.Text = 'Browse...'
$browse.Location = New-Object Drawing.Point(590, 113)
$browse.Size = New-Object Drawing.Size(90, 28)
$browse.Add_Click({
    $dlg = New-Object Windows.Forms.FolderBrowserDialog
    $dlg.Description = 'Select the folder where <chat or Work title>.jsonl will be saved.'
    if ($dlg.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { $destBox.Text = $dlg.SelectedPath }
})
$form.Controls.Add($browse)

$archiveCheck = New-Object Windows.Forms.CheckBox
$archiveCheck.Text = 'Remove from sidebar after verified backup (Archive; reversible)'
$archiveCheck.Location = New-Object Drawing.Point(20, 155)
$archiveCheck.Size = New-Object Drawing.Size(500, 25)
$archiveCheck.Checked = $false
$form.Controls.Add($archiveCheck)

$backupButton = New-Object Windows.Forms.Button
$backupButton.Text = 'Backup'
$backupButton.Location = New-Object Drawing.Point(20, 190)
$backupButton.Size = New-Object Drawing.Size(110, 34)
$form.Controls.Add($backupButton)

$status = New-Object Windows.Forms.TextBox
$status.Location = New-Object Drawing.Point(20, 240)
$status.Size = New-Object Drawing.Size(660, 155)
$status.Multiline = $true
$status.ReadOnly = $true
$status.ScrollBars = 'Vertical'
$form.Controls.Add($status)

$backupButton.Add_Click({
    $status.Text = 'Starting backup. Keep the ChatGPT Windows App open.'
    $form.Refresh()
    try {
        $params = @{
            Title = $titleBox.Text
            OutputDirectory = $destBox.Text
        }
        if ($archiveCheck.Checked) { $params.ArchiveAfterBackup = $true }

        $result = Backup-ChatGPTConversation @params
        $countLine = if ($result.ItemKind -eq 'local') { "Records: $($result.RecordCount)" } else { "Nodes: $($result.MappingCount)" }
        $status.Text = "Backup file saved and SHA-256 verified.`r`nSnapshot: $($result.SnapshotStatus)`r`nType: $($result.ItemKind)`r`nPath: $($result.Path)`r`nID: $($result.ConversationId)`r`n$countLine`r`nBytes: $($result.Bytes)`r`nSHA-256: $($result.Sha256)"
        if ($result.ItemKind -eq 'server' -and -not $result.LatestUserTurnCompleted) {
            $status.AppendText("`r`nWARNING: The latest user turn has no finished assistant final in this snapshot. Re-backup after the answer completes.")
        }
        if ($result.BackupOfPrevious) { $status.AppendText("`r`nPrevious file backup: $($result.BackupOfPrevious)") }
        if ($result.ArchiveRequested) {
            if ($result.ItemKind -eq 'server') {
                $status.AppendText("`r`nArchive: native ChatGPT Archive completed.")
                if ($result.PSObject.Properties['ArchivedListVerified'] -and $result.ArchivedListVerified) {
                    $status.AppendText(" Settings > Archived chats: verified.")
                } elseif ($result.PSObject.Properties['ArchiveVerificationDeferred'] -and $result.ArchiveVerificationDeferred) {
                    $status.AppendText(" Settings > Archived chats verification: deferred ($($result.ArchivedListVerificationStatus)).")
                }
                if ($result.SidebarRemovedAfterBackup) {
                    $status.AppendText(" Regular sidebar: removed.")
                } else {
                    $status.AppendText(" Regular sidebar verification: deferred.")
                }
            } else {
                $status.AppendText("`r`nArchive: local Work moved to archived sessions and removed from the regular sidebar.")
            }
            if ($result.PSObject.Properties['SidebarSyncWaitMs']) {
                $status.AppendText(" Sync: $($result.SidebarSyncWaitMs) ms.")
            }
        } else {
            $status.AppendText("`r`nSidebar: unchanged.")
        }
    } catch {
        $message = $_.Exception.Message
        if ($message.StartsWith('Backup is safely stored') -or $message.StartsWith('Work backup is safely stored')) {
            $status.Text = "Backup completed, but the sidebar archive step failed.`r`n$message"
        } else {
            $status.Text = "Backup failed:`r`n$message"
        }
    }
})

[void]$form.ShowDialog()
