' Lançador da tarefa "Luxor - ETL Indicadores (hub)": roda o
' run_etl_indicadores_agendado.cmd SEM janela e devolve o exit code dele, para o
' resultado da tarefa continuar denunciando falha.
'
' Com o cmd visível a tarefa morria com 0xC000013A (CTRL+C) segundos depois de
' abrir: a janela aparece às 09:30 por cima do que estiver aberto, e fechá-la —
' ou um Ctrl+C digitado pra outro app que caiu no console — mata o pipeline.
' Foi assim em 13/08, 17/08, 01/09 e 07/10/2026 (este último aos 8 segundos).
'
' cmd.exe /c com aspas DUPLAS em volta do caminho: o "&" de LuxorP&CHub quebra o
' comando se o cmd tirar o único par de aspas.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
alvo = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "run_etl_indicadores_agendado.cmd")
WScript.Quit sh.Run("cmd.exe /c """"" & alvo & """""", 0, True)
