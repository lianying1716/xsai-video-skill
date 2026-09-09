---
name: xsai-video-skill
description: Use when an agent needs to create, watch, cancel, or download videos through the Xingsuan relay with device authorization.
---

# 星算外部视频 Skill

视频任务都是异步任务。命令只使用设备授权后的受限 Token，任务、素材和结果按 Grant 隔离。真实创建会扣费；长时长、批量和多素材任务必须由用户明确确认。

## 命令

```bash
node scripts/video.mjs auth login --scope media.list_models,media.read_capabilities,media.generate,media.jobs.read,media.jobs.cancel,media.files.upload,media.files.download
node scripts/video.mjs models
node scripts/video.mjs create --prompt "..." [--model MODEL] [--duration 8] [--confirm-spend]
node scripts/video.mjs create --prompt "..." --first-frame ./start.png --last-frame ./end.png
node scripts/video.mjs create --prompt "..." --images ./ref.png --videos ./source.mp4 --audios ./voice.wav
node scripts/video.mjs status JOB_ID
node scripts/video.mjs watch JOB_ID --timeout 900
node scripts/video.mjs cancel JOB_ID
node scripts/video.mjs download JOB_ID --output ./result.mp4
```

提示词先按“主体→动作→镜头→时间线→声音→结尾”组织，再根据模型画像调整。`seedance-2.0`/`seedance2.5` 适合分镜、首尾帧和参考素材职责说明；`minimax-h3` 优先对白和环境声；`omni` 只展示，不默认推荐，直到星算侧完成验证。

不要提交 `--api-key`、`--provider-id`、`--channel-id` 或 `--group-id`。下载使用短时、绑定 Grant 的签名地址；默认不覆盖已有文件。

本地参考素材会先上传到当前授权的 relay，命令只接受本地文件或已有 `file_id`，不接受任意外部 URL；relay 仍会再次校验 MIME、大小、过期时间和用户/Grant 归属。
