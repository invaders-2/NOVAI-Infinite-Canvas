import { Icon } from "../ui/Icon";
import type { SkillInstallMessage } from "./skillInstallIntent";

const STATUS_TEXT = {
  inspecting: "正在读取",
  ready: "待确认",
  installing: "正在导入",
  installed: "已导入 · 未启用",
  error: "未完成",
  cancelled: "已取消",
} as const;

export function SkillInstallCard({ value, onConfirm, onCancel, onManage }: {
  value: SkillInstallMessage;
  onConfirm: () => void;
  onCancel: () => void;
  onManage: () => void;
}) {
  const preview = value.preview;
  const busy = value.status === "inspecting" || value.status === "installing";
  return <section className="confirm skill-install" data-skill-install={value.status} aria-label="GitHub Skill 安装">
    <div className="ch"><Icon name="sparkle" size="s" /><b>GitHub Skill 安装</b><span className="sp" /><span className="tag">{STATUS_TEXT[value.status]}</span></div>
    {preview ? <>
      <div className="cgrid">
        <span>仓库</span><b>{preview.repository}</b>
        <span>固定版本</span><b title={preview.commit}>{preview.branch} · {preview.commit.slice(0, 12)}</b>
        <span>内容校验</span><b title={preview.sha256}>SHA-256 · {preview.sha256.slice(0, 16)}…</b>
      </div>
      <div className="skill-install-docs" data-skill-install-docs>
        {preview.skills.map((skill) => <div key={skill.path}><b>{skill.name || skill.path}</b><small>{skill.description || skill.path}</small><code>{skill.path}</code></div>)}
      </div>
      {preview.scripts.length ? <details className="skill-install-scripts"><summary>发现 {preview.scripts.length} 个脚本或打包配置文件</summary><ul>{preview.scripts.map((name) => <li key={name}><code>{name}</code></li>)}</ul></details> : null}
      <p className="skill-install-note">不会执行仓库脚本或安装命令。确认后仅导入上述 Skill，且默认不启用。</p>
    </> : <p className="skill-install-note">{value.status === "inspecting" ? "正在读取公开仓库、固定 commit 并检查 Skill 内容，尚未安装。" : value.source}</p>}
    {value.error ? <p className="skill-install-error" role="alert">{value.error}</p> : null}
    <div className="acts">
      {value.status === "ready" || value.status === "installing" || (value.status === "error" && preview) ? <button className="btn solid" data-skill-install-confirm disabled={busy} onClick={onConfirm}>{value.status === "installing" ? "正在导入…" : value.status === "error" ? "重试导入" : "确认导入"}</button> : null}
      {value.status !== "installed" && value.status !== "cancelled" ? <button className="btn" data-skill-install-cancel disabled={busy} onClick={onCancel}>取消</button> : null}
      {value.status === "installed" ? <button className="btn" data-skill-install-manage onClick={onManage}>管理 Skill</button> : null}
    </div>
    {value.status === "installed" ? <p className="skill-install-note">已导入 {value.skillCount || 0} 个 Skill。为安全起见，需在 Skill 管理中手动启用后才能在 Agent 使用。</p> : null}
  </section>;
}
