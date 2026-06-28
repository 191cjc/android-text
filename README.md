# 4399 Flash 115225 Local Experiment

本项目用于本地运行并观察 4399 游戏“机甲小子”的 Flash 资源加载方式，目标是构建一个桌面实验壳：

- 使用 Electron 提供桌面窗口和外置按钮。
- 使用 Ruffle 在本地页面中运行 Flash。
- 使用本地 Express 服务提供原始资源、修改资源和请求日志。
- 后续只做本地资源覆盖实验，不处理充值、支付、账号权益或服务端校验绕过。

## Commands

```powershell
npm start
npm run start:remote
npm run serve
npm run inspect-swf
npm run check
```

## Layout

- `original/`: 归档的页面和原始 SWF。
- `modified/`: 修改后的资源或按 mod 名称分组的覆盖资源。
- `public/`: Ruffle 播放页和按钮面板。
- `src/`: Electron 主进程与本地服务。
- `notes/`: 实验记录。

## Current Status

- Electron desktop shell starts with `npm start`.
- Original 4399 page mode starts with `npm run start:remote`.
- Ruffle loads `original/xfbbv451.swf`.
- Local proxy handles known auxiliary hosts:
  - `stat.api.4399.com`
  - `cdn.comment.4399pk.com`
  - `media.5054399.net`
  - `save.api.4399.com/?ac=get_time` only
- The `local` mod slot is wired to `modified/local/`; it currently contains an identical SWF copy as a placeholder.

The proxy policy intentionally does not override account, save, shop, recharge, payment, or inventory mutation APIs. Use `npm start` for local resource experiments and `npm run start:remote` when testing login or official cloud-save behavior.
