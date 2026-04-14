#!/bin/sh
set -eu

export HOME="${HOME:-/home/user}"
export USER="${USER:-user}"
export LOGNAME="${LOGNAME:-user}"
export SHELL="${SHELL:-/bin/bash}"

export DISPLAY=:1
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export WEBKIT_DISABLE_SANDBOX_FOR_TESTING=1

export XDG_RUNTIME_DIR="/tmp/runtime-$(id -u)"
export XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
chmod 700 "$XDG_RUNTIME_DIR"

mkdir -p /tmp/.X11-unix /tmp/.ICE-unix
chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix

mkdir -p \
  "$HOME/.local/share/widgetizr" \
  "$HOME/.local/share/widgetizr/widgets" \
  "$HOME/.config/widgetizr" \
  "$HOME/.config/autostart" \
  "$HOME/Desktop" \
  "$HOME/Documents" \
  "$HOME/Downloads"

if [ -d /widgets ]; then
  rm -rf "$HOME/.local/share/widgetizr/widgets"
  mkdir -p "$HOME/.local/share/widgetizr/widgets"
  cp -a /widgets/. "$HOME/.local/share/widgetizr/widgets/"
  printf 'Installed local widgets from /widgets into %s\n' "$HOME/.local/share/widgetizr/widgets"
fi

WJS="$HOME/.local/share/widgetizr/widgetizr.js"
if [ -f /dist/widgetizr.js ]; then
  cp /dist/widgetizr.js "$WJS"
elif [ ! -f "$WJS" ]; then
  printf 'Downloading widgetizr...\n'
  curl -fsSL https://github.com/widgetizr/widgetizr/releases/latest/download/widgetizr.js -o "$WJS" \
  || {
    printf 'ERROR: no widgetizr.js found.\nBuild it first: bun build widgetizr.ts --outfile dist/widgetizr.js\n' >&2
    exit 1
  }
fi

Xvfb :1 -screen 0 1280x800x24 -ac +extension RANDR +extension RENDER +extension GLX &
XVFB_PID=$!

mkdir -p /run/dbus
if [ ! -f /run/dbus/pid ]; then
  dbus-daemon --system --fork
fi

cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

i=0
while [ "$i" -lt 50 ]; do
  if xdpyinfo >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
  i=$((i + 1))
done
if ! xdpyinfo >/dev/null 2>&1; then
  printf 'ERROR: Xvfb failed to start on :1\n' >&2
  exit 1
fi

x11vnc -display :1 -rfbport 5900 -nopw -forever -shared -quiet &

NOVNC_DIR="/usr/share/novnc"
if command -v websockify >/dev/null 2>&1 && [ -d "$NOVNC_DIR" ]; then
  websockify --web "$NOVNC_DIR" 6080 localhost:5900 >/tmp/novnc.log 2>&1 &
  printf 'noVNC ready — open http://localhost:6080/vnc.html\n'
else
  printf 'WARNING: noVNC/websockify not found. Only raw VNC on port 5900 is available.\n' >&2
fi

case "${DESKTOP:-cinnamon}" in
  budgie)
    export XDG_CURRENT_DESKTOP="Budgie:GNOME"
    export XDG_SESSION_DESKTOP="budgie"
    export DESKTOP_SESSION="budgie-desktop"
    export GNOME_DESKTOP_SESSION_ID="this-is-deprecated"
    DESKTOP_CMD='budgie-desktop'
    READY_CMD='xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1'
    ;;
  cinnamon)
    export XDG_CURRENT_DESKTOP="X-Cinnamon"
    export XDG_SESSION_DESKTOP="cinnamon"
    export DESKTOP_SESSION="cinnamon"
    DESKTOP_CMD='cinnamon-session'
    READY_CMD='xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1'
    ;;
  gnome)
    export XDG_CURRENT_DESKTOP="GNOME"
    export XDG_SESSION_DESKTOP="gnome"
    export DESKTOP_SESSION="gnome"
    export GNOME_DESKTOP_SESSION_ID="this-is-deprecated"
    export GNOME_SHELL_SESSION_MODE="ubuntu"
    DESKTOP_CMD='gnome-session'
    READY_CMD='xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1'
    ;;
  kde)
    export XDG_CURRENT_DESKTOP="KDE"
    export XDG_SESSION_DESKTOP="KDE"
    export DESKTOP_SESSION="plasma"
    export KDE_FULL_SESSION="true"
    export KDE_SESSION_VERSION="5"
    DESKTOP_CMD='startplasma-x11'
    READY_CMD='xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1'
    ;;
  *)
    export XDG_CURRENT_DESKTOP="X-Cinnamon"
    export XDG_SESSION_DESKTOP="cinnamon"
    export DESKTOP_SESSION="cinnamon"
    DESKTOP_CMD='cinnamon-session'
    READY_CMD='xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1'
    ;;
esac

cat > "$HOME/.xsessionrc" <<EOF
export HOME="$HOME"
export USER="$USER"
export LOGNAME="$LOGNAME"
export SHELL="$SHELL"
export DISPLAY="$DISPLAY"
export XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR"
export XDG_SESSION_TYPE="x11"
export GDK_BACKEND="x11"
export XDG_CONFIG_HOME="$XDG_CONFIG_HOME"
export XDG_DATA_HOME="$XDG_DATA_HOME"
export XDG_CACHE_HOME="$XDG_CACHE_HOME"
export XDG_CURRENT_DESKTOP="$XDG_CURRENT_DESKTOP"
export XDG_SESSION_DESKTOP="$XDG_SESSION_DESKTOP"
export DESKTOP_SESSION="$DESKTOP_SESSION"
export GNOME_DESKTOP_SESSION_ID="${GNOME_DESKTOP_SESSION_ID:-}"
export GNOME_SHELL_SESSION_MODE="${GNOME_SHELL_SESSION_MODE:-}"
export KDE_FULL_SESSION="${KDE_FULL_SESSION:-}"
export KDE_SESSION_VERSION="${KDE_SESSION_VERSION:-}"
EOF

dbus-run-session -- sh -eu -c '
  export HOME="'"$HOME"'"
  export USER="'"$USER"'"
  export LOGNAME="'"$LOGNAME"'"
  export SHELL="'"$SHELL"'"
  export DISPLAY="'"$DISPLAY"'"
  export XDG_RUNTIME_DIR="'"$XDG_RUNTIME_DIR"'"
  export XDG_SESSION_TYPE="x11"
  export GDK_BACKEND="x11"
  export XDG_CONFIG_HOME="'"$XDG_CONFIG_HOME"'"
  export XDG_DATA_HOME="'"$XDG_DATA_HOME"'"
  export XDG_CACHE_HOME="'"$XDG_CACHE_HOME"'"
  export XDG_CURRENT_DESKTOP="'"$XDG_CURRENT_DESKTOP"'"
  export XDG_SESSION_DESKTOP="'"$XDG_SESSION_DESKTOP"'"
  export DESKTOP_SESSION="'"$DESKTOP_SESSION"'"
  export GNOME_DESKTOP_SESSION_ID="'"${GNOME_DESKTOP_SESSION_ID:-}"'"
  export GNOME_SHELL_SESSION_MODE="'"${GNOME_SHELL_SESSION_MODE:-}"'"
  export KDE_FULL_SESSION="'"${KDE_FULL_SESSION:-}"'"
  export KDE_SESSION_VERSION="'"${KDE_SESSION_VERSION:-}"'"

  if command -v gnome-keyring-daemon >/dev/null 2>&1; then
    eval "$(gnome-keyring-daemon --start --components=secrets,pkcs11,ssh 2>/dev/null || true)"
    export SSH_AUTH_SOCK
    export GNOME_KEYRING_CONTROL
    export GNOME_KEYRING_PID
  fi

  if command -v /usr/libexec/polkit-gnome-authentication-agent-1 >/dev/null 2>&1; then
    /usr/libexec/polkit-gnome-authentication-agent-1 >/dev/null 2>&1 &
  elif command -v /usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1 >/dev/null 2>&1; then
    /usr/lib/policykit-1-gnome/polkit-gnome-authentication-agent-1 >/dev/null 2>&1 &
  fi

  if command -v /usr/lib/x86_64-linux-gnu/libexec/polkit-kde-authentication-agent-1 >/dev/null 2>&1; then
    /usr/lib/x86_64-linux-gnu/libexec/polkit-kde-authentication-agent-1 >/dev/null 2>&1 &
  elif command -v polkit-kde-authentication-agent-1 >/dev/null 2>&1; then
    polkit-kde-authentication-agent-1 >/dev/null 2>&1 &
  fi

  if command -v xdg-desktop-portal >/dev/null 2>&1; then
    xdg-desktop-portal >/dev/null 2>&1 &
  fi
  if command -v xdg-desktop-portal-gtk >/dev/null 2>&1; then
    xdg-desktop-portal-gtk >/dev/null 2>&1 &
  fi
  if command -v xdg-desktop-portal-gnome >/dev/null 2>&1; then
    xdg-desktop-portal-gnome >/dev/null 2>&1 &
  fi
  if command -v xdg-desktop-portal-kde >/dev/null 2>&1; then
    xdg-desktop-portal-kde >/dev/null 2>&1 &
  fi
  if command -v xdg-desktop-portal-xapp >/dev/null 2>&1; then
    xdg-desktop-portal-xapp >/dev/null 2>&1 &
  fi

  '"$DESKTOP_CMD"' >/tmp/desktop-session.log 2>&1 &
  DESKTOP_PID=$!

  i=0
  while [ "$i" -lt 100 ]; do
    if '"$READY_CMD"'; then
      break
    fi
    if ! kill -0 "$DESKTOP_PID" 2>/dev/null; then
      printf "WARNING: desktop session exited early. See /tmp/desktop-session.log\n" >&2
      break
    fi
    sleep 0.2
    i=$((i + 1))
  done

  printf "VNC ready — connect with: vncviewer localhost:5900\n"
  exec gjs -m "'"$WJS"'"
'
