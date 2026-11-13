from __future__ import annotations

"""语义层：角色的统一词汇表、中文命名、层级顺序。

拆分结果要「像人排的版」，关键不是切得多细，而是每层知道自己是
背景 / 场景 / 道具 / 主体 / 标识 / 文字，并且按这个顺序叠。
模型（vision）和离线启发式（heuristic）都从这里取角色和名字，
避免两边各写一套、命名五花八门。
"""

ROLE_BACKGROUND = "background"
ROLE_SCENE = "scene"
ROLE_DECORATION = "decoration"
ROLE_PROP = "prop"
ROLE_SUBJECT = "subject"
ROLE_LOGO = "logo"
ROLE_TEXT = "text"

ROLES = (
    ROLE_BACKGROUND,
    ROLE_SCENE,
    ROLE_DECORATION,
    ROLE_PROP,
    ROLE_SUBJECT,
    ROLE_LOGO,
    ROLE_TEXT,
)

# z 越大越靠上：背景永远垫底，文字/标识永远最上
ROLE_Z = {
    ROLE_BACKGROUND: 0,
    ROLE_SCENE: 10,
    ROLE_DECORATION: 20,
    ROLE_PROP: 40,
    ROLE_SUBJECT: 100,
    ROLE_LOGO: 200,
    ROLE_TEXT: 300,
}

ROLE_LABELS = {
    ROLE_BACKGROUND: "背景",
    ROLE_SCENE: "场景",
    ROLE_DECORATION: "装饰",
    ROLE_PROP: "道具",
    ROLE_SUBJECT: "主体",
    ROLE_LOGO: "标识",
    ROLE_TEXT: "文字",
}

# 前端图层面板的短标签（角色比「图片/文本」有用得多）
ROLE_BADGES = dict(ROLE_LABELS)

_ALIASES = {
    "background": ROLE_BACKGROUND,
    "backdrop": ROLE_BACKGROUND,
    "bg": ROLE_BACKGROUND,
    "背景": ROLE_BACKGROUND,
    "底色": ROLE_BACKGROUND,
    "底图": ROLE_BACKGROUND,
    "backplate": ROLE_BACKGROUND,

    "scene": ROLE_SCENE,
    "environment": ROLE_SCENE,
    "场景": ROLE_SCENE,
    "环境": ROLE_SCENE,
    "地面": ROLE_SCENE,
    "天空": ROLE_SCENE,

    "block": ROLE_DECORATION,
    "card": ROLE_DECORATION,
    "shape": ROLE_DECORATION,
    "panel": ROLE_DECORATION,
    "色块": ROLE_DECORATION,
    "卡片": ROLE_DECORATION,
    "装饰": ROLE_DECORATION,
    "底纹": ROLE_DECORATION,

    "prop": ROLE_PROP,
    "item": ROLE_PROP,
    "element": ROLE_PROP,
    "道具": ROLE_PROP,
    "元素": ROLE_PROP,
    "装饰物": ROLE_PROP,
    "配件": ROLE_PROP,

    "subject": ROLE_SUBJECT,
    "model": ROLE_SUBJECT,
    "person": ROLE_SUBJECT,
    "people": ROLE_SUBJECT,
    "product": ROLE_SUBJECT,
    "character": ROLE_SUBJECT,
    "foreground": ROLE_SUBJECT,
    "主体": ROLE_SUBJECT,
    "人物": ROLE_SUBJECT,
    "模特": ROLE_SUBJECT,
    "商品": ROLE_SUBJECT,
    "产品": ROLE_SUBJECT,
    "前景": ROLE_SUBJECT,

    "logo": ROLE_LOGO,
    "brand": ROLE_LOGO,
    "mark": ROLE_LOGO,
    "标识": ROLE_LOGO,
    "徽标": ROLE_LOGO,
    "商标": ROLE_LOGO,
    "标志": ROLE_LOGO,

    "text": ROLE_TEXT,
    "title": ROLE_TEXT,
    "heading": ROLE_TEXT,
    "copy": ROLE_TEXT,
    "文字": ROLE_TEXT,
    "文本": ROLE_TEXT,
    "标题": ROLE_TEXT,
    "正文": ROLE_TEXT,
}

# 模型爱用英文 snake_case 命名；翻成中文，翻不出来就按角色命名
_NAME_WORDS = (
    ("robot_hand", "机械手"),
    ("robot", "机械主体"),
    ("title", "标题"),
    ("heading", "标题"),
    ("header", "页眉"),
    ("footer", "页脚"),
    ("subtitle", "副标题"),
    ("caption", "说明文字"),
    ("price", "价格"),
    ("button", "按钮"),
    ("badge", "徽章"),
    ("icon", "图标"),
    ("logo", "标识"),
    ("chart", "图表"),
    ("table", "表格"),
    ("card", "卡片"),
    ("panel", "面板"),
    ("divider", "分隔"),
    ("decoration", "装饰"),
    ("highlight", "高亮块"),
    ("background", "背景"),
    ("model", "模特"),
    ("person", "人物"),
    ("product", "商品"),
    ("bottle", "瓶身"),
    ("shadow", "投影"),
    ("main", "主视觉"),
)

_MAX_NAME = 12


def has_cjk(value: str) -> bool:
    return any("\u3400" <= ch <= "\u9fff" for ch in value)


def _norm(raw) -> str:
    return str(raw or "").strip().lower().replace("-", "_").replace(" ", "_")


_NAME_HINTS = (
    (("模特", "人物", "主体", "商品", "产品", "机械", "model", "person", "product", "robot"), ROLE_SUBJECT),
    (("logo", "标识", "徽标", "商标", "标志", "brand"), ROLE_LOGO),
    (("背景", "background", "backdrop", "底图"), ROLE_BACKGROUND),
)


def canonical_role(raw, kind: str = "image", index: int = 0, name: str | None = None) -> str:
    """把模型/启发式给的 role 收敛到 7 个固定角色；认不出时按类型/名字兜底。"""
    if str(kind or "").lower() == "text":
        return ROLE_TEXT
    value = _norm(raw)
    if value in _ALIASES:
        return _ALIASES[value]
    # 模型常写 "background layer" / "subject_person"
    for key, role in _ALIASES.items():
        if key and key in value:
            return role
    if value == "object":
        return ROLE_SUBJECT
    if value == "block":
        return ROLE_DECORATION
    lowered = str(name or "").lower()
    if lowered:
        for words, role in _NAME_HINTS:
            if any(word in lowered for word in words):
                return role
    return ROLE_BACKGROUND if index == 0 else ROLE_DECORATION


def z_for(role: str) -> int:
    return ROLE_Z.get(role, ROLE_DECORATION)


def is_object_role(role: str) -> bool:
    """需要抠成透明 PNG 的层：主体 / 道具 / 标识 / 场景里的实体。"""
    return role in {ROLE_SUBJECT, ROLE_PROP, ROLE_LOGO, ROLE_SCENE}


def _translate(name: str) -> str | None:
    key = _norm(name)
    if not key:
        return None
    if key in _ALIASES:
        return ROLE_LABELS[_ALIASES[key]]
    for word, label in _NAME_WORDS:
        if word in key:
            return label
    return None


def clean_name(raw, role: str, text: str | None = None, index: int = 1) -> str:
    """给图层起一个用户能读的名字：中文优先、长度受控、不重复角色标签。"""
    label = ROLE_LABELS.get(role, "图层")
    if role == ROLE_TEXT:
        snippet = " ".join(str(text or "").split())
        return (snippet or label)[:_MAX_NAME]

    raw_name = str(raw or "").strip()
    translated = None
    if raw_name and not raw_name.isdigit():
        if has_cjk(raw_name):
            translated = raw_name[:_MAX_NAME]
        else:
            translated = _translate(raw_name)
    if not translated:
        return label if index == 1 else "%s %d" % (label, index)
    if translated == label or translated.startswith(label):
        return translated[:_MAX_NAME]
    combined = "%s：%s" % (label, translated)
    return combined[:_MAX_NAME] if len(combined) <= _MAX_NAME else translated[:_MAX_NAME]


def ensure_unique(drafts) -> None:
    """同名图层加序号，否则面板上两行「主体」分不清谁是谁。"""
    seen: dict[str, int] = {}
    for draft in drafts:
        name = str(getattr(draft, "name", "") or "图层")
        if name in seen:
            seen[name] += 1
            draft.name = "%s %d" % (name, seen[name])
        else:
            seen[name] = 1
