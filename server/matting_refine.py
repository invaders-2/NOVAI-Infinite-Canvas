"""抠图边缘精修（本地模型与「AI 绿幕」两条链路共用）。

步骤：
1. 引导滤波（guided filter，用原图作引导）只修边缘带：低分辨率 mask 放大后的边缘贴回原图真实轮廓，
   保留发丝/半透明过渡，不再用腐蚀去「啃」边。
2. 去掉孤立小碎块（远离主体的噪点）。
3. 前景色估计（Forte & Pitié 2021「Approximate Fast Foreground Colour Estimation」，两级 blur fusion）：
   把半透明边缘里混进来的背景色（绿幕/原背景）换成主体自身颜色，消除绿边、灰边、暗边。
4. 绿幕：按色度距离（YCrCb）抠，背景色从画面四周自动取样，不假定一定是 #00FF00；
   生成图与原图对得上时直接用「原图像素」+ 绿幕得到的 alpha，主体不被 AI 重画。

只依赖 numpy + opencv（两端打包都已带）。
"""
import numpy as np
import cv2


def _box(x, r):
    return cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1), borderType=cv2.BORDER_REFLECT)


def guided_filter_color(I, p, r, eps):
    """彩色引导滤波（He et al.）。I: HxWx3 float32 [0,1]，p: HxW float32。"""
    mean_I = _box(I, r)
    mean_p = _box(p, r)
    mean_Ip = _box(I * p[:, :, None], r)
    cov_Ip = mean_Ip - mean_I * mean_p[:, :, None]
    var = {}
    for i in range(3):
        for j in range(i, 3):
            var[(i, j)] = _box(I[:, :, i] * I[:, :, j], r) - mean_I[:, :, i] * mean_I[:, :, j]
    a11, a12, a13 = var[(0, 0)] + eps, var[(0, 1)], var[(0, 2)]
    a22, a23, a33 = var[(1, 1)] + eps, var[(1, 2)], var[(2, 2)] + eps
    # 3×3 对称矩阵逐像素求逆
    c11 = a22 * a33 - a23 * a23
    c12 = a13 * a23 - a12 * a33
    c13 = a12 * a23 - a13 * a22
    c22 = a11 * a33 - a13 * a13
    c23 = a13 * a12 - a11 * a23
    c33 = a11 * a22 - a12 * a12
    det = a11 * c11 + a12 * c12 + a13 * c13
    det = np.where(np.abs(det) < 1e-12, 1e-12, det)
    cx, cy, cz = cov_Ip[:, :, 0], cov_Ip[:, :, 1], cov_Ip[:, :, 2]
    a0 = (c11 * cx + c12 * cy + c13 * cz) / det
    a1 = (c12 * cx + c22 * cy + c23 * cz) / det
    a2 = (c13 * cx + c23 * cy + c33 * cz) / det
    b = mean_p - a0 * mean_I[:, :, 0] - a1 * mean_I[:, :, 1] - a2 * mean_I[:, :, 2]
    q = _box(a0, r) * I[:, :, 0] + _box(a1, r) * I[:, :, 1] + _box(a2, r) * I[:, :, 2] + _box(b, r)
    return q


def _fb_blur_fusion(image, F, B, alpha, r):
    blurred_alpha = cv2.blur(alpha, (r, r))
    blurred_FA = cv2.blur(F * alpha[:, :, None], (r, r))
    blurred_F = blurred_FA / (blurred_alpha[:, :, None] + 1e-5)
    blurred_B1A = cv2.blur(B * (1 - alpha)[:, :, None], (r, r))
    blurred_B = blurred_B1A / ((1 - blurred_alpha)[:, :, None] + 1e-5)
    a = alpha[:, :, None]
    F = blurred_F + a * (image - a * blurred_F - (1 - a) * blurred_B)
    return np.clip(F, 0, 1), blurred_B


def estimate_foreground(image, alpha):
    """两级 blur fusion 前景色估计。image HxWx3 float [0,1]，alpha HxW [0,1]。"""
    h, w = alpha.shape
    s = max(h, w) / 1024.0
    r1 = max(15, int(round(90 * s)))
    r2 = max(3, int(round(6 * s)))
    F, B = _fb_blur_fusion(image, image, image, alpha, r1)
    F, _ = _fb_blur_fusion(image, F, B, alpha, r2)
    return F


def _remove_specks(alpha, min_frac=0.0006):
    """去掉和主体不相连的小碎块（面积 < 画面 min_frac）：只清碎块本身，不扩大范围（避免抠出方形洞）。"""
    solid = (alpha > 0.5).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    if n <= 2:
        return alpha
    limit = alpha.size * min_frac
    small = np.zeros(n, dtype=bool)
    small[1:] = stats[1:, cv2.CC_STAT_AREA] < limit
    drop = small[labels]
    if drop.any():
        alpha = np.where(drop, 0.0, alpha)
    return alpha


def _smoothstep(x, e0, e1):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def refine_alpha(rgb_u8, alpha, mask_res=1024):
    """用原图引导修边缘，按图像局部对比度决定「信原图还是信模型」：
    - 发丝、高对比轮廓（图上有清楚的边/纹理）→ 用引导滤波结果，细节贴着原图走；
    - 白鞋配浅底这类低对比的实心边 → 引导滤波只会抹成光晕，改用模型 mask 收紧后的利落边；
    - 结果始终夹在模型 mask 附近几像素内（半径按 mask 被放大的倍数算），不会外扩成雾。"""
    h, w = alpha.shape
    I = rgb_u8.astype(np.float32) / 255.0
    f = max(1.0, max(h, w) / float(mask_res))
    r = max(2, int(round(1.5 * f)))
    k = max(3, int(round(2 * f)) * 2 + 1)
    ker = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k))
    sig = max(0.8, k / 4.0)
    lo = cv2.GaussianBlur(cv2.erode(alpha, ker), (0, 0), sig)
    hi = cv2.GaussianBlur(cv2.dilate(alpha, ker), (0, 0), sig)
    sharp = _smoothstep(alpha, 0.2, 0.8)          # 模型边缘收紧（≈旧版阈值拉伸，但不腐蚀）
    edge = (hi - lo) > 0.04
    out = sharp
    if edge.any():
        q = np.clip(guided_filter_color(I, alpha.astype(np.float32), r, 4e-5), lo, hi)
        gray = cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0
        m = _box(gray, r)
        std = np.sqrt(np.maximum(_box(gray * gray, r) - m * m, 0.0))
        trust = np.clip((std - 0.025) / 0.06, 0.0, 1.0)   # 局部标准差小 → 低对比 → 信模型
        out = np.where(edge, sharp + trust * (q - sharp), sharp)
    out = _smoothstep(out, 0.04, 0.96)
    out = _remove_specks(out)
    return out.astype(np.float32)


def compose_rgba(rgb_u8, alpha):
    """前景色去污染后合成透明 PNG 的 RGBA（uint8）。"""
    I = rgb_u8.astype(np.float32) / 255.0
    F = estimate_foreground(I, alpha)
    # 不透明区域保留原像素，只替换半透明边缘
    solid = alpha >= 0.985
    F[solid] = I[solid]
    out = np.zeros(alpha.shape + (4,), np.uint8)
    out[:, :, :3] = np.clip(F * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)
    # 完全透明处 RGB 置 0，减小体积、避免别的软件显示残色
    out[out[:, :, 3] == 0, :3] = 0
    return out


def mask_to_rgba(rgb_u8, coarse_alpha):
    """本地模型：粗 mask（已放大到原图尺寸，[0,1]）→ 精修 RGBA。"""
    alpha = refine_alpha(rgb_u8, np.clip(coarse_alpha.astype(np.float32), 0, 1))
    return compose_rgba(rgb_u8, alpha)


# ───────────────── 绿幕 ─────────────────
def _key_color(rgb_u8):
    h, w = rgb_u8.shape[:2]
    m = max(2, int(min(h, w) * 0.03))
    border = np.concatenate([rgb_u8[:m].reshape(-1, 3), rgb_u8[-m:].reshape(-1, 3), rgb_u8[:, :m].reshape(-1, 3), rgb_u8[:, -m:].reshape(-1, 3)]).astype(np.float32)
    g_dom = border[:, 1] - np.maximum(border[:, 0], border[:, 2])
    cand = border[g_dom > 40]
    if len(cand) < 50:
        return np.array([0, 255, 0], np.float32)
    return np.median(cand, axis=0)


def chroma_alpha(rgb_u8):
    """色度距离抠绿：返回 alpha [0,1]（1=主体）。"""
    key = _key_color(rgb_u8)
    ycc = cv2.cvtColor(rgb_u8, cv2.COLOR_RGB2YCrCb).astype(np.float32)
    k = cv2.cvtColor(key.reshape(1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2YCrCb).astype(np.float32)[0, 0]
    d = np.sqrt((ycc[:, :, 1] - k[1]) ** 2 + (ycc[:, :, 2] - k[2]) ** 2)
    # 绿得越纯越透明；阈值按实测：纯绿 d≈0，肤色/白衣 d>60
    alpha = np.clip((d - 18.0) / 34.0, 0.0, 1.0)
    # 明显偏绿（G 远高于 R、B）的像素再压一次，防止阴影里的暗绿漏掉
    rgb = rgb_u8.astype(np.float32)
    greenness = rgb[:, :, 1] - np.maximum(rgb[:, :, 0], rgb[:, :, 2])
    alpha = np.minimum(alpha, np.clip(1.0 - (greenness - 50.0) / 70.0, 0.0, 1.0))
    alpha = cv2.medianBlur((alpha * 255).astype(np.uint8), 3).astype(np.float32) / 255.0
    return alpha


def despill(rgb_u8):
    rgb = rgb_u8.astype(np.float32)
    rgb[:, :, 1] = np.minimum(rgb[:, :, 1], np.maximum(rgb[:, :, 0], rgb[:, :, 2]))
    return np.clip(rgb, 0, 255).astype(np.uint8)


def greenscreen_to_rgba(gen_rgb_u8, orig_rgb_u8=None):
    """AI 绿幕图 → 透明 PNG。
    生成图与原图比例一致且主体对得上（亮度差小）时：alpha 用绿幕算，像素用原图（主体保持原样）；
    否则退回用生成图像素（先去绿溢色）。返回 (rgba_u8, used_original: bool)。"""
    alpha_gen = chroma_alpha(gen_rgb_u8)
    if orig_rgb_u8 is not None:
        oh, ow = orig_rgb_u8.shape[:2]
        gh, gw = gen_rgb_u8.shape[:2]
        if abs(ow / oh - gw / gh) < 0.02:
            a = cv2.resize(alpha_gen, (ow, oh), interpolation=cv2.INTER_LINEAR)
            g = cv2.resize(gen_rgb_u8, (ow, oh), interpolation=cv2.INTER_AREA)
            core = cv2.erode((a > 0.95).astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
            if core.sum() > a.size * 0.01:
                yo = cv2.cvtColor(orig_rgb_u8, cv2.COLOR_RGB2GRAY).astype(np.float32)
                yg = cv2.cvtColor(g, cv2.COLOR_RGB2GRAY).astype(np.float32)
                # 允许整体亮度偏移，只看结构是否一致
                diff = np.abs((yo[core] - yo[core].mean()) - (yg[core] - yg[core].mean())).mean()
                if diff < 16.0:
                    alpha = refine_alpha(orig_rgb_u8, a, mask_res=max(gh, gw))
                    return compose_rgba(orig_rgb_u8, alpha), True
    rgb = despill(gen_rgb_u8)
    alpha = refine_alpha(rgb, alpha_gen, mask_res=max(gen_rgb_u8.shape[:2]))
    return compose_rgba(rgb, alpha), False
