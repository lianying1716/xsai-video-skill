# xsai-video-skill

星算外部视频 Skill，作为独立 GitHub 仓库发布。仓库已经内置运行时和视频模型画像，克隆后不依赖 `xsai-external-skills-pack` 或其他仓库。

- 入口：`scripts/video.mjs`
- 授权：设备码/浏览器授权，状态文件仅保存受限 refresh token
- 模型：MiniMax、Omni、Seedance 2.0/2.5 能力画像
- 能力：异步创建、状态、轮询、取消、参考素材上传和结果下载
- 素材：支持本地图片/视频/音频或当前授权生成的 relay `file_id`，拒绝任意外部 URL

支持 Node.js 18+。发布版本使用 GitHub tag，例如 `v1.0.0`。
