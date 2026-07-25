#!/usr/bin/env sh
set -eu

COMMAND=${1:-help}
LOG_LINES=${2:-50}
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SKILL_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
CFN_DATA_HOME=${CFN_HOME:-"$HOME/.codex-feishu-nsx"}
RUNTIME_DIR="$CFN_DATA_HOME/runtime"
LOG_DIR="$CFN_DATA_HOME/logs"
PID_FILE="$RUNTIME_DIR/bridge.pid"
STATUS_FILE="$RUNTIME_DIR/status.json"
LOG_FILE="$LOG_DIR/bridge.log"
CONSOLE_LOG_FILE="$LOG_DIR/bridge-console.log"
ERROR_LOG_FILE="$LOG_DIR/bridge-error.log"
DAEMON_FILE="$SKILL_DIR/dist/daemon.mjs"

ensure_dirs() {
  mkdir -p "$CFN_DATA_HOME/data/messages" "$CFN_DATA_HOME/data/job-files" "$LOG_DIR" "$RUNTIME_DIR"
}

ensure_built() {
  if [ ! -f "$DAEMON_FILE" ] || find "$SKILL_DIR/src" -type f -newer "$DAEMON_FILE" -print -quit | grep -q .; then
    NODE_BIN=$(find_node)
    (cd "$SKILL_DIR" && "$NODE_BIN" scripts/build.js)
  fi
}

find_node() {
  for candidate in "$(command -v node || true)" "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"; do
    [ -n "$candidate" ] && [ -x "$candidate" ] || continue
    major=$($candidate --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
    case "$major" in
      ''|*[!0-9]*) continue ;;
      *) [ "$major" -ge 20 ] && { printf '%s\n' "$candidate"; return 0; } ;;
    esac
  done
  echo "Node.js >= 20 is required." >&2
  exit 1
}

status_running() {
  [ -f "$STATUS_FILE" ] && grep -Eq '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" \
    && grep -Eq '"pid"[[:space:]]*:[[:space:]]*'"$1" "$STATUS_FILE"
}

read_pid() {
  [ -f "$PID_FILE" ] && tr -d '[:space:]' < "$PID_FILE" || true
}

pid_alive() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

start_fallback() {
  ensure_dirs
  [ -f "$CFN_DATA_HOME/config.env" ] || { echo "Configuration not found: $CFN_DATA_HOME/config.env" >&2; exit 1; }
  ensure_built
  OLD_PID=$(read_pid)
  if pid_alive "$OLD_PID"; then
    echo "Bridge already running (PID: $OLD_PID)"
    exit 0
  fi
  NODE_BIN=$(find_node)
  nohup env CFN_HOME="$CFN_DATA_HOME" "$NODE_BIN" "$DAEMON_FILE" >>"$CONSOLE_LOG_FILE" 2>>"$ERROR_LOG_FILE" &
  STARTED_PID=$!
  printf '%s\n' "$STARTED_PID" > "$PID_FILE"
  sleep 2
  if pid_alive "$STARTED_PID" && status_running "$STARTED_PID"; then
    echo "Bridge started (PID: $STARTED_PID)"
  else
    echo "Bridge failed to start. Check $ERROR_LOG_FILE" >&2
    exit 1
  fi
}

stop_fallback() {
  BRIDGE_PID=$(read_pid)
  if ! pid_alive "$BRIDGE_PID"; then
    echo "Bridge is not running"
    rm -f "$PID_FILE"
    return
  fi
  kill -TERM "$BRIDGE_PID"
  COUNT=0
  while pid_alive "$BRIDGE_PID" && [ "$COUNT" -lt 20 ]; do
    sleep 1
    COUNT=$((COUNT + 1))
  done
  if pid_alive "$BRIDGE_PID"; then
    echo "Bridge did not stop within 20 seconds (PID: $BRIDGE_PID)" >&2
    exit 1
  fi
  rm -f "$PID_FILE"
  echo "Bridge stopped"
}

xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

install_service() {
  ensure_dirs
  ensure_built
  NODE_BIN=$(command -v node || true)
  [ -n "$NODE_BIN" ] || { echo "Node.js >= 20 is required." >&2; exit 1; }
  OS_NAME=$(uname -s)
  if [ "$OS_NAME" = "Darwin" ]; then
    PLIST_DIR="$HOME/Library/LaunchAgents"
    PLIST_FILE="$PLIST_DIR/com.nsx.codex-feishu-nsx.plist"
    mkdir -p "$PLIST_DIR"
    NODE_XML=$(xml_escape "$NODE_BIN")
    DAEMON_XML=$(xml_escape "$DAEMON_FILE")
    HOME_XML=$(xml_escape "$CFN_DATA_HOME")
    SKILL_XML=$(xml_escape "$SKILL_DIR")
    LOG_XML=$(xml_escape "$LOG_FILE")
    ERROR_XML=$(xml_escape "$ERROR_LOG_FILE")
    cat > "$PLIST_FILE" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.nsx.codex-feishu-nsx</string>
  <key>ProgramArguments</key><array><string>$NODE_XML</string><string>$DAEMON_XML</string></array>
  <key>WorkingDirectory</key><string>$SKILL_XML</string>
  <key>EnvironmentVariables</key><dict><key>CFN_HOME</key><string>$HOME_XML</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOG_XML</string>
  <key>StandardErrorPath</key><string>$ERROR_XML</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)" "$PLIST_FILE" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST_FILE"
    echo "Installed and started macOS LaunchAgent: $PLIST_FILE"
  elif [ "$OS_NAME" = "Linux" ]; then
    SYSTEMD_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    UNIT_FILE="$SYSTEMD_DIR/codex-feishu-nsx.service"
    mkdir -p "$SYSTEMD_DIR"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Codex Feishu NSX Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="$SKILL_DIR"
Environment="CFN_HOME=$CFN_DATA_HOME"
ExecStart="$NODE_BIN" "$DAEMON_FILE"
Restart=on-failure
RestartSec=10
StandardOutput=append:"$LOG_FILE"
StandardError=append:"$ERROR_LOG_FILE"

[Install]
WantedBy=default.target
EOF
    systemctl --user daemon-reload
    systemctl --user enable --now codex-feishu-nsx.service
    echo "Installed and started systemd user service: $UNIT_FILE"
  else
    echo "Service installation is supported on macOS and Linux only. Use start for the portable fallback." >&2
    exit 1
  fi
}

uninstall_service() {
  OS_NAME=$(uname -s)
  if [ "$OS_NAME" = "Darwin" ]; then
    PLIST_FILE="$HOME/Library/LaunchAgents/com.nsx.codex-feishu-nsx.plist"
    launchctl bootout "gui/$(id -u)" "$PLIST_FILE" >/dev/null 2>&1 || true
    rm -f "$PLIST_FILE"
    echo "Removed macOS LaunchAgent"
  elif [ "$OS_NAME" = "Linux" ]; then
    UNIT_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/codex-feishu-nsx.service"
    systemctl --user disable --now codex-feishu-nsx.service >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl --user daemon-reload
    echo "Removed systemd user service"
  fi
}

case "$COMMAND" in
  start) start_fallback ;;
  stop) stop_fallback ;;
  status)
    BRIDGE_PID=$(read_pid)
    if pid_alive "$BRIDGE_PID"; then
      echo "Bridge process is running (PID: $BRIDGE_PID)"
      [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE"
    else
      echo "Bridge is not running"
      [ -f "$STATUS_FILE" ] && cat "$STATUS_FILE"
    fi
    ;;
  logs)
    [ -f "$LOG_FILE" ] && tail -n "$LOG_LINES" "$LOG_FILE"
    [ -f "$CONSOLE_LOG_FILE" ] && tail -n "$LOG_LINES" "$CONSOLE_LOG_FILE"
    [ -f "$ERROR_LOG_FILE" ] && tail -n "$LOG_LINES" "$ERROR_LOG_FILE" >&2
    ;;
  install-service) install_service ;;
  uninstall-service) uninstall_service ;;
  help|*) echo "Usage: sh scripts/daemon.sh {start|stop|status|logs [N]|install-service|uninstall-service}" ;;
esac
