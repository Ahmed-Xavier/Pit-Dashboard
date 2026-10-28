$ErrorActionPreference = 'Stop'
$pit = Split-Path -Parent $MyInvocation.MyCommand.Path
& (Join-Path $pit 'scripts\sync-track.ps1')
$pitServer = Join-Path $pit 'scripts\run-pit-server.ps1'
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',("`"$pitServer`""))
Write-Host 'Pit dashboard:   http://localhost:8080'
Start-Process 'http://localhost:8080'
