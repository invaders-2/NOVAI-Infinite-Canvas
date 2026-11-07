# 风格档案目录 (profiles/)

存放 lock 模式生成的专属风格档案。启动时若该目录只有一份档案，则自动作为默认风格加载（stderr 输出 `[AUTO]`）。

| 档案 | 版本 | 锁定时间 | 来源 | 状态 |
|---|---|---|---|---|
| `film-darkroom-cn.json` | v1.1 | 2026-09-01 | 17 张用户参考图（ROSE LING LING / DAYIN STUDIO / VIZA VIZA / MIRROR VISUAL 系列） | 默认 |

## 档案字段说明

```json
{
  "style_name": "中文名称",
  "profile_id": "英文短 id（与档案名一致）",
  "source": "风格来源说明",
  "version": "vX.Y",
  "locked_at": "YYYY-MM-DD",
  "revised_at": "修订历史说明",
  "zh_summary": "中文风格摘要",
  "style_keywords": ["英文风格关键词数组，注入每条 prompt 末尾"],
  "single_line": "一句话英文风格描述，作为 atmosphere 行注入",
  "color_palette": ["配色规则"],
  "composition": ["构图规则"],
  "lighting": ["光线规则"],
  "texture_material": ["质感规则"],
  "border_overlay": ["边框规则"],
  "negative_prompt": "统一负面词串",
  "consistency_notes": ["一致性与争议点处理"],
  "reference_signature_examples": ["参考图中的具体签名特征示例"]
}
```

## 添加新档案

用户提供 3-20 张同风格参考图、明确要"锁定为我的风格"时：

```bash
python3 <skill>/scripts/shoot_plan.py \
  --mode lock \
  --image ref1.png --image ref2.png --image ref3.png \
  --profile-name <档案名> \
  --out <skill>/profiles/<档案名>.json
```

## 切换默认

- 多份档案时：使用 `--style <profile_id>` 显式选择，或 `--style-file <path>` 指定自定义路径
- 删除档案后请同步更新本 README
