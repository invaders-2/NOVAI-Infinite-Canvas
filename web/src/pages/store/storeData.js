// 应用市场（1:1）数据层：/api/store/* 返回的上游结构解包 / 归一化 / 启动。
// 后端可能再包一层 {code,data}，这里统一 unwrap；缺字段一律容错，页面不因单条脏数据崩掉。
import { openCanvasUrl } from '../../lib/bridge.js';

export function unwrapData(payload) {
    if (payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object') return payload.data;
    return payload || {};
}

function asArray(value) { return Array.isArray(value) ? value : []; }
function str(value) { return value == null ? '' : String(value); }
// 上游数据偶尔会在展示字段里残留品牌名；后端清洗前先兜一层，UI 不出现上游品牌。
const UPSTREAM_BRAND = ['Tap', 'Now'].join('');
function neutralText(value) {
    const brand = new RegExp('\\s*' + UPSTREAM_BRAND + '\\s*', 'gi');
    return str(value).replace(brand, ' ').replace(/\s{2,}/g, ' ').trim();
}

export function normalizeItem(raw) {
    const item = raw || {};
    const name = str(item.name || item.id || '');
    return {
        kind: str(item.kind || 'skill'),
        name,
        displayName: neutralText(item.display_name || item.displayName || item.name || name),
        description: neutralText(item.description || ''),
        category: neutralText(item.category || ''),
        businessScenario: str(item.business_scenario || item.businessScenario || ''),
        marketingLine: neutralText(item.marketing_line || item.marketingLine || ''),
        coverUrl: str(item.cover_url || item.coverUrl || ''),
        coverVideoUrl: str(item.cover_video_url || item.coverVideoUrl || ''),
        iconUrl: str(item.icon_url || item.iconUrl || ''),
        searchTerms: asArray(item.search_terms).map(neutralText),
        installed: !!item.installed,
        enabled: item.enabled !== false,
        raw: item,
    };
}

export function itemKey(kind, name) { return str(kind) + ':' + str(name); }

export function normalizeCatalog(payload) {
    const data = unwrapData(payload);
    const items = asArray(data.items).map(normalizeItem).filter(item => item.name);
    const byKey = new Map(items.map(item => [itemKey(item.kind, item.name), item]));
    const categories = asArray(data.categories)
        .filter(cat => cat && (cat.id || cat.label))
        .map(cat => ({ id: str(cat.id || cat.label), label: str(cat.label || cat.id) }));
    const featured = asArray(data.featured)
        .map(ref => byKey.get(itemKey(ref && ref.kind, ref && ref.name)))
        .filter(Boolean);
    const trending = asArray(data.trending_use_cases || data.trendingUseCases).map(useCase => {
        const source = useCase && useCase.item ? byKey.get(itemKey(useCase.item.kind, useCase.item.name)) : null;
        return {
            id: str(useCase && useCase.id),
            title: str(useCase && useCase.title),
            prompt: str(useCase && useCase.prompt),
            context: str(useCase && useCase.context),
            item: source,
        };
    }).filter(useCase => useCase.title && useCase.item);
    return {
        contentVersion: str(data.content_version || data.contentVersion || ''),
        items,
        categories,
        featured,
        trending,
    };
}

export async function fetchCatalog() {
    const res = await fetch('/api/store/catalog', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return normalizeCatalog(await res.json());
}

export function normalizeDetail(payload, fallbackItem) {
    const data = unwrapData(payload);
    const item = normalizeItem({ ...(fallbackItem && fallbackItem.raw ? fallbackItem.raw : fallbackItem), ...data });
    const guide = data.guide && typeof data.guide === 'object' ? data.guide : {};
    const presetGallery = data.preset_gallery && typeof data.preset_gallery === 'object'
        ? {
            hero: normalizeMedia(data.preset_gallery.hero),
            categories: asArray(data.preset_gallery.categories).map(cat => ({ id: str(cat.id || cat.label), label: str(cat.label || cat.id) })),
            presets: asArray(data.preset_gallery.presets).map(normalizePreset).filter(preset => preset.id || preset.title),
        }
        : null;
    const collection = data.collection && typeof data.collection === 'object'
        ? {
            categories: asArray(data.collection.categories).map(cat => ({ id: str(cat.id || cat.label), label: str(cat.label || cat.id) })),
            entries: asArray(data.collection.entries).map(entry => ({
                title: str(entry && entry.title),
                description: str(entry && entry.description),
                category: str(entry && entry.category),
                status: str(entry && entry.status),
                tags: asArray(entry && entry.tags).map(str),
                cover: normalizeMedia(entry && entry.cover),
                item: entry && entry.item ? { kind: str(entry.item.kind || 'skill'), name: str(entry.item.name) } : null,
            })),
        }
        : null;
    return {
        ...item,
        iconStyle: str(data.icon_style),
        installMode: str(data.install_mode),
        starterPrompt: str(data.starter_prompt),
        recommendedModel: data.recommended_model && typeof data.recommended_model === 'object'
            ? { id: str(data.recommended_model.id), displayName: str(data.recommended_model.display_name || data.recommended_model.id) }
            : null,
        guide: {
            summary: str(guide.summary),
            scenarios: asArray(guide.scenarios).map(str),
            steps: normalizeTextEntries(guide.steps),
            outputs: asArray(guide.outputs).map(str),
            requiredContext: normalizeTextEntries(guide.required_context),
            boundaries: asArray(guide.boundaries).map(str),
            useCases: asArray(guide.use_cases).map(useCase => ({ title: str(useCase && useCase.title), description: str(useCase && useCase.description), prompt: str(useCase && useCase.prompt) })),
            followUps: asArray(guide.follow_ups).map(str),
        },
        capabilities: normalizeTextEntries(data.capabilities),
        connectors: normalizeTextEntries(data.connectors),
        presetGallery,
        influencerStudio: normalizeStudio(data.influencer_studio),
        collection,
        introShowcase: normalizeShowcases(data.intro_showcase || data.introShowcase),
        presentation: normalizePresentation(data.presentation),
        library: normalizeLibrary(data.library),
        publicContent: str(data.public_content || data.publicContent || ''),
        tryForm: normalizeTryForm(data.try_form),
        tryFormRaw: data.try_form || null,
        detailUnavailable: data.detail_unavailable === true,
        detailUnavailableReason: str(data.detail_unavailable_reason || '该应用详情由上游暂不提供'),
        skillBodySource: str(data.skill_body_source || ''),
        legacySections: asArray(data.sections).map(sec => ({ id: str(sec && sec.id), title: str(sec && sec.title), body: str(sec && sec.body) })),
        raw: data,
    };
}

function normalizeShowcaseHero(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const media = normalizeMedia(raw.media || raw);
    const alt = neutralText(raw.alt || (raw.media && raw.media.alt) || '');
    if (!media && !alt) return null;
    return { media: media || { kind: 'image', src: '', poster: '', alt: alt }, alt: alt };
}

function normalizeShowcases(value) {
    const list = Array.isArray(value) ? value : (value && typeof value === 'object'
        ? (Array.isArray(value.items) ? value.items : [value]) : []);
    return list.map(item => {
        if (!item || typeof item !== 'object') return null;
        const hero = normalizeShowcaseHero(item.hero);
        const panels = asArray(item.panels).map(normalizeShowcaseHero).filter(Boolean);
        const eyebrow = neutralText(item.eyebrow || '');
        const caption = neutralText(item.caption || '');
        if (!hero && !panels.length && !caption) return null;
        return { layout: str(item.layout || 'even'), eyebrow: eyebrow, caption: caption, hero: hero, panels: panels };
    }).filter(Boolean);
}

function normalizePresentation(raw) {
    if (!raw || typeof raw !== 'object' || !raw.series || typeof raw.series !== 'object') return null;
    const series = raw.series;
    const collection = series.collection && typeof series.collection === 'object'
        ? { kind: str(series.collection.kind || 'skill'), name: str(series.collection.name) }
        : null;
    const creators = asArray(series.creators).map(person => {
        const source = person && typeof person === 'object' ? person : { name: person };
        return {
            name: neutralText(source.name || source.display_name || ''),
            avatar: str(source.avatar || source.avatar_url || source.image || (source.media && source.media.src) || ''),
        };
    }).filter(person => person.name);
    if (!collection && !creators.length && !str(series.title) && !str(series.work_title)) return null;
    return {
        variant: str(raw.variant || ''),
        series: {
            collection: collection,
            title: neutralText(series.title || ''),
            workTitle: neutralText(series.work_title || series.workTitle || ''),
            creators: creators,
        },
    };
}

function normalizeLibrary(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const families = asArray(raw.families).map(family => ({
        id: str(family && (family.id || family.label)),
        label: neutralText(family && (family.label || family.id)),
        items: asArray(family && family.items),
    })).filter(family => family.id || family.label);
    const byId = new Map();
    const sourceTemplates = Array.isArray(raw.templates)
        ? raw.templates
        : Object.entries(raw.templates && typeof raw.templates === 'object' ? raw.templates : {})
            .map(([id, template]) => ({ id, ...(template && typeof template === 'object' ? template : {}) }));
    const collect = (template, fallbackFamily) => {
        if (!template || typeof template !== 'object') return;
        const id = str(template.id || template.template_id || '');
        const name = neutralText(template.name || template.title || id);
        if (!id && !name) return;
        const key = id || name;
        if (byId.has(key)) return;
        const family = str(template.family || fallbackFamily || '');
        byId.set(key, {
            id: key,
            name: name,
            description: neutralText(template.description || ''),
            interaction: neutralText(template.interaction || ''),
            family: family,
            starter: str(template.starter || template.starter_prompt || template.prompt || ''),
            cover: normalizeMedia(template.cover || template.media),
        });
    };
    sourceTemplates.forEach(template => collect(template, ''));
    families.forEach(family => family.items.forEach(template => collect(template, family.id)));
    const featured = asArray(raw.featured_template_ids || raw.featuredTemplateIds).map(str);
    let templates = Array.from(byId.values());
    if (featured.length) {
        const rank = new Map(featured.map((id, index) => [id, index]));
        templates.sort((a, b) => {
            const ai = rank.has(a.id) ? rank.get(a.id) : 999;
            const bi = rank.has(b.id) ? rank.get(b.id) : 999;
            return ai - bi;
        });
    }
    if (!families.length && !templates.length) return null;
    return { families: families.map(({ items, ...family }) => family), templates: templates, featuredIds: featured };
}

function normalizeMedia(media) {
    if (!media || typeof media !== 'object') return null;
    return {
        kind: str(media.kind || 'image'),
        src: str(media.src || media.url || ''),
        poster: str(media.poster || ''),
        alt: str(media.alt || ''),
        objectPosition: str(media.object_position || ''),
    };
}

function normalizeTextEntries(list) {
    return asArray(list).map(entry => {
        if (entry && typeof entry === 'object') return { title: str(entry.title || entry.label || entry.name), description: str(entry.description || entry.desc || '') };
        return { title: str(entry), description: '' };
    }).filter(entry => entry.title || entry.description);
}

function normalizeStudio(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const normalizePersona = persona => {
        const source = persona || {};
        const traits = {};
        for (const [key, value] of Object.entries(source.traits && typeof source.traits === 'object' ? source.traits : {})) {
            traits[key] = asArray(value).map(str);
        }
        return {
            id: str(source.id),
            name: str(source.name || source.id),
            handle: str(source.handle),
            bio: str(source.bio),
            traits,
            format: str(source.format),
            focus: str(source.focus),
            images: {
                base: str(source.images && source.images.base),
                caricature: str(source.images && source.images.caricature),
                turnaround: str(source.images && source.images.turnaround),
            },
        };
    };
    const normalizeTrait = trait => ({
        id: str(trait && trait.id),
        label: str(trait && trait.label),
        section: str(trait && trait.section),
        select: str(trait && trait.select) || 'single',
        max: Number(trait && trait.max) || 0,
        defaults: asArray(trait && trait.default).map(str),
        options: asArray(trait && trait.options).map(option => ({ id: str(option.id), label: str(option.label) })).filter(option => option.id),
    });
    const normalizeFormat = format => ({
        id: str(format && format.id),
        title: str(format && format.title),
        hook: str(format && format.hook),
        description: str(format && format.description),
        cover: normalizeMedia(format && format.cover),
        aspect: str(format && format.aspect) || '9/16',
        beats: asArray(format && format.beats).map(str),
        prompt: str(format && format.prompt),
        idea: str(format && format.idea),
    });
    const references = raw.references && typeof raw.references === 'object'
        ? { min: Number(raw.references.min) || 0, max: Number.isFinite(Number(raw.references.max)) ? Number(raw.references.max) : 0, roles: asArray(raw.references.roles).map(str) }
        : null;
    return {
        view: str(raw.view) || (raw.personas ? 'studio' : 'hub'),
        ticker: asArray(raw.ticker).map(str),
        hero: normalizeMedia(raw.hero),
        heroes: asArray(raw.heroes).map(hero => ({
            persona: str(hero && hero.persona),
            video: str(hero && hero.video),
            poster: str(hero && hero.poster),
            caption: str(hero && hero.caption),
            handle: str(hero && hero.handle),
        })),
        studio: raw.studio && typeof raw.studio === 'object' ? { kind: str(raw.studio.kind), name: str(raw.studio.name) } : null,
        personas: asArray(raw.personas).map(normalizePersona).filter(persona => persona.id || persona.name),
        traits: asArray(raw.traits).map(normalizeTrait).filter(trait => trait.id),
        fields: asArray(raw.fields).map(field => ({
            id: str(field && field.id),
            label: str(field && field.label),
            placeholder: str(field && field.placeholder),
            maxLength: Number(field && field.max_length) || 0,
            section: str(field && field.section),
            formats: asArray(field && field.formats).map(str),
        })).filter(field => field.id),
        formats: asArray(raw.formats).map(normalizeFormat).filter(format => format.id),
        references,
        note: raw.note && typeof raw.note === 'object' ? { maxLength: Number(raw.note.max_length) || 0 } : null,
        clips: asArray(raw.clips).map(clip => ({
            id: str(clip && clip.id),
            video: str(clip && clip.video),
            poster: str(clip && clip.poster),
            handle: str(clip && clip.handle),
            caption: str(clip && clip.caption),
        })),
        agent: raw.agent && typeof raw.agent === 'object'
            ? { skillMention: str(raw.agent.skill_mention), prompt: str(raw.agent.prompt), autoSend: raw.agent.auto_send !== false }
            : null,
        clipPrompt: str(raw.clip_prompt),
        raw,
    };
}

function normalizePreset(preset) {
    const raw = preset || {};
    const inputs = raw.inputs && typeof raw.inputs === 'object' ? raw.inputs : {};
    const refs = inputs.references && typeof inputs.references === 'object' ? inputs.references : {};
    const prompt = inputs.prompt && typeof inputs.prompt === 'object' ? inputs.prompt : {};
    return {
        id: str(raw.id),
        title: str(raw.title || raw.id),
        description: str(raw.description),
        category: str(raw.category),
        aspect: str(raw.aspect || '9/16'),
        isNew: !!raw.is_new,
        cover: normalizeMedia(raw.cover),
        agent: raw.agent && typeof raw.agent === 'object'
            ? { skillMention: str(raw.agent.skill_mention), prompt: str(raw.agent.prompt), autoSend: raw.agent.auto_send !== false }
            : null,
        inputs: {
            references: {
                min: Number(refs.min) || 0,
                max: Number.isFinite(Number(refs.max)) ? Number(refs.max) : 0,
                roles: asArray(refs.roles).map(str),
            },
            prompt: { maxLength: Number(prompt.max_length) || 0 },
            fields: asArray(inputs.fields).map(field => ({
                id: str(field && field.id),
                label: str(field && field.label),
                placeholder: str(field && field.placeholder),
                maxLength: Number(field && field.max_length) || 0,
            })).filter(field => field.id || field.label),
        },
    };
}

function normalizeTryForm(tryForm) {
    if (!tryForm || typeof tryForm !== 'object') return null;
    const refs = tryForm.references && typeof tryForm.references === 'object' ? tryForm.references : {};
    const prompt = tryForm.prompt && typeof tryForm.prompt === 'object' ? tryForm.prompt : {};
    return {
        references: { min: Number(refs.min) || 0, max: Number.isFinite(Number(refs.max)) ? Number(refs.max) : 0 },
        prompt: { maxLength: Number(prompt.max_length) || 0 },
        fields: asArray(tryForm.fields).map(field => ({
            id: str(field && field.id),
            label: str(field && field.label),
            placeholder: str(field && field.placeholder),
            maxLength: Number(field && field.max_length) || 0,
        })).filter(field => field.id || field.label),
    };
}

export async function fetchItemDetail(kind, name) {
    const res = await fetch('/api/store/items/' + encodeURIComponent(kind) + '/' + encodeURIComponent(name), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = unwrapData(await res.json());
    return normalizeDetail(data.item || data);
}

export function buildCounts(items, categories) {
    const counts = { all: items.length, skill: 0, app: 0 };
    const byCategory = {};
    for (const item of items) {
        if (item.kind === 'skill') counts.skill += 1;
        else if (item.kind === 'app') counts.app += 1;
        if (item.businessScenario) byCategory[item.businessScenario] = (byCategory[item.businessScenario] || 0) + 1;
    }
    return {
        ...counts,
        categories: categories.map(cat => ({ ...cat, count: byCategory[cat.id] || 0 })),
    };
}

export function filterItems(items, filter) {
    const query = str(filter && filter.query).trim().toLowerCase();
    const kind = str(filter && filter.kind) || 'all';
    const category = str(filter && filter.category);
    return items.filter(item => {
        if (kind !== 'all' && item.kind !== kind) return false;
        if (category && item.businessScenario !== category) return false;
        if (!query) return true;
        const hay = [item.displayName, item.description, item.category, item.marketingLine, ...item.searchTerms].join(' ').toLowerCase();
        return hay.includes(query);
    });
}

export async function uploadReferences(files) {
    const list = Array.from(files || []);
    if (!list.length) return [];
    const form = new FormData();
    list.forEach(file => form.append('files', file));
    const res = await fetch('/api/ai/upload', { method: 'POST', body: form });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return asArray(data.files).map(file => ({ name: str(file.name), url: str(file.url || file.path), kind: str(file.kind || 'image') }));
}

export async function launchStoreItem(kind, name, body) {
    const res = await fetch('/api/store/items/' + encodeURIComponent(kind) + '/' + encodeURIComponent(name) + '/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(str(unwrapData(data).detail || data.detail) || ('HTTP ' + res.status));
    const result = unwrapData(data);
    return {
        canvasId: str(result.canvas_id || result.canvasId || ''),
        prompt: str(result.prompt || ''),
        project: str(result.project || 'default'),
        skillRef: str(result.skill_ref || result.skillRef || ''),
        raw: result,
    };
}

// 跳画布 + 预填 Agent 输入；只有市场 brief 提交（options.autoSend === true）才自动发送一次，
// 直接打开画布/刷新永远不会自动发。
export function openStoreCanvas(canvasId, prompt, project, options) {
    if (!canvasId) return false;
    const autoSend = !!(options && options.autoSend === true);
    const skillRef = str(options && options.skillRef);
    try {
        localStorage.setItem('novai_canvas_seed:' + canvasId, JSON.stringify({ v: 1, agent: str(prompt), autoSend, skillRef }));
    } catch (e) { /* 本地存储不可用就只跳画布，不让启动失败 */ }
    openCanvasUrl('/static/smart-canvas.html?id=' + encodeURIComponent(canvasId) + '&project=' + encodeURIComponent(project || 'default'));
    return true;
}

export function buildLaunchBody({ prompt, fields, references, presetId, kind, name }) {
    // 与服务端 StoreLaunchRequest 对齐：preset_id + inputs（字段 id -> 值）+ references；
    // 服务端按字段 label 编译「输入：- 字段：值」，补充描述用一个可读 key 落进去。
    const inputs = {};
    for (const [key, value] of Object.entries(fields && typeof fields === 'object' ? fields : {})) {
        if (str(value).trim()) inputs[key] = str(value);
    }
    if (str(prompt).trim()) inputs['补充描述'] = str(prompt).trim();
    return {
        kind: str(kind),
        name: str(name),
        preset_id: str(presetId),
        inputs,
        references: asArray(references).map(ref => ({ name: str(ref.name), url: str(ref.url), kind: str(ref.kind || 'image') })),
        // 不带技能正文：/api/agent/run 的 instruction 上限 4000 字，长手册（如 Skrull）会直接 400；
        // 简短模板 + skill_mention 已足够让画布助手开跑。
        include_skill_body: false,
    };
}
