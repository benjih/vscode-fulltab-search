# FullTab Search

A VS Code extension that opens project search in a full editor tab — with multiple search tabs, include/exclude filters, inline results, and find-and-replace.

Heavily inspired by the Zed multi-buffer search.

## What it does

FullTab Search replaces the cramped sidebar search experience with a dedicated tab in the editor area. Open it from the Command Palette with **FullTab Search: Open Project Search** (`fullTabSearch.open`).

### Features

- **Full-tab UI** — search controls and results share one editor tab, with more room for context and navigation
- **Multiple search tabs** — keep up to 12 recent searches; tab state is persisted across sessions
- **Ripgrep-powered search** — fast workspace search via `@vscode/ripgrep`
- **Filters** — comma-separated include and exclude glob patterns (e.g. `src/**`, `node_modules/**, *.lock`)
- **Search options** — match case, whole word, and regular expression toggles
- **Inline results** — matches grouped by file with surrounding context lines; expand before/after for more
- **Breadcrumbs** — symbol hints (functions, classes, etc.) shown above each match
- **Find and replace** — replace the current match or all matches in the workspace
- **Jump to source** — click a match to open the file at the exact line and column

## How it works

The extension has two main parts:

1. **Extension host** (`src/`) — registers the command, creates a `WebviewPanel`, and handles messages from the UI. `SearchEngine` spawns ripgrep against the first workspace folder, parses JSON output, and applies edits for replace operations.

2. **Webview UI** (`media/`) — plain HTML/CSS/JS rendered inside the panel. It manages tabs, debounces search input, renders grouped results, and communicates with the extension via `postMessage`.

```
Command Palette → extension.ts → SearchPanel (webview)
                                      ↕ postMessage
                                 media/search.js
                                      ↓
                              SearchEngine → ripgrep
```

Search runs against the first open workspace folder. Results are capped at 10,000 matches.

## Requirements

- [VS Code](https://code.visualstudio.com/) 1.85 or later
- [Node.js](https://nodejs.org/) 22 (provided via [devbox](https://www.jetify.com/devbox))

## Getting started

Clone the repository and install dependencies:

```bash
devbox shell          # optional: enter the devbox environment
make install          # npm install
```

If you use [direnv](https://direnv.net/), the included `.envrc` loads devbox automatically when you `cd` into the project.

## Development

### Compile

```bash
make build            # or: npm run compile
```

Watch mode recompiles on save:

```bash
npm run watch
```

### Run the extension

1. Open this folder in VS Code
2. Press **F5** (or use **Run Extension** from the Run and Debug panel)

This launches an Extension Development Host with the extension loaded. Open a workspace folder, then run **FullTab Search: Open Project Search** from the Command Palette.

The launch configuration runs the `compile` task first, which uses devbox to invoke TypeScript.

### Lint and test

The project uses a three-layer testing pyramid:

| Layer | Runner | Location | Command |
|-------|--------|----------|---------|
| Unit | Vitest (Node, no VS Code API) | `src/test/unit/` | `make test-unit` |
| Integration | Mocha + `@vscode/test-electron` | `src/test/suite/*.test.ts` | `make test-integration` |
| E2E (API) | Same as integration | `src/test/suite/e2e.flow.test.ts` | `make test-integration` |
| UI E2E | ExTester + WebDriver | `src/ui-test/*.ui.test.ts` | `make test-ui` |

```bash
make lint                 # type-check without emitting
make test-unit            # fast unit tests only
make test-integration     # compile + integration + API E2E in Extension Host
make test-ui              # compile + Selenium UI tests (needs display; CI uses xvfb)
make test                 # unit + integration (API layers)
npm run test:unit:watch   # unit tests in watch mode
```

Integration and API E2E tests open a fixture workspace at `src/test/fixtures/sample-workspace/` (via `src/test/runTest.ts`). UI E2E uses the same fixture (opened via the simple file dialog), drives the webview with [vscode-extension-tester](https://github.com/redhat-developer/vscode-extension-tester), and requires `EXTENSIONS_FOLDER` plus `EXTENSION_DEV_PATH` (set automatically by `make test-ui`). CI runs `make lint`, `make test`, `make test-ui` (under xvfb), and `make build` on pull requests.

**Future: webview unit tests** — Pure helpers in `media/search.js` (e.g. `escapeHtml`, `groupMatchesIntoSections`) can move to `media/searchLogic.js` and be covered by Vitest without launching VS Code.

## Project structure

```
src/
  extension.ts          Entry point; registers the open command
  search/
    searchPanel.ts      Webview panel and message handling
    searchEngine.ts     Ripgrep integration and replace logic
    searchUtils.ts      Pure helpers (patterns, grouping, breadcrumbs)
    ripgrepParser.ts    Ripgrep args and JSON line parsing
    types.ts            Shared message and result types
  test/
    unit/               Vitest unit tests
    suite/              Integration and API E2E tests (Mocha)
    fixtures/           Sample workspace for integration/E2E
  ui-test/              UI E2E tests (ExTester + WebDriver)
media/
  search.js             Webview frontend
  search.css            Webview styles
out/                    Compiled JavaScript (generated)
```

## Build and package

To produce a `.vsix` installable package:

```bash
make package          # compile + vsce package
```

This creates `fulltab-search-<version>.vsix` in the project root. `@vscode/vsce` is included as a dev dependency, so no global install is needed.

Install locally to test the packaged extension:

   ```bash
   code --install-extension fulltab-search-0.0.1.vsix
   ```

Files excluded from the package are listed in [`.vscodeignore`](.vscodeignore) (source, dev config, tests, etc.).

Before packaging for others, update `publisher` and `version` in [`package.json`](package.json).

## License

See the repository for license information.
