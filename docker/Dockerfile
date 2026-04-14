ARG DESKTOP=cinnamon

FROM ubuntu:22.04

ARG DESKTOP
ENV DEBIAN_FRONTEND=noninteractive
ENV DESKTOP=$DESKTOP

RUN apt-get update && apt-get install -y --no-install-recommends \
    at-spi2-core \
    ca-certificates \
    curl \
    dbus \
    dbus-user-session \
    dbus-x11 \
    dconf-gsettings-backend \
    dconf-service \
    fonts-dejavu-core \
    gir1.2-glib-2.0 \
    gir1.2-gtk-3.0 \
    gir1.2-webkit2-4.1 \
    gjs \
    gnome-keyring \
    gsettings-desktop-schemas \
    ibus \
    libgdk-pixbuf-2.0-0 \
    libgdk-pixbuf2.0-bin \
    libglib2.0-bin \
    libnotify4 \
    libwebkit2gtk-4.1-0 \
    mesa-utils \
    novnc \
    policykit-1-gnome \
    websockify \
    x11-utils \
    x11vnc \
    xauth \
    xdg-desktop-portal \
    xdg-desktop-portal-gtk \
    xdg-utils \
    xterm \
    xvfb \
  && case "$DESKTOP" in \
    budgie) \
      apt-get install -y --no-install-recommends \
        budgie-control-center \
        budgie-desktop \
        budgie-desktop-view \
        gnome-terminal \
        nautilus \
        network-manager-gnome \
      ;; \
    cinnamon) \
      apt-get install -y --no-install-recommends \
        cinnamon \
        gnome-terminal \
        nemo \
        xdg-desktop-portal-xapp \
      ;; \
    gnome) \
      apt-get install -y --no-install-recommends \
        gnome-control-center \
        gnome-session \
        gnome-settings-daemon \
        gnome-shell \
        gnome-terminal \
        nautilus \
        network-manager-gnome \
        power-profiles-daemon \
        xdg-desktop-portal-gnome \
      ;; \
    kde) \
      apt-get install -y --no-install-recommends \
        dolphin \
        kde-config-gtk-style \
        kde-config-screenlocker \
        kio-extras \
        konsole \
        kscreen \
        kwalletmanager \
        kwin-x11 \
        libpam-kwallet5 \
        plasma-desktop \
        plasma-pa \
        polkit-kde-agent-1 \
        powerdevil \
        systemsettings \
        xdg-desktop-portal-kde \
      ;; \
  esac \
  && rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash user && echo 'user:user' | chpasswd

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

USER user
ENV HOME=/home/user
WORKDIR /home/user

EXPOSE 5900 6080

ENTRYPOINT ["/entrypoint.sh"]
