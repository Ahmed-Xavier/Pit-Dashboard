@echo off
setlocal
set "ROOT=%~dp0"
set "PORT=%~1"
if not defined PORT set "PORT=8080"
set "PYRUN="

where python >nul 2>nul && set "PYRUN=python"
if not defined PYRUN where py >nul 2>nul && set "PYRUN=py"
if not defined PYRUN where npx >nul 2>nul && set "PYRUN=npx"
if not defined PYRUN (
  echo Could not find Python, py, or npx. Install Python 3 or Node.js and try again.
  echo Dashboard folder: %ROOT%
  pause
  exit /b 1
)

:check_port
if %PORT% GTR 8090 (
  echo Ports 8080 through 8090 are busy. Close a server and try again.
  pause
  exit /b 1
)
if /I "%PYRUN%"=="npx" (
  powershell -NoProfile -Command "try {$l=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,%PORT%);$l.Start();$l.Stop();exit 0}catch{exit 1}" >nul 2>nul
) else (
  %PYRUN% -c "import socket,sys; s=socket.socket(); s.bind(('127.0.0.1',int(sys.argv[1]))); s.close()" %PORT% >nul 2>nul
)
if errorlevel 1 (
  echo Port %PORT% is busy; trying %PORT%+1.
  set /a PORT+=1
  goto check_port
)

cd /d "%ROOT%"
echo Pit Dashboard web root: %ROOT%
echo URL: http://localhost:%PORT%/?bridge=ws://127.0.0.1:8765
echo Press Ctrl+C in this window to stop the static server.
echo Reminder: this does not start ROS or foxglove_bridge. In WSL run:
echo   source /opt/ros/jazzy/setup.bash
echo   cd ~/Autonomous-outdoor-RC/ros2_ws ^&^& source install/setup.bash
echo   ros2 launch simulation simulation.launch.py
echo Development note: Python's basic server sends cacheable responses. Use Ctrl+F5 after edits.
start "" /b powershell -NoProfile -Command "Start-Sleep -Seconds 1; Start-Process 'http://localhost:%PORT%/?bridge=ws://127.0.0.1:8765'"

if /I "%PYRUN%"=="npx" (
  npx --yes serve -l %PORT% "%ROOT%"
) else (
  %PYRUN% -m http.server %PORT% --bind 127.0.0.1
)
pause
