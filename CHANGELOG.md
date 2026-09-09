# Changelog
## 1.1.0 - 2026-09-09

Shared suite OAuth runtime, one shared permission grant, and crash-safe refresh state.


## 1.0.1 - 2026-09-09

- 修复主站设备授权域与 Relay API 域分离。
- 视频任务提交后默认 30 秒再查询，支持瞬时网络重试、服务端建议间隔、进度回调和可恢复超时。
- 结果下载改为受信任域名校验与流式写盘。

## 1.0.0 - 2026-09-08

- 首次发布独立 GitHub 仓库版本。
- 支持视频模型路由、异步任务、轮询、取消、素材上传和下载。
- 内置 runtime 与视频模型画像。
