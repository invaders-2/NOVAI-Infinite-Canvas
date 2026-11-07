# raw/ 原文快照说明

本目录只放「能直接复核 REPORT.md 引用」的原文快照，单文件都 < 300KB；2.3MB 的 llms-full.txt 全库**没有**入库，只入库了它的页面索引。

## 抓取方式（2026-11 执行，必须走代理）

```bash
# 1) 全站正文（约 2.33MB，不入库）
curl -sSL -x http://127.0.0.1:7897 https://docs.apimart.ai/llms-full.txt -o /tmp/apimart-llms-full.txt
# sha256: da7f038a4cf98a3f09c2c9fdd960c2276885ed00c084aae551aebada968387fc  (2327937 bytes)

# 2) 文档站目录索引（Mintlify 生成，含各语言 llms 索引）
curl -sSL -x http://127.0.0.1:7897 https://docs.apimart.ai/llms.txt

# 3) 单页中文 Markdown（比 HTML 干净，体积小；路径加 /cn 前缀 + .md 后缀）
curl -sSL -x http://127.0.0.1:7897 https://docs.apimart.ai/cn/<page>.md
```

注意：`https://docs.apimart.ai/cn/llms-full.txt` **不存在（404）**；中文全量只有 `https://docs.apimart.ai/_llms/zh-hans.txt` 这个目录索引，正文页需要逐页取。直连 docs.apimart.ai 会超时，必须走代理。

## 本目录文件

| 文件 | 中文页面 URL | sha256 |
| - | - | - |
| api-reference_texts_general_chat-completions.md | https://docs.apimart.ai/cn/api-reference/texts/general/chat-completions | fd7f924476fd67b452c698e960d0f0eac29411d5cd912894eef1bfde113ae701 |
| api-reference_texts_general_claude-messages.md | https://docs.apimart.ai/cn/api-reference/texts/general/claude-messages | 39cf2eea49f98b95e1ab948d76646816dd38f5f1ae5a80d208f0a8a3df7d3689 |
| api-reference_texts_gemini_quickstart.md | https://docs.apimart.ai/cn/api-reference/texts/gemini/quickstart | 92a23f9abde7f8e7a5bb0442d7de7021397a9aa3742c5237d1bebc5cf7de3254 |
| api-reference_texts_models_list.md | https://docs.apimart.ai/cn/api-reference/texts/models/list | 515463868a96fbd4338d20e549697877bd416d1ecdfacbdc593c56bb06554f76 |
| api-reference_tasks_status.md | https://docs.apimart.ai/cn/api-reference/tasks/status | d2b42f69b71fbe25776c181d79c2596cc25dddcedd5c31807fbcea6617a2f544 |
| api-reference_tasks_webhook.md | https://docs.apimart.ai/cn/api-reference/tasks/webhook | 7ae89a15be0ac8eebe5aa8ce793989e4f47a0e5bd079555b97bdde7c35088490 |
| api-reference_uploads_images.md | https://docs.apimart.ai/cn/api-reference/uploads/images | bf9049f3fac0a96c568bbf88254f1b634d2d9bda5a2ba7d0b9b25e269730d4c5 |
| llms-full-index.txt | （llms-full.txt 的页面索引：标题 → 行号 → Source URL） | 1902e14b44bf2803eb42b6600ea15a9ec73e23186a27fb9b679b9daf9de38767 |

## 怎么用 llms-full-index.txt 复核

REPORT.md 里写成 `L79316` 的行号，指的是 `/tmp/apimart-llms-full.txt`（sha256 见上）里的行号。拿到同 sha256 的文件后：

```bash
sed -n '79316,79831p' /tmp/apimart-llms-full.txt   # → Get Task Status 全文
```

行号在文件被重新抓取后会漂移，所以复核前先比对 sha256。
