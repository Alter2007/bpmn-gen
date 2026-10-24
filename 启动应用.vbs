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

' ---- stop any previous instance so every launch starts from a clean process ----
' (otherwise an orphan server keeps the old API key in memory)
Dim http
On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Err.Number = 0 Then
  http.open "POST", "http://127.0.0.1:8099/api/shutdown", False
  http.setRequestHeader "Content-Type", "application/json"
  http.send "{}"
End If
On Error Goto 0
WScript.Sleep 700

' ---- start the server hidden (0 = no window, False = do not wait) ----
sh.Run """" & nodeExe & """ ""web\serve.js""", 0, False
WScript.Sleep 1500

' ---- open the app window ----
If edge <> "" Then
  sh.Run """" & edge & """ --app=http://127.0.0.1:8099/ --window-size=1360,900", 1, False
Else
  sh.Run "http://127.0.0.1:8099/", 1, False
End If
