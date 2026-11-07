# GitHub 令牌中转（relay）

NOVAI 客户端从 GitHub 安装技能时需要读仓库信息、目录树和 SKILL.md。
如果不想把 GitHub 令牌放在每个人的客户端里，就把令牌放到一台中转服务上，客户端只配中转地址：

    NOVAI 客户端  ──(只带中转地址，不带 GitHub 令牌)──▶  中转服务（持 GITHUB_TOKEN）  ──▶  GitHub

中转是**只读**的：只有 4 个 GET 接口，参数严格校验，只允许访问 api.github.com 与
raw.githubusercontent.com，10 秒超时，响应不超过 1MB，不开放任意 URL 代理。

## 接口契约

| 方法 | 路径 | 说明 | 成功响应 |
| --- | --- | --- | --- |
| GET | `/v1/health` | 健康检查（**不校验密钥**，方便探活） | `{"ok": true}` |
| GET | `/v1/default-branch?owner=&repo=` | 仓库默认分支 | `{"branch": "main"}` |
| GET | `/v1/list?owner=&repo=&ref=` | 该分支下所有 SKILL.md 路径 | `{"files": ["skills/pdf/SKILL.md", ...]}` |
| GET | `/v1/raw?owner=&repo=&ref=&path=` | SKILL.md 原文 | `text/markdown; charset=utf-8` |

其它方法一律 405。配置了 `RELAY_SECRET` 时，除 `/v1/health` 外都要带请求头
`x-relay-token: <RELAY_SECRET>`，不匹配返回 401。

错误响应统一是 `{"error": "中文说明"}`：400 参数不合法 / 401 密钥不对 / 403 GitHub 拒绝
（令牌权限或限流）/ 404 仓库、分支或文件不存在 / 413 超过 1MB / 502 连不上 GitHub或上游异常。

## 方案一：Cloudflare Worker（免费额度够用）

1. 打开 Cloudflare 控制台 → Workers & Pages → Create → Worker，名字随意（例如 `novai-github-relay`）。
2. 把 `relay/cloudflare-worker.js` 的全部内容粘贴进在线编辑器，Deploy。
3. 进入该 Worker 的 Settings → Variables and Secrets，添加：
   - `GITHUB_TOKEN`：GitHub 令牌（建议 fine-grained PAT，只勾 public repo 的读权限），类型选 **Secret**；
   - `RELAY_SECRET`（强烈建议）：自己随便生成一串，类型也选 **Secret**。
4. 记下 Worker 的地址，形如 `https://novai-github-relay.xxx.workers.dev`。
5. 验证（把地址换成你的）：

       curl https://novai-github-relay.xxx.workers.dev/v1/health
       # {"ok":true}
       curl -H "x-relay-token: 你的RELAY_SECRET" \
            "https://novai-github-relay.xxx.workers.dev/v1/raw?owner=anthropics&repo=skills&ref=main&path=skills/pdf/SKILL.md" \
            | head -5

## 方案二：VPS / 本地 Python（标准库，零依赖）

代码：`relay/python_relay.py`（Python 3.9+，只用标准库；装了 certifi 会自动用它）

    # 本机自测（不带 GITHUB_TOKEN 也能跑，走 GitHub 未认证 60 次/小时配额）
    python3 relay/python_relay.py --host 127.0.0.1 --port 4180

    # 生产（一定要带令牌 + 密钥）
    GITHUB_TOKEN=ghp_xxx RELAY_SECRET=your-secret \
      python3 relay/python_relay.py --host 0.0.0.0 --port 4180

端口默认 4180，可用 `--host/--port` 或环境变量 `RELAY_HOST/RELAY_PORT` 改。
公网部署请用 Nginx / Caddy 反代成 **https**（客户端只接受 https 地址，本地自测才允许
`http://127.0.0.1` / `http://localhost`）：

    # Caddy 示例（自动申请证书）
    relay.example.com {
        reverse_proxy 127.0.0.1:4180
    }

    # systemd 示例
    [Unit]
    Description=NOVAI GitHub relay
    After=network.target
    [Service]
    Environment=GITHUB_TOKEN=ghp_xxx
    Environment=RELAY_SECRET=your-secret
    ExecStart=/usr/bin/python3 /opt/novai/relay/python_relay.py --host 127.0.0.1 --port 4180
    Restart=always
    [Install]
    WantedBy=multi-user.target

## 客户端怎么配

- 界面：设置 → 技能 → GitHub 令牌 / 中转，填中转地址（必须 https，本地可填
  `http://127.0.0.1:4180`）和可选密钥，保存即生效（不用重启）。
- 对应接口：`GET|PUT|DELETE /api/skills/github-relay`，PUT body `{"url": "...", "secret": "..."}`；
  响应只有 `{configured, url, masked_secret}`，**永远不回明文密钥**。
- 也可用环境变量（优先级高于界面）：`NOVAI_GITHUB_RELAY`、`NOVAI_GITHUB_RELAY_TOKEN`。
- 配了中转以后，客户端**完全不读本地 GitHub 令牌，也不再直连 GitHub**：
  默认分支查 `/v1/default-branch`、找 SKILL.md 查 `/v1/list`、取正文走 `/v1/raw`。
  想改回直连，删掉中转地址即可（直连行为与原来完全一致）。

## 安全注意

1. **令牌只在服务端**：Worker/VPS 的环境变量里，客户端和浏览器里都没有；
   `config.json` 里只存中转地址和（可选）密钥，且该文件已在 `.gitignore` 里。
2. **建议开 RELAY_SECRET**：否则任何能访问到中转地址的人都能用你的令牌额度。
   密钥丢了就换一个（改环境变量），客户端重填即可。
3. **不要当开放代理**：本服务的 owner/repo/ref/path 有严格正则校验，上游固定为
   GitHub 的两个域名，只读、10s 超时、1MB 上限——请不要改宽这些限制。
4. `/v1/health` 不校验密钥，只回 `{"ok":true}`，不要往这个接口里塞任何信息。
5. 令牌最小权限：fine-grained PAT 只勾 public 仓库读权限即可；泄露了立刻吊销重发。
6. 本地自测允许 `http://127.0.0.1`、`http://localhost`，公网地址必须是 https。

## 故障排查

| 现象 | 原因 |
| --- | --- |
| 客户端提示「中转服务连不上：<地址>（请检查中转是否在线）」 | 地址写错、中转没启动、被墙/证书拦截 |
| `401 unauthorized` | 客户端密钥与 `RELAY_SECRET` 不一致（或没带 `x-relay-token`） |
| `403 GitHub 拒绝访问` | 令牌权限不足，或 GitHub 限流（换令牌 / 等一会） |
| `404 仓库不存在或名字不对` | 仓库地址写错；私有仓库需要中转侧令牌有权限 |
| `413` | SKILL.md 或目录树超过 1MB |
| `502 无法连接 GitHub` | 中转机器访问不了 GitHub（网络/代理问题） |
