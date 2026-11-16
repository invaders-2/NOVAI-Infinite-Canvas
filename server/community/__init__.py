#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""NOVAI 社区（局域网版）：发布包 / 版本化存储 / 节点传输。

模块分工：
    store.py      数据落盘（items.json / me.json / profile.json / packages / cache），全部原子写
    packager.py   发布包构建（画布 / 技能 / 提示词）与克隆时的媒体本地化
    transport.py  CommunityTransport 抽象 + LanTransport（UDP 发现 + 并发拉取 + 30s 缓存）

Python 3.9 约束：注解用 Optional/Dict/List，禁止 X | Y。
"""
from __future__ import annotations

__all__ = ["store", "packager", "transport"]
