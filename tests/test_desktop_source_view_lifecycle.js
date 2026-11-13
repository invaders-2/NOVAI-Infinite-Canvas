#!/usr/bin/env node
/* 转接 desktop/__tests__/test_source_view_lifecycle.js，让 node tests/run-all.js 的
   tests/test_*.js 收集规则也能跑到在线素材视图生命周期的假桩回归。 */
'use strict';
require('../desktop/__tests__/test_source_view_lifecycle.js');
