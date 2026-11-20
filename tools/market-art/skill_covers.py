#!/usr/bin/env python3
"""技能封面：用 APIMart seedream 生成统一风格的原创封面（风格参考 Pinterest 上的暖中性色棚拍 / 编辑大片，只取风格不取图）。
  venv/bin/python tools/market-art/skill_covers.py [name ...]
输出 _tmp/market-art/covers/<name>.png（原图），之后由 --install 写成 static/store/covers/gen-<name>.webp(1600x1200) 和 -sq.webp(700x700)。
"""
import json, os, sys, time, urllib.request, concurrent.futures as cf
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, '_tmp', 'market-art', 'covers')
BASE = os.environ.get('APIMART_BASE', 'https://apib.ai/v1')
MODEL = os.environ.get('COVER_MODEL', 'seedream-5-0-pro')
STYLE = ('Editorial photograph for a premium creative app. Warm neutral palette of sand, oat and stone with one restrained accent color, '
         'soft directional daylight with crisp long shadows, generous clean negative space, medium format camera, subtle fine film grain, '
         'matte finish, high-end magazine look, horizontal 4:3 composition with the subject centered. No text, no letters, no logo, no watermark.')
PROMPTS = {
 'ai-image-prompts-skill': 'Dozens of small printed photographs of varied subjects pinned in a neat grid on a sand-colored plaster wall, a hand reaching in to pick one card',
 'amazon-listing-images': 'E-commerce hero shot of a minimalist cream leather sneaker on a pure white seamless background, soft contact shadow, perfectly lit product',
 'banner-design': 'A large printed advertising banner mockup hanging in a bright modern gallery, bold color-block composition with an amber perfume bottle and empty areas reserved for copy',
 'brand-identity': 'Flat lay brand identity kit on oat linen: blank business cards, paint color swatches, fabric samples, ceramic chips, a pencil, arranged in an orderly grid',
 'cover-design': 'A smartphone lying on a travertine table showing a vertical lifestyle photo of a woman holding coffee, surrounded by dried flowers and a linen napkin, social media cover concept',
 'ecommerce-listing-suite': 'A contact sheet of six consistent product photos of one matte ceramic water bottle from different angles and scenes, prints laid out on a light table',
 'ecommerce-product-imagery': 'A luxury steel wristwatch resting on a travertine stone block, hard sunlight casting a long shadow, a single green leaf as accent',
 'fashion-campaign-production': 'Behind the scenes of a fashion campaign shoot: model in a camel wool coat under a large softbox, photographer silhouette in the foreground, warm studio',
 'fashion-model-photography': 'Full-body fashion model in an oatmeal knit set standing naturally on a sand-colored seamless backdrop, relaxed pose, clean studio light',
 'google-veo': 'Four cinematic film frames side by side on a film strip, showing a woman running along a beach at golden hour, motion continuity between frames',
 'gpt-image-2': 'A ceramic vase that is half unfinished raw clay and half glossy glazed cobalt blue, transformation concept, on a stone plinth',
 'item-change-background': 'A brown leather derby shoe, left half of the frame on a pure white studio background, right half the same shoe on wet cobblestones at dusk, seamless split composition',
 'lighting-direction': 'A glass perfume bottle on black acrylic lit by a single hard spotlight with a warm amber rim light, visible light falloff, dramatic studio lighting study',
 'novai-fashion-studio': 'A fashion creative director moodboard wall in a sunlit studio: fabric swatches, polaroids, sketches pinned up, a wooden director chair in front',
 'nuyoah-xiezhen-prompt': 'Portrait of a young East Asian woman by a window in soft daylight, wearing a cream linen dress, gentle expression, film portrait look',
 'qiaomu-mondo-poster-design': 'A framed screenprint-style illustrated poster artwork of a lone figure under a giant pale moon, limited three-color palette, hanging on a plaster wall',
 'seedance-fashion-lookbook': 'A fashion model walking mid-stride on a minimal concrete runway, slight motion blur on the coat hem, lookbook video still',
 'seedance-prompt-zh': 'Cinematic film still: a person with a red oil-paper umbrella walking through rain in an old Chinese stone alley, reflections on wet ground',
 'shot-composition': 'View through a camera viewfinder with a rule-of-thirds grid overlay framing a lone person on a vast pale salt flat under a soft sky',
 'fashion-editorial': 'Fashion editorial shot on 35mm analog film: a model in a cream linen slip dress leaning against a sunlit white stucco wall, long cast shadows and dappled leaf shadows, hand-enlarged silver gelatin print feel, honest skin texture',
 'text-to-image-prompt-optimizer': 'A vintage cream typewriter on a wooden desk whose paper sheet unfurls into a vivid painted landscape flowing out of it, imaginative concept',
}

def key():
    for p in ('data/API/.env', 'API/.env', '.env'):
        f = os.path.join(ROOT, p)
        if os.path.isfile(f):
            for line in open(f, encoding='utf-8'):
                if line.startswith('API_PROVIDER_APIMART_KEY='):
                    return line.split('=', 1)[1].strip().strip('"\'')
    raise SystemExit('no APIMART key')

def req(method, url, body=None):
    import requests
    r = requests.request(method, url, json=body, timeout=180, headers={'Authorization': 'Bearer ' + KEY})
    if r.status_code >= 400:
        raise RuntimeError('%s %s' % (r.status_code, r.text[:300]))
    return r.json()

def find_url(obj):
    if isinstance(obj, str) and obj.startswith('http') and any(x in obj for x in ('.png', '.jpg', '.jpeg', '.webp', 'image')):
        return obj
    if isinstance(obj, dict):
        for k in ('url', 'image_url', 'urls', 'images', 'data', 'result', 'output'):
            if k in obj:
                u = find_url(obj[k])
                if u: return u
        for v in obj.values():
            u = find_url(v)
            if u: return u
    if isinstance(obj, list):
        for v in obj:
            u = find_url(v)
            if u: return u
    return None

def gen(name):
    dst = os.path.join(OUT, name + '.png')
    if os.path.isfile(dst): return name, 'cached'
    body = {'model': MODEL, 'prompt': PROMPTS[name] + '. ' + STYLE, 'size': '2048x1536', 'n': 1}
    res = req('POST', BASE + '/images/generations', body)
    url = find_url(res)
    task = None
    if not url:
        d = res.get('data')
        task = (d[0] if isinstance(d, list) and d else d or {}).get('task_id') if isinstance(d, (list, dict)) else None
        task = task or res.get('task_id') or res.get('id')
        if not task: return name, 'no url/task: ' + json.dumps(res)[:300]
        for _ in range(90):
            time.sleep(4)
            st = req('GET', BASE + '/tasks/' + task)
            s = json.dumps(st)
            if '"failed"' in s or '"error"' in s.lower() and 'completed' not in s:
                return name, 'failed: ' + s[:300]
            url = find_url(st.get('data', st))
            if url and ('completed' in s or 'succeed' in s or 'success' in s): break
            url = None
        if not url: return name, 'timeout ' + str(task)
    import requests
    raw = requests.get(url, timeout=180).content
    open(dst, 'wb').write(raw)
    return name, 'ok %d KB' % (len(raw) // 1024)

def install(names):
    from PIL import Image
    covers = os.path.join(ROOT, 'static', 'store', 'covers')
    for n in names:
        src = os.path.join(OUT, n + '.png')
        if not os.path.isfile(src): print('skip', n); continue
        im = Image.open(src).convert('RGB')
        w, h = im.size; tw = min(w, round(h * 4 / 3)); th = round(tw * 3 / 4)
        im = im.crop(((w - tw) // 2, (h - th) // 2, (w - tw) // 2 + tw, (h - th) // 2 + th))
        im.resize((1600, 1200), Image.LANCZOS).save(os.path.join(covers, 'gen-%s.webp' % n), 'WEBP', quality=82, method=6)
        s = min(im.size); sq = im.crop(((im.width - s) // 2, (im.height - s) // 2, (im.width - s) // 2 + s, (im.height - s) // 2 + s))
        sq.resize((700, 700), Image.LANCZOS).save(os.path.join(covers, 'gen-%s-sq.webp' % n), 'WEBP', quality=82, method=6)
        print('installed', n)

if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    names = args or list(PROMPTS)
    if '--install' in sys.argv:
        install(names); sys.exit(0)
    KEY = key()
    os.makedirs(OUT, exist_ok=True)
    def safe(n):
        try: return gen(n)
        except Exception as e: return n, 'error: %s' % e
    with cf.ThreadPoolExecutor(int(os.environ.get('JOBS', '4'))) as ex:
        for n, r in ex.map(safe, names):
            print(n, r, flush=True)
