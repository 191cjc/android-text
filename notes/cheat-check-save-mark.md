# 作弊检查存档标记与本地 mock

本文记录当前反编译结果，以及 `cheat` 分支上的本地 mock 方案。这里的 mock 只用于本地调试存档，不用于官方云存档、支付、充值或服务端校验流程。

## 存档里的标记

作弊检查结果会被保存到 `NewSDList` 的顶层字段 `cm`。

- `NewSDList.save()` 会调用 `checkfm.save()`，再写入属性 `cm`。
- `NewSDList.readData()` 会从 `input.cm` 调用 `CheckFlagM.readData()`，再恢复到 `checkfm`。

`cm` 对应 `hotpointgame.savedatal::CheckFlagM`，序列化后的结构是：

```js
cm: {
  fa: [],   // cfm，普通作弊标记列表
  dm: [],   // dangerM，危险标记列表
  idai: 0,  // userId/dataIndex 相关校验值
  co: 0     // checkRValue
}
```

单条 `CheckFlag` 在存档中保存为：

```js
{
  cf: cflag,   // 标记类型
  cv: cvalue,  // 标记值
  cm: cnum,    // 次数
  cd: cDate    // 时间
}
```

注意：这里单条记录里的 `cm` 是 `cnum` 的短字段名，不是顶层 `NewSDList.cm`。

## 判断逻辑

主要判断点在 `CheckFlagM`：

- `isHasZoubi()`：读取 `cfm/fa`，某些 `cflag/cvalue` 组合会判定为作弊。
- `isHasZouBiInDm()`：如果 `isHasZoubi()` 为真，或 `dangerM/dm` 非空，则认为存在危险标记。
- `addFlag()` / `addFlagB()`：写入或合并 `CheckFlag`，并更新值、次数和时间。

目前已看到多个路径会调用 `checkfm.addFlag/addFlagB`，例如 `GoodsFactory`、`GLoadDataing`、`CLevel`、`DiaoLouGoodsM`、`FlowInterface`、`Api4399.saveDataStart` 等。部分调用后会立刻走 `saveDataBeforeNoState`，因此标记可能直接落盘。

## 本地 mock 方案

`cheat` 分支新增了 `src/cheat-check-mock.js`，用于处理保存字符串：

1. 将存档字段从 base64 解码。
2. 使用 zlib inflate 得到 `<saveXml>`。
3. 只匹配顶层 `name="cm"` 且内部包含 `fa` 和 `dm` 的 `CheckFlagM` 对象。
4. 将其中的 `fa` 和 `dm` 覆盖为空数组。
5. 尽量保留 `idai` 和 `co`。
6. 重新 deflate 并转回 base64。

这样做的目的不是修改道具、货币、角色等业务字段，而是在本地 mock 保存/加载时清除作弊检查容器里的判定结果。

## 接入点

已接入两个本地路径：

- `tools/launch-360x-mock.js`
  - `LAUNCH_360X_CHEAT_CHECK_MOCK=1` 时启用。
  - `writeMockSlotFromRequest()` 保存本地 mock slot 前清理。
  - `mockSlotRecord()` 从本地 mock slot 读取并返回给游戏前再次清理。
- `src/offline-4399-api.js`
  - `OFFLINE_4399_CHEAT_CHECK_MOCK=1` 时启用。
  - 本地 `/offline-4399` 保存与读取都会返回清理后的数据。

## 使用方式

推荐使用本地 session，避免写官方云存档：

```powershell
npm run start:360:mock:cheat
```

这个命令会设置：

- `LAUNCH_360X_PROFILE=isolated`
- `LAUNCH_360X_MOCK_SAVE_MODE=local-session`
- `LAUNCH_360X_CHEAT_CHECK_MOCK=1`

同时 `tools/launch-360x-mock.js` 默认以无头浏览器启动。需要临时可见窗口时，才手动设置：

```powershell
$env:LAUNCH_360X_HEADLESS='0'; npm run start:360:mock:cheat
```

## 参考反编译文件

- `.cache/dump-newsdlist-investigate-cheat.txt`
- `.cache/dump-checkflagm-investigate-cheat.txt`
- `.cache/refs-checkfm-investigate-cheat.json`
