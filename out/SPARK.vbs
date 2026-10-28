Option Explicit

Dim shell, fso, root, supervisor, workerPath, action, command, exitRequest
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
supervisor = fso.BuildPath(root, "out\spark\script\spark-tray-supervisor.ps1")
workerPath = fso.BuildPath(root, "out\spark\script\spark-hidden-action.ps1")
exitRequest = fso.BuildPath(root, "log\system\spark-tray-exit.request")

If WScript.Arguments.Count = 0 Then
  action = "start"
Else
  action = LCase(Trim(WScript.Arguments(0)))
End If

Select Case action
  Case "start", "restart", "status", "stop"
  Case Else
    WScript.Quit 2
End Select

On Error Resume Next
If action = "start" Or action = "restart" Then
  ' A fresh user launch cancels a previous explicit Exit Tray request.
  If fso.FileExists(exitRequest) Then fso.DeleteFile exitRequest, True
  Err.Clear
  command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & supervisor & Chr(34)
  shell.Run command, 0, False
  If Err.Number <> 0 Then
    MsgBox "SPARK tray supervisor could not start: " & Err.Description, 16, "SPARK startup failed"
    WScript.Quit 1
  End If
End If

' Lifecycle is serialized and must not depend on tray initialization.
Err.Clear
command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & Chr(34) & workerPath & Chr(34) & " -Action " & action
shell.Run command, 0, False
If Err.Number <> 0 Then
  MsgBox "SPARK " & action & " could not start: " & Err.Description, 16, "SPARK startup failed"
  WScript.Quit 1
End If
On Error GoTo 0
