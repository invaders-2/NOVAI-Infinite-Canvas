# 镜头编排词表（Shot Choreography Vocabulary）

本技能**没有固定镜头组**——合成数量由用户指定（`--count N`，默认 6，上限 30），
每张的动作与景别由编排模型从下面的维度池中组合，硬性要求：
**同一计划内任意两张的景别不同、动作不同**（防"AI 味"的关键）。
脚本内置同一份词表，本文件供 agent 与用户查阅。

## 景别池（framing）

| id | 中文 | 英文定义 |
|---|---|---|
| extreme-close-up | 特写 | extreme close-up, one key detail filling the frame |
| close-up | 近景 | close-up shot, head and shoulders |
| medium-shot | 中景 | medium shot, waist-up framing |
| full-shot | 全景 | full shot, entire figure head to toe with breathing room |
| wide-shot | 远景/大场景 | wide shot, small figure within the environment |
| cowboy-shot | 牛仔景别 | cowboy shot, mid-thigh-up framing |

## 机位池（angle）

| id | 中文 | 英文定义 |
|---|---|---|
| front | 正面机位 | frontal camera angle |
| three-quarter | 45度机位 | three-quarter camera angle |
| profile | 侧面机位 | side profile camera angle |
| back | 背面机位 | camera behind the subject |
| over-shoulder | 过肩 | over-the-shoulder framing toward the scene |
| low-angle | 仰拍 | low camera angle looking up |
| high-angle | 俯拍 | high camera angle looking down |

## 动作池（action）

| id | 中文 | 英文定义 |
|---|---|---|
| standing-still | 静立 | standing still, weight settled, quiet composure |
| walking | 行走 | mid-stride walking, natural gait, fabric in motion |
| turning | 转身 | turning the body, momentum caught mid-rotation |
| glancing-back | 回眸 | glancing back over the shoulder toward camera |
| seated | 坐姿 | seated within the scene, relaxed posture |
| leaning | 倚靠 | leaning against a surface in the scene |
| hands-in-motion | 手部动作 | hands adjusting a garment detail, caught mid-gesture |
| crouching | 蹲姿 | crouching low, compact posture |
| interacting | 与环境互动 | interacting with an element of the scene |
| duo-interaction | 双人互动 | the two models interacting with each other |

## 编排原则

- 动作要写到肢体与重心（如 "weight on the back leg, front foot lifted mid-stride"），
  禁止只写 standing / walking——动作词级描述是呆板出图的根因。
- 双人 look 图：至少 2-3 张双人互动镜头，其余可一人为主、一人景深虚化。
- 尺寸建议：全景/远景按空镜横竖选 832x1472 或 1472x832；中近景特写用 1024x1024 或 1024x1536。
- N 超过词表组合的自然上限时（约 20+），允许同景别不同动作、或同动作不同景别，
  但绝不允许景别与动作双重复。
