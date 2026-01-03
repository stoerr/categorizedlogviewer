# Repository Guidelines

## Project Structure & Module Organization
- `bin/logviewer`: Node.js CLI entry point. Handles argument parsing, picks a port, and launches the server.
- `server/js/server.js`: HTTP server, HTML template rendering, and chunked log access endpoints.
- `server/js/client.js`: Browser-side logic for virtual scrolling and chunk fetches.
- `server/html/index.html`: HTML template with `{{PLACEHOLDER}}` substitutions.
- `server/css/style.css`: Styling and layout for the viewer.
- `docs/initialidea.md`: Product requirements and design intent.
- `docs/prompts.md`: Consolidated feature prompts/specifications.

## Build, Test, and Development Commands
- `node bin/logviewer --help`: Show CLI usage and flags.
- `node bin/logviewer /path/to/log.txt`: Start the viewer, auto-opens on macOS.
- `node bin/logviewer --wrap /path/to/log.txt`: Enable line wrapping.
- `node bin/logviewer --line-numbers /path/to/log.txt`: Show line numbers in the UI.
- `node bin/logviewer --charset iso-8859-15 /path/to/log.txt`: Decode with a specific charset.

There is no build step or package manager in this repo; run the CLI directly with Node.js.

## Coding Style & Naming Conventions
- JavaScript: 2-space indentation, double quotes, semicolons, `"use strict"` at top-level.
- CSS/HTML: 2-space indentation; keep HTML placeholders in `{{UPPER_SNAKE_CASE}}`.
- File and directory names are lowercase with dashes or plain lowercase (e.g., `server/js/client.js`).
- Keep edits ASCII-only unless a file already uses Unicode.

## Testing Guidelines
There is no automated test suite yet. Validate changes manually:
- Start the server with a real log file.
- Scroll to confirm virtualized content loads correctly.
- Toggle `--wrap` to verify both layout modes.
- Switch charsets and files when multiple paths are provided.
- Enable line numbers and confirm copying log text excludes the gutter.

## Commit & Pull Request Guidelines
History is minimal and does not show a strict convention. Use concise, imperative commit messages (e.g., `Add chunked tail rendering`).
For pull requests, include:
- A short description of the behavior change.
- Example command(s) used to verify (`node bin/logviewer sample.log`).
- Screenshots or GIFs for UI changes when relevant.

## Configuration & External Dependencies
- HTML loads Bootstrap from a CDN; keep integrity/crossorigin attributes intact.
- Fonts are pulled from Google Fonts in `server/css/style.css`.
