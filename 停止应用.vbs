' BPMN Generator - stop the local server (POST /api/shutdown).
Option Explicit

Dim http, ok
ok = False

On Error Resume Next
Set http = CreateObject("MSXML2.ServerXMLHTTP.6.0")
If Err.Number = 0 Then
  http.open "POST", "http://127.0.0.1:8099/api/shutdown", False
  http.setRequestHeader "Content-Type", "application/json"
  http.send "{}"
  If Err.Number = 0 Then ok = True
End If
On Error Goto 0

If ok Then
  MsgBox "App server stopped. You can close the window now.", 64, "BPMN Generator"
Else
  MsgBox "App server is not running.", 64, "BPMN Generator"
End If
