# Camera Agent 

研究院内网直连，以及可视化大屏中的智能助理“小安”相关代码。

## 功能范围

- 两路 TP-Link 网络摄像头 RTSP 子码流接入。
- 本地录制、关键帧提取、事件合并与事件入库。
- Qwen2.5-VL 视觉模型负责关键帧图像分析。
- SQLite 存储结构化事件，Qdrant 存储语义向量索引。
- Flask Web 前端提供实时画面、关键帧分析、自然语言问答、全天日志总结。
- 可视化大屏 `/dashboard` 集成智能助理“小安”，支持 ASR、问答、TTS 播报。


## 启动顺序

1. 修改 `camera_config.json` 中的 RTSP、Qwen2.5-VL、Ollama、Qdrant、飞书配置。
2. 启动 Qdrant。
3. 启动本地 Embedding 服务：`python api_server.py`。
4. 启动本地问答模型服务，例如 Ollama：`ollama serve`。
5. 如需语音大屏，启动 ASR 和 TTS 服务：
   - `python tools/sensevoice_server.py`
   - `python tools/moss_tts_onnx_server.py`
6. 启动主程序：`python app.py`。
7. 浏览器访问：
   - 主系统：`http://127.0.0.1:5000/`
   - 可视化大屏：`http://127.0.0.1:5000/dashboard`

## 关键配置

- 摄像头地址：`camera_config.json -> cameras[].rtsp_url`
- 存储目录：`camera_config.json -> storage.base_dir`
- 视觉模型：`camera_config.json -> vision_llm`
- 文本问答模型：`camera_config.json -> text_llm`
- 小安语音服务：`camera_config.json -> dashboard.asr_url` 和 `dashboard.tts_url`

## 数据位置

默认业务数据保存在 `D:\camera_agent_data`：

- `security_events.db`：SQLite 结构化事件库。
- `session_data/`：本地任务会话数据。
- `raw_clips/`：录制视频片段。
- `extracted_frames/`：关键帧图片。

