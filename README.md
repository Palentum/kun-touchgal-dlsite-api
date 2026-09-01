# kun-touchgal-dlsite-api

DLsite metadata API for [TouchGal](https://github.com/KUN1007/kun-touchgal-next).

## Development

```bash
pnpm install
pnpm dev
```

The dev server listens on `http://127.0.0.1:8787`. Available routes:

| Method | Path          | Description                                                              |
| ------ | ------------- | ------------------------------------------------------------------------ |
| GET    | `/health`     | Returns `{ status: "ok" }`.                                              |
| GET    | `/api/dlsite` | Requires `code` query (RJ/VJ). Returns a `DlsiteApiResponse` on success. |

## Production build

```bash
pnpm build
node dist/index.js
```

`pnpm build` bundles the API with [tsup](https://tsup.egoist.dev/), producing an ESM entry inside `dist/`.

裸 `node dist/index.js` 默认监听 `127.0.0.1:8787`（可用 `PORT` / `HOST` 覆盖）。生产部署走 pm2（`pnpm start`，读取 `ecosystem.config.cjs`），监听 `127.0.0.1:8686` —— 反向代理的 `proxy_pass` 应以 8686 为准。

## Testing

```bash
pnpm test
```

Unit tests run on [Vitest](https://vitest.dev/) and rely on the HTML snapshots in `meta/`, so they are hermetic and do not hit DLsite during CI.
