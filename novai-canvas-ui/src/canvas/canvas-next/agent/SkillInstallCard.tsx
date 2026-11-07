import { Icon } from "../ui/Icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/hexta/alert";
import { Badge } from "@/components/hexta/badge";
import { Button } from "@/components/hexta/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/hexta/card";
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/hexta/item";
import { Progress } from "@/components/hexta/progress";
import { Spinner } from "@/components/hexta/spinner";
import type { SkillInstallMessage } from "./skillInstallIntent";

const STATUS_TEXT = {
  inspecting: "正在读取",
  ready: "待确认",
  installing: "正在导入",
  installed: "已导入 · 未启用",
  error: "未完成",
  cancelled: "已取消",
} as const;

const STATUS_TONE = {
  inspecting: "info",
  ready: "default",
  installing: "info",
  installed: "success",
  error: "destructive",
  cancelled: "default",
} as const;

export function SkillInstallCard({ value, onConfirm, onCancel, onManage }: {
  value: SkillInstallMessage;
  onConfirm: () => void;
  onCancel: () => void;
  onManage: () => void;
}) {
  const preview = value.preview;
  const busy = value.status === "inspecting" || value.status === "installing";
  return <Card aria-label="GitHub Skill 安装" className="message-card skill-card" data-skill-install={value.status} size="sm">
    <CardHeader className="mc-head">
      <div className="mc-head-row">
        <span className="mc-glyph">{busy ? <Spinner aria-hidden size="sm" /> : <Icon name={value.status === "installed" ? "check" : "sparkle"} size="s" />}</span>
        <CardTitle className="mc-title">GitHub Skill 安装</CardTitle>
        <Badge className="mc-badge" size="sm" variant={STATUS_TONE[value.status]}>{STATUS_TEXT[value.status]}</Badge>
      </div>
      {busy ? <Progress aria-label="安装进度" className="mc-progress" size="sm" value={null} /> : null}
    </CardHeader>
    <CardContent className="mc-body">
      {preview ? <>
        <div className="skill-meta">
          <div><span>仓库</span><b>{preview.repository}</b></div>
          <div><span>固定版本</span><b title={preview.commit}>{preview.branch} · {preview.commit.slice(0, 12)}</b></div>
          <div><span>内容校验</span><b title={preview.sha256}>SHA-256 · {preview.sha256.slice(0, 16)}…</b></div>
        </div>
        <div className="skill-docs" data-skill-install-docs>
          {preview.skills.map((skill) => <Item className="skill-doc" key={skill.path} size="xs">
            <ItemMedia className="skill-doc-glyph" variant="icon"><Icon name="layers" size="xs" /></ItemMedia>
            <ItemContent>
              <ItemTitle>{skill.name || skill.path}</ItemTitle>
              <ItemDescription>{skill.description || skill.path}</ItemDescription>
              <code className="skill-doc-path">{skill.path}</code>
            </ItemContent>
          </Item>)}
        </div>
        {preview.scripts.length ? <details className="skill-scripts"><summary>发现 {preview.scripts.length} 个脚本或打包配置文件</summary><ul>{preview.scripts.map((name) => <li key={name}><code>{name}</code></li>)}</ul></details> : null}
        <p className="mc-note">不会执行仓库脚本或安装命令。确认后仅导入上述 Skill，且默认不启用。</p>
      </> : <p className="mc-note">{value.status === "inspecting" ? "正在读取公开仓库、固定 commit 并检查 Skill 内容，尚未安装。" : value.source}</p>}
      {value.error ? <Alert appearance="soft" className="skill-error" role="alert" variant="destructive">
        <AlertTitle>导入未完成</AlertTitle>
        <AlertDescription>{value.error}</AlertDescription>
      </Alert> : null}
    </CardContent>
    <CardFooter className="mc-foot">
      {value.status === "installed" ? <p className="mc-note">已导入 {value.skillCount || 0} 个 Skill。为安全起见，需在 Skill 管理中手动启用后才能在 Agent 使用。</p> : null}
      <div className="mc-actions">
        {value.status === "ready" || value.status === "installing" || (value.status === "error" && preview) ? <Button className="mc-btn-solid" data-skill-install-confirm disabled={busy} onClick={onConfirm} size="sm" variant="default">{value.status === "installing" ? "正在导入…" : value.status === "error" ? "重试导入" : "确认导入"}</Button> : null}
        {value.status !== "installed" && value.status !== "cancelled" ? <Button className="mc-btn-ghost" data-skill-install-cancel disabled={busy} onClick={onCancel} size="sm" variant="ghost">取消</Button> : null}
        {value.status === "installed" ? <Button className="mc-btn-ghost" data-skill-install-manage onClick={onManage} size="sm" variant="secondary">管理 Skill</Button> : null}
      </div>
    </CardFooter>
  </Card>;
}
