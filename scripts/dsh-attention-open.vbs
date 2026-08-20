' Hidden launcher for dsh-attention: protocol.
' Join every argument: if Windows/cmd splits on &, we stitch it back.
' Pass the URI via process env so the PowerShell command line never contains &.
Option Explicit
Dim sh, ps, scriptDir, ps1, uri, cmd, i
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then WScript.Quit 0
uri = Replace(WScript.Arguments(0), """", "")
For i = 1 To WScript.Arguments.Count - 1
  uri = uri & "&" & Replace(WScript.Arguments(i), """", "")
Next
scriptDir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
ps1 = scriptDir & "protocol-handler.ps1"
ps = sh.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
sh.Environment("Process")("DSH_ATTENTION_URI") = uri
cmd = """" & ps & """ -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & ps1 & """"
sh.Run cmd, 0, False
