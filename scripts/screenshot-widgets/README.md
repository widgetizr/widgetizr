# Widget Screenshot Automation

Automated Playwright screenshots of five Widgetizr widgets, used in the landing page mockup.

Each widget is loaded in a headless Chromium browser at a fixed capture size, seeded with deterministic demo content, and captured at `@2x` resolution in dark mode.

## Widgets covered

The screenshot tooling currently targets these built-in widgets:

- Clock
- Notes
- Todo
- Time Tracker
- Server Monitor

## Prerequisites

- Docker

## Running

```sh
./scripts/screenshot-widgets/run.sh
```

The script builds the screenshot image, runs the capture process in Docker, mounts `widgets/` read-only, and writes the generated PNGs into `website/screenshots/`.

## Output

Screenshots are saved to `website/screenshots/`:

| File                 | Widget         | Capture size |
| -------------------- | -------------- | ------------ |
| `clock.png`          | Clock          | 192×244      |
| `notes.png`          | Notes          | 232×340      |
| `todo.png`           | Todo           | 292×300      |
| `time-tracker.png`   | Time Tracker   | 230×380      |
| `server-monitor.png` | Server Monitor | 292×340      |

All images are generated at device scale factor `2`.

## Demo data

The screenshot script prepares stable demo content so the landing page visuals stay consistent:

- **Clock**: captured after a short settle delay
- **Notes**: seeded with demo markdown files
- **Todo**: seeded with a demo plain-text task list
- **Time Tracker**: seeded with a demo `.timelog` file
- **Server Monitor**: rendered against a temporary fake metrics backend

## Notes on appearance

The screenshots are intentionally captured in dark mode. The widgets use the shared Widgetizr theme, so the output should not depend on browser light mode.

If screenshots ever look unexpectedly bright or washed out, the most likely cause is missing shared CSS or a capture-specific styling issue rather than system theme detection.

## When to re-run

Re-run the screenshot tooling whenever:

- widget HTML/CSS changes
- demo content changes
- landing page mockup composition changes
- capture sizes or framing are adjusted

## Related files

- `scripts/screenshot-widgets/screenshot.mjs`
- `scripts/screenshot-widgets/run.sh`
- `website/screenshots/`
