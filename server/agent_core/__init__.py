# -*- coding: utf-8 -*-
"""画布助手 Agent 核心（v2）：上下文引擎 / 运行转录 / 按需读取工具 / 跨会话记忆。

这个包不 import main：全部是纯函数 + 小类，画布、模型调用、落盘目录都由调用方传进来，
main.py 只在接线点调用它。Python 3.9 约束：注解用 Optional/Dict/List。
"""
