# Feature Prompts Specification

This document compiles the feature-focused prompts for this repository, excluding error reports and bug-only fixes. It is intended as a lightweight specification of requested behavior and UI capabilities.

## CLI Behavior
- `bin/logviewer` is the entry point for starting the viewer with one or more logfiles.
- If multiple files are provided, the UI must allow switching between them.
- Support these switches:
  - `--wrap` / `--no-wrap` to control line wrapping.
  - `--charset <name>` for decoding (e.g., `utf-8`, `iso-8859-1`, `iso-8859-15`, `windows-1252`).
  - `-v` / `--verbose` to log all incoming web requests and exceptions.
  - `--line-numbers` / `--no-line-numbers` to toggle line numbers in the UI.
- Default port should be `3200`; only increment if that port is already in use.
- On macOS, open the browser automatically after a short delay (2 seconds).

## UI Requirements
- Provide a line wrap switch in the header.
- Provide a charset dropdown populated with common German-compatible encodings.
- Provide a file selector dropdown when multiple files are launched.
- Provide a line-number toggle and render line numbers in a separate gutter with a visible divider; copying log text should not include line numbers.
- Display line range (not byte range) and overall line count when available.
- Screen space should be used efficiently, with minimal wasted margins.

## Scrolling & Data Loading
- The viewer must handle multi-megabyte files without loading everything at once.
- Scrolling should be smooth and not jumpy; preload adjacent ranges before they become visible.
- Line counts should be computed in the background so the UI starts quickly and updates when the count is ready.

## Caching
- UI assets and API responses should be served with no-cache headers to avoid stale browser caching.
