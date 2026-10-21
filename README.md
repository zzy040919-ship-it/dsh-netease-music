# dsh-netease-music

DeepSeek Harness 的网易云音乐播放器插件

![plugin](https://img.shields.io/badge/dsh-plugin-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## 功能

| 功能 | 说明 |
|---|---|
| 迷你播放条 | 收起时是右上角一条玻璃条：小封面 + 歌名/歌手 + 播放键 + 进度线 |
| 播放器卡片 | 点开后是液态玻璃卡片（高模糊、透明白、边缘高光、鼠标跟随光斑） |
| 黑胶视图 | 点卡片上半部分（封面/歌名区）切换成大黑胶：唱片纹路 + 金色圈边 + 封面标签 + 金色唱臂；播放时转动，暂停即停 |
| 搜索 | 卡片底部输入框回车搜索，结果就地展开，点一条即播 |
| 播放控制 | 上一首 / 播放暂停 / 下一首、可点进度条、音量条（记忆上次音量）；播放队列会记住，重启后继续 |
| 歌词 | 自动拉取 LRC，卡片里显示当前句 + 下一句（含翻译） |
| 账号 | 自动登录本机网易云客户端账号，登录后 VIP / 高音质曲目可播，头像显示在卡片上 |
| 同步客户端 | 读取网易云客户端正在播放的歌并播放；**客户端没开时**退回到账号的最近播放列表 |
| CDN 容灾 | 网易云的音频节点按域名调度，个别 `m*.music.126.net` 节点会抽风：插件自动换一个能通的节点 |
| 系统媒体键 | 通过 `navigator.mediaSession` 发布元数据，锁屏 / 媒体键可用 |

## 安装

标准 DSH bundle（`package.json` 声明了 `dsh.bundle.patch` 与 `cordis.patch.yml`），装在 profile 里即可：

```sh
dsh plugin --profile desktop add https://github.com/zzy040919-ship-it/dsh-netease-music
```

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

# 3) 完全重启 DSH
```

宿主半区（`lib/index.js`）有改动时必须完全重启客户端，只刷新页面不会重新加载。

## 自动登录是怎么做的

点卡片上的账号按钮时，宿主半区会：

1. 找到本机网易云客户端的 CEF 数据目录 `%LOCALAPPDATA%\Netease\CloudMusic\webapp*\`；
2. 用 Windows DPAPI 解开该目录 `LocalPrefs.json` 里的 cookie 加密密钥（`ProtectedData.Unprotect`，只有当前用户能解）；
3. 用 `node:sqlite` 读取 `Cookies` 库里的 `MUSIC_U`，AES-256-GCM 解密；
4. 调 `/api/nuser/account/get` 校验，通过后写入 `%USERPROFILE%\.dsh\dsh-netease-music.json`（仅本机）。

Cookie 只保存在本机、只用于 music.163.com 请求，不会上传任何地方。也可以手动写这个 JSON：

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

## 排查

播放器把关键步骤写进 `%TEMP%\dsh-netease-music.log`（`streamUrl ok`、`cdn host ok`、`now playing`、`audio error`、`play rejected`），出问题先看这个文件。

| 现象 | 原因 / 处理 |
|---|---|
| 点了播放没声音 | 浏览器自动播放策略：随便点一下页面任意位置解锁后即可 |
| 提示「VIP / 付费歌」 | 需要登录账号（点卡片上的账号按钮自动登录本机客户端） |
| 一直「拿不到播放地址」 | 该曲目在网易云已下架或无版权 |
| 某个节点连接重置 | 插件会自动切换 `m701/m702/m703/m801/m802/m803` 等节点 |
| 同步客户端没反应 | 客户端没开时用账号最近播放；两者都没有时先搜一首歌 |

## 已知边界

- 网易云网页搜索接口在请求过多时会返回加密串，插件使用 `/api/search/get`，失败时自动回退。
- 客户端「同步」读的是窗口标题（`歌名 - 歌手`），拿不到进度和暂停状态。
- 仅供个人学习使用，音乐版权归网易云音乐及各版权方所有。

## License

MIT
