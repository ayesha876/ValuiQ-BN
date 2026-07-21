ValuiQ Backend

## Testing

Tests run with [Vitest](https://vitest.dev/). The integration suite drives the real
Express app against an isolated, throwaway MongoDB spun up by
[`mongodb-memory-server`](https://github.com/typegoose/mongodb-memory-server).

```bash
npm test          # run the suite once
npm run test:watch
```

**First run downloads a mongod binary** (~780 MB, MongoDB `8.2.6` — pinned in
`package.json` under `config.mongodbMemoryServer.version`). It is cached after that,
so subsequent runs are fast.

**Skip the download** by pointing mms at a mongod you already have installed, via the
`MONGOMS_SYSTEM_BINARY` environment variable:

```bash
# macOS / Linux
export MONGOMS_SYSTEM_BINARY=/path/to/mongod

# Windows (PowerShell)
$env:MONGOMS_SYSTEM_BINARY = "C:\Program Files\MongoDB\Server\8.2\bin\mongod.exe"
```

Either way, `mongodb-memory-server` always launches its **own isolated, ephemeral
instance** (its own port and a throwaway data directory). It never connects to or
touches a mongod you already have running (e.g. on `27017`) — your local data is safe.
