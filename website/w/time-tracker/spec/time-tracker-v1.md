# Widgetizr Time Tracker Storage Spec — V1

## Overview

This spec defines a plain-text, human- and machine-readable format for storing time-tracking projects and session history. The file can be freely edited by hand; any violation of this spec will cause the Widgetizr Time Tracker widget to reject the file and show a precise error indicating the line number and the nature of the violation.

## File Header

Every conforming file MUST begin with exactly these two lines (no leading whitespace, no variation):

```
// WIDGETIZR TIME TRACKER STORAGE FILE V1
// This file follows the Widgetizr Time Tracker Storage Spec V1, documented at https://widgetizr.app/w/time-tracker/spec/time-tracker-v1.md. Manual edits that violate the spec will cause this file to be rejected by the widget.
```

Any deviation — including a missing line, extra whitespace, or changed wording — causes rejection.

## General Parsing Rules

- The file is UTF-8 encoded.
- Line endings may be LF or CRLF; both are accepted.
- Lines whose trimmed content starts with `//` are comments and are ignored by the parser (except lines 1 and 2, which are validated literally).
- Blank lines (empty or whitespace-only) are ignored.
- The file must contain exactly one `[projects]` section header and exactly one `[log]` section header, in that order, each on its own line with no surrounding whitespace.

## `[projects]` Section

Each non-comment, non-blank line defines one project.

**Format:** `<name>  <#color>`

The color is always the last whitespace-delimited token; everything before it (trimmed) is the name.

- `<name>`: Non-empty. Maximum 40 characters.
- `<#color>`: Exactly `#rrggbb` format (case-insensitive hex digits). The `#` must be present.
- Project names must be unique within the file using case-insensitive comparison.
- The section may be empty (zero projects).

## `[log]` Section

Each non-comment, non-blank line defines one session.

**Format for a completed session:** `YYYY-MM-DD HH:MM - HH:MM  <project name>`

**Format for an active session:** `YYYY-MM-DD HH:MM - ...  <project name>`

- The first `YYYY-MM-DD HH:MM` is the start (date + time).
- The separator between start and end is exactly `-` (space, hyphen, space).
- The end token is either `HH:MM` (completed) or `...` (active/running).
- The end token and the project name are separated by two or more spaces.
- `<project name>` is all remaining text on the line after the end token, with leading and trailing whitespace stripped. It must exactly match a project defined in `[projects]`.
- Sessions must not span midnight. The end `HH:MM` must denote a time strictly later than the start `HH:MM` on the same calendar day.
- At most one active session (`...`) is allowed per file. If present, it must be the last log entry.
- Log entries must be in strictly ascending chronological order by start time (no two entries may share the same start minute).
- Sessions must not overlap: the start time of each entry must be greater than or equal to the end time of the preceding completed entry.

## Validation Errors

The parser rejects the file and reports the line number and specific reason.

| Error                               | Example causing it                                            |
| ----------------------------------- | ------------------------------------------------------------- |
| Wrong or missing header line 1      | First line does not match exactly                             |
| Wrong or missing header line 2      | Second line does not match exactly                            |
| Missing `[projects]` section        | Section header absent                                         |
| Missing `[log]` section             | Section header absent                                         |
| `[log]` appears before `[projects]` | Wrong order                                                   |
| Duplicate section header            | `[projects]` appears twice                                    |
| Malformed project line              | `Work` (no color token)                                       |
| Invalid color                       | `Work #89b4` or `Work 89b4fa`                                 |
| Empty project name                  | `  #89b4fa`                                                   |
| Project name too long               | Name exceeds 40 characters                                    |
| Duplicate project name              | Two lines both define `Work` and `work`                       |
| Malformed log line                  | Fewer than 5 whitespace-delimited tokens                      |
| Invalid date                        | `2025-13-01` or `2025-02-30`                                  |
| Invalid time                        | `25:00` or `12:60`                                            |
| End time not after start time       | `2025-01-15 12:00 - 07:00  Work`                              |
| Cross-midnight session              | `2025-01-15 23:00 - 00:30  Work` (caught by end ≤ start rule) |
| Unknown project reference           | Project name in log not in `[projects]`                       |
| Multiple active sessions            | Two lines ending in `...`                                     |
| Active session not last             | A `...` line followed by another log entry                    |
| Entries out of chronological order  | Start time ≤ previous start time                              |
| Overlapping sessions                | Start time < end time of preceding session                    |

## Midnight Splits

Sessions must never span midnight. The Widgetizr widget enforces this automatically: when a session is active at midnight (00:00 local time), the widget ends it at `23:59` of the current day and immediately starts a new session for the same project at `00:00` of the next day. This results in a one-minute gap at midnight, which is intentional and by design.

## Active Sessions on Reload

If a file contains an active session (line ending with `...`), the widget will display a prompt when the file is opened or the widget reloads. The user can choose to:

- **Resume** the session — the timer continues from the original start time. If the session started on a previous day, the widget retroactively splits it at midnight boundaries before resuming.
- **Stop now** — the session is ended at the current local time.
- **Stop at a chosen time** — the user picks any datetime after the session start.
- **Discard** — the active session entry is removed entirely with no session recorded.

## Timezone

All times in this file are local wall-clock time. No timezone offset is stored. The local time is determined by the system clock at the moment each entry is written by the widget.

## Full Example

```
// WIDGETIZR TIME TRACKER STORAGE FILE V1
// This file follows the Widgetizr Time Tracker Storage Spec V1, documented at https://widgetizr.app/w/time-tracker/spec/time-tracker-v1.md. Manual edits that violate the spec will cause this file to be rejected by the widget.

[projects]
// Development projects
Backend API  #3b82f6
Frontend UI  #a855f7
// Administrative
Meetings  #f59e0b

[log]
// Day 1
2025-06-10 09:02 - 12:15  Backend API
2025-06-10 13:00 - 14:30  Frontend UI
2025-06-10 14:30 - 15:00  Meetings
// Resumed work after a short break
2025-06-10 15:15 - 18:45  Backend API
// Late session close to midnight
2025-06-10 22:30 - 23:59  Frontend UI

// Day 2
2025-06-11 08:55 - 10:10  Meetings
2025-06-11 10:30 - 12:00  Backend API
// Currently active session
2025-06-11 13:15 - ...  Frontend UI
```
