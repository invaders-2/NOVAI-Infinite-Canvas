"""拆分图层启发式引擎（beat 接入版）。

由 split-layers/backend/engine 迁入，差异仅在于运行配置：
- 任务数据目录跟随 NOVAI_DATA_DIR（$NOVAI_DATA_DIR/split_jobs）；
- 不再包含独立服务的端口 / 样例 / /demo 配置。
"""
