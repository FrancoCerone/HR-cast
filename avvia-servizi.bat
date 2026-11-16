@echo off
setlocal EnableExtensions
title Launcher servizi
echo ===============================
echo Avvio servizi Ableton + HRcast
echo ===============================
echo.

:: Avvio primo servizio
start "AbletonLiveTimelineReader" cmd /k "title AbletonLiveTimelineReader & cd /d C:\D_E_V_E_L_O_P\gitHubFranco\AbletonLiveTimelineReader\git\AbletonLiveTimelineReader && npm start"

:: Avvio secondo servizio
start "AbletonJsConnector" cmd /k "title AbletonJsConnector & cd /d C:\D_E_V_E_L_O_P\gitHubFranco\AbletonSongTimeServer\git\AbletonJsConnector && npm start"

:: Avvio HRcast prima del tunnel, cosi' ngrok ha gia' un server a cui collegarsi.
start "HRcast" cmd /k "title HRcast & cd /d C:\D_E_V_E_L_O_P\gitHubFranco\HR-cast && npm start"

echo Attendo HRcast, poi apro il tunnel ngrok...
timeout /t 4 >nul

where ngrok >nul 2>&1
if errorlevel 1 (
  echo ngrok non trovato nel PATH. I servizi partono lo stesso, senza URL pubblico.
  goto MENU
)

:: WindowsApps prima di npm, cosi' parte l'agent ngrok e non lo shim di npm.
start "HRcast-ngrok" cmd /k "title HRcast-ngrok & set PATH=%LOCALAPPDATA%\Microsoft\WindowsApps;%PATH% & ngrok http https://127.0.0.1:3033 --upstream-tls-verify=false"

set /a NGROK_TRIES=0
:ATTENDI_NGROK
call :AGGIORNA_NGROK
echo URL pubblico: %NGROK_URL%
echo %NGROK_URL% | findstr /i /c:"https://" >nul
if not errorlevel 1 goto MENU
set /a NGROK_TRIES+=1
if %NGROK_TRIES% GEQ 20 (
  echo Tunnel non pronto. Controlla la finestra HRcast-ngrok.
  goto MENU
)
timeout /t 1 >nul
goto ATTENDI_NGROK

:MENU
cls
call :AGGIORNA_NGROK
echo ===============================
echo  Controllo servizi Ableton+HR
echo ===============================
echo.
echo URL pubblico: %NGROK_URL%
echo Il QR della dashboard coach usa questo indirizzo.
echo.
echo 1. Vedi se AbletonLiveTimelineReader e' attivo
echo 2. Vedi se AbletonJsConnector e' attivo
echo 3. Vedi se HRcast e' attivo
echo 4. Controlla tutti i servizi
echo 5. Esci e chiudi tutto
echo.
set /p scelta=Seleziona un'opzione [1-5]: 

if "%scelta%"=="1" tasklist /v | findstr /i "AbletonLiveTimelineReader"
if "%scelta%"=="2" tasklist /v | findstr /i "AbletonJsConnector"
if "%scelta%"=="3" tasklist /v | findstr /i "HRcast"
if "%scelta%"=="4" tasklist /v | findstr /i "Ableton HRcast ngrok"
if "%scelta%"=="5" goto CHIUDI

pause
goto MENU

:AGGIORNA_NGROK
set "NGROK_URL=non ancora pronto"
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; $path=Join-Path $env:TEMP 'hrcast-ngrok-url.txt'; try { $r=Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2; $https=@($r.tunnels | Where-Object { $_.public_url -like 'https://*' }); $mine=@($https | Where-Object { $_.config.addr -like '*3033*' }); $pick=$null; if ($mine.Count -gt 0) { $pick=$mine[0] } elseif ($https.Count -gt 0) { $pick=$https[0] }; if ($pick -and $pick.public_url) { [System.IO.File]::WriteAllText($path, [string]$pick.public_url) } elseif (Test-Path $path) { Remove-Item $path -Force } } catch { if (Test-Path $path) { Remove-Item $path -Force } }"
if exist "%TEMP%\hrcast-ngrok-url.txt" set /p NGROK_URL=<"%TEMP%\hrcast-ngrok-url.txt"
exit /b 0

:CHIUDI
cls
echo ===============================
echo  Chiusura servizi e tunnel
echo ===============================
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Continue'; $me=$PID; $needles=@('AbletonLiveTimelineReader\git\AbletonLiveTimelineReader && npm start','AbletonJsConnector && npm start','gitHubFranco\HR-cast && npm start'); $killed=0; $procs=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -and ( $_.CommandLine.Contains($needles[0]) -or $_.CommandLine.Contains($needles[1]) -or $_.CommandLine.Contains($needles[2]) -or ($_.Name -eq 'ngrok.exe' -and $_.CommandLine -like '*3033*') ) }); foreach ($p in $procs) { & taskkill.exe /F /T /PID $p.ProcessId 1>$null 2>$null; if ($LASTEXITCODE -eq 0) { $killed++ } }; foreach ($title in @('AbletonLiveTimelineReader*','AbletonJsConnector*','HRcast-ngrok*','HRcast*')) { & taskkill.exe /F /T /FI ('WINDOWTITLE eq ' + $title) 1>$null 2>$null }; [System.IO.File]::WriteAllText((Join-Path $env:TEMP 'hrcast-shutdown.txt'), ('SERVIZI=' + $killed + [Environment]::NewLine))"
set "CHIUSI=0"
if exist "%TEMP%\hrcast-shutdown.txt" for /f "usebackq tokens=1,* delims==" %%A in ("%TEMP%\hrcast-shutdown.txt") do (
  if /I "%%A"=="SERVIZI" set "CHIUSI=%%B"
)
echo Finestre servizi chiuse: %CHIUSI%
echo Tunnel ngrok chiuso.
timeout /t 2 >nul
exit /b 0
