#!/usr/bin/env python3
"""
shoot_plan.py — 胶片暗房放大风格服装大片拍摄计划工作台

输入：模特白底服装 look 图（单人或双人，服装已穿在模特身上）+ 空镜画面（无人场景）。
输出：批量合成计划——用户指定数量 N 张，每张人物动作不同、景别不同，
     风格统一为胶片暗房放大（Film Darkroom Enlargement）风格。

三种模式：
  plan : look 图（必须）+ 空镜（图或文字）→ 输出「身份锁 + N 镜头编排提示词集」JSON，
         供 generate_image.py 逐镜头出图。这是主流程。
  lock : 批量分析用户提供的风格参考图，提炼「风格档案」JSON 存入 profiles/。
         （用户提供胶片暗房放大风格参考素材后使用；在此之前用内置预设 placeholder）
  identity : 只提取身份锁清单，不出镜头组（用户只想核对特征时用，罕见）

配置来源（优先级从高到低）：
  1. 环境变量：FE_LLM_BASE_URL / FE_LLM_API_KEY / FE_LLM_MODEL / FE_LLM_VISION_MODEL
  2. skill 根目录 config.json 的 prompt_llm 字段
均未配置时报错并给出指引。模型调用走 OpenAI 兼容 /chat/completions，仅依赖标准库。

用法示例：
  # 主流程：白底 look 图 + 空镜 → 8 张动作/景别各异的大片计划
  python3 shoot_plan.py --mode plan \
      --look look_front.png --look look_back.png \
      --scene-image empty_scene.jpg \
      --count 8 --out ./outputs/shotplan.json

  # 双人 look 图 + 多张空镜
  python3 shoot_plan.py --mode plan \
      --look duo_look.png \
      --scene-image scene_a.jpg --scene-image scene_b.jpg \
      --count 12 --out ./outputs/shotplan.json

  # 空镜只有文字描述
  python3 shoot_plan.py --mode plan --look look.png \
      --scene "傍晚的老式暗房外的天台，晾着印相纸" \
      --count 6 --out ./outputs/shotplan.json

  # 锁定风格档案（用户提供胶片放大风格参考图之后）
  python3 shoot_plan.py --mode lock --image ref1.png --image ref2.png --image ref3.png \
      --profile-name 胶片暗房放大 --out profiles/film-darkroom.json
"""

import argparse
import base64
import json
import mimetypes
import os
import re
import sys
import urllib.error
import urllib.request

SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(SKILL_ROOT, "config.json")
STYLES_PATH = os.path.join(SKILL_ROOT, "references", "styles.md")
PROFILES_DIR = os.path.join(SKILL_ROOT, "profiles")

# 默认风格：胶片暗房放大（用户提供参考素材锁定档案前的内置预设）
DEFAULT_STYLE_ID = "film-darkroom"

# ---------------------------------------------------------------- 镜头编排词表
# 不再是固定镜头组——数量由用户指定（--count），每张的动作与景别由模型从下面
# 维度池中编排组合，硬性要求：同一计划内任意两镜的动作不同、景别不同。
FRAMING_POOL = [
    ("extreme-close-up", "特写", "extreme close-up, one key detail filling the frame"),
    ("close-up", "近景", "close-up shot, head and shoulders"),
    ("medium-shot", "中景", "medium shot, waist-up framing"),
    ("full-shot", "全景", "full shot, entire figure head to toe with breathing room"),
    ("wide-shot", "远景/大场景", "wide shot, small figure within the environment"),
    ("cowboy-shot", "牛仔景别", "cowboy shot, mid-thigh-up framing"),
]
ANGLE_POOL = [
    ("front", "正面机位", "frontal camera angle"),
    ("three-quarter", "45度机位", "three-quarter camera angle"),
    ("profile", "侧面机位", "side profile camera angle"),
    ("back", "背面机位", "camera behind the subject"),
    ("over-shoulder", "过肩", "over-the-shoulder framing toward the scene"),
    ("low-angle", "仰拍", "low camera angle looking up"),
    ("high-angle", "俯拍", "high camera angle looking down"),
]
ACTION_POOL = [
    ("standing-still", "静立", "standing still, weight settled, quiet composure"),
    ("walking", "行走", "mid-stride walking, natural gait, fabric in motion"),
    ("turning", "转身", "turning the body, momentum caught mid-rotation"),
    ("glancing-back", "回眸", "glancing back over the shoulder toward camera"),
    ("seated", "坐姿", "seated within the scene, relaxed posture"),
    ("leaning", "倚靠", "leaning against a surface in the scene"),
    ("hands-in-motion", "手部动作", "hands adjusting a garment detail, caught mid-gesture"),
    ("crouching", "蹲姿", "crouching low, compact posture"),
    ("interacting", "与环境互动", "interacting with an element of the scene"),
    ("duo-interaction", "双人互动", "the two models interacting with each other"),
]

# ---------------------------------------------------------------- 配置加载


def load_llm_config():
    """LLM 配置：环境变量 > config.json。返回 dict 或报错退出。"""
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = (json.load(f) or {}).get("prompt_llm") or {}
        except Exception as e:
            sys.stderr.write("[CONFIG] config.json 解析失败：%s\n" % e)
            sys.exit(2)
    merged = {
        "base_url": os.environ.get("FE_LLM_BASE_URL") or cfg.get("base_url"),
        "api_key": os.environ.get("FE_LLM_API_KEY") or cfg.get("api_key"),
        "model": os.environ.get("FE_LLM_MODEL") or cfg.get("model"),
        "vision_model": os.environ.get("FE_LLM_VISION_MODEL") or cfg.get("vision_model"),
        "timeout": cfg.get("timeout", 180),
    }
    if not merged["base_url"] or not merged["api_key"] or not merged["model"]:
        sys.stderr.write(
            "[CONFIG] prompt_llm 未配置。两种方式任选：\n"
            "  1. 复制 config.example.json 为 config.json 并填写 prompt_llm（base_url/api_key/model/vision_model）\n"
            "  2. 设置环境变量 FE_LLM_BASE_URL / FE_LLM_API_KEY / FE_LLM_MODEL / FE_LLM_VISION_MODEL\n"
            "申请指引见 references/api-guide.md\n"
        )
        sys.exit(2)
    return merged


def image_to_data_url(path):
    mime, _ = mimetypes.guess_type(path)
    if not mime or not mime.startswith("image/"):
        mime = "image/png"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return "data:%s;base64,%s" % (mime, b64)


def call_llm(config, system_prompt, user_content, is_vision=False):
    model = (config.get("vision_model") if is_vision else None) or config.get("model")
    url = config["base_url"].rstrip("/") + "/chat/completions"
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ],
        "temperature": 0.4,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + config["api_key"],
    }
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=config.get("timeout", 180)) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:800]
        sys.stderr.write("[HTTP %s] %s\n" % (e.code, detail))
        sys.exit(1)
    except Exception as e:
        sys.stderr.write("[ERROR] 调用提示词模型失败: %s\n" % e)
        sys.exit(1)
    try:
        return body["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        sys.stderr.write("[ERROR] 无法解析模型响应: %s\n" % json.dumps(body, ensure_ascii=False)[:800])
        sys.exit(1)


def extract_json(text):
    """容错提取 JSON（剥离 markdown 代码块 / 前后缀文本 / 提取数组）。"""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if m:
            try:
                return json.loads(m.group(0))
            except json.JSONDecodeError:
                pass
        m = re.search(r"\[.*\]", text, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise


# ---------------------------------------------------------------- 风格注入


def auto_pick_profile():
    """profiles/ 下只有一份档案时自动加载；多份时不替用户选。"""
    if not os.path.isdir(PROFILES_DIR):
        return None
    candidates = sorted(
        os.path.join(PROFILES_DIR, n)
        for n in os.listdir(PROFILES_DIR)
        if n.endswith(".json") and not n.startswith(".")
    )
    if len(candidates) == 1:
        return candidates[0]
    return None


def load_preset_style(style_id):
    """从 references/styles.md 解析 '## 名称 (style-id)' 段落。"""
    if not style_id or not os.path.exists(STYLES_PATH):
        return ""
    with open(STYLES_PATH, "r", encoding="utf-8") as f:
        content = f.read()
    m = re.search(
        r"^## .+\(" + re.escape(style_id) + r"\)\s*\n(.*?)(?=^## |\Z)",
        content,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        sys.stderr.write("[STYLE] 未找到预设风格 '%s'（可用风格见 references/styles.md），将不注入风格。\n" % style_id)
        return ""
    return m.group(1).strip()


def load_style_file(path):
    """加载风格档案 JSON，格式化为注入文本块，并返回档案对象。"""
    with open(path, "r", encoding="utf-8") as f:
        profile = json.load(f)
    lines = ["【风格档案（最高优先级，风格层面必须严格遵循）】"]
    key_map = [
        ("style_name", "风格名称"),
        ("zh_summary", "风格总述"),
        ("style_keywords", "风格关键词（必须融入每个镜头的 en_prompt）"),
        ("single_line", "【氛围行】原样追加到每个 en_prompt 末尾"),
        ("color_palette", "色彩调性"),
        ("lighting", "光线"),
        ("composition", "构图结构"),
        ("texture_material", "质感材质"),
        ("negative_prompt", "负面提示（必须并入 negative_prompt）"),
        ("consistency_notes", "一致性要点"),
    ]
    for key, label in key_map:
        if profile.get(key):
            val = profile[key]
            if isinstance(val, list):
                val = ", ".join(str(v) for v in val)
            lines.append("- %s: %s" % (label, val))
    return "\n".join(lines), profile


def resolve_style(args):
    """解析风格来源。返回 (style_text, style_desc_for_output)。
    优先级：--style-file > profiles/ 唯一档案 > --style > 默认胶片暗房放大预设。"""
    if args.style_file:
        if not os.path.exists(args.style_file):
            sys.stderr.write("[STYLE-FILE] 风格档案不存在: %s\n" % args.style_file)
            sys.exit(2)
        text, _ = load_style_file(args.style_file)
        return text, "profile:" + os.path.basename(args.style_file)
    auto = auto_pick_profile()
    if auto:
        sys.stderr.write("[AUTO] 未指定风格，自动加载 profiles/ 下唯一档案：%s\n" % auto)
        text, _ = load_style_file(auto)
        return text, "profile:" + os.path.basename(auto)
    style_id = args.style or DEFAULT_STYLE_ID
    text = load_preset_style(style_id)
    if text:
        return "【指定风格模板】\n" + text, "preset:" + style_id
    return "", "none"


# ---------------------------------------------------------------- 系统提示词

IDENTITY_SYSTEM_PROMPT = """你是顶级的商业时尚大片视觉分析师。用户会提供：模特白底服装 look 图（单人或双人，服装已穿在身上）+ 空镜画面（无人场景图）+（可能的）场景文字补充。请提取身份锁清单——特征精确到可核查的程度，这是后续批量出图保持一致性的核心。

提取要求：
- 人物与服装（从白底 look 图提取，人物和服装合为一体分析）：
  * 单人：模特的年龄段、肤色与肤质、发型发色（长度/卷直/分缝）、脸型与五官特征、体态身形、可见身体特征（痣/纹身/配饰）；身上服装的品类版型、面料材质与垂坠感、颜色（具体色名）、图案/印花、结构细节（领型/袖型/口袋/扣件/腰带/缝线，位置与数量）、比例长度。
  * 双人：分别提取两位模特的外貌身份（称呼为"模特A（左/画面前方）""模特B（右/画面后方）"等可稳定指代的方式）与各自所穿服装；两人身高差与相对位置关系也要记录。
  * 身份锁定后不得换脸美化、不得改变种族或年龄、不得增删服装设计元素或改变部件数量位置。
- 场景（从空镜画面提取）：空间类型、地面/墙面/环境物件及其材质、色温与光线条件（光的方向与质感）、空间纵深与构图锚点（模特可站立/倚靠/互动的位置）。空镜里若有人物出现则忽略，只取环境。
  * 若用户另有场景文字描述：与空镜互补则合并；冲突则以文字为准并注明。

【硬规则 - 文字剥离】参考图中的文字、Logo、水印、品牌字、标签、吊牌文字一律不写入清单。白底视为拍摄棚底，不是场景。

输出严格的 JSON（不要 markdown 代码块）：
{
  "person_garment_identity": "中文：人物与服装身份锁。单人直接写；双人分别写「模特A」与「模特B」两段",
  "person_count": 1 或 2,
  "scene_identity": "中文：场景身份锁（来自空镜）",
  "scene_source": "scene-image | text-only | not-specified"
}"""

PLAN_SYSTEM_PROMPT = """你是顶级的胶片暗房放大风格时尚大片摄影导演兼提示词工程师。任务：把白底 look 图中的人物（连人带服装，单人或双人）合成到空镜场景中，批量生成 N 张大片。基于已提取的身份锁和风格档案，为每一张写一条可直接生成的英文提示词。

【硬规则 1 - 一致性块（最高优先级）】
每条 en_prompt 必须以同一段「一致性块」开头（英文）：完整人物与服装身份（外貌+服装逐条可核查；双人则两人各自描述+相对站位）+ 场景身份（空镜的地点/材质/光线）。整组保持一致，仅随镜头调整措辞。合成指令要明确：将 look 图中的人物原样置入该空镜场景（如 "the model from the lookbook reference, wearing the exact same garment, placed within this scene"），禁止写 "same outfit as before" 等元语言。

【硬规则 2 - 每张动作不同、景别不同（本任务核心差异点）】
N 条提示词中任意两条的【景别/机位】和【人物动作】均不得重复：从景别池（特写/近景/中景/全景/远景/牛仔景别）、机位池（正面/45度/侧面/背面/过肩/仰拍/俯拍）、动作池（静立/行走/转身/回眸/坐姿/倚靠/手部动作/蹲姿/环境互动/双人互动）中编排组合，并具体化——动作写到肢体与重心（如 "weight on the back leg, front foot lifted mid-stride"），景别写到画框裁切位置。双人时至少安排 2-3 张两人互动镜头，其余可一人为主一人景深虚化。禁止只写 standing / walking 这类词。

【硬规则 3 - 风格（胶片暗房放大）】
所有风格关键词、颗粒、影调、边缘暗角、纸质质感必须严格取自风格档案/模板；档案含 single_line 字段时原样追加到每条 en_prompt 末尾。不得引入档案外的数码感画风。

【硬规则 4 - 负面提示】
negative_prompt 为整组共用一段（英文），必须包含：text, typography, letters, watermark, brand name, wordmark, logo, captions, type overlay, altered garment design, changed product details, missing garment elements, added garment elements, face distortion, inconsistent face, different person, airbrushed plastic skin, extra fingers, deformed hands, duplicate limbs, clean digital rendering, HDR look, studio white background（白底必须被替换为空镜场景）。若风格档案另有 negative_prompt 一并并入。

【硬规则 5 - 文字剥离】任何提示词中不得出现品牌名/文字排版元素。

输出严格的 JSON（不要 markdown 代码块）：
{
  "consistency_block": "英文：整组共用的一致性块（人物+服装+场景身份的完整自含描述，含合成置入指令）",
  "negative_prompt": "英文：整组共用的负面提示",
  "shots": [
    {
      "shot_id": "shot_01 起的递增编号",
      "zh_title": "中文镜头名（景别+动作）",
      "framing": "本条用的景别（中文）",
      "action": "本条用的动作（中文）",
      "en_prompt": "英文完整提示词（一致性块+镜头编排，自含）",
      "size": "建议尺寸：全身/远景用 832x1472 或 1472x832（按空镜横竖），中近景特写用 1024x1024 或 1024x1536",
      "notes": "中文：本张的编排意图一句话"
    }
  ]
}
shots 数组长度必须精确等于用户指定的 N。"""

LOCK_SYSTEM_PROMPT = """你是顶级的视觉风格分析师。用户会提供一批同风格的参考图（胶片暗房放大风格等），请分析共性，提炼可复用的「风格档案」，用于让图像生成模型持续产出同风格图片。

分析维度：艺术风格与流派、画面结构（构图规律、人物比例与位置、留白）、色彩调性（主色、饱和度、冷暖、对比、纸张色）、光线特征（光质/方向/色温）、质感与材质（银盐颗粒/暗房放大痕迹/暗角/相纸质感/显影不均匀）、整体氛围调性。提炼的是这批图的【共性】而非某张图的个性；人物长相、具体服装款式等内容主体不进档案。

输出严格的 JSON（不要 markdown 代码块）：
{
  "style_name": "给这个风格起一个简短中文名",
  "zh_summary": "风格总述：结构、风格、调性的综合描述（150字内）",
  "style_keywords": ["英文风格关键词数组，20-40个，生成时直接拼入提示词"],
  "single_line": "英文氛围行：唯一允许直接复制粘贴到 prompt 末尾的画质/氛围语汇（30词内）",
  "color_palette": ["主色与辅助色描述数组"],
  "composition": "构图结构规律描述",
  "lighting": "光线特征描述",
  "texture_material": "质感与材质描述（暗房放大特有痕迹务必写全）",
  "negative_prompt": "英文负面提示词：与该风格冲突、必须避免的元素（务必包含数码感相关项）",
  "consistency_notes": "复刻该风格时最容易被忽略的 3-5 个一致性要点"
}"""


# ---------------------------------------------------------------- 模式实现


def mode_lock(args, config):
    if len(args.image) < 2:
        sys.stderr.write("[ERROR] lock 模式至少需要 2 张参考图（--image 可重复传入）\n")
        sys.exit(1)
    content = [{
        "type": "text",
        "text": "以下是 %d 张同风格的参考图。请分析共性并输出风格档案 JSON。" % len(args.image)
        + (("附加说明：" + args.extra) if args.extra else ""),
    }]
    for p in args.image:
        if not os.path.exists(p):
            sys.stderr.write("[ERROR] 参考图不存在: %s\n" % p)
            sys.exit(2)
        content.append({"type": "image_url", "image_url": {"url": image_to_data_url(p)}})
    result_text = call_llm(config, LOCK_SYSTEM_PROMPT, content, is_vision=True)
    try:
        result = extract_json(result_text)
    except Exception:
        sys.stderr.write("[WARN] 模型未返回合法 JSON，返回原始文本。\n")
        result = {"raw": result_text}
    if args.out:
        out_path = args.out
    else:
        os.makedirs(PROFILES_DIR, exist_ok=True)
        name = args.profile_name or (result.get("style_name") or "locked-style")
        out_path = os.path.join(PROFILES_DIR, "%s.json" % sanitize(name))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(result, ensure_ascii=False, indent=2))
    print("[OK] 风格档案已锁定并保存至 " + out_path)
    print(json.dumps(result, ensure_ascii=False, indent=2))


def pools_text():
    lines = ["【景别池】"]
    lines += ["- %s（%s）：%s" % f for f in FRAMING_POOL]
    lines.append("【机位池】")
    lines += ["- %s（%s）：%s" % a for a in ANGLE_POOL]
    lines.append("【动作池】")
    lines += ["- %s（%s）：%s" % a for a in ACTION_POOL]
    return "\n".join(lines)


def mode_plan(args, config):
    if not args.look:
        sys.stderr.write("[ERROR] plan 模式至少需要 1 张白底服装 look 图（--look，可重复传入）\n")
        sys.exit(1)
    if not (args.scene_image or args.scene):
        sys.stderr.write("[ERROR] 需要空镜画面（--scene-image）或场景文字（--scene）至少其一\n")
        sys.exit(1)
    for p in list(args.look) + list(args.scene_image or []):
        if not os.path.exists(p):
            sys.stderr.write("[ERROR] 参考图不存在: %s\n" % p)
            sys.exit(2)

    count = args.count or 6
    if count < 1 or count > 30:
        sys.stderr.write("[ERROR] --count 需在 1-30 之间\n")
        sys.exit(2)

    # ---- 第 1 步：视觉模型提取身份锁 ----
    id_content = [{
        "type": "text",
        "text": "下面提供 %d 张模特白底服装 look 图（单人或双人）、%d 张空镜画面。\n场景文字补充：%s\n请按系统规则输出身份锁清单。"
        % (len(args.look), len(args.scene_image or []), args.scene or "（未提供）"),
    }]
    for i, p in enumerate(args.look):
        id_content.append({"type": "text", "text": "【白底 look 图 %d/%d】（人物+服装身份锁定对象）" % (i + 1, len(args.look))})
        id_content.append({"type": "image_url", "image_url": {"url": image_to_data_url(p)}})
    for i, p in enumerate(args.scene_image or []):
        id_content.append({"type": "text", "text": "【空镜画面 %d/%d】（场景身份锁定对象，图中若有人则忽略人物只取环境）" % (i + 1, len(args.scene_image))})
        id_content.append({"type": "image_url", "image_url": {"url": image_to_data_url(p)}})

    sys.stderr.write("[STEP1] 提取身份锁（人物+服装 / 空镜场景）...\n")
    id_result = extract_json(call_llm(config, IDENTITY_SYSTEM_PROMPT, id_content, is_vision=True))
    if "raw" in id_result:
        sys.stderr.write("[ERROR] 身份锁提取失败，模型返回非 JSON。\n")
        print(json.dumps(id_result, ensure_ascii=False, indent=2))
        sys.exit(1)

    # ---- 第 2 步：编排 N 张动作/景别各异的镜头 ----
    style_text, style_desc = resolve_style(args)
    plan_user = """【身份锁】（一致性块的内容来源，逐条融入）
人物与服装身份锁：{person}
场景身份锁（空镜）：{scene}

【本次合成数量】N = {n}（shots 数组长度必须精确等于 {n}，每张动作不同、景别不同）

{pools}
{style}

请输出整组大片的提示词 JSON。""".format(
        person=id_result.get("person_garment_identity", ""),
        scene=id_result.get("scene_identity", "") or args.scene or "",
        n=count,
        pools=pools_text(),
        style=("\n\n" + style_text) if style_text else "",
    )
    if args.extra:
        plan_user += "\n\n【附加要求】\n" + args.extra

    sys.stderr.write("[STEP2] 编排 %d 张动作/景别各异的镜头提示词...\n" % count)
    plan_result = extract_json(call_llm(config, PLAN_SYSTEM_PROMPT, plan_user, is_vision=False))

    shots = plan_result.get("shots") or []
    if len(shots) != count:
        sys.stderr.write("[WARN] 模型返回 %d 条镜头（要求 %d），以实际返回为准。\n" % (len(shots), count))

    # ---- 组装输出 ----
    output = {
        "identities": {
            "person_garment_identity": id_result.get("person_garment_identity", ""),
            "person_count": id_result.get("person_count", 1),
            "scene_identity": id_result.get("scene_identity", "") or (args.scene or ""),
            "scene_source": id_result.get("scene_source", "scene-image" if args.scene_image else "text-only"),
        },
        "style": style_desc,
        "consistency_block": plan_result.get("consistency_block", ""),
        "negative_prompt": plan_result.get("negative_prompt", ""),
        "reference_images": {
            "look": [os.path.abspath(p) for p in args.look],
            "scene": [os.path.abspath(p) for p in (args.scene_image or [])],
        },
        "shots": shots,
        "recommended_params": {
            "size_default": "832x1472",
            "notes": "一致性关键：生成时必须把 reference_images 中的 look 图与空镜图全部作为参考图输入（需支持多参考图的模型，如火山方舟 Seedream 4.0、即梦、Gemini、GPT-4o）；同一镜头多张时固定 seed 逐张迭代。出图模型按用户要求配置，见 references/api-guide.md。",
        },
    }
    out_path = args.out or os.path.join(os.getcwd(), "outputs", "shotplan.json")
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(json.dumps(output, ensure_ascii=False, indent=2))
    print("[OK] 拍摄计划已保存至 " + out_path)
    print(json.dumps(output, ensure_ascii=False, indent=2))


def sanitize(name):
    name = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", str(name)).strip("_")
    return name[:40] or "locked-style"


def main():
    parser = argparse.ArgumentParser(description="胶片暗房放大风格服装大片拍摄计划工作台")
    parser.add_argument("--mode", default="plan", choices=["plan", "lock", "identity"], help="默认 plan")
    parser.add_argument("--look", action="append", default=[], help="模特白底服装 look 图路径（单人或双人），可重复传入（plan 必须）")
    parser.add_argument("--scene-image", action="append", default=[], help="空镜画面路径（无人场景），可重复传入")
    parser.add_argument("--scene", help="场景文字描述（无空镜图时使用，或作为空镜的补充）")
    parser.add_argument("--count", type=int, default=None, help="合成图片数量（默认 6，上限 30）：每张动作不同、景别不同")
    parser.add_argument("--style", help="预设风格 id，见 references/styles.md（默认 %s）" % DEFAULT_STYLE_ID)
    parser.add_argument("--style-file", help="已锁定的风格档案 JSON 路径（优先级高于 --style）")
    parser.add_argument("--image", action="append", default=[], help="lock 模式：风格参考图，可重复传入（>=2 张）")
    parser.add_argument("--profile-name", help="lock 模式：档案名称")
    parser.add_argument("--extra", help="附加要求")
    parser.add_argument("--out", help="输出 JSON 路径（plan 默认 ./outputs/shotplan.json）")
    args = parser.parse_args()

    config = load_llm_config()
    if args.mode == "lock":
        mode_lock(args, config)
    else:
        mode_plan(args, config)


if __name__ == "__main__":
    main()
