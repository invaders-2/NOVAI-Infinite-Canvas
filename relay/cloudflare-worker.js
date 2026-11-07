// NOVAI GitHub 令牌中转（Cloudflare Worker 单文件版）
//
// 令牌只放在 Worker 的环境变量里；NOVAI 客户端只配中转地址（https://xxx.workers.dev）。
//
// 契约（只有 GET，全部只读）：
//   GET /v1/health                              -> {"ok": true}
//   GET /v1/default-branch?owner=&repo=          -> {"branch": "main"}
//   GET /v1/list?owner=&repo=&ref=               -> {"files": ["skills/pdf/SKILL.md", ...]}
//   GET /v1/raw?owner=&repo=&ref=&path=          -> SKILL.md 原文（text/markdown; charset=utf-8）
//
// 环境变量：
//   GITHUB_TOKEN  必填（建议 fine-grained PAT，只需 public repo 读权限）
//   RELAY_SECRET  可选；设了就要求请求头 x-relay-token 与之相等
//
// 安全：只允许 api.github.com / raw.githubusercontent.com，10s 超时，响应 <=1MB，
// 上游重定向一律拒绝，参数严格校验（不开放任意 URL 代理）。

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10 * 1000;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const ALLOWED_UPSTREAM = new Set(["api.github.com", "raw.githubusercontent.com"]);
const USER_AGENT = "NOVAI-GitHub-Relay/1.0";

class BadRequest extends Error {}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: Object.assign({
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    }, extraHeaders),
  });
}

function text(body) {
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function pickName(params, key) {
  const value = (params.get(key) || "").trim();
  if (!NAME_RE.test(value) || value === "." || value === "..") {
    throw new BadRequest(key + " 不合法");
  }
  return value;
}

function pickRef(params) {
  const value = (params.get("ref") || "").trim();
  if (!value || value.length > 255 || value.includes("\\") ||
      value.startsWith("/") || value.split("/").includes("..")) {
    throw new BadRequest("ref 不合法");
  }
  return value;
}

function pickPath(params) {
  const value = (params.get("path") || "").trim().replace(/^\/+|\/+$/g, "");
  if (!value || value.length > 512 || value.includes("\\") ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new BadRequest("path 不合法");
  }
  return value;
}

async function upstream(url, token) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_UPSTREAM.has(parsed.hostname)) {
    throw new BadRequest("上游地址不在白名单");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        "accept": "application/vnd.github+json",
        "authorization": "Bearer " + token,
      },
      redirect: "manual",           // 上游重定向一律拒绝，避免被带去别的主机
      signal: controller.signal,
    });
    const body = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function decodeBody(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function githubError(status) {
  if (status === 401 || status === 403) {
    return [403, { error: "GitHub 拒绝访问（令牌权限不足或被限流）" }];
  }
  if (status === 429) {
    return [429, { error: "GitHub 请求过于频繁（限流）" }];
  }
  if (status === 404) {
    return [404, { error: "GitHub 上找不到对应资源" }];
  }
  return [502, { error: "GitHub 返回 HTTP " + status }];
}

async function defaultBranch(params, token) {
  const owner = pickName(params, "owner");
  const repo = pickName(params, "repo");
  const { status, body } = await upstream(
    "https://api.github.com/repos/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repo), token);
  if (status === 200) {
    let branch = "";
    try {
      branch = String(JSON.parse(decodeBody(body)).default_branch || "").trim();
    } catch (err) {
      branch = "";
    }
    if (!branch) {
      return json({ error: "GitHub 没有返回默认分支" }, 502);
    }
    return json({ branch: branch });
  }
  if (status === 404) {
    return json({ error: "仓库不存在或名字不对：" + owner + "/" + repo }, 404);
  }
  const [code, payload] = githubError(status);
  return json(payload, code);
}

async function listSkills(params, token) {
  const owner = pickName(params, "owner");
  const repo = pickName(params, "repo");
  const ref = pickRef(params);
  const url = "https://api.github.com/repos/" + encodeURIComponent(owner) + "/" +
    encodeURIComponent(repo) + "/git/trees/" + encodeURIComponent(ref) + "?recursive=1";
  const { status, body } = await upstream(url, token);
  if (status !== 200) {
    if (status === 404) {
      return json({ error: "仓库或分支不存在：" + owner + "/" + repo + "@" + ref }, 404);
    }
    const [code, payload] = githubError(status);
    return json(payload, code);
  }
  if (body.length > MAX_BYTES) {
    return json({ error: "目录树超过 1MB 上限" }, 413);
  }
  let tree = [];
  try {
    tree = JSON.parse(decodeBody(body)).tree || [];
  } catch (err) {
    return json({ error: "GitHub 返回了无法解析的数据" }, 502);
  }
  const files = [];
  for (const item of tree) {
    if (!item || item.type !== "blob") continue;
    const path = String(item.path || "");
    if (path === "SKILL.md" || path.endsWith("/SKILL.md")) {
      files.push(path);
    }
  }
  return json({ files: files });
}

async function rawFile(params, token) {
  const owner = pickName(params, "owner");
  const repo = pickName(params, "repo");
  const ref = pickRef(params);
  const path = pickPath(params);
  const url = "https://raw.githubusercontent.com/" + encodeURIComponent(owner) + "/" +
    encodeURIComponent(repo) + "/" + ref.split("/").map(encodeURIComponent).join("/") + "/" +
    path.split("/").map(encodeURIComponent).join("/");
  const { status, body } = await upstream(url, token);
  if (status === 200) {
    if (body.length > MAX_BYTES) {
      return json({ error: "SKILL.md 超过 1MB 上限" }, 413);
    }
    return text(decodeBody(body));
  }
  if (status === 404) {
    return json({ error: "文件不存在：" + owner + "/" + repo + "@" + ref + "/" + path }, 404);
  }
  const [code, payload] = githubError(status);
  return json(payload, code);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405, { allow: "GET" });
    }
    if (path === "/v1/health") {
      return json({ ok: true });
    }
    const secret = String(env.RELAY_SECRET || "").trim();
    if (secret && request.headers.get("x-relay-token") !== secret) {
      return json({ error: "unauthorized" }, 401);
    }
    const token = String(env.GITHUB_TOKEN || "").trim();
    if (!token) {
      return json({ error: "relay 未配置 GITHUB_TOKEN" }, 503);
    }
    try {
      if (path === "/v1/default-branch") {
        return await defaultBranch(url.searchParams, token);
      }
      if (path === "/v1/list") {
        return await listSkills(url.searchParams, token);
      }
      if (path === "/v1/raw") {
        return await rawFile(url.searchParams, token);
      }
    } catch (err) {
      if (err instanceof BadRequest) {
        return json({ error: err.message }, 400);
      }
      return json({ error: "无法连接 GitHub" }, 502);
    }
    return json({ error: "not found" }, 404);
  },
};
