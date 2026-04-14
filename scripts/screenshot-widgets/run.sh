#!/bin/sh
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WIDGETS_DIR="$PROJECT_ROOT/widgets"
WEBSITE_DIR="$PROJECT_ROOT/website"
OUT_DIR="$PROJECT_ROOT/website/screenshots"

echo "Building Docker image widgetizr-screenshots..."
docker build -t widgetizr-screenshots "$SCRIPT_DIR"

mkdir -p "$OUT_DIR"

echo "Running screenshot container..."
if docker run --rm \
  -v "$WIDGETS_DIR:/widgets:ro" \
  -v "$WEBSITE_DIR:/website:ro" \
  -v "$OUT_DIR:/output" \
  -e WIDGETS_DIR=/widgets \
  -e WEBSITE_DIR=/website \
  -e OUT_DIR=/output \
  widgetizr-screenshots; then
  echo "Screenshots saved to $OUT_DIR"
else
  echo "Screenshot process failed." >&2
  exit 1
fi
