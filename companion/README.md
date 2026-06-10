# GLMPS Companion

Auto-starts the GLMPS dashboard server when Antigravity IDE launches and provides a status-bar button to open it. On activation it drains any queued resume requests from `~/.glmps/requests/resume.jsonl`, opening a terminal per request and running `claude --resume <sessionId>`.

Install: `antigravity-ide --install-extension glmps-companion-0.1.0.vsix`

Settings: `missionControl.autoStart` (bool), `missionControl.serverPath` (string), `missionControl.port` (number, default 8123).
