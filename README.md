<p align="center">
  <img src="assets/logo.svg" alt="Roboquant logo" width="96" height="91">
</p>

<h1 align="center">Strategy Optimizer for TradingView</h1>

A free, open-source Chrome extension that optimizes the inputs of your TradingView Pine Script strategies. It runs every backtest through TradingView's own Strategy Tester, right on your chart.

No account, no login, no paid tier. MIT licensed.

Built by [Roboquant](https://roboquant.dev/?utm_source=tradingview-optimizer&utm_medium=github&utm_content=readme-header).

## What's new in 3.0.0

If you installed an earlier version from the Chrome Web Store, it updates to 3.0.0 automatically. What changed:

- **Everything is free.** All optimization modes, walk-forward analysis, heatmaps and the prop firm check work for everyone. There are no parameter or history limits tied to a plan.
- **No account needed.** Sign-in and the Roboquant account connection are gone.
- **Send to app is removed.** Results stay in your browser. You can download any result as JSON.
- **Open source.** The code is on GitHub under the MIT license.

## Features

- **Grid search** over numeric, dropdown and checkbox strategy inputs
- **Modes:** Standard, Multi-Timeframe, Multi-Symbol and Full Grid
- **Optimization goals:** Sharpe ratio, net profit %, profit factor, win rate or minimum drawdown
- **Walk-forward validation:** a single in-sample / out-of-sample split, or rolling windows
- **Heatmaps:** 2D and 3D (Plotly) views of how two parameters interact
- **Prop firm challenge check** of the best result against profit target, daily loss and max drawdown rules
- **Sortable results table** with one-click Apply to push a parameter set back to your chart
- **JSON export** of results
- **Local history** of your last 10 optimizations, stored in `chrome.storage.local`

## Install

### Chrome Web Store

Install **[Strategy Optimizer for TradingView](https://chromewebstore.google.com/detail/strategy-optimizer-for-tr/knmhofaifgcakgjifhjalahmbfgokiep)** from the Chrome Web Store.

### From source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/Roboquant-AI/tradingview-optimizer.git
cd tradingview-optimizer
bun install
bun run build
```

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist` folder

## Usage

1. Open a TradingView chart with a Pine Script strategy applied
2. Click **Optimizer** in the panel tab bar below the chart (next to Strategy Tester)
3. Select the inputs to optimize and set min / max / step
4. Pick a mode and a goal, then click **Start Optimization**
5. Sort the results and click **Apply** on the row you want

## Development

```bash
bun run dev        # watch build into dist/
bun run typecheck  # tsc --noEmit
bun run test       # unit tests
bun run build      # production build
```

| File | Description |
|------|-------------|
| `manifest.json` | Chrome extension manifest (MV3) |
| `src/background.ts` | Service worker: tracks TradingView tabs, sets the backtest date range through the debugger API |
| `src/content.ts` | Content script: reads strategy inputs, applies parameter sets, changes symbol / timeframe, extracts metrics |
| `src/optimizer-ui.ts` | Optimizer overlay injected into the TradingView page |
| `src/popup.html`, `src/popup.ts` | Toolbar popup with status and how-to |
| `src/config.ts` | Roboquant link helper |
| `src/types.ts` | Shared types |
| `src/selectors.json` | TradingView DOM selectors |

TradingView changes its DOM from time to time. If the optimizer stops finding inputs or buttons, `src/selectors.json` is the first place to look.

See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request.

## Permissions

| Permission | Reason |
|------------|--------|
| `activeTab` | Work with the TradingView tab you are on |
| `debugger` | Set the Strategy Tester date range for walk-forward runs |
| `storage`, `unlimitedStorage` | Keep optimization history locally |
| `https://*.tradingview.com/*` | Run the content script on TradingView only |

The extension sends nothing to Roboquant or any other server. It only opens roboquant.dev when you click a Roboquant link.

## About Roboquant

[Roboquant 2.0](https://roboquant.dev/?utm_source=tradingview-optimizer&utm_medium=github&utm_content=readme-about) is where you build and backtest trading strategies on Roboquant's native engine, using CME market data, and then optimize and deploy them. If this optimizer helps you tune a TradingView strategy, Roboquant is the next step for taking the idea further.

## Disclaimer

This project is not affiliated with, endorsed by or sponsored by TradingView. TradingView is a trademark of its owner. The extension automates the TradingView web page; use it at your own risk and check that your use complies with TradingView's terms. Backtest and optimization results do not guarantee future performance.

## License and trademarks

The code is released under the [MIT License](./LICENSE).

The MIT License covers the code only. It does not grant any right to use the Roboquant name, logo or other brand assets. If you fork or redistribute this extension, remove the Roboquant name and logo and publish it under a different name.
