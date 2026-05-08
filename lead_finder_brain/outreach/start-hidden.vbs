' Launches the outreach server with no visible console window.
' Double-click to start now, or let Windows run it at login via the
' shortcut placed in the Startup folder.

Set fso  = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "cmd /c cd /d """ & scriptDir & """ && npm start >> outreach.log 2>&1"

' 0 = hide window, False = don't wait for it to exit.
shell.Run cmd, 0, False
