# 服务器录制端

这套代码只负责两件事：

- 连接两路 RTSP 摄像头
- 按固定时长滚动录制 mp4，并把片段信息写入 `clips.jsonl`

它不做关键帧提取、不做大模型分析、不写 SQLite。

## 目录结构

建议在服务器上放到：

```bash
/home/jxq/extraction-keyframe/video_get
```

运行后会自动生成：

```bash
data/
  raw_clips/
    cam01/YYYY-MM-DD/*.mp4
    cam02/YYYY-MM-DD/*.mp4
  manifests/
    clips.jsonl
```

## 部署步骤

1. 进入目录

```bash
cd /home/jxq/extraction-keyframe/video_get
```

2. 安装依赖

```bash
/home/jxq/miniconda3/bin/python -m pip install -r requirements.txt
```

3. 复制配置模板

```bash
cp server_config.example.json server_config.json
```

4. 先做一次单轮测试

```bash
/home/jxq/miniconda3/bin/python server_recorder.py --config server_config.json --once
```

如果成功，会输出每路摄像头的一条录制结果，并在 `data/raw_clips` 下生成 mp4。

5. 持续运行

```bash
bash run_recorder.sh
```

## 配置说明

- `storage_dir`: 视频片段保存根目录
- `manifest_path`: 片段清单文件，推荐使用 `jsonl`
- `segment_seconds`: 每段录制时长，建议先用 `120`
- `retention_days`: 原始视频保留天数
- `reconnect_backoff_seconds`: RTSP 断流后的重试等待时间
- `cleanup_interval_seconds`: 清理过期视频的周期

## 和本地分析端怎么配合

本地后续只需要做两件事：

- 读取 `clips.jsonl`
- 把新的 mp4 下载到本地，再走现有关键帧提取和分析流程

也就是说，服务器只负责“采集+落盘”，你现有本地智能体链路可以保持不变。
