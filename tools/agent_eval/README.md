# 画布助手评测集

拿一组固定任务跑画布助手（智能画布 BEAT），按每条用例的期望自动打分，出一份报告；改了助手的提示词、工具或换了对话模型后再跑一次，加 `--baseline` 就能看到哪些用例变好、哪些变坏。

## 怎么跑

在仓库根目录：

```bash
# --source-data 是正式安装版的数据目录（里面有 data/settings.json、API/.env）
python tools/agent_eval/agent_eval.py --source-data "<数据目录>" --provider <平台id> --model <模型>

# 只跑几条、每条跑 3 次（模型有随机性），并和上次对比
python tools/agent_eval/agent_eval.py --source-data "<数据目录>" --cases angle-three,split-grid --repeat 3 \
    --baseline tools/agent_eval/reports/<上次>/report.json
```

报告写在 `tools/agent_eval/reports/<时间>/report.md`（给人看）和 `report.json`（给下次对比用）。

- **不花生成额度**：BEAT 的生成一律停在「待生成卡片」，评测不点执行；花的只是对话模型（和看图模型）的调用。
- **不碰正式数据**：每次在临时目录建独立数据目录，只复制 `data/settings.json`、`data/api_providers.json`、`API/.env` 三个配置文件，跑完删掉（`--keep` 保留）。不连 3000 端口的正式后端。

## 用例格式（cases.json）

```json
{"id": "angle-three", "title": "组件：三个机位", "category": "组件",
 "instruction": "给这双鞋出 3 个不同角度",
 "canvas": {"nodes": [{"id": "shoe", "kind": "image", "title": "白色运动鞋", "asset": "product"}]},
 "focus": {"selected": ["shoe"]},
 "expect": {"actions": [{"action": "angle", "min": 3}], "plan": true}}
```

`asset` 是现场画的占位素材：`product` / `grid3`（九宫格）/ `scene`（横版场景）/ `person` / `video`（2 秒占位视频）。

`expect` 里每一项是一条检查，全部通过才算这条用例通过；得分 = 通过的检查数 / 检查总数。

| 检查 | 含义 |
|---|---|
| `status` | 结束状态在列表里（通常 `["ok"]`） |
| `plan` | 有没有出待生成卡片（true / false） |
| `asks` | 有没有先反问用户（回复里有问答卡或问号） |
| `tools_any` / `tools_all` / `tools_none` | 用了其中之一 / 全部用了 / 一个都没用 |
| `actions` | `canvas_action` 的组件，`params` 是子集匹配，`min` 是至少几次 |
| `actions_any` | 组件里命中其一即可 |
| `new_nodes` | 新节点：`kind`、`min`，可加 `from`（从哪个节点连过来）、`prompt_any`（提示词含其一）、`mode`（视频生成方式，画布里存中文，如「视频编辑」） |
| `new_nodes_max` | 新节点最多几个（问答类用例写 0） |
| `max_rounds` | 最多几轮 |
| `reply_any` | 回复里提到其一 |
| `generations_min` | 计划的生成次数至少多少（批量用例用） |

加用例后跑 `python -m pytest tests/test_agent_eval.py`，会校验用例文件（检查名写错、素材名写错、focus 指向不存在的节点都会报出来）。
