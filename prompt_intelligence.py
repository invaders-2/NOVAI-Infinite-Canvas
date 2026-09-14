# -*- coding: utf-8 -*-
"""
NOVAI Prompt Intelligence Engine (v1)
=====================================
核心职责（附件《NOVAI_LLM_Node_通用多模态Prompt_Intelligence_最终实施方案》）：
1. Universal Intent Understanding（Operation/Target/Property/Scope/Editable/Preserve/Constraint/Reference Role）
2. Targeted Analysis（Reverse OFF 允许的必要定向分析）
3. Full Reverse Analysis（Reverse ON 才允许的 Image/Video DNA）
4. 四层 Lock：Intent > Editable > Preserve > Reference（Prompt Optimizer / Compiler 不得越界）
5. Prompt Optimizer：只优化表达，绝不改变用户任务
6. Prompt Auditor：检测 Prompt Drift，发现即 REJECT 并回退
7. Model Compiler：Nano Banana Pro / Seedance 2.0 / Seedance 2.5 各自独立
8. Capability Registry：真实 Model+Provider+Endpoint 能力校验，不支持不伪装
9. 全链路降级：任何一步失败 → 跳过该步 / 回退原 Prompt，绝不破坏现有 LLM 流程

设计约束：
- 本模块不 import main.py（避免循环依赖）。LLM 调用通过构造函数注入的 llm_call 完成。
- 所有对外方法均有 try/except，外部永远可以安全调用。
"""

import hashlib
import json
import re
import time
from typing import Any, Awaitable, Callable, Optional

MAX_INTELLIGENCE_STEPS = 5

# ---------------------------------------------------------------------------
# Universal Intent Schema（附件 §12）
# ---------------------------------------------------------------------------
INTENT_SCHEMA_EXAMPLE = {
    "operation": "generate|edit|replace|remove|add|modify|transform|transfer|reconstruct|extend|compose|analyze|describe|optimize|reverse",
    "targets": [{"type": "object|person|product|face|clothing|background|scene|region|mask|shot|camera|motion|material|custom", "id": "target_1"}],
    "properties": ["identity|shape|color|material|texture|logo|pose|clothing|background|lighting|composition|camera|motion|style|atmosphere|custom"],
    "scope": "pixel|region|object|subject|scene|shot|video|entire_image|entire_video",
    "editable": ["target_1.material"],
    "preserve": ["scene", "camera", "lighting", "identity"],
    "constraints": ["保持原构图", "只修改该对象"],
    "references": [{"role": "object_reference|character_reference|scene_reference|motion_reference|style_reference|composition_reference|identity_reference", "asset_index": 0}],
    "reference_mode": "none|targeted|reference|reverse",
    "reverse": False,
    "target_type": "image|video|",
    "target_model": ""
}

INTENT_JUDGE_SYSTEM = """你是 NOVAI Prompt Intelligence 的 Intent Judge。
任务：把用户的自然语言创作/编辑需求解析成严格的 Universal Intent JSON。
规则：
1. 只输出一个 JSON 对象，不要任何解释、Markdown 或代码块标记。
2. operation 必须是：generate/edit/replace/remove/add/modify/transform/transfer/reconstruct/extend/compose/analyze/describe/optimize/reverse 之一。
3. editable 只包含用户明确要求改变的内容；用户没有要求改变的，一律进 preserve。
4. 默认 preserve 至少包含：用户说"其他都不要改变"的内容；拿不准时倾向 preserve 而不是 editable。
5. references 描述参考素材的角色（object_reference/character_reference/scene_reference/motion_reference/style_reference/composition_reference/identity_reference），没有参考素材则为空数组。
6. reference_mode：无参考=none；有参考且只是完成任务所需=targeted；用户要求借鉴某维度=reference；用户要求完整反推=reverse。
7. 不要把"换鞋/换衣服/换场景"等写成专用字段，统一进 targets/properties/editable/preserve。"""

TARGETED_ANALYSIS_SYSTEM = """你是 NOVAI Prompt Intelligence 的 Targeted Analyzer。
任务：只分析当前任务需要的参考素材维度（定向分析），禁止分析整张图的无关内容。
规则：
1. 只输出一个 JSON 对象：{"dna": {"<相关维度>": "<结论>"}}，相关维度由用户指定，禁止自己扩大。
2. 只描述事实，不要给出创作建议，不要生成新画面描述。"""

FULL_REVERSE_IMAGE_SYSTEM = """你是 NOVAI Prompt Intelligence 的 Full Reverse Analyzer（图片）。
任务：对参考图片执行完整的视觉 DNA 逆向分析。
规则：只输出一个 JSON 对象，结构如下：
{"dna": {"subject": "...", "objects": ["..."], "composition": "...", "camera": "...", "lens": "...", "perspective": "...", "lighting": "...", "shadows": "...", "environment": "...", "materials": ["..."], "color": "...", "style": "...", "depth_of_field": "...", "post_processing": "...", "spatial_relationships": ["..."]}}
不要输出其它文字。"""

FULL_REVERSE_VIDEO_SYSTEM = """你是 NOVAI Prompt Intelligence 的 Full Reverse Analyzer（视频）。
任务：基于按时间顺序排列的关键帧，对参考视频执行完整的视觉 DNA 逆向分析。
规则：只输出一个 JSON 对象，结构如下：
{"dna": {"duration": "", "shots": [{"start": 0, "end": 0, "shot_size": "", "camera_angle": "", "camera_position": "", "lens": "", "camera_motion": "", "movement_speed": "", "subject_action": "", "composition": "", "lighting": "", "transition": ""}], "subject": "", "objects": [], "action": "", "motion": "", "camera": "", "camera_motion": "", "lens": "", "composition": "", "lighting": "", "environment": "", "color": "", "timing": "", "tempo": "", "transition": "", "continuity": ""}}
关键帧数量有限，无法确认的字段填空字符串，禁止编造。不要输出其它文字。"""

OPTIMIZER_SYSTEM = """你是 NOVAI Prompt Intelligence 的 Prompt Optimizer。
任务：在严格约束下优化用户的 Prompt 表达。
硬性规则（违反任意一条即失败）：
1. 绝对禁止改变用户任务：不能扩大修改范围、不能添加用户没要求的风格/镜头/场景/人物/商品。
2. 只能：消除歧义、补足必要信息、整理结构、提高表达精度。
3. 用户要求保留的内容（preserve）必须明确写入最终 Prompt。
4. 用户要求修改的内容（editable）之外的任何内容默认保持。
5. 参考素材只贡献用户指定角色（reference role）允许的信息。
6. 直接输出优化后的 Prompt 文本，不要解释，不要 JSON，不要 Markdown 代码块。"""

AUDITOR_SYSTEM = """你是 NOVAI Prompt Intelligence 的 Prompt Auditor。
任务：审计"优化后的 Prompt"是否发生了 Prompt Drift（偏离用户原始意图）。
检查项：
1. 用户要求修改的目标（editable）是否被改变/扩大？
2. 用户要求保留的内容（preserve：场景/镜头/光影/人物/商品/构图等）是否被要求改变？
3. 是否自动添加了用户没要求的风格/镜头/场景/人物/商品？
4. 参考素材是否被允许越界使用（如用户只要求参考目标对象，却被要求继承背景/光影/人物）？
5. 是否要求了模型根本不支持的产出（如图片模型生成视频）？
只输出一个 JSON 对象：{"drift": true/false, "reasons": ["..."]}，不要其它文字。"""

# ---------------------------------------------------------------------------
# Capability Registry（附件 §40-42）——只登记仓库/协议确认过的能力，不写死"支持"
# ---------------------------------------------------------------------------
_CAPABILITY_CACHE = {}


def model_capability(model: str) -> dict:
    """根据模型名返回真实能力表。未知模型返回空 dict（调用方不得假设能力）。"""
    if not model:
        return {}
    key = str(model).strip().lower()
    cached = _CAPABILITY_CACHE.get(key)
    if cached is not None:
        return cached
    caps = _capability_by_name(key)
    _CAPABILITY_CACHE[key] = caps
    return caps


def _capability_by_name(key: str) -> dict:
    if "nano-banana" in key:
        return {
            "model": key,
            "image_generation": True,
            "image_edit": True,
            "reference_image": True,
            "reference_video": False,
            "mask_edit": False,
            "identity_reference": False,
            "video_generation": False,
        }
    if "seedance" in key or "doubao-seedance" in key:
        if "2.5" in key or "2-5" in key:
            # Seedance 2.5：NOVAI 仓库当前未接入该模型（2026-08 审计），
            # 能力表预置但外部必须通过 unsupported_reason 感知。
            return {
                "model": key,
                "image_generation": False,
                "image_edit": False,
                "video_generation": True,
                "reference_image": True,
                "reference_video": True,
                "mask_edit": False,
                "identity_reference": False,
                "unsupported": True,
                "unsupported_reason": "Seedance 2.5 尚未接入 NOVAI（仓库无该模型端点），Compiler 已预留但当前不可用",
            }
        return {
            "model": key,
            "image_generation": False,
            "image_edit": False,
            "video_generation": True,
            "reference_image": True,
            "reference_video": True,
            "mask_edit": False,
            "identity_reference": False,
        }
    return {}


def compiler_for(model: str):
    """按目标模型选择独立 Compiler；未知模型 → Generic（原样输出）。"""
    key = str(model or "").strip().lower()
    if "nano-banana" in key:
        return NanoBananaCompiler
    if "seedance" in key:
        if "2.5" in key or "2-5" in key:
            return Seedance25Compiler
        return Seedance20Compiler
    return GenericCompiler


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------
def _parse_json(text: str):
    """容错 JSON 解析：剥离代码块标记后尝试 json.loads。"""
    if not text:
        return None
    cleaned = str(text).strip()
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
    cleaned = re.sub(r"\s*```$", "", cleaned)
    # 截取第一个 { ... } 块
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start >= 0 and end > start:
        cleaned = cleaned[start:end + 1]
    try:
        return json.loads(cleaned)
    except Exception:
        # 尝试找到 JSON 对象内的完整块
        for candidate in re.findall(r"\{[^{}]*\}", cleaned):
            try:
                return json.loads(candidate)
            except Exception:
                continue
    return None


def _asset_hash(value: str) -> str:
    return hashlib.md5(str(value or "").encode("utf-8")).hexdigest()[:16]


def _pick(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k):
            return d[k]
    return default


# ---------------------------------------------------------------------------
# 四层 Lock（附件 §17-20）
# ---------------------------------------------------------------------------
class IntentLocks:
    """从 Universal Intent 提取并固化的锁。Optimizer/Compiler 只能读取，不能扩大。"""

    def __init__(self, intent: dict, message: str):
        self.intent = intent or {}
        self.operation = str(self.intent.get("operation") or "").strip()
        self.editable = self._as_list(self.intent.get("editable"))
        self.preserve = self._as_list(self.intent.get("preserve"))
        self.constraints = self._as_list(self.intent.get("constraints"))
        self.references = self.intent.get("references") or []
        self.reference_mode = str(self.intent.get("reference_mode") or "").strip() or (
            "reverse" if self.intent.get("reverse") else "none"
        )
        self.reverse = bool(self.intent.get("reverse"))
        # 用户显式"不要改变"的兜底提取
        for m in re.findall(r"(?:不要|别|保持|保留|不改变|不动|维持)[^。；;，,]{1,40}", message):
            cleaned = re.sub(r"^(?:不要|别|保持|保留|不改变|不动|维持)", "", m).strip()
            if cleaned and cleaned not in self.preserve:
                self.preserve.append(cleaned)

    @staticmethod
    def _as_list(value):
        if not value:
            return []
        if isinstance(value, list):
            return [str(v).strip() for v in value if str(v).strip()]
        return [str(value).strip()]

    def lock_block(self) -> str:
        """把锁渲染成约束文本，注入 Optimizer/Auditor/Compiler 上下文。"""
        lines = []
        if self.operation:
            lines.append(f"用户任务类型(operation): {self.operation}")
        if self.editable:
            lines.append(f"允许修改(editable): {'、'.join(self.editable)}")
        if self.preserve:
            lines.append(f"必须保持(preserve): {'、'.join(self.preserve)}")
        if self.constraints:
            lines.append(f"约束(constraints): {'；'.join(self.constraints)}")
        if self.references:
            roles = []
            for i, ref in enumerate(self.references):
                if isinstance(ref, dict):
                    roles.append(f"参考素材{i + 1} 角色={ref.get('role') or '未知'}")
            if roles:
                lines.append("参考角色: " + "；".join(roles))
        return "\n".join(lines)

    def reference_roles_block(self, reference_count: int) -> str:
        """Reference Lock：为每份参考素材分配只允许贡献的维度。"""
        if not self.references or reference_count <= 0:
            return "无参考素材。"
        role_dims = {
            "object_reference": "shape, material, color, texture, logo, branding, construction",
            "character_reference": "identity, face, body, clothing, hair, pose, expression",
            "identity_reference": "identity, face",
            "scene_reference": "environment, background, atmosphere",
            "motion_reference": "action, motion, timing",
            "style_reference": "style, color palette, lighting mood",
            "composition_reference": "composition, camera, perspective",
        }
        lines = []
        for i, ref in enumerate(self.references[:reference_count]):
            if not isinstance(ref, dict):
                continue
            role = str(ref.get("role") or "").strip()
            dims = role_dims.get(role)
            if dims:
                lines.append(f"参考素材{i + 1}(role={role}) 只允许贡献: {dims}；禁止继承背景/光影/构图/风格等未指定维度")
            else:
                lines.append(f"参考素材{i + 1}(role={role or '未指定'}) 只允许贡献与用户明确要求相关的维度")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Compilers（附件 §31-35）
# ---------------------------------------------------------------------------
class BaseCompiler:
    name = "generic"

    @staticmethod
    def compile(intent: dict, locks: IntentLocks, message: str, dna: dict, reference_context: str) -> str:
        return message


class GenericCompiler(BaseCompiler):
    name = "generic"

    @staticmethod
    def compile(intent, locks, message, dna, reference_context):
        # 未知目标模型：不冒险改写，原样输出（最优降级）
        return message


class NanoBananaCompiler(BaseCompiler):
    """Nano Banana Pro：官方提示指南强调"明确要改变什么 + 保持什么"（编辑场景），
    生成场景则突出主体/动作/上下文/构图/风格。禁止堆砌 8K/masterpiece 等。"""

    name = "nano-banana-pro"

    @staticmethod
    def compile(intent, locks, message, dna, reference_context):
        parts = []
        editable = locks.editable
        preserve = locks.preserve
        references = locks.references
        op = locks.operation or "generate"

        if op in ("edit", "replace", "modify", "remove", "transform", "transfer", "reconstruct", "add", "extend"):
            # —— 编辑/修改类：明确变化对象 + 保持项 ——
            parts.append("This is an image edit task.")
            if editable:
                parts.append(f"Modify only: {' and '.join(editable)}.")
            elif references:
                parts.append("Modify the target object as described.")
            if preserve:
                parts.append(f"Preserve unchanged: {' and '.join(preserve)}.")
            else:
                parts.append("Keep everything else exactly unchanged.")
            # Reference Lock：参考素材只贡献指定角色维度
            if references:
                for i, ref in enumerate(references):
                    if isinstance(ref, dict):
                        role = str(ref.get("role") or "").strip() or "object_reference"
                        parts.append(f"Reference image {i + 1} contributes only its {role.replace('_', ' ')}; do not copy its background, lighting, composition, or unrelated content.")
        else:
            # —— 生成/创作类：主体 + 动作/变化 + 上下文 + 构图/风格 ——
            parts.append(message.strip())
            if preserve:
                parts.append(f"Keep consistent with: {' and '.join(preserve)}.")

        if reference_context and references:
            parts.append("Reference context (facts only):")
            parts.append(reference_context)

        final = "\n".join(p for p in parts if p)
        return final[:6000]


class Seedance20Compiler(BaseCompiler):
    """Seedance 2.0：有层次、可执行的创作指令（Task/Subject/Action/Scene/Camera/...），
    参考素材必须带明确 role（火山 reference_video / reference_image 语义）。"""

    name = "seedance-2.0"

    @staticmethod
    def compile(intent, locks, message, dna, reference_context):
        op = locks.operation or "generate"
        parts = []
        if op in ("edit", "replace", "modify", "transform", "transfer", "reconstruct", "extend", "add", "remove"):
            parts.append("视频编辑任务：只修改用户指定的部分，其余必须保持时间与空间一致。")
            if locks.editable:
                parts.append(f"修改范围(editable): {'、'.join(locks.editable)}。")
            if locks.preserve:
                parts.append(f"必须保持(preserve): {'、'.join(locks.preserve)}。")
            parts.append("连续性要求：角色身份、服装、场景、镜头、动作、光影、节奏全程一致；禁止因编辑引发无关漂移。")
        else:
            parts.append("视频生成任务。")
            parts.append(f"核心主题: {message.strip()}")
        # 结构化创作字段（只放有内容的）
        fields = []
        if locks.constraints:
            fields.append(f"约束: {'；'.join(locks.constraints)}")
        if dna:
            video_dna = dna.get("video") or dna.get("image") or {}
            for key, label in (
                ("action", "动作/主体行为"),
                ("camera", "镜头"),
                ("camera_motion", "运镜"),
                ("composition", "构图"),
                ("lighting", "光影"),
                ("environment", "场景环境"),
                ("color", "色彩"),
                ("timing", "节奏/时间结构"),
                ("continuity", "连续性"),
            ):
                val = video_dna.get(key)
                if val:
                    fields.append(f"{label}: {val}")
        if fields:
            parts.append("视觉规格:")
            parts.extend("  - " + f for f in fields)
        if reference_context and locks.references:
            parts.append("参考素材约束（只贡献指定角色，禁止污染其它维度）:")
            parts.append(reference_context)
        final = "\n".join(p for p in parts if p)
        return final[:6000]


class Seedance25Compiler(BaseCompiler):
    """Seedance 2.5：独立 Compiler（与 2.0 完全隔离）。当前仓库未接入 2.5 模型，
    运行时通过 capability.unsupported 拦截，永不实际生成 2.5 提示词。"""

    name = "seedance-2.5"

    @staticmethod
    def compile(intent, locks, message, dna, reference_context):
        caps = model_capability(locks.intent.get("target_model") or "")
        if caps.get("unsupported"):
            # 附件 §42：不支持时清晰提示 + 降级，禁止伪装成功
            return message
        # 未来接入后在此实现独立的 2.5 编译策略（不得复制 2.0 的提示词）
        return message


# ---------------------------------------------------------------------------
# Prompt Intelligence 主流程
# ---------------------------------------------------------------------------
class PromptIntelligence:
    def __init__(self, *, llm_call, message, images=None, videos=None, reverse=False,
                 target_type="", target_model="", provider="", model=""):
        self.llm_call = llm_call          # async (text, system_prompt, images, videos) -> str
        self.message = str(message or "").strip()
        self.images = list(images or [])[:8]
        self.videos = list(videos or [])[:3]
        self.reverse = bool(reverse)
        self.target_type = str(target_type or "").strip()
        self.target_model = str(target_model or "").strip()
        self.provider = provider
        self.model = model
        self.video_frames_cb: Optional[Callable[[str], Awaitable[list]]] = None  # 由调用方注入：async (video_ref) -> [frame_data_url]，复用现有关键帧链
        self.intent = {}
        self.locks = None
        self.dna = {}
        self.reference_context = ""
        self.steps_used = 0
        self.log = []
        self.final_prompt = ""

    # ---- 对外入口：全部异常吞掉，返回 dict（调用方永远能安全降级）----
    async def run(self) -> dict:
        try:
            if not self.message:
                return {"ok": False, "reason": "empty_message"}
            if not self.reverse and not self.images and not self.videos:
                # 附件 §7 none 模式无参考：保持原 Prompt 行为，不加智能层
                return {"ok": False, "reason": "no_reference_no_reverse", "final_prompt": self.message}

            # 1. Intent Judge
            intent = await self._intent_judge()
            if not intent:
                return {"ok": False, "reason": "intent_judge_failed", "final_prompt": self.message}
            self.intent = intent
            self.locks = IntentLocks(intent, self.message)

            # 2. 参考分析（Targeted / Full Reverse）
            analysis = await self._analyze_references()

            # 3. Reference Fusion → 统一参考上下文
            self.reference_context = self._fuse_references(analysis)

            # 4. Prompt Optimizer（只优化表达）
            optimized = await self._optimize(self.reference_context)

            # 5. Prompt Auditor（Drift → REJECT → 回退原 Prompt，且不再过 Compiler）
            final_candidate, fell_back = await self._audit(optimized)
            if fell_back:
                self.final_prompt = final_candidate
                return {
                    "ok": True,
                    "final_prompt": final_candidate,
                    "intent": intent,
                    "dna": analysis,
                    "reference_context": self.reference_context,
                    "steps_used": self.steps_used,
                    "compiler": "rejected(drift)",
                    "drift_rejected": True,
                }

            # 6. Model Compiler（按 target_model 选择；capability 校验）
            final = self._compile(final_candidate)

            self.final_prompt = final
            return {
                "ok": True,
                "final_prompt": final,
                "intent": intent,
                "dna": analysis,
                "reference_context": self.reference_context,
                "steps_used": self.steps_used,
                "compiler": getattr(compiler_for(self.target_model), "name", "generic"),
            }
        except Exception as exc:
            print(f"[prompt-intelligence] degraded: {type(exc).__name__}: {exc}")
            return {"ok": False, "reason": "exception", "final_prompt": self.message, "error": str(exc)}

    # ---- 1. Intent Judge ----
    async def _intent_judge(self):
        self.steps_used += 1
        if self.steps_used > MAX_INTELLIGENCE_STEPS:
            return None
        try:
            context_lines = [f"用户请求: {self.message}"]
            if self.images:
                context_lines.append(f"参考图片数量: {len(self.images)}")
            if self.videos:
                context_lines.append(f"参考视频数量: {len(self.videos)}")
            context_lines.append(f"Reverse 开关: {'ON(允许完整反推)' if self.reverse else 'OFF(仅允许必要定向分析)'}")
            context_lines.append(f"目标产出类型: {self.target_type or '未知'} 目标模型: {self.target_model or '未知'}")
            context_lines.append(f"JSON 结构示例: {json.dumps(INTENT_SCHEMA_EXAMPLE, ensure_ascii=False)}")
            raw = await self.llm_call("\n".join(context_lines), INTENT_JUDGE_SYSTEM, [], [])
            parsed = _parse_json(raw)
            if not parsed or not parsed.get("operation"):
                return None
            # 补默认
            parsed.setdefault("reverse", self.reverse)
            parsed.setdefault("target_type", self.target_type)
            parsed.setdefault("target_model", self.target_model)
            if self.reverse and not parsed.get("reference_mode"):
                parsed["reference_mode"] = "reverse"
            self._log("intent", parsed)
            return parsed
        except Exception as exc:
            print(f"[prompt-intelligence] intent judge failed: {exc}")
            return None

    # ---- 2. 参考分析 ----
    async def _analyze_references(self):
        analysis = {"targeted": [], "full": []}
        has_any = False
        try:
            if self.reverse:
                # Full Reverse（仅 ON 时允许）
                for i, img in enumerate(self.images[:4]):
                    dna = await self._analyze_one(img, None, i, full=True)
                    if dna:
                        analysis["full"].append({"kind": "image", "index": i, "dna": dna})
                        has_any = True
                for i, vid in enumerate(self.videos[:2]):
                    dna = await self._analyze_one(None, vid, i, full=True)
                    if dna:
                        analysis["full"].append({"kind": "video", "index": i, "dna": dna})
                        has_any = True
            else:
                # Targeted Analysis：只分析任务需要的维度（参考素材存在且 intent 有 references）
                refs = self.locks.references if self.locks else []
                total_refs = len(self.images) + len(self.videos)
                if total_refs:
                    ref_roles = self._role_for_assets(refs, total_refs)
                    for i, img in enumerate(self.images[:4]):
                        role = ref_roles[i] if i < len(ref_roles) else "object_reference"
                        dna = await self._analyze_one(img, None, i, full=False, role=role)
                        if dna:
                            analysis["targeted"].append({"kind": "image", "index": i, "role": role, "dna": dna})
                            has_any = True
                    for i, vid in enumerate(self.videos[:2]):
                        role = ref_roles[len(self.images) + i] if len(self.images) + i < len(ref_roles) else "motion_reference"
                        dna = await self._analyze_one(None, vid, i, full=False, role=role)
                        if dna:
                            analysis["targeted"].append({"kind": "video", "index": i, "role": role, "dna": dna})
                            has_any = True
            return analysis if has_any else {}
        except Exception as exc:
            print(f"[prompt-intelligence] analyze failed: {exc}")
            return {}

    async def _analyze_one(self, image, video, index, full=False, role="object_reference"):
        self.steps_used += 1
        if self.steps_used > MAX_INTELLIGENCE_STEPS:
            return None
        try:
            if video is not None:
                # 视频 → 关键帧 → 时间顺序送入（复用 NOVAI 关键帧链，由调用方转成帧列表）
                frames = await self._video_frames(video)
                if not frames:
                    return None
                system = FULL_REVERSE_VIDEO_SYSTEM if full else TARGETED_ANALYSIS_SYSTEM
                prompt_lines = ["参考视频关键帧按时间顺序排列。"]
                if full:
                    prompt_lines.append("请执行完整视频 Reverse Analysis（Video DNA / Shot DNA / Motion DNA / Camera DNA）。")
                else:
                    prompt_lines.append(f"本次任务只允许定向分析维度: {self._dims_for_role(role)}。禁止分析无关内容。")
                prompt_lines.append(f"参考素材 #{index + 1}")
                raw = await self.llm_call("\n".join(prompt_lines), system, [], frames)
            else:
                system = FULL_REVERSE_IMAGE_SYSTEM if full else TARGETED_ANALYSIS_SYSTEM
                prompt_lines = []
                if full:
                    prompt_lines.append("请对参考图片执行完整 Reverse Analysis（Image DNA：主体/物体/构图/镜头/光影/环境/材质/色彩/风格/景深/后期）。")
                else:
                    prompt_lines.append(f"本次任务只允许定向分析维度: {self._dims_for_role(role)}。禁止分析整张图的无关内容。")
                prompt_lines.append(f"参考素材 #{index + 1}")
                raw = await self.llm_call("\n".join(prompt_lines), system, [image], [])
            parsed = _parse_json(raw)
            if parsed and isinstance(parsed.get("dna"), dict):
                return parsed["dna"]
            return None
        except Exception as exc:
            print(f"[prompt-intelligence] analyze_one failed: {exc}")
            return None

    async def _video_frames(self, video):
        """视频帧提取由调用方注入的 video_frames_cb 完成（复用 /api/canvas-llm 现有链）。"""
        cb = self.video_frames_cb
        if cb is None:
            return []
        try:
            return await cb(video)
        except Exception as exc:
            print(f"[prompt-intelligence] video frames failed: {exc}")
            return []

    @staticmethod
    def _dims_for_role(role):
        dims = {
            "object_reference": "shape, material, color, texture, logo, branding, construction",
            "character_reference": "identity, face, body, clothing, hair, pose, expression",
            "identity_reference": "identity, face",
            "scene_reference": "environment, background, atmosphere",
            "motion_reference": "action, motion, timing",
            "style_reference": "style, color palette, lighting mood",
            "composition_reference": "composition, camera, perspective",
        }
        return dims.get(str(role or "").strip(), "与用户明确要求直接相关的维度")

    @staticmethod
    def _role_for_assets(references, total):
        roles = []
        for ref in references:
            if isinstance(ref, dict):
                roles.append(str(ref.get("role") or "").strip() or "object_reference")
        while len(roles) < total:
            roles.append("object_reference")
        return roles[:total]

    # ---- 3. Reference Fusion（附件 §37-39）----
    def _fuse_references(self, analysis) -> str:
        blocks = []
        for item in analysis.get("full", []):
            kind = item.get("kind")
            dna = item.get("dna") or {}
            if kind == "video":
                blocks.append(f"完整视频反推(素材{int(item.get('index', 0)) + 1}): {json.dumps(dna, ensure_ascii=False)}")
            else:
                blocks.append(f"完整图片反推(素材{int(item.get('index', 0)) + 1}): {json.dumps(dna, ensure_ascii=False)}")
        for item in analysis.get("targeted", []):
            role = item.get("role") or "object_reference"
            dna = item.get("dna") or {}
            blocks.append(f"定向分析(素材{int(item.get('index', 0)) + 1}, role={role}): {json.dumps(dna, ensure_ascii=False)}")
        return "\n".join(blocks)

    # ---- 4. Prompt Optimizer（只优化表达）----
    async def _optimize(self, reference_context):
        self.steps_used += 1
        if self.steps_used > MAX_INTELLIGENCE_STEPS:
            return self.message
        try:
            lines = [f"用户原始 Prompt:\n{self.message}"]
            lock_text = self.locks.lock_block() if self.locks else ""
            if lock_text:
                lines.append(f"意图锁:\n{lock_text}")
            if reference_context:
                lines.append(f"参考素材分析结果（仅作事实参考，是否使用由用户意图决定）:\n{reference_context}")
            lines.append("请只优化表达（消除歧义/整理结构/补足必要信息），不得改变任务。直接输出优化后的 Prompt。")
            optimized = await self.llm_call("\n".join(lines), OPTIMIZER_SYSTEM, [], [])
            optimized = str(optimized or "").strip()
            self._log("optimized", optimized[:500])
            return optimized if optimized else self.message
        except Exception as exc:
            print(f"[prompt-intelligence] optimize failed: {exc}")
            return self.message

    # ---- 5. Prompt Auditor（Drift → REJECT → 回退）----
    async def _audit(self, candidate):
        """返回 (最终文本, 是否回退)。Drift 时回退原消息，调用方将跳过 Compiler。"""
        self.steps_used += 1
        if self.steps_used > MAX_INTELLIGENCE_STEPS:
            return candidate, False
        # 规则层快速检查（不依赖 LLM）
        if self._rule_drift(candidate):
            self._log("auditor", "rule drift detected, fallback to original")
            return self.message, True
        try:
            lines = [
                f"原始意图(Prompt): {self.message}",
                f"意图锁:\n{self.locks.lock_block() if self.locks else ''}",
                f"优化后 Prompt:\n{candidate}",
                "请审计是否发生 Prompt Drift。只输出 JSON。",
            ]
            raw = await self.llm_call("\n".join(lines), AUDITOR_SYSTEM, [], [])
            parsed = _parse_json(raw)
            if parsed and parsed.get("drift"):
                self._log("auditor", f"llm drift: {parsed.get('reasons')}")
                return self.message, True
            return candidate, False
        except Exception as exc:
            print(f"[prompt-intelligence] audit failed, keep candidate: {exc}")
            return candidate, False

    def _rule_drift(self, candidate) -> bool:
        """规则护栏：preserve 里的场景/镜头/光影若在候选里被要求改变 → drift。"""
        if not self.locks or not candidate:
            return False
        low = candidate.lower()
        forbidden_phrases = [
            ("scene", ["change the scene", "new scene", "different scene", "redesign the scene", "改变场景", "更换场景", "重新设计场景"]),
            ("camera", ["new camera", "change the camera", "different camera angle", "改变镜头", "更换镜头", "新的镜头"]),
            ("lighting", ["change the lighting", "new lighting", "different lighting", "改变光影", "更换光影", "重新布光", "调整灯光"]),
            ("background", ["change the background", "new background", "不同背景", "更换背景", "改变背景"]),
            ("person/character", ["change the person", "replace the person", "different person", "换一个人", "改变人物", "更换人物"]),
        ]
        for preserve_word, phrases in forbidden_phrases:
            if any(w in preserve_word for w in []) and any(p in low for p in phrases):
                return True
        # 更精确：preserve 项逐条匹配
        preserve_low = " ".join(p.lower() for p in self.locks.preserve)
        if "scene" in preserve_low or "场景" in preserve_low:
            if any(p in low for p in ["change the scene", "new scene", "不同场景", "更换场景", "改变场景", "重新设计场景"]):
                return True
        if "camera" in preserve_low or "镜头" in preserve_low:
            if any(p in low for p in ["new camera", "change the camera", "改变镜头", "更换镜头"]):
                return True
        if "lighting" in preserve_low or "光影" in preserve_low or "灯光" in preserve_low:
            if any(p in low for p in ["change the lighting", "new lighting", "改变光影", "更换光影", "重新布光"]):
                return True
        if "background" in preserve_low or "背景" in preserve_low:
            if any(p in low for p in ["change the background", "new background", "更换背景", "改变背景"]):
                return True
        return False

    # ---- 6. Model Compiler（capability 校验 + 模型专用编译）----
    def _compile(self, candidate) -> str:
        try:
            caps = model_capability(self.target_model)
            if caps.get("unsupported"):
                self._log("compiler", f"capability unsupported: {caps.get('unsupported_reason')}")
                return candidate
            compiler = compiler_for(self.target_model)
            locks = self.locks if self.locks is not None else IntentLocks({}, self.message)
            compiled = compiler.compile(self.intent, locks, candidate, self.dna, self.reference_context)
            self._log("compiler", f"compiled by {getattr(compiler, 'name', 'generic')}")
            return compiled or candidate
        except Exception as exc:
            print(f"[prompt-intelligence] compile failed, fallback: {exc}")
            return candidate

    def _log(self, step, detail):
        if len(self.log) < 50:
            self.log.append({"step": step, "detail": str(detail)[:400]})
