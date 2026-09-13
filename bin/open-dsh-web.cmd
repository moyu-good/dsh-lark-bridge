@echo off
rem 打开 dsh 网页端(web UI)——服务随 WSL systemd 开机自启，
rem 这条只负责拉起浏览器。Windows->WSL 的 localhost 转发已实测可用。
start "" "http://127.0.0.1:18787"
