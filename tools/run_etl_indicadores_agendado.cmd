@echo off
rem Wrapper de agendamento do pipeline Indicadores (tools\run_etl_indicadores.py):
rem indices de mercado -> cotas CVM -> build_data -> publish_hub.
rem
rem Amarra a republicacao do hub a atualizacao dos indicadores: roda depois do
rem Container App Job (cron 0 11 1-20 * * = 08:00 BRT), pega o Blob ja
rem atualizado e republica o snapshot indicadores.json no bucket hub-data.
rem
rem Usado pela tarefa agendada "Luxor - ETL Indicadores (hub)". Sem argumento o
rem run_etl_indicadores.py resolve o ultimo mes fechado.
rem
rem Passo 1 e no-op quando nenhum indicador novo foi liberado (o state no Blob
rem marca o mes completo), entao rodar todo dia sai barato.

setlocal enabledelayedexpansion
set "HUB=%~dp0.."
set "LOGDIR=%LOCALAPPDATA%\Luxor\etl_logs"
set PYTHONIOENCODING=utf-8

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

for /f "tokens=1-3 delims=/-. " %%a in ("%DATE%") do set "STAMP=%%c%%b%%a"
set "LOG=%LOGDIR%\etl_indicadores_!STAMP!.log"

echo ==== %DATE% %TIME% ==== >> "!LOG!"
pushd "%HUB%"
python tools\run_etl_indicadores.py >> "!LOG!" 2>&1
set RC=!ERRORLEVEL!
popd
echo ---- exit=!RC! >> "!LOG!"

rem Mantem apenas os 30 logs mais recentes.
for /f "skip=30 delims=" %%f in ('dir /b /o-d "%LOGDIR%\etl_indicadores_*.log" 2^>nul') do del "%LOGDIR%\%%f"

exit /b !RC!
