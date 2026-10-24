' BPMN Generator - desktop launcher
' Starts the local server with NO console window, then opens an app-style window.
' ASCII only on purpose: avoids codepage issues on non-UTF8 hosts.
Option Explicit

Dim fso, sh, base, nodeExe, edge
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base

' ---- locate node.exe ----
nodeExe = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then
  If fso.FileExists("C:\Program Files\nodejs\node.exe") Then
    nodeExe = "C:\Program Files\nodejs\node.exe"
  Else
    nodeExe = "node.exe"
  End If
End If

' ---- locate Microsoft Edge (app mode gives a chromeless window) ----
edge = ""
If fso.FileExists("C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe") Then
  edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
ElseIf fso.FileExists("C:\Program Files\Microsoft\Edge\Application\msedge.exe") Then
  edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
End If

' ---- start the server hidden (0 = no window, False = do not wait) ----
sh.Run """" & nodeExe & """ ""web\serve.js""", 0, False
WScript.Sleep 1500

' ---- open the app window ----
If edge <> "" Then
  sh.Run """" & edge & """ --app=http://127.0.0.1:8099/ --window-size=1360,900", 1, False
Else
  sh.Run "http://127.0.0.1:8099/", 1, False
End If
