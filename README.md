# Categorized Log Viewer

Fast, local log viewer with virtualized scrolling, category filters, and optional AI-assisted regex suggestions.
The idea is that you can create categories with regular expressions that have to be contained in log lines, and either
use these to highlight interesting lines, or create categories of uninteresting log lines and hide them from view.

## AI / Vibe-coding note

![Vibe-coded](https://img.shields.io/badge/code-vibe--coded-orange)

This project was built almost exclusively using LLM assistance 
(namely OpenAI [Codex CLI](https://chatgpt.com/de-DE/features/codex/))
and validated by use and testing rather than by code review. 
The focus was on quickly achieving correct behavior and practical usefulness, not on polishing or refactoring the 
generated source.

**Privacy note:** The *AI Add* feature sends selected log lines to OpenAI’s API to generate regex suggestions. Avoid
using this feature with sensitive data.

## Features

- Smooth virtual scrolling for multi-megabyte logs.
- Category highlighting, hiding, and solo filtering (regex-based).
- Header regex search to filter visible lines.
- Optional AI Add to suggest category regexes from selected lines.
- Charset switching and line-number gutter.

## Technology and Requirements

This is a simple Node.js application that serves a web interface for viewing logs. For the front end, it uses vanilla JS
and CSS with bootstrap from CDN.

- Node.js (no package manager or build step).
- macOS auto-opens the browser on start.

## Quick Start

Check out the project and run:

```bash
./bin/logviewer /path/to/log.txt
```

You can symlink the logviewer script to a directory in your PATH for easier access - it will follow the link to find
the source.

Common options:

```bash
logviewer --wrap /path/to/log.txt
logviewer --line-numbers /path/to/log.txt
logviewer --charset iso-8859-15 /path/to/log.txt
```

## Using Categories

- Add a category and enter a regex to highlight matches.
- Hide a category to filter it out.
- Solo a category to show only its matches.

## Header Search

- Enter a regex in the Search field to show only matching lines.
- Hidden categories still exclude their matches when search is active.

## AI Add (Optional)

AI Add suggests regexes for a new category based on selected lines.

1) Check the boxes beside one or more log lines.
2) Click `AI Add`.
3) Pick a suggestion and create a category.

Environment variables:

- `OPENAI_API_KEY` (required)
- `OPENAI_MODEL` (optional, default `gpt-5.2`)
- `OPENAI_API_URL` (optional, default OpenAI chat completions endpoint)

When started with `--verbose`, the server logs the AI request payload.

## Manual Verification

- Scroll to ensure chunk loading stays smooth and gaps do not appear.
- Toggle wrap and line numbers.
- Switch between files and charsets.
- Try search + hidden categories together.
- Use AI Add with non-contiguous line selections.

## Project Layout

- `bin/logviewer`: CLI entry point.
- `server/js/server.js`: HTTP server and API.
- `server/js/client.js`: Browser logic for scrolling and filters.
- `server/html/index.html`: HTML template.
- `server/css/style.css`: Styling.
