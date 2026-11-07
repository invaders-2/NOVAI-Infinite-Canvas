# API 配置指引

本 skill 装到任何 agent 上后，只需配好两块配置即可直接出图：
`prompt_llm`（视觉语言模型，提取身份锁+编排镜头）与 `image_backend`（图像生成模型）。
所有接口走 OpenAI 兼容格式，仅依赖 Python 标准库（urllib），无需 pip 安装。

## 配置方式（二选一）

1. **config.json**：复制 `config.example.json` 为 `config.json`（与 SKILL.md 同目录），填入密钥。
2. **环境变量**（适合容器 / 其他 agent 注入）：
   - `FE_LLM_BASE_URL` / `FE_LLM_API_KEY` / `FE_LLM_MODEL` / `FE_LLM_VISION_MODEL`
   - `FE_IMG_TYPE` / `FE_IMG_BASE_URL` / `FE_IMG_API_KEY` / `FE_IMG_MODEL`

环境变量优先级高于 config.json。

## 推荐组合（国内，多参考图一致性最佳）

**火山方舟（字节，即梦 Seedream 4.0）**——image_backend 与 prompt_llm 可共用一个 Key：

- `image_backend`: `base_url = https://ark.cn-beijing.volces.com/api/v3`，`model = doubao-seedream-4-0-xxxxxx`（以方舟控制台「模型推理」页实际接入点 ID 为准）。Seedream 4.0 支持 `image` 数组多参考图输入，是三重身份锁（服装+模特+场景）落地的关键。
- `prompt_llm`: 同一 `base_url`，`model` 用视觉模型（如 doubao-seed-1.6-vision 系列接入点），`vision_model` 同值。
- Key 申请：火山方舟控制台 → API Key 管理。

**阿里云百炼（通义）**：

- `prompt_llm`: `base_url = https://dashscope.aliyuncs.com/compatible-mode/v1`，`vision_model` 用 qwen-vl-max / qwen2.5-vl 系列。
- `image_backend`: `type = dashscope`，`model = wanx2.1-t2i-turbo` 等。注意：dashscope 后端**不支持参考图**，服装一致性会受损，仅作无参考图兜底。

**OpenAI / 兼容聚合（SiliconFlow 等）**：

- `prompt_llm`: `base_url = https://api.openai.com/v1`（或聚合站），`vision_model = gpt-4o` 等。
- `image_backend`: `type = openai`，`model = gpt-image-1`（图生图走 /images/edits 的服务需自行确认兼容性）；聚合站可填其支持的 Seedream 接入点。

## 一致性能力对照

| 后端 | 多参考图 | 说明 |
|---|---|---|
| 火山方舟 Seedream 4.0 | ✅（首选） | `image` 字段传 base64 数组，服装/模特/场景图一起进 |
| 即梦网页端 | ✅ | 走提示词路径（复制 shotplan 中的 en_prompt + 上传参考图） |
| Gemini / GPT-4o 图像编辑 | ✅ | 多图输入 |
| dashscope wanx | ❌ | 仅文生图，一致性靠提示词，效果打折 |

> 提示词只能锁定风格与画面编排，身份一致性必须靠"多参考图随图输入"落地——
> 这是本 skill 把参考图路径写进 shotplan.json 并在生成时自动附带的原因。
