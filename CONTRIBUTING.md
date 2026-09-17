# Contributing

Thanks for helping improve Strategy Optimizer for TradingView.

## Setup

```bash
bun install
bun run dev
```

Load the `dist` folder as an unpacked extension in `chrome://extensions/` (Developer mode) and reload it after each build.

## Before opening a pull request

```bash
bun run typecheck
bun run test
bun run build
```

All three must pass. Then check your change by hand on a TradingView chart with a strategy applied.

## Guidelines

- Keep pull requests small and focused on one change.
- TradingView DOM selectors belong in `src/selectors.json`.
- The extension must not send user data to any server.
- Bug reports: open an issue with your Chrome version, the strategy mode you ran and the console output (`[RQ ...]` log lines).

By contributing, you agree that your contributions are licensed under the MIT License. The Roboquant name and logo are not part of that license.
