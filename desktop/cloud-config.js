// NOVAI Desktop — 云端地址解析（纯函数，不依赖 Electron，方便 node 单测）
//
// 解析顺序：NOVAI_URL 环境变量 → <userData>/novai-cloud.json 的 baseUrl → 本机地址。
// NOVAI_LOCAL_BACKEND=1 可强制回到本地后端（跳过配置文件，但仍尊重显式 NOVAI_URL）。
'use strict';

const fs = require('fs');
const path = require('path');

const CLOUD_CONFIG_FILENAME = 'novai-cloud.json';
const LOCAL_BACKEND_ENV = 'NOVAI_LOCAL_BACKEND';

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  if (!parsed.hostname) return '';
  const tail = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + tail + parsed.search + parsed.hash;
}

function readCloudBaseUrl(userDataDir) {
  if (!userDataDir) return '';
  try {
    const raw = fs.readFileSync(path.join(String(userDataDir), CLOUD_CONFIG_FILENAME), 'utf8');
    const data = JSON.parse(raw);
    return normalizeBaseUrl(data && data.baseUrl);
  } catch (_) {
    return '';
  }
}

function isLocalBackendForced(env) {
  const value = String((env || {})[LOCAL_BACKEND_ENV] || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
}

function readCloudBaseUrlFromDirs(dirs) {
  for (const dir of dirs || []) {
    const found = readCloudBaseUrl(dir);
    if (found) return found;
  }
  return '';
}

function resolveBaseUrl(options) {
  const opts = options || {};
  const env = opts.env || {};
  const localUrl = normalizeBaseUrl(opts.localUrl) || 'http://127.0.0.1:3000';

  const fromEnv = normalizeBaseUrl(env.NOVAI_URL);
  if (fromEnv) return { baseUrl: fromEnv, source: 'env' };

  if (isLocalBackendForced(env)) return { baseUrl: localUrl, source: 'local' };

  const dirs = [];
  if (opts.userDataDir) dirs.push(opts.userDataDir);
  if (Array.isArray(opts.userDataDirs)) dirs.push(...opts.userDataDirs);
  const fromConfig = readCloudBaseUrlFromDirs(dirs.filter(Boolean));
  if (fromConfig) return { baseUrl: fromConfig, source: 'config' };

  return { baseUrl: localUrl, source: 'local' };
}

module.exports = {
  CLOUD_CONFIG_FILENAME,
  LOCAL_BACKEND_ENV,
  normalizeBaseUrl,
  readCloudBaseUrl,
  readCloudBaseUrlFromDirs,
  resolveBaseUrl,
};
