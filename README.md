# MT5 history backup

Portable CLI to back up MetaTrader 5 **real ticks** (`.tkc`) and **M1 bar history** (`.hcc`) from any local terminal to Google Drive, a network folder, or later Cloudflare R2.

## What it does

1. **Discover** broker data under `%APPDATA%\MetaQuotes\Terminal\<id>\bases\<Server>\`
2. **Force-complete** the newest calendar month via Strategy Tester (`SymbolSpecProbe`, Model 4 for ticks, Model 1 for history-only symbols). This nudges MT5 to download/finish tick and bar data for that month.
3. **Sync** to your backup folder with safe rules:
   - Add missing symbol folders and missing months/years
   - Replace **only the newest** dated file when the terminal copy is larger
   - Never overwrite older months/years
4. Write **`manifest.json`** (R2-ready inventory)

## Quick start (this PC)

```powershell
cd C:\Cursor\somatrading\mt5-history-backup
copy config.example.json config.json
node src/backup.mjs --discover
node src/backup.mjs --dest "C:\Users\andrs\My Drive\Forex\Ticks history backup" --server ICMarketsSC-MT5 --terminal 010E047102812FC0C18890992854220E
```

## Another machine

1. Clone this repo (or copy the folder).
2. Edit `config.json` (`dest`, optional `server` / `terminalId`).
3. Run `node src/backup.mjs --discover` to see local servers.
4. Run `node src/backup.mjs --all-brokers` or `--server YourBroker-MT5`.

## Backup layout

```
<dest>/
  manifest.json
  ICMarketsSC-MT5/
    ticks/
      XAUUSD/
        202307.tkc
        ...
        ticks.dat
    history/
      XAUUSD/
        2023.hcc
        ...
```

## CLI options

| Flag | Description |
|------|-------------|
| `--discover` | List terminals with ticks/history |
| `--dest PATH` | Backup root folder |
| `--server NAME` | Single broker server (e.g. `ICMarketsSC-MT5`) |
| `--terminal ID` | Terminal hash (optional; largest data set used if omitted) |
| `--all-brokers` | Backup every discovered server |
| `--include-demo` | Include `*Demo*` servers |
| `--skip-tester` | Copy only, no tester pre-run |
| `--leverage N` | Tester leverage (default 500) |

## Safety

- Checks `mt5-batch-cli occupancy` and refuses to run if the target terminal `installPath` is `cliBusy`.
- Does **not** wipe or redeploy other EAs (only copies/compiles `SymbolSpecProbe` into that terminal).
- Retries file copies when history files are locked (close MT5 if copies keep failing).

## Requirements

- Windows with MT5 installed
- Node.js 18+
- Optional: `mt5-batch-optimizer` built CLI for occupancy checks

## Later (not in v1)

- Cloudflare R2 upload worker
- Public download website
