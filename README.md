# Widgetizr

Desktop widgets for Linux, built with GJS, GTK 3, and WebKit2GTK.

Widgetizr lets you place web-powered widgets directly on your desktop background layer. You can load any compatible URL or use the included built-in widgets for notes, todos, time tracking, server monitoring, and more.

## Features

- Desktop-native widget windows on Linux
- Built-in widget picker
- Support for arbitrary `http://`, `https://`, and `file://` widget URLs
- Per-origin isolated WebKit storage
- Persistent widget position, size, and settings
- Persistent permission decisions per origin
- Local-first built-in widgets
- MIT licensed

## Included Widgets

- **Clock**
- **Todo**
- **Notes**
- **Time Tracker**
- **Server Monitor**

## Supported Environments

Widgetizr currently targets **X11 sessions on Linux**.

### Tested
- Cinnamon (X11)
- Budgie 10.9 or earlier (X11)

### Not supported
- Wayland

### Not yet fully validated
- MATE
- KDE Plasma on X11
- GNOME on X11
- Xfce

## Installation

```sh
curl -fsSL https://widgetizr.app/install | sh
```

The installer:

- downloads `widgetizr.js` into `~/.local/share/widgetizr/widgetizr.js`
- installs a launcher script at `~/.local/bin/widgetizr`
- creates a desktop entry
- installs the built-in widgets into `~/.local/share/widgetizr/widgets/`

## Requirements

Widgetizr depends on the Linux desktop stack it runs on. In particular, you need:

- `gjs` 1.72 or newer
- GTK 3
- WebKit2GTK 4.1

Example for Debian/Ubuntu:

```sh
sudo apt install gjs libwebkit2gtk-4.1-0 gir1.2-webkit2-4.1
```

## Using Built-in Widgets

Open widget settings and choose a built-in widget from the **Built-in widget** dropdown.

You can also point a widget manually at a local file URL such as:

```text
file:///home/yourname/.local/share/widgetizr/widgets/clock/index.html
```

## Configuration and Storage

Widgetizr stores its data under:

```text
~/.config/widgetizr/
```

This includes:

- `config-v1.json` for widget configuration
- `permissions.json` for saved permission decisions
- `fs-handles.json` for persisted file/directory grants
- `storage/` for per-origin WebKit storage

## Known Limitations

- Widgetizr requires X11
- Desktop icon/file-manager processes can interfere with widget interaction
- Some desktop environments are not yet fully tested

## Development

### Build the app bundle

```sh
bun build widgetizr.ts --outfile dist/widgetizr.js --external "gi://*"
```

### Package widgets

```sh
tar -czf dist/widgets.tar.gz widgets/
```

### Run screenshot generation

```sh
./scripts/screenshot-widgets/run.sh
```

## Repository Structure

```text
backend/                     Optional backend services
docker/                      Desktop test container image
scripts/screenshot-widgets/  Screenshot generation tooling
website/                     Public website and installer
widgets/                     Built-in widgets
widgetizr.ts                 Main desktop application
```

## Server Monitor Backend

The server monitor widget can talk to a separate backend service (a small Go agent that exposes CPU, RAM, disk, and network metrics over HTTP).

The backend is published as a separate repository: https://github.com/widgetizr/server-monitor

The desktop app itself does not depend on it at build time.

## Security Notes

- Widget URLs can load arbitrary web content, so only use sources you trust
- The server monitor widget stores configured server tokens locally in widget storage
- Widgetizr may fetch `https://widgetizr.app/version.txt` to notify about updates

## License

MIT. See [`LICENSE`](LICENSE).

## Website

- Main site: `https://widgetizr.app`
- Time Tracker spec: `https://widgetizr.app/w/time-tracker/spec/time-tracker-v1.md`

## Contributing

Issues are welcome. As for PRs, we prefer to make implementations by AI ourselves :-)
