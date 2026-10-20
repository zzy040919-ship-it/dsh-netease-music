# dsh-netease-music

DeepSeek Harness 的网易云音乐播放器插件

## 功能

| 功能 | 说明 |
|---|---|
| 迷你播放条 | 收起时是右上角一条 250px 的玻璃条：小封面 + 歌名/歌手 + 播放键 + 进度线 |
| 播放器卡片 | 点开后是液态玻璃卡片（高模糊、透明白、边缘高光、鼠标跟随光斑、极慢扫光） |
| 黑胶视图 | 点卡片上半部分（封面/歌名区）切换成大黑胶：196px 唱片 + 金色圈边 + 封面标签 + 金色唱臂；播放时 12 秒一圈转动，暂停即停 |
| 搜索 | 卡片底部输入框回车搜索，结果就地展开，点一条即播 |
| 播放控制 | 上一首/播放暂停/下一首、可点进度条、音量条（记忆上次音量） |
| 歌词 | 自动拉取 LRC，卡片里显示当前句 + 下一句（含翻译） |
| 账号 | **自动登录本机网易云客户端账号**（见下），登录后 VIP / 高音质曲目可播，头像显示在卡片上 |
| 同步客户端 | 一键读取网易云客户端正在播放的歌，搜索并播放同一首 |
| 系统媒体键 | 通过 `navigator.mediaSession` 发布元数据，锁屏/媒体键可用 |

## 安装

插件是标准的 DSH profile bundle（`package.json` 里声明 `dsh.bundle.patch`），安装后由 `plugin_manager` / 插件市场完成包安装与 bundle 选择，重启 DSH 生效。

手动安装（开发调试）：

```powershell
# 1) 链接进 profile
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-netease-music" `
  -Target "<本仓库路径>"

# 2) 在 profile 的 cordis.patch.yml 末尾追加
# - insert:
#     - id: dsh-netease-music
#       name: 'dsh-netease-music'

# 3) 重启 DSH
```

## 自动登录是怎么做的

点卡片上的头像时，宿主半区会：

1. 找到本机网易云客户端的 CEF 数据目录 `%LOCALAPPDATA%\Netease\CloudMusic\webapp*\`；
2. 用 Windows DPAPI 解开该目录 `LocalPrefs.json` 里的 cookie 加密密钥（`ProtectedData.Unprotect`，仅当前用户可解）；
3. 用 `node:sqlite` 读取 `Cookies` 库里的 `MUSIC_U`，AES-256-GCM 解密；
4. 调 `api/nuser/account/get` 校验，通过后写入 `%USERPROFILE%\.dsh\dsh-netease-music.json`（仅本地）。

Cookie 只保存在本机、只用于 music.163.com 请求，不会上传任何地方。也可以手动把 cookie 写进上面那个 JSON：

```json
{ "cookie": "MUSIC_U=...; __csrf=...", "quality": "exhigh" }
```

## 结构

```
lib/index.js              宿主半区：/api/search、/api/song、/api/audio（同源音频代理）、
                          /api/lyric、/api/cover、/api/account、/api/account/auto、/api/client-now
lib/client.js             浏览器半区：shell.overlay 里的迷你条 / 玻璃卡片 / 黑胶视图
helper/client-title.ps1   读取网易云客户端窗口标题（同步客户端用）
helper/net-cookie-key.ps1 DPAPI 解出 cookie 密钥（自动登录用）
cordis.patch.yml          bundle 补丁
```

## 已知边界

- 未登录账号时只有免费曲目能播；VIP 曲目需要上面的账号登录。
- 网易云**网页**搜索接口在请求过多时会返回加密串，插件已改用 `/api/search/get` 接口并在失败时自动回退。
- 客户端"同步"依赖窗口标题（`歌名 - 歌手`），客户端不提供播放进度/暂停状态，因此只能拉取歌曲本身。
- 仅供个人学习使用，音乐版权归网易云音乐及各版权方所有。

## License

MIT
