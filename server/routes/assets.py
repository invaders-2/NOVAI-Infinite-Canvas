from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import shutil
import tempfile
import threading
import urllib.parse
import uuid
import zipfile
from io import BytesIO
from typing import Any, Dict, List, Optional

import httpx
from PIL import Image
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel

from server.agents import store as agent_store
from server.routes.deps import deps

router = APIRouter(prefix="/api")


# --- Pydantic 模型（自 main.py 迁入，字段定义保持不变） ---

class CanvasAssetCheckRequest(BaseModel):
    urls: List[str] = []


class CanvasAssetDownloadRequest(BaseModel):
    urls: List[str] = []
    items: List[Dict[str, Any]] = []
    filename: str = "canvas-output-images.zip"


class LocalAssetCaptionRequest(BaseModel):
    names: List[str] = []
    provider: str = "comfly"
    model: str = ""
    ms_model: str = ""
    prompt: str = "描述图片"


class LocalAssetCaptionSaveRequest(BaseModel):
    name: str = ""
    caption: str = ""


class LocalAssetClassifyRequest(BaseModel):
    names: List[str] = []
    provider: str = "comfly"
    model: str = ""
    ms_model: str = ""
    prompt: str = ""


class LocalAssetUrlImportItem(BaseModel):
    url: str = ""
    name: str = ""
    data: str = ""          # 可选：base64 / dataURL，由插件在网页上下文里读取（blob: 等无法服务端下载的素材）
    content_type: str = ""  # 配合 data 使用，用于推断扩展名


class LocalAssetUrlImportRequest(BaseModel):
    items: List[LocalAssetUrlImportItem] = []
    folder: str = ""
    classify: bool = False
    provider: str = "comfly"
    model: str = ""
    ms_model: str = ""
    prompt: str = ""


class LocalAssetFolderRequest(BaseModel):
    parent: str = ""
    path: str = ""
    name: str = ""


class LocalAssetRenameRequest(BaseModel):
    path: str = ""
    name: str = ""


class AssetLibraryCategoryRequest(BaseModel):
    name: str = "新文件夹"
    type: str = "image"
    library_id: str = ""
    # 父分类 id（空 = 顶级）；子文件夹功能入口
    parent_id: str = ""


class AssetLibraryRequest(BaseModel):
    name: str = "资产库"


class AssetLibraryAddRequest(BaseModel):
    category_id: str = ""
    url: str = ""
    name: str = ""
    library_id: str = ""
    # false = 跳过 AI 分类（只落库立即返回）；默认 true 但分类在后台跑，不阻塞保存
    classify: bool = True


class AssetLibraryBatchAddRequest(BaseModel):
    category_id: str = ""
    library_id: str = ""
    items: List[AssetLibraryAddRequest] = []
    classify: bool = True


def _generation_sidecar(rel):
    """本地上传的生成信息旁车文件（与 .classification.json 同基名）。"""
    return deps._local_upload_classification_path(rel)[:-len(".classification.json")] + ".generation.json"


class SharedFolderRegister(BaseModel):
    path: str = ""
    name: str = ""


class SharedFolderImport(BaseModel):
    library_id: str = ""
    category_id: str = ""
    folder_id: str = ""
    paths: List[str] = []


class AssetLibraryRenameRequest(BaseModel):
    name: str = ""
    library_id: str = ""
    # 可选：改名同时改分类类型（image/video/audio；workflow 不允许改）
    type: str = ""
    # 可选：移动分类（None=不改；""=移到顶级；其它=挂到该父分类下）
    parent_id: Optional[str] = None


class AssetLibraryBatchDeleteRequest(BaseModel):
    ids: List[str] = []
    library_id: str = ""


class AssetLibraryBatchMoveRequest(BaseModel):
    ids: List[str] = []
    library_id: str = ""
    target_library_id: str = ""
    target_category_id: str = ""


class AssetLibraryBatchCropRequest(BaseModel):
    ids: List[str] = []
    library_id: str = ""
    target_library_id: str = ""
    target_category_id: str = ""
    mode: str = "square"


class AssetAvatarRegisterRequest(BaseModel):
    library_id: str = ""
    provider_id: str = ""
    project_name: str = "default"
    group_name: str = ""


class AssetLibraryClassifyRequest(BaseModel):
    library_id: str = ""
    ids: List[str] = []
    provider: str = "comfly"
    model: str = ""
    ms_model: str = ""
    prompt: str = ""


class PromptLibraryRequest(BaseModel):
    name: str = "提示词库"


class PromptLibraryItemRequest(BaseModel):
    library_id: str = ""
    item_id: str = ""
    name: str = "提示词"
    category: str = "custom"
    positive: str = ""
    negative: str = ""
    scene: str = ""


class PromptLibraryBatchDeleteRequest(BaseModel):
    ids: List[str] = []


class PromptLibraryCategoryRequest(BaseModel):
    name: str = "新分组"
    library_id: str = ""


class StoragePathPayload(BaseModel):
    data_root: str = ""


class AssetRegisterRequest(BaseModel):
    url: str = ""
    name: str = ""
    kind: str = ""
    mime: str = ""
    natural_w: int = 0
    natural_h: int = 0
    canvas_id: str = ""
    source: str = ""
    asset_id: str = ""
    created_at: int = 0


# --- import-urls 的类型兜底：CDN 不给正确 Content-Type 时按文件头魔数识别 ---
# 花瓣等图床的"原图"地址常常返回 application/octet-stream 且路径没有扩展名，
# 这时按魔数识别成图片/视频再落盘；识别不出才走原来的报错文案。

_MEDIA_SNIFF_BYTES = 64
# ftyp 的 major brand：这些归 mp4（M4V/3gp 也属 mp4 家族），qt 归 mov
_MP4_FTYP_BRANDS = (
    b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6", b"mp41", b"mp42",
    b"avc1", b"dash", b"mmp4", b"MSNV", b"M4V ", b"M4VH", b"M4VP", b"f4v ",
    b"3gp4", b"3gp5", b"3g2a", b"3g2b",
)


def _sniff_media_ext(head):
    """按文件头识别媒体格式，返回 (kind, ext)；识别不出返回 None。

    图片复用 deps._sniff_image_ext_bytes（png/jpg/webp/gif/bmp），这里再补 avif；
    视频认 mp4/ftyp、mov/ftyp-qt、webm/EBML 头。
    """
    head = head or b""
    image_ext = deps._sniff_image_ext_bytes(head)
    if image_ext:
        return "image", image_ext
    if len(head) >= 12 and head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand in (b"avif", b"avis"):
            return "image", ".avif"
        if brand == b"qt  ":
            return "video", ".mov"
        if brand in _MP4_FTYP_BRANDS or brand.startswith(b"3g"):
            return "video", ".mp4"
        return None
    if head[:4] == b"\x1aE\xdf\xa3" and b"webm" in head[:_MEDIA_SNIFF_BYTES].lower():
        return "video", ".webm"
    return None


def _resolve_media_kind_ext(name_path, content_type, content):
    """决定落盘的 (kind, ext)：先按 Content-Type/扩展名，认不出再按文件头魔数。"""
    kind, ext = deps._local_upload_kind_ext(name_path, content_type)
    if kind not in ("image", "video"):
        sniffed = _sniff_media_ext((content or b"")[:_MEDIA_SNIFF_BYTES])
        if sniffed:
            return sniffed
    if kind == "image":
        real = deps._sniff_image_ext_bytes((content or b"")[:16])
        if real and not (real == ".jpg" and ext == ".jpeg"):
            ext = real
    return kind, ext


# --- 素材 handler（自 main.py 迁入，函数体照抄，模块级符号改为 deps.XXX） ---

# ===== local-assets 族 =====

@router.post("/local-assets/upload")
async def upload_local_assets(files: List[UploadFile] = File(...), folder: str = Form("")):
    uploaded = []
    folder_rel, folder_abs = deps._local_upload_safe_folder(folder)
    os.makedirs(folder_abs, exist_ok=True)
    for file in files:
        content = await file.read()
        if not content:
            continue
        kind, ext = deps._local_upload_kind_ext(file.filename, file.content_type)
        if kind is None:
            continue
        base = os.path.splitext(os.path.basename(file.filename or "file"))[0]
        base = re.sub(r"[^0-9A-Za-z一-鿿._-]+", "_", base).strip("_") or "file"
        base = base[:60]
        filename = f"up_{uuid.uuid4().hex[:12]}_{base}{ext}"
        rel_name = f"{folder_rel}/{filename}".lstrip("/")
        path = os.path.join(folder_abs, filename)
        with open(path, "wb") as f:
            f.write(content)
        if kind == "image":
            classification = await deps.classify_asset_image_best_effort(path)
            if classification:
                deps._write_local_upload_classification(rel_name, classification)
        uploaded.append(deps._local_upload_item(rel_name))
    return {"files": uploaded}


@router.post("/local-assets/import-urls")
async def import_local_assets_from_urls(payload: LocalAssetUrlImportRequest):
    uploaded = []
    results = []
    folder_rel, folder_abs = deps._local_upload_safe_folder(payload.folder)
    os.makedirs(folder_abs, exist_ok=True)
    timeout = httpx.Timeout(connect=20.0, read=120.0, write=30.0, pool=20.0)
    async with httpx.AsyncClient(http2=False, verify=deps._SSL_CONTEXT, trust_env=deps._TRUST_ENV, timeout=timeout, follow_redirects=True, headers={"User-Agent": "Infinite-Canvas-Asset-Importer/1.0"}) as client:
        for entry in (payload.items or [])[:200]:
            src_url = str(entry.url or "").strip()
            inline_data = str(entry.data or "").strip()
            result = {"url": src_url, "ok": False, "file": "", "error": ""}
            if not inline_data and not src_url.startswith(("http://", "https://")):
                result["error"] = "仅支持 http(s) 素材地址"
                results.append(result)
                continue
            try:
                if inline_data:
                    # 插件已在网页上下文里把字节读成 base64（dataURL 形如 data:<ct>;base64,<payload>）
                    content_type = str(entry.content_type or "").split(";", 1)[0].strip().lower()
                    b64 = inline_data
                    if inline_data.startswith("data:"):
                        header, _, b64 = inline_data.partition(",")
                        if not content_type:
                            content_type = header[5:].split(";", 1)[0].strip().lower()
                    try:
                        content = base64.b64decode(b64, validate=False)
                    except Exception:
                        raise HTTPException(status_code=400, detail="素材数据无法解码")
                    name_path = urllib.parse.urlparse(src_url).path
                else:
                    response = await client.get(src_url)
                    response.raise_for_status()
                    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
                    content = response.content
                    name_path = urllib.parse.urlparse(src_url).path
                # Content-Type 认不出时按魔数兜底（花瓣原图常返回 application/octet-stream）
                kind, ext = _resolve_media_kind_ext(name_path, content_type, content)
                if kind not in ("image", "video"):
                    raise HTTPException(status_code=400, detail=f"不是图片或视频资源：{content_type or src_url}")
                if not content:
                    raise HTTPException(status_code=400, detail="素材内容为空")
                # entry.name 可能自带扩展名（采集器常传完整文件名），先 splitext 去掉，否则会和下面拼接的 ext 叠成 .png.png
                if entry.name:
                    base = os.path.splitext(entry.name)[0]
                else:
                    base = os.path.splitext(os.path.basename(urllib.parse.unquote(name_path)))[0]
                base = base or ("web-video" if kind == "video" else "web-image")
                base = re.sub(r"[^0-9A-Za-z一-鿿._-]+", "_", base).strip("_") or ("web-video" if kind == "video" else "web-image")
                base = base[:60]
                # 兜底：若 base 末尾已是同一扩展名，去掉一层再拼，杜绝重复后缀
                if ext and base.lower().endswith(ext.lower()):
                    base = base[:-len(ext)].rstrip(".") or ("web-video" if kind == "video" else "web-image")
                filename = f"up_{uuid.uuid4().hex[:12]}_{base}{ext}"
                rel_name = f"{folder_rel}/{filename}".lstrip("/")
                path = os.path.join(folder_abs, filename)
                with open(path, "wb") as f:
                    f.write(content)
                if payload.classify and kind == "image":
                    classification = await deps.classify_asset_image_best_effort(path, payload.provider, payload.model, payload.ms_model, payload.prompt)
                    if classification:
                        deps._write_local_upload_classification(rel_name, classification)
                # 从画布存进来的生成图：把提示词 / 模型等生成信息一起带过来
                try:
                    gen = await asyncio.to_thread(deps.generation_meta_for_url, src_url)
                    if gen:
                        deps._write_local_upload_generation(rel_name, gen)
                except Exception:
                    pass
                item = deps._local_upload_item(rel_name)
                uploaded.append(item)
                result.update({"ok": True, "file": rel_name, "item": item})
            except HTTPException as exc:
                result["error"] = str(exc.detail or "导入失败")
            except Exception as exc:
                result["error"] = str(exc) or "导入失败"
            results.append(result)
    return {"ok": True, "count": len(uploaded), "files": uploaded, "items": results}


@router.get("/local-assets")
async def list_local_assets(folder: str = "", q: str = "", limit: int = 0):
    tree, items = deps._local_upload_tree_and_items()
    items = [item for item in (items or []) if isinstance(item, dict)]
    # folders 汇总（不改既有 items/tree 契约）：前端可直接拿它渲染文件夹列表，不用自己扫 tree
    folder_counts = {}
    for item in items:
        path = str(item.get("folder") or "").replace("\\", "/").strip("/")
        folder_counts[path] = folder_counts.get(path, 0) + 1
    folders = [{"path": path, "name": path.rsplit("/", 1)[-1] if path else "全部上传", "count": count}
               for path, count in sorted(folder_counts.items())]
    folder_key = str(folder or "").replace("\\", "/").strip().strip("/")
    query = str(q or "").strip().lower()
    try:
        limit_value = max(0, min(int(limit or 0), 2000))
    except (TypeError, ValueError):
        limit_value = 0

    def _match(item):
        item_folder = str(item.get("folder") or "").replace("\\", "/").strip("/")
        if folder_key and folder_key not in ("__root__", "root"):
            if item_folder != folder_key and not item_folder.startswith(folder_key + "/"):
                return False
        elif folder_key:
            if item_folder:
                return False
        if query:
            haystack = " ".join(str(item.get(key) or "") for key in
                                ("name", "caption", "file", "classification")).lower()
            if query not in haystack:
                return False
        return True

    filtered = [item for item in items if _match(item)]
    limited = filtered[:limit_value] if limit_value else filtered
    return {"items": limited, "tree": tree, "folders": folders,
            "count": len(limited), "total": len(items)}


@router.post("/local-assets/folders")
async def create_local_asset_folder(payload: LocalAssetFolderRequest, request: Request):
    deps.ensure_same_origin_request(request)
    parent_rel, parent_abs = deps._local_upload_safe_folder(payload.parent)
    if not os.path.isdir(parent_abs):
        raise HTTPException(status_code=404, detail="父文件夹不存在")
    name = deps._local_upload_safe_folder_name(payload.name)
    rel = f"{parent_rel}/{name}".lstrip("/")
    _, abs_path = deps._local_upload_safe_folder(rel)
    if os.path.exists(abs_path):
        raise HTTPException(status_code=400, detail="同名文件夹已存在")
    os.makedirs(abs_path, exist_ok=False)
    tree, items = deps._local_upload_tree_and_items()
    return {"ok": True, "folder": {"path": rel, "name": name}, "tree": tree, "items": items}


@router.patch("/local-assets/folders")
async def rename_local_asset_folder(payload: LocalAssetFolderRequest, request: Request):
    deps.ensure_same_origin_request(request)
    rel, abs_path = deps._local_upload_safe_folder(payload.path)
    if not rel:
        raise HTTPException(status_code=400, detail="根目录不能重命名")
    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=404, detail="文件夹不存在")
    name = deps._local_upload_safe_folder_name(payload.name)
    parent = os.path.dirname(rel).replace("\\", "/")
    new_rel = f"{parent}/{name}".lstrip("/")
    _, new_abs = deps._local_upload_safe_folder(new_rel)
    if os.path.exists(new_abs):
        raise HTTPException(status_code=400, detail="同名文件夹已存在")
    os.rename(abs_path, new_abs)
    tree, items = deps._local_upload_tree_and_items()
    return {"ok": True, "folder": {"path": new_rel, "name": name}, "tree": tree, "items": items}


@router.patch("/local-assets/items")
async def rename_local_asset_item(payload: LocalAssetRenameRequest, request: Request):
    deps.ensure_same_origin_request(request)
    rel, abs_path = deps._local_upload_safe_path(payload.path)
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="本地素材不存在")
    kind, ext = deps._local_upload_kind_ext(rel, "")
    if kind is None:
        raise HTTPException(status_code=400, detail="不支持的素材类型")
    new_stem = deps._local_upload_safe_file_stem(payload.name)
    old_ext = os.path.splitext(rel)[1] or ext
    parent = os.path.dirname(rel).replace("\\", "/")
    new_rel = f"{parent}/{new_stem}{old_ext}".lstrip("/")
    if new_rel == rel:
        tree, items = deps._local_upload_tree_and_items()
        return {"ok": True, "item": deps._local_upload_item(rel), "tree": tree, "items": items}
    _, new_abs = deps._local_upload_abs(new_rel)
    if os.path.exists(new_abs):
        raise HTTPException(status_code=400, detail="同名素材已存在")
    os.rename(abs_path, new_abs)
    old_caption = deps._local_upload_caption_path(rel)
    new_caption = deps._local_upload_caption_path(new_rel)
    if os.path.isfile(old_caption) and not os.path.exists(new_caption):
        os.rename(old_caption, new_caption)
    old_classification = deps._local_upload_classification_path(rel)
    new_classification = deps._local_upload_classification_path(new_rel)
    if os.path.isfile(old_classification) and not os.path.exists(new_classification):
        os.rename(old_classification, new_classification)
    old_gen, new_gen = _generation_sidecar(rel), _generation_sidecar(new_rel)
    if os.path.isfile(old_gen) and not os.path.exists(new_gen):
        os.rename(old_gen, new_gen)
    tree, items = deps._local_upload_tree_and_items()
    return {"ok": True, "item": deps._local_upload_item(new_rel), "old_path": rel, "tree": tree, "items": items}


@router.post("/local-assets/delete")
async def delete_local_assets(payload: dict, request: Request):
    deps.ensure_same_origin_request(request)
    names = payload.get("names") if isinstance(payload, dict) else None
    if not isinstance(names, list):
        names = []
    deleted = []
    for name in names:
        try:
            rel, path = deps._local_upload_safe_path(name)
        except HTTPException:
            continue
        if os.path.isfile(path):
            try:
                os.remove(path)
                txt_path = deps._local_upload_caption_path(rel)
                if os.path.isfile(txt_path):
                    os.remove(txt_path)
                cls_path = deps._local_upload_classification_path(rel)
                if os.path.isfile(cls_path):
                    os.remove(cls_path)
                gen_path = _generation_sidecar(rel)
                if os.path.isfile(gen_path):
                    os.remove(gen_path)
                deleted.append(rel)
            except OSError:
                pass
    return {"deleted": deleted}


@router.post("/local-assets/move")
async def move_local_assets(payload: dict, request: Request):
    """把选中的本地素材移动到目标文件夹（folder 为空表示根目录）；连同 .txt / .classification.json 兄弟文件一起搬。"""
    deps.ensure_same_origin_request(request)
    names = payload.get("names") if isinstance(payload, dict) else None
    if not isinstance(names, list) or not names:
        raise HTTPException(status_code=400, detail="没有选择素材")
    folder_value = str(payload.get("folder") or "").strip() if isinstance(payload, dict) else ""
    target_rel, target_abs = deps._local_upload_safe_folder(folder_value)
    if target_rel and not os.path.isdir(target_abs):
        raise HTTPException(status_code=404, detail="目标文件夹不存在")
    moved = 0
    for name in names:
        try:
            rel, abs_path = deps._local_upload_safe_path(name)
        except HTTPException:
            continue
        if not os.path.isfile(abs_path):
            continue
        base = os.path.basename(rel)
        new_rel = f"{target_rel}/{base}".lstrip("/") if target_rel else base
        if new_rel == rel:
            continue  # 已在目标文件夹，跳过
        _, new_abs = deps._local_upload_abs(new_rel)
        if os.path.exists(new_abs):
            # 同名冲突：加短随机后缀，避免覆盖已有文件
            stem, ext = os.path.splitext(base)
            base = f"{stem}_{uuid.uuid4().hex[:6]}{ext}"
            new_rel = f"{target_rel}/{base}".lstrip("/") if target_rel else base
            _, new_abs = deps._local_upload_abs(new_rel)
        try:
            os.makedirs(os.path.dirname(new_abs), exist_ok=True)
            os.rename(abs_path, new_abs)
            for src_sib, dst_sib in (
                (deps._local_upload_caption_path(rel), deps._local_upload_caption_path(new_rel)),
                (deps._local_upload_classification_path(rel), deps._local_upload_classification_path(new_rel)),
                (_generation_sidecar(rel), _generation_sidecar(new_rel)),
            ):
                if os.path.isfile(src_sib) and not os.path.exists(dst_sib):
                    os.rename(src_sib, dst_sib)
            moved += 1
        except OSError:
            continue
    tree, items = deps._local_upload_tree_and_items()
    return {"ok": True, "moved": moved, "items": items, "tree": tree}


@router.post("/local-assets/caption")
async def caption_local_assets(payload: LocalAssetCaptionRequest):
    prompt = (payload.prompt or "描述图片").strip() or "描述图片"
    items = []
    ok_count = 0
    for name in (payload.names or [])[:100]:
        item = {"name": name, "ok": False, "caption": "", "caption_file": "", "error": ""}
        try:
            filename, path = deps._local_upload_safe_path(name)
            if not os.path.isfile(path):
                raise HTTPException(status_code=404, detail="文件不存在")
            kind, _ = deps._local_upload_kind_ext(filename, "")
            if kind != "image":
                raise HTTPException(status_code=400, detail="仅支持图片素材反推提示词")
            caption, resolved_model = await deps.caption_image_with_provider(
                path,
                prompt,
                payload.provider,
                payload.model,
                payload.ms_model,
            )
            txt_path = deps._local_upload_caption_path(filename)
            with open(txt_path, "w", encoding="utf-8", newline="") as f:
                f.write(caption)
            item.update({
                "ok": True,
                "name": filename,
                "caption": caption,
                "caption_file": os.path.basename(txt_path),
                "model": resolved_model,
            })
            ok_count += 1
        except HTTPException as exc:
            item["error"] = str(exc.detail or "反推失败")
        except Exception as exc:
            item["error"] = str(exc) or "反推失败"
        items.append(item)
    return {"ok": True, "count": ok_count, "items": items}


@router.post("/local-assets/classify")
async def classify_local_assets(payload: LocalAssetClassifyRequest):
    items = []
    ok_count = 0
    for name in (payload.names or [])[:80]:
        item = {"name": name, "ok": False, "classification": None, "classification_file": "", "error": ""}
        try:
            filename, path = deps._local_upload_safe_path(name)
            if not os.path.isfile(path):
                raise HTTPException(status_code=404, detail="文件不存在")
            kind, _ = deps._local_upload_kind_ext(filename, "")
            if kind != "image":
                raise HTTPException(status_code=400, detail="仅支持图片素材智能分类")
            classification = await deps.classify_image_with_provider(
                path,
                payload.provider,
                payload.model,
                payload.ms_model,
                payload.prompt,
            )
            deps._write_local_upload_classification(filename, classification)
            item.update({
                "ok": True,
                "name": filename,
                "classification": classification,
                "classification_file": os.path.basename(deps._local_upload_classification_path(filename)),
                "model": classification.get("model") or "",
            })
            ok_count += 1
        except HTTPException as exc:
            item["error"] = str(exc.detail or "智能分类失败")
        except Exception as exc:
            item["error"] = str(exc) or "智能分类失败"
        items.append(item)
    return {"ok": True, "count": ok_count, "items": items}


@router.patch("/local-assets/caption")
async def save_local_asset_caption(payload: LocalAssetCaptionSaveRequest):
    filename, path = deps._local_upload_safe_path(payload.name)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件不存在")
    kind, _ = deps._local_upload_kind_ext(filename, "")
    if kind != "image":
        raise HTTPException(status_code=400, detail="仅支持图片素材保存提示词")
    caption = str(payload.caption or "")[:100000]
    txt_path = deps._local_upload_caption_path(filename)
    with open(txt_path, "w", encoding="utf-8", newline="") as f:
        f.write(caption)
    return {"ok": True, "caption": caption, "caption_file": os.path.basename(txt_path)}


# ===== asset-library / prompt-libraries / shared-folders 族 =====

_ASSET_LIBRARY_MEDIA_TYPES = ("image", "video", "audio")
_ASSET_LIBRARY_MEDIA_LABELS = {"image": "图片", "video": "视频", "audio": "音频"}
_ASSET_LIBRARY_AUTO_CATEGORY = {"video": ("videos", "视频"), "audio": ("audios", "音频")}


def _asset_library_parent_id(cat) -> str:
    return str((cat or {}).get("parent_id") or "").strip()


def _asset_library_children(categories, category_id):
    return [cat for cat in categories if _asset_library_parent_id(cat) == category_id]


def _asset_library_descendants(categories, category_id):
    """返回该分类下的所有子孙分类 id（不含自己），用于递归删除/防环。"""
    descendants = set()
    frontier = {category_id}
    guard = 0
    while frontier and guard < 1000:
        guard += 1
        next_frontier = set()
        for cat in categories:
            cat_id = str(cat.get("id") or "")
            if cat_id and cat_id not in descendants and cat_id != category_id and _asset_library_parent_id(cat) in frontier:
                descendants.add(cat_id)
                next_frontier.add(cat_id)
        frontier = next_frontier
    return descendants


def _asset_library_subtree(categories, category_id):
    """该分类自己 + 所有子孙分类（父在前）。"""
    ids = {category_id} | _asset_library_descendants(categories, category_id)
    return [cat for cat in categories if str(cat.get("id") or "") in ids]


def _asset_library_child_dir(library, parent_cat, name, current_id=""):
    """子分类的磁盘目录：父 dir + 唯一子目录名，真正嵌套在 library/<父>/<子>/。"""
    parent_dir = str(parent_cat.get("dir") or "").strip("/").strip()
    base = deps.sanitize_asset_name(name or "子文件夹", "子文件夹").strip(" .") or "子文件夹"
    siblings = {
        str(cat.get("dir") or "").rstrip("/").rsplit("/", 1)[-1]
        for cat in (library.get("categories") or [])
        if _asset_library_parent_id(cat) == str(parent_cat.get("id") or "") and str(cat.get("id") or "") != current_id
    }
    candidate = base
    index = 2
    while candidate in siblings or os.path.exists(os.path.join(deps.ASSET_LIBRARY_DIR, parent_dir, candidate)):
        candidate = f"{base}_{index}"
        index += 1
    return f"{parent_dir}/{candidate}".strip("/") if parent_dir else candidate


def _asset_library_media_type(cat) -> str:
    """分类的媒体类型：image/video/audio；workflow 与未知都按 image 处理（兼容老分类）。"""
    cat_type = str((cat or {}).get("type") or "image").strip().lower()
    return cat_type if cat_type in _ASSET_LIBRARY_MEDIA_TYPES else "image"


def _ensure_asset_library_media_category(lib, library, media_kind):
    """按媒体类型找分类；视频/音频没有就自动建「视频」「音频」。
    只在真正需要时追加，不动 characters/scenes/workflows 的结构与 type。"""
    categories = library.setdefault("categories", [])
    category = next((cat for cat in categories if _asset_library_media_type(cat) == media_kind), None)
    if category:
        return category
    preset = _ASSET_LIBRARY_AUTO_CATEGORY.get(media_kind)
    if not preset:
        return None
    base_id, label = preset
    existing_ids = {str(cat.get("id") or "") for cat in categories}
    category_id = base_id if base_id not in existing_ids else f"cat_{uuid.uuid4().hex[:12]}"
    category = {"id": category_id, "name": label, "type": media_kind, "items": []}
    categories.append(category)
    if (library.get("id") or "") == (lib.get("active_library_id") or ""):
        lib["categories"] = categories
    return category


def _resolve_asset_library_target_category(lib, library, category_id, media_kind):
    """返回 (category, error)。category_id 为空/auto 时按媒体类型自动选或建分类；
    指定分类时校验类型匹配：图片分类不能收视频/音频，反之亦然。"""
    wanted = str(category_id or "").strip()
    if not wanted or wanted.lower() in ("auto", "auto_media", "auto:media"):
        return _ensure_asset_library_media_category(lib, library, media_kind), ""
    category = deps.find_asset_category_in_library(lib, wanted, library.get("id") or "")
    if not category:
        return None, "分类不存在"
    category_type = _asset_library_media_type(category)
    if category_type != media_kind:
        want_label = _ASSET_LIBRARY_MEDIA_LABELS.get(media_kind, media_kind)
        cat_label = _ASSET_LIBRARY_MEDIA_LABELS.get(category_type, category_type)
        return None, (f"分类「{category.get('name') or category_type}」是{cat_label}分类，"
                      f"不能存{want_label}；请换到{want_label}分类（没有时留空 category_id 会自动创建）")
    return category, ""


def _find_asset_library_item(lib, item_id, library_id=""):
    library = deps.find_asset_library(lib, library_id)
    if not library:
        return None
    for cat in library.get("categories") or []:
        for item in cat.get("items") or []:
            if isinstance(item, dict) and item.get("id") == item_id:
                return item
    return None


_ASSET_LIBRARY_CLASSIFY_LOCK = threading.Lock()


def _classify_asset_item_background(item_id, src, library_id=""):
    """后台跑 AI 分类：完成后重新加载资产库更新该条目并落盘（save_asset_library 内部会广播 ws）。
    分类失败只打日志，条目保持可用，前端仍可手动点分类。"""
    if not item_id or not src:
        return
    try:
        classification = asyncio.run(deps.classify_asset_image_best_effort(src))
    except Exception as exc:
        print(f"[AssetLibrary] 后台分类失败 item={item_id}: {exc}", flush=True)
        return
    if not classification:
        return
    try:
        with _ASSET_LIBRARY_CLASSIFY_LOCK:
            lib = deps.load_asset_library()
            item = _find_asset_library_item(lib, item_id, library_id)
            if not item:
                return
            item["classification"] = classification
            deps.save_asset_library(lib)
        print(f"[AssetLibrary] 后台分类完成 item={item_id}", flush=True)
    except Exception as exc:
        print(f"[AssetLibrary] 后台分类写库失败 item={item_id}: {exc}", flush=True)


def _spawn_asset_library_classification(item, src, library_id=""):
    """图片条目落库后异步触发分类（daemon 线程），请求不等它。"""
    if not isinstance(item, dict) or item.get("kind") != "image" or not item.get("id"):
        return False
    path = deps.output_file_from_url(item.get("url") or "") or src
    if not path:
        return False
    threading.Thread(target=_classify_asset_item_background,
                     args=(str(item.get("id") or ""), path, library_id), daemon=True).start()
    return True


def _asset_library_src_or_error(url):
    src = deps.output_file_from_url(url)
    if not src:
        raise HTTPException(status_code=400, detail="只支持保存本地 /assets 或 /output 媒体（图片/视频/音频）")
    media_kind = deps.asset_library_media_kind(src)
    if media_kind not in _ASSET_LIBRARY_MEDIA_TYPES:
        raise HTTPException(status_code=400, detail="该文件类型不能存进素材库（工作流请用工作流上传接口）")
    return src, media_kind

@router.post("/asset-library/workflows/upload")
async def upload_asset_library_workflows(
    files: List[UploadFile] = File(...),
    library_id: str = Form(""),
    category_id: str = Form(""),
):
    lib = deps.load_asset_library()
    _, cat = deps.asset_library_workflow_category(lib, library_id, category_id)
    added = []
    for file in files[:100]:
        raw = await file.read()
        filename = file.filename or "canvas-workflow.zip"
        lower = filename.lower()
        if not (lower.endswith(".json") or lower.endswith(".zip") or raw[:2] == b"PK"):
            continue
        item = deps.make_workflow_library_item_from_bytes(raw, filename, os.path.splitext(filename)[0])
        cat.setdefault("items", []).append(item)
        added.append(item)
    if not added:
        raise HTTPException(status_code=400, detail="没有可上传的工作流文件")
    deps.save_asset_library(lib)
    return {"library": lib, "items": added}


@router.get("/asset-library")
async def get_asset_library():
    return {"library": deps.load_asset_library()}


@router.get("/asset-library/items/{item_id}/workflow")
async def get_asset_library_item_workflow(item_id: str):
    """读回工作流条目的 JSON 内容（模板面板/个人模板用）。

    浏览器端原来直接 fetch item.url（/assets/library/...）：生产同源能取到，
    但 vite dev 只代理 /api，静态路径 404 → 模板读不出来。这里统一走 API，
    dev / 生产行为一致；文件只允许落在 ASSET_LIBRARY_DIR 下。
    """
    lib = deps.load_asset_library()
    found = None
    for library in lib.get("libraries", []):
        for cat in library.get("categories", []):
            for item in cat.get("items", []):
                if str(item.get("id") or "") == item_id:
                    found = item
                    break
            if found:
                break
        if found:
            break
    if not found or str(found.get("kind") or "") != "workflow":
        raise HTTPException(status_code=404, detail="工作流条目不存在")
    raw_url = urllib.parse.unquote(str(found.get("url") or "").split("?")[0])
    name = os.path.basename(raw_url)
    base = os.path.abspath(deps.ASSET_LIBRARY_DIR)
    path = os.path.abspath(os.path.join(base, name))
    if not name or not path.startswith(base + os.sep):
        raise HTTPException(status_code=404, detail="工作流文件不存在")
    if path.lower().endswith(".zip"):
        raise HTTPException(status_code=415, detail="压缩包格式的模板暂不支持读取")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="工作流文件不存在")
    try:
        with open(path, "r", encoding="utf-8") as f:
            workflow = json.load(f)
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="工作流文件不是合法 JSON：%s" % exc)
    return {"ok": True, "workflow": workflow}


# ===== 智能体/技能产物（只读）：让资产库也能看到能力运行生成的文件 =====
# 产物落在 {DATA_DIR}/agent_outputs/<run_id>/，运行记录在 {DATA_DIR}/agent_runs/<run_id>.json。
# 这里只扫描、只返回：不写入资产库索引，既有接口的字段含义与行为都不变。

_AGENT_ARTIFACT_KIND_BY_EXT = {
    ".html": "html", ".htm": "html",
    ".xlsx": "xlsx", ".xlsm": "xlsx", ".xls": "xlsx",
    ".csv": "csv",
    ".md": "markdown", ".markdown": "markdown",
    ".txt": "text",
    ".pdf": "pdf",
    ".doc": "doc", ".docx": "doc",
    ".json": "json",
    ".zip": "zip",
}


def _agent_artifact_kind(name: str, declared: str = "") -> str:
    ext = os.path.splitext(str(name or ""))[1].lower()
    return _AGENT_ARTIFACT_KIND_BY_EXT.get(ext) or str(declared or "file")


def _agent_run_record(runs_dir: str, run_id: str) -> Dict[str, Any]:
    path = os.path.join(runs_dir, "%s.json" % run_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            record = json.load(f)
    except Exception:
        return {}
    return record if isinstance(record, dict) else {}


def _agent_artifact_item(run_id: str, name: str, path: str,
                         declared_kind: str, record: Dict[str, Any]) -> Dict[str, Any]:
    try:
        size = os.path.getsize(path)
        mtime_ms = int(os.path.getmtime(path) * 1000)
    except OSError:
        size, mtime_ms = 0, 0
    try:
        updated = float(record.get("updated_at") or record.get("created_at") or 0)
    except (TypeError, ValueError):
        updated = 0.0
    source = str(record.get("capability_name") or record.get("capability_id") or "").strip()
    return {
        "id": "artifact:%s:%s" % (run_id, name),
        "name": name,
        "url": agent_store.artifact_url(run_id, name),
        "kind": _agent_artifact_kind(name, declared_kind),
        "size": size,
        # 与资产库条目同口径：毫秒时间戳（asset_library 用 now_ms 写入）
        "created_at": int(updated * 1000) if updated else mtime_ms,
        "source": source or "智能体产物",
        "category": source,
        "run_id": run_id,
    }


@router.get("/asset-library/agent-artifacts")
async def list_agent_artifacts():
    data_dir = str(deps.DATA_DIR or "")
    runs_dir = os.path.join(data_dir, "agent_runs")
    outputs_dir = os.path.join(data_dir, "agent_outputs")
    items: List[Dict[str, Any]] = []
    if os.path.isdir(outputs_dir):
        for run_id in sorted(os.listdir(outputs_dir)):
            if run_id.startswith("."):
                continue
            run_dir = os.path.join(outputs_dir, run_id)
            if not os.path.isdir(run_dir):
                continue
            record = _agent_run_record(runs_dir, run_id)
            declared: Dict[str, str] = {}
            for artifact in record.get("artifacts") or []:
                if isinstance(artifact, dict) and artifact.get("name"):
                    declared[str(artifact["name"])] = str(artifact.get("kind") or "")
            for name in sorted(os.listdir(run_dir)):
                path = os.path.join(run_dir, name)
                # 产物接口按 safe_filename 定位文件，名字不规范的跳过，避免列出打不开的死链
                if name.startswith(".") or not os.path.isfile(path):
                    continue
                if agent_store.safe_filename(name) != name:
                    continue
                items.append(_agent_artifact_item(run_id, name, path, declared.get(name, ""), record))
    items.sort(key=lambda it: int(it.get("created_at") or 0), reverse=True)
    return {"items": items, "count": len(items)}


@router.get("/prompt-libraries")
async def get_prompt_libraries():
    return {"library": deps.public_prompt_libraries()}


@router.post("/prompt-libraries")
async def create_prompt_library(payload: PromptLibraryRequest):
    data = deps.load_prompt_libraries()
    library = {
        "id": f"lib_{uuid.uuid4().hex[:12]}",
        "name": deps.sanitize_asset_name(payload.name, "提示词库"),
        "type": "prompt",
        "categories": [],
        "items": [],
    }
    data.setdefault("libraries", []).append(library)
    data["active_library_id"] = library["id"]
    data = deps.save_prompt_libraries(data)
    new_lib = next((lib for lib in data.get("libraries", []) if lib.get("id") == library["id"]), library)
    return {"library": deps.public_prompt_libraries(data), "prompt_library": new_lib}


@router.patch("/prompt-libraries/{library_id}")
async def rename_prompt_library(library_id: str, payload: PromptLibraryRequest):
    data = deps.load_prompt_libraries()
    library = deps.find_prompt_library(data, library_id)
    if not library or library.get("id") != library_id:
        raise HTTPException(status_code=404, detail="提示词库不存在")
    library["name"] = deps.sanitize_asset_name(payload.name, library.get("name") or "提示词库")
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data), "prompt_library": library}


@router.delete("/prompt-libraries/{library_id}")
async def delete_prompt_library(library_id: str):
    if library_id == "system":
        raise HTTPException(status_code=400, detail="系统提示词库不能删除，可以删除其中的提示词")
    data = deps.load_prompt_libraries()
    libraries = data.get("libraries", []) or []
    kept = [lib for lib in libraries if lib.get("id") != library_id]
    if len(kept) == len(libraries):
        raise HTTPException(status_code=404, detail="提示词库不存在")
    data["libraries"] = kept
    if data.get("active_library_id") == library_id:
        data["active_library_id"] = "system"
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data)}


@router.post("/prompt-libraries/items")
async def add_prompt_library_item(payload: PromptLibraryItemRequest):
    data = deps.load_prompt_libraries()
    library = deps.find_prompt_library(data, payload.library_id)
    if not library:
        raise HTTPException(status_code=404, detail="提示词库不存在")
    if not str(payload.positive or "").strip():
        raise HTTPException(status_code=400, detail="提示词内容不能为空")
    item = deps.normalize_prompt_library_item({
        "id": f"tpl_{uuid.uuid4().hex[:12]}",
        "name": payload.name,
        "category": payload.category,
        "positive": payload.positive,
        "negative": payload.negative,
        "scene": payload.scene,
        "created_at": deps.now_ms(),
        "updated_at": deps.now_ms(),
    })
    library.setdefault("items", []).insert(0, item)
    data["active_library_id"] = library.get("id") or data.get("active_library_id")
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data), "item": item}


@router.patch("/prompt-libraries/items/{item_id}")
async def update_prompt_library_item(item_id: str, payload: PromptLibraryItemRequest):
    data = deps.load_prompt_libraries()
    for library in data.get("libraries", []) or []:
        if payload.library_id and library.get("id") != payload.library_id:
            continue
        for index, item in enumerate(library.get("items", []) or []):
            if item.get("id") == item_id:
                next_item = deps.normalize_prompt_library_item({
                    **item,
                    "name": payload.name or item.get("name"),
                    "category": payload.category or item.get("category"),
                    "positive": payload.positive or item.get("positive"),
                    "negative": payload.negative,
                    "scene": payload.scene,
                    "updated_at": deps.now_ms(),
                })
                library["items"][index] = next_item
                data = deps.save_prompt_libraries(data)
                return {"library": deps.public_prompt_libraries(data), "item": next_item}
    raise HTTPException(status_code=404, detail="提示词不存在")


@router.delete("/prompt-libraries/items/{item_id}")
async def delete_prompt_library_item(item_id: str):
    data = deps.load_prompt_libraries()
    removed = None
    for library in data.get("libraries", []) or []:
        keep = []
        for item in library.get("items", []) or []:
            if item.get("id") == item_id:
                removed = item
            else:
                keep.append(item)
        library["items"] = keep
    if not removed:
        raise HTTPException(status_code=404, detail="提示词不存在")
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data), "removed": 1}


@router.post("/prompt-libraries/items/delete")
async def batch_delete_prompt_library_items(payload: PromptLibraryBatchDeleteRequest):
    ids = {str(item) for item in (payload.ids or []) if str(item)}
    if not ids:
        raise HTTPException(status_code=400, detail="没有选择提示词")
    data = deps.load_prompt_libraries()
    removed = 0
    for library in data.get("libraries", []) or []:
        keep = []
        for item in library.get("items", []) or []:
            if item.get("id") in ids:
                removed += 1
            else:
                keep.append(item)
        library["items"] = keep
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data), "removed": removed}


@router.post("/prompt-libraries/categories")
async def add_prompt_library_category(payload: PromptLibraryCategoryRequest):
    data = deps.load_prompt_libraries()
    library = deps.find_prompt_library(data, payload.library_id) or deps.find_prompt_library(data, "system")
    if not library:
        raise HTTPException(status_code=404, detail="提示词库不存在")
    name = deps.sanitize_asset_name(payload.name, "新分组")
    existing = {str(c.get("id")) for c in (library.get("categories") or []) if isinstance(c, dict)} | deps.PROMPT_BUILTIN_CATEGORY_IDS
    cat_id = f"pcat_{uuid.uuid4().hex[:10]}"
    while cat_id in existing:
        cat_id = f"pcat_{uuid.uuid4().hex[:10]}"
    category = {"id": cat_id, "name": name}
    library.setdefault("categories", []).append(category)
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data), "category": category}


@router.patch("/prompt-libraries/categories/{category_id}")
async def rename_prompt_library_category(category_id: str, payload: PromptLibraryCategoryRequest):
    # 系统库（内置）分组也允许重命名：分组的 id 不变，只改显示名，
    # 这样画布与素材库管理共用同一份分组数据，重命名两端实时同步。
    name = deps.sanitize_asset_name(payload.name, "")
    if not name:
        raise HTTPException(status_code=400, detail="分组名称不能为空")
    data = deps.load_prompt_libraries()
    updated = False
    for library in data.get("libraries", []) or []:
        for cat in library.get("categories") or []:
            if isinstance(cat, dict) and cat.get("id") == category_id:
                cat["name"] = name
                updated = True
    if not updated:
        raise HTTPException(status_code=404, detail="分组不存在")
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data)}


@router.delete("/prompt-libraries/categories/{category_id}")
async def delete_prompt_library_category(category_id: str):
    # 系统库（内置）分组也允许删除，与素材库管理/画布保持一致。
    data = deps.load_prompt_libraries()
    found = False
    for library in data.get("libraries", []) or []:
        cats = library.get("categories") or []
        kept = [c for c in cats if not (isinstance(c, dict) and c.get("id") == category_id)]
        if len(kept) != len(cats):
            found = True
            library["categories"] = kept
            # 被删分组下的条目改挂到剩余的第一个分组；若已无分组则归到“未分类”。
            fallback = next((str(c.get("id")) for c in kept if isinstance(c, dict) and c.get("id")), "")
            for item in library.get("items", []) or []:
                if isinstance(item, dict) and item.get("category") == category_id:
                    item["category"] = fallback
    if not found:
        raise HTTPException(status_code=404, detail="分组不存在")
    data = deps.save_prompt_libraries(data)
    return {"library": deps.public_prompt_libraries(data)}


@router.post("/asset-library/libraries")
async def create_asset_library(payload: AssetLibraryRequest):
    lib = deps.load_asset_library()
    library = {"id": f"lib_{uuid.uuid4().hex[:12]}", "name": deps.sanitize_asset_name(payload.name, "资产库"), "type": "asset", "categories": []}
    library["categories"].append({"id": f"cat_{uuid.uuid4().hex[:12]}", "name": "默认分组", "type": "image", "items": []})
    library["categories"].append({"id": f"wf_{uuid.uuid4().hex[:12]}", "name": "工作流", "type": "workflow", "items": []})
    lib.setdefault("libraries", []).append(library)
    lib["active_library_id"] = library["id"]
    deps.save_asset_library(lib)
    return {"library": lib, "asset_library": library}


@router.patch("/asset-library/libraries/{library_id}")
async def rename_asset_library(library_id: str, payload: AssetLibraryRenameRequest):
    lib = deps.load_asset_library()
    library = deps.find_asset_library(lib, library_id)
    if not library or library.get("id") != library_id:
        raise HTTPException(status_code=404, detail="资产库不存在")
    library["name"] = deps.sanitize_asset_name(payload.name, library.get("name") or "资产库")
    deps.save_asset_library(lib)
    return {"library": lib, "asset_library": library}


@router.delete("/asset-library/libraries/{library_id}")
async def delete_asset_library(library_id: str):
    lib = deps.load_asset_library()
    libraries = lib.get("libraries") or []
    if len(libraries) <= 1:
        raise HTTPException(status_code=400, detail="至少保留一个资产库")
    if not any(item.get("id") == library_id for item in libraries):
        raise HTTPException(status_code=404, detail="资产库不存在")
    lib["libraries"] = [item for item in libraries if item.get("id") != library_id]
    if lib.get("active_library_id") == library_id:
        lib["active_library_id"] = lib["libraries"][0].get("id")
    deps.save_asset_library(lib)
    return {"library": lib}


@router.post("/asset-library/categories")
async def create_asset_library_category(payload: AssetLibraryCategoryRequest):
    lib = deps.load_asset_library()
    library = deps.find_asset_library(lib, payload.library_id)
    if not library:
        raise HTTPException(status_code=404, detail="资产库不存在")
    categories = library.setdefault("categories", [])
    parent_id = str(payload.parent_id or "").strip()
    parent = None
    raw_type = str(payload.type or "").strip().lower()
    if parent_id:
        parent = next((cat for cat in categories if str(cat.get("id") or "") == parent_id), None)
        if not parent:
            raise HTTPException(status_code=404, detail="父分类不存在")
        parent_raw_type = str(parent.get("type") or "image").strip().lower()
        cat_type = parent_raw_type if parent_raw_type in ("workflow", "video", "audio") else "image"
        if raw_type and raw_type != cat_type:
            raise HTTPException(status_code=400,
                                detail=f"子分类类型必须与父分类一致（父分类是 {cat_type}）")
    else:
        cat_type = raw_type if raw_type in ("workflow", "video", "audio") else "image"
    category = {"id": f"cat_{uuid.uuid4().hex[:12]}",
                "name": deps.sanitize_asset_name(payload.name, "新文件夹"),
                "type": cat_type, "parent_id": parent_id, "items": []}
    if cat_type == "image":
        # 图片分组在 library/ 下建真实文件夹；子分类建在父分类目录里面（真正嵌套）
        if parent is not None:
            if not str(parent.get("dir") or "").strip():
                parent["dir"] = deps.unique_asset_category_dir(library, parent.get("name") or "分组")
            category["dir"] = _asset_library_child_dir(library, parent, payload.name)
        else:
            category["dir"] = deps.unique_asset_category_dir(library, payload.name)
        try:
            os.makedirs(os.path.join(deps.ASSET_LIBRARY_DIR, category["dir"]), exist_ok=True)
        except Exception as exc:
            print(f"创建分组文件夹失败: {exc}")
    categories.append(category)
    lib["active_library_id"] = library.get("id") or lib.get("active_library_id")
    deps.save_asset_library(lib)
    return {"library": lib, "category": category}


@router.patch("/asset-library/categories/{category_id}")
async def rename_asset_library_category(category_id: str, payload: AssetLibraryRenameRequest):
    lib = deps.load_asset_library()
    library, cat = deps.find_asset_category_with_library(lib, category_id, payload.library_id)
    if not cat:
        raise HTTPException(status_code=404, detail="分类不存在")
    if payload.name:
        cat["name"] = deps.sanitize_asset_name(payload.name, cat.get("name") or "新文件夹")
    wanted_type = str(payload.type or "").strip().lower()
    if wanted_type:
        raw_current_type = str(cat.get("type") or "").strip().lower()
        current_type = _asset_library_media_type(cat)
        if wanted_type not in _ASSET_LIBRARY_MEDIA_TYPES:
            raise HTTPException(status_code=400, detail="分类类型只能是 image/video/audio")
        if wanted_type == "workflow" or raw_current_type == "workflow":
            raise HTTPException(status_code=400, detail="工作流分类不能改类型")
        if wanted_type != current_type:
            if cat.get("items"):
                raise HTTPException(status_code=400, detail="分类下还有素材，不能改类型；请先清空该分类")
            cat["type"] = wanted_type
    if payload.parent_id is not None:
        categories = library.setdefault("categories", [])
        target_parent_id = str(payload.parent_id or "").strip()
        current_parent_id = _asset_library_parent_id(cat)
        if target_parent_id != current_parent_id:
            if target_parent_id == category_id:
                raise HTTPException(status_code=400, detail="不能把分类挂到自己下面")
            if target_parent_id in _asset_library_descendants(categories, category_id):
                raise HTTPException(status_code=400, detail="不能把分类移动到它自己的子分类下")
            parent = None
            if target_parent_id:
                parent = next((c for c in categories if str(c.get("id") or "") == target_parent_id), None)
                if not parent:
                    raise HTTPException(status_code=404, detail="父分类不存在")
                if _asset_library_media_type(parent) != _asset_library_media_type(cat):
                    raise HTTPException(status_code=400, detail="父子分类类型不一致，不能移动")
            if _asset_library_children(categories, category_id):
                raise HTTPException(status_code=400, detail="分类下还有子分类，暂不支持移动；请先删除或移走子分类")
            if cat.get("items"):
                raise HTTPException(status_code=400, detail="分类下还有素材，暂不支持移动；请先移走素材")
            old_dir = str(cat.get("dir") or "").strip("/").strip()
            if _asset_library_media_type(cat) == "image":
                if parent is None:
                    new_dir = deps.unique_asset_category_dir(library, cat.get("name") or "分组")
                else:
                    if not str(parent.get("dir") or "").strip():
                        parent["dir"] = deps.unique_asset_category_dir(library, parent.get("name") or "分组")
                    new_dir = _asset_library_child_dir(library, parent, cat.get("name") or "分组", current_id=category_id)
                if old_dir and new_dir and old_dir != new_dir:
                    old_abs = os.path.join(deps.ASSET_LIBRARY_DIR, old_dir)
                    new_abs = os.path.join(deps.ASSET_LIBRARY_DIR, new_dir)
                    try:
                        os.makedirs(os.path.dirname(new_abs), exist_ok=True)
                        if os.path.isdir(old_abs):
                            os.rename(old_abs, new_abs)
                    except Exception as exc:
                        raise HTTPException(status_code=500, detail=f"移动分组文件夹失败：{exc}")
                cat["dir"] = new_dir or old_dir
            cat["parent_id"] = target_parent_id
    deps.save_asset_library(lib)
    return {"library": lib, "category": cat}


@router.delete("/asset-library/categories/{category_id}")
async def delete_asset_library_category(category_id: str, library_id: str = "", force: Optional[bool] = None):
    lib = deps.load_asset_library()
    library, cat = deps.find_asset_category_with_library(lib, category_id, library_id)
    if not cat:
        raise HTTPException(status_code=404, detail="分类不存在")
    if cat.get("type") == "workflow" and category_id == "workflows" and (library.get("id") or "") == "default":
        raise HTTPException(status_code=400, detail="默认工作流分类不能删除")
    categories = library.setdefault("categories", [])
    subtree = _asset_library_subtree(categories, category_id)
    subtree_items = [item for node in subtree for item in (node.get("items") or []) if isinstance(item, dict)]
    child_count = len(subtree) - 1
    # 显式 force=false：分类（或其子分类）里还有素材/子分类时拒绝，给出计数
    if force is False and (subtree_items or child_count):
        parts = []
        if subtree_items:
            parts.append(f"{len(subtree_items)} 个素材")
        if child_count:
            parts.append(f"{child_count} 个子分类")
        raise HTTPException(status_code=400,
                            detail="分类下还有 " + "、".join(parts) + "，请先移走或删除，或传 force=true 强制删除（会连同子分类一起删）")
    # 递归删除：先清素材文件，再从深到浅删磁盘目录，最后从分类树里移除整棵子树
    for node in subtree:
        for item in (node.get("items") or []):
            deps.remove_asset_library_file(item)
    for node in sorted(subtree, key=lambda c: len(str(c.get("dir") or "")), reverse=True):
        node_dir = str(node.get("dir") or "").strip("/").strip()
        if not node_dir:
            continue
        try:
            target = os.path.join(deps.ASSET_LIBRARY_DIR, node_dir)
            if os.path.isdir(target) and os.path.abspath(target).startswith(os.path.abspath(deps.ASSET_LIBRARY_DIR) + os.sep):
                shutil.rmtree(target, ignore_errors=True)
        except Exception as exc:
            print(f"删除分组文件夹失败: {exc}")
    removed_ids = {str(node.get("id") or "") for node in subtree}
    library["categories"] = [c for c in categories if str(c.get("id") or "") not in removed_ids]
    deps.save_asset_library(lib)
    return {"library": lib, "deleted_categories": len(subtree), "deleted_items": len(subtree_items)}


@router.post("/asset-library/items")
async def add_asset_library_item(payload: AssetLibraryAddRequest):
    lib = deps.load_asset_library()
    library = deps.find_asset_library(lib, payload.library_id)
    if not library:
        raise HTTPException(status_code=404, detail="资产库不存在")
    src, media_kind = _asset_library_src_or_error(payload.url)
    cat, error = _resolve_asset_library_target_category(lib, library, payload.category_id, media_kind)
    if error:
        raise HTTPException(status_code=404 if error == "分类不存在" else 400, detail=error)
    _, item = deps.make_asset_library_item(src, payload.name or os.path.basename(src), subdir=cat.get("dir") or "")
    gen = await asyncio.to_thread(deps.generation_meta_for_url, payload.url)
    if gen:
        item["generation"] = gen
    cat.setdefault("items", []).append(item)
    # 先落库并返回（save 内部会广播 ws），AI 分类改到后台线程：不再让保存等几秒
    deps.save_asset_library(lib)
    pending = False
    if payload.classify and item.get("kind") == "image":
        pending = _spawn_asset_library_classification(item, src, payload.library_id)
    return {"library": lib, "item": item, "category": cat, "classification_pending": pending}


@router.post("/asset-library/items/batch")
async def batch_add_asset_library_items(payload: AssetLibraryBatchAddRequest):
    added = []
    errors = []
    lib = deps.load_asset_library()
    library = deps.find_asset_library(lib, payload.library_id)
    if not library:
        raise HTTPException(status_code=404, detail="资产库不存在")
    # 目标分类允许为空/auto：按每个条目的媒体类型自动落到图片/视频/音频分类，混合批量也能一次存
    target = str(payload.category_id or "").strip()
    for entry in (payload.items or [])[:200]:
        entry.library_id = payload.library_id
        src = deps.output_file_from_url(entry.url)
        if not src:
            errors.append({"url": entry.url, "error": "只支持保存本地 /assets 或 /output 媒体"})
            continue
        media_kind = deps.asset_library_media_kind(src)
        if media_kind not in _ASSET_LIBRARY_MEDIA_TYPES:
            errors.append({"url": entry.url, "error": "该文件类型不能存进素材库"})
            continue
        cat, error = _resolve_asset_library_target_category(lib, library, target, media_kind)
        if error:
            errors.append({"url": entry.url, "error": error})
            continue
        entry.category_id = cat.get("id") or ""
        _, item = deps.make_asset_library_item(src, entry.name or os.path.basename(src), subdir=cat.get("dir") or "")
        gen = await asyncio.to_thread(deps.generation_meta_for_url, entry.url)
        if gen:
            item["generation"] = gen
        cat.setdefault("items", []).append(item)
        added.append((item, src, entry))
    # 先落库并返回（save 内部广播一次 ws），图片分类全部丢到后台，批量保存不再逐张等 AI
    deps.save_asset_library(lib)
    pending = 0
    for item, src, entry in added:
        if payload.classify and entry.classify and item.get("kind") == "image":
            if _spawn_asset_library_classification(item, src, payload.library_id):
                pending += 1
    return {"library": lib, "items": [item for item, _src, _entry in added], "errors": errors,
            "classification_pending": pending}


@router.get("/shared-folders")
async def list_shared_folders():
    data = deps.shared_folders_load()
    folders = []
    for entry in data.get("folders", []):
        abs_path = deps.shared_folder_abs(entry)
        folders.append({
            "id": entry.get("id"),
            "name": entry.get("name") or os.path.basename(abs_path) or abs_path,
            "rel": entry.get("rel") or "",
            "path": abs_path,
            "exists": os.path.isdir(abs_path),
            "created_at": entry.get("created_at"),
        })
    return {"folders": folders}


@router.post("/shared-folders")
async def register_shared_folder(payload: SharedFolderRegister):
    abs_path, rel = deps.shared_resolve_register(payload.path)
    name = deps.sanitize_asset_name(payload.name or os.path.basename(abs_path), "共享文件夹")
    with deps.SHARED_FOLDERS_LOCK:
        data = deps.shared_folders_load()
        for entry in data.get("folders", []):
            if os.path.normpath(deps.shared_folder_abs(entry)) == os.path.normpath(abs_path):
                entry["name"] = name
                deps.shared_folders_save(data)
                return {"folder": {**entry, "path": abs_path, "exists": True}}
        entry = {
            "id": f"shared_{uuid.uuid4().hex[:12]}",
            "name": name,
            "rel": rel,
            "created_at": deps.now_ms(),
        }
        data.setdefault("folders", []).append(entry)
        deps.shared_folders_save(data)
    return {"folder": {**entry, "path": abs_path, "exists": True}}


@router.delete("/shared-folders/{folder_id}")
async def unregister_shared_folder(folder_id: str):
    with deps.SHARED_FOLDERS_LOCK:
        data = deps.shared_folders_load()
        before = len(data.get("folders", []))
        data["folders"] = [f for f in data.get("folders", []) if f.get("id") != folder_id]
        if len(data["folders"]) == before:
            raise HTTPException(status_code=404, detail="共享文件夹不存在")
        deps.shared_folders_save(data)
    return {"ok": True}


@router.get("/shared-folders/{folder_id}/tree")
async def get_shared_folder_tree(folder_id: str):
    entry = deps.shared_folder_by_id(folder_id)
    if not entry:
        raise HTTPException(status_code=404, detail="共享文件夹不存在")
    abs_path = deps.shared_folder_abs(entry)
    if not os.path.isdir(abs_path):
        raise HTTPException(status_code=404, detail="文件夹已不存在")
    tree = deps.scan_shared_tree(folder_id, abs_path, "", entry.get("name") or os.path.basename(abs_path))
    return {"folder": {"id": folder_id, "name": entry.get("name"), "path": abs_path}, "tree": tree}


@router.get("/shared-folders/{folder_id}/file")
async def get_shared_folder_file(folder_id: str, path: str = ""):
    entry = deps.shared_folder_by_id(folder_id)
    if not entry:
        raise HTTPException(status_code=404, detail="共享文件夹不存在")
    folder_abs = deps.shared_folder_abs(entry)
    abs_path = deps.shared_child_abs(folder_abs, path)
    if not os.path.isfile(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")
    ext = os.path.splitext(abs_path)[1].lower()
    if ext not in deps.SHARED_MEDIA_EXTS:
        raise HTTPException(status_code=400, detail="不支持的文件类型")
    return FileResponse(abs_path, media_type=deps.content_type_for_path(abs_path))


@router.post("/shared-folders/import")
async def import_shared_folder_files(payload: SharedFolderImport):
    entry = deps.shared_folder_by_id(payload.folder_id)
    if not entry:
        raise HTTPException(status_code=404, detail="共享文件夹不存在")
    folder_abs = deps.shared_folder_abs(entry)
    lib = deps.load_asset_library()
    cat = deps.find_asset_category_in_library(lib, payload.category_id, payload.library_id)
    if not cat:
        raise HTTPException(status_code=404, detail="分类不存在")
    if cat.get("type") != "image":
        raise HTTPException(status_code=400, detail="该分类暂不支持添加媒体")
    added = []
    for rel in (payload.paths or [])[:200]:
        abs_path = deps.shared_child_abs(folder_abs, rel)
        if not os.path.isfile(abs_path):
            continue
        ext = os.path.splitext(abs_path)[1].lower()
        if ext not in deps.SHARED_MEDIA_EXTS:
            continue
        _, item = deps.make_asset_library_item(abs_path, os.path.basename(abs_path), subdir=cat.get("dir") or "")
        if item.get("kind") == "image":
            classification = await deps.classify_asset_image_best_effort(deps.output_file_from_url(item.get("url") or "") or abs_path)
            if classification:
                item["classification"] = classification
        cat.setdefault("items", []).append(item)
        added.append(item)
    deps.save_asset_library(lib)
    return {"library": lib, "items": added}


@router.patch("/asset-library/items/{item_id}")
async def rename_asset_library_item(item_id: str, payload: AssetLibraryRenameRequest):
    lib = deps.load_asset_library()
    for library in lib.get("libraries", []):
        for cat in library.get("categories", []):
            for item in cat.get("items", []):
                if item.get("id") == item_id:
                    item["name"] = deps.sanitize_asset_name(payload.name, item.get("name") or "asset")
                    deps.save_asset_library(lib)
                    return {"library": lib, "item": item}
    raise HTTPException(status_code=404, detail="资产不存在")


@router.post("/asset-library/items/classify")
async def classify_asset_library_items(payload: AssetLibraryClassifyRequest):
    lib = deps.load_asset_library()
    results = []
    changed = False
    for item_id in (payload.ids or [])[:80]:
        item = deps.find_asset_item_in_library(lib, item_id, payload.library_id)
        result = {"id": item_id, "ok": False, "classification": None, "error": ""}
        if not item:
            result["error"] = "资产不存在"
            results.append(result)
            continue
        if deps.asset_library_media_kind(item.get("url") or "") != "image" and item.get("kind") != "image":
            result["error"] = "仅支持图片素材智能分类"
            results.append(result)
            continue
        path = deps.output_file_from_url(item.get("url") or "")
        if not path or not os.path.isfile(path):
            result["error"] = "文件不存在"
            results.append(result)
            continue
        try:
            classification = await deps.classify_image_with_provider(path, payload.provider, payload.model, payload.ms_model, payload.prompt)
            item["classification"] = classification
            changed = True
            result.update({"ok": True, "classification": classification})
        except Exception as exc:
            result["error"] = str(getattr(exc, "detail", "") or exc)
        results.append(result)
    if changed:
        deps.save_asset_library(lib)
    return {"library": lib, "count": sum(1 for item in results if item.get("ok")), "items": results}


@router.post("/asset-library/items/{item_id}/register-avatar")
async def register_asset_library_avatar(item_id: str, payload: AssetAvatarRegisterRequest):
    lib = deps.load_asset_library()
    target_item = deps.find_asset_item_in_library(lib, item_id, payload.library_id)
    if not target_item:
        raise HTTPException(status_code=404, detail="资产不存在")
    provider = deps.get_api_provider(payload.provider_id)
    platform = deps.avatar_platform_for_provider(provider)
    if platform not in deps.AVATAR_SUPPORTED_PLATFORMS:
        name = (provider or {}).get("name") or (provider or {}).get("id") or "该平台"
        raise HTTPException(status_code=400, detail=f"「{name}」暂不支持数字人/真人认证（目前仅 APIMart 可用，火山等平台待接入官方资产 API）。")
    kind = str(target_item.get("kind") or "image").lower()
    if kind not in ("image", "video", "audio"):
        kind = "image"
    if platform == "apimart":
        project_name = str(payload.project_name or "default").strip() or "default"
        async with httpx.AsyncClient(http2=False, verify=deps._SSL_CONTEXT, trust_env=deps._TRUST_ENV, timeout=deps.VIDEO_POLL_TIMEOUT) as client:
            public_url = await deps.upload_media_for_apimart(client, provider, target_item.get("url") or "", kind)
        if not deps.valid_apimart_video_image_input(public_url):
            reason = public_url[4:] if isinstance(public_url, str) and public_url.startswith("ERR:") else "无法获取公网可访问地址"
            raise HTTPException(status_code=400, detail=f"素材无法提交到 APIMart：{reason}\n请配置 PUBLIC_BASE_URL，或确认本地文件存在。")
        task_id = await deps.submit_apimart_avatar_asset(
            provider, public_url, target_item.get("name") or "asset", kind,
            project_name=project_name, group_name=payload.group_name,
        )
    elif platform == "volcengine":
        # 火山以 API 设置里配置的 ProjectName 为准（必须与视频生成 key 的项目一致）
        project_name = str(provider.get("volcengine_project_name") or deps.VOLCENGINE_DEFAULT_PROJECT_NAME).strip() or deps.VOLCENGINE_DEFAULT_PROJECT_NAME
        public_url = deps.volcengine_public_asset_url(target_item.get("url") or "")
        if public_url.startswith("ERR:"):
            raise HTTPException(status_code=400, detail=public_url[4:])
        task_id = await deps.submit_volcengine_avatar_asset(
            public_url, target_item.get("name") or "asset", kind,
            project_name=project_name, group_name=payload.group_name or "",
        )
    else:
        raise HTTPException(status_code=400, detail="该平台的认证后端尚未接入。")
    regs = target_item.get("registrations")
    if not isinstance(regs, dict):
        regs = {}
    regs[platform] = {
        "provider_id": provider["id"],
        "project_name": project_name,
        "task_id": task_id,
        "status": "Processing",
        "detail": "已提交，审核中",
        "asset_uri": "",
        "asset_id": "",
        "registered_at": deps.now_ms(),
    }
    target_item["registrations"] = regs
    deps.save_asset_library(lib)
    return {"library": lib, "item": target_item}


@router.post("/asset-library/items/{item_id}/avatar-status")
async def check_asset_library_avatar(item_id: str, payload: AssetAvatarRegisterRequest):
    lib = deps.load_asset_library()
    target_item = deps.find_asset_item_in_library(lib, item_id, payload.library_id)
    if not target_item:
        raise HTTPException(status_code=404, detail="资产不存在")
    regs = target_item.get("registrations") if isinstance(target_item.get("registrations"), dict) else {}
    provider = deps.get_api_provider(payload.provider_id or "")
    platform = deps.avatar_platform_for_provider(provider)
    if platform not in deps.AVATAR_SUPPORTED_PLATFORMS:
        raise HTTPException(status_code=400, detail="该平台暂不支持数字人/真人认证审核。")
    reg = regs.get(platform) if isinstance(regs.get(platform), dict) else {}
    task_id = str(reg.get("task_id") or "").strip()
    if not task_id:
        raise HTTPException(status_code=400, detail="该素材还没有提交到这个平台的认证审核。")
    if platform == "apimart":
        result = await deps.check_apimart_avatar_task(provider, task_id)
    elif platform == "volcengine":
        result = await deps.check_volcengine_avatar_task(
            task_id, str(reg.get("project_name") or deps.VOLCENGINE_DEFAULT_PROJECT_NAME).strip() or deps.VOLCENGINE_DEFAULT_PROJECT_NAME,
        )
    else:
        raise HTTPException(status_code=400, detail="该平台的认证后端尚未接入。")
    reg["status"] = result["status"]
    reg["detail"] = result.get("detail") or ""
    if result["status"] == "Active" and result.get("asset_uri"):
        reg["asset_uri"] = result["asset_uri"]
        reg["asset_id"] = result["asset_uri"].replace("asset://", "")
    regs[platform] = reg
    target_item["registrations"] = regs
    deps.save_asset_library(lib)
    return {"library": lib, "item": target_item}


@router.delete("/asset-library/items/{item_id}")
async def delete_asset_library_item(item_id: str):
    lib = deps.load_asset_library()
    removed = None
    for library in lib.get("libraries", []):
        for cat in library.get("categories", []):
            keep = []
            for item in cat.get("items", []):
                if item.get("id") == item_id:
                    removed = item
                else:
                    keep.append(item)
            cat["items"] = keep
    if not removed:
        raise HTTPException(status_code=404, detail="资产不存在")
    deps.remove_asset_library_file(removed)  # 同时删除本地文件，避免磁盘上堆积
    deps.save_asset_library(lib)
    return {"library": lib}


@router.post("/asset-library/items/delete")
async def batch_delete_asset_library_items(payload: AssetLibraryBatchDeleteRequest):
    ids = {str(item) for item in (payload.ids or []) if str(item)}
    if not ids:
        raise HTTPException(status_code=400, detail="没有选择资产")
    lib = deps.load_asset_library()
    removed = 0
    removed_items = []
    for library in lib.get("libraries", []):
        if payload.library_id and library.get("id") != payload.library_id:
            continue
        for cat in library.get("categories", []):
            keep = []
            for item in cat.get("items", []):
                if item.get("id") in ids:
                    removed += 1
                    removed_items.append(item)
                else:
                    keep.append(item)
            cat["items"] = keep
    for item in removed_items:  # 批量删除同时清理本地文件
        deps.remove_asset_library_file(item)
    deps.save_asset_library(lib)
    return {"library": lib, "removed": removed}


@router.post("/asset-library/items/move")
async def batch_move_asset_library_items(payload: AssetLibraryBatchMoveRequest):
    ids = {str(item) for item in (payload.ids or []) if str(item)}
    if not ids:
        raise HTTPException(status_code=400, detail="没有选择资产")
    lib = deps.load_asset_library()
    target_cat = deps.find_asset_category_in_library(lib, payload.target_category_id, payload.target_library_id)
    if not target_cat:
        raise HTTPException(status_code=404, detail="目标分组不存在")
    target_type = target_cat.get("type") or "image"
    moved = []
    for library in lib.get("libraries", []):
        if payload.library_id and library.get("id") != payload.library_id:
            continue
        for cat in library.get("categories", []):
            if (cat.get("type") or "image") != target_type:
                continue
            keep = []
            for item in cat.get("items", []):
                if item.get("id") in ids:
                    moved.append(item)
                else:
                    keep.append(item)
            cat["items"] = keep
    existing_ids = {item.get("id") for item in target_cat.get("items", [])}
    for item in moved:
        if item.get("id") not in existing_ids:
            target_cat.setdefault("items", []).append(item)
            existing_ids.add(item.get("id"))
    deps.save_asset_library(lib)
    return {"library": lib, "moved": len(moved)}


@router.post("/asset-library/items/crop")
async def batch_crop_asset_library_items(payload: AssetLibraryBatchCropRequest):
    ids = {str(item) for item in (payload.ids or []) if str(item)}
    if not ids:
        raise HTTPException(status_code=400, detail="没有选择资产")
    lib = deps.load_asset_library()
    target_cat = None
    if payload.target_category_id:
        target_cat = deps.find_asset_category_in_library(lib, payload.target_category_id, payload.target_library_id)
        if not target_cat:
            raise HTTPException(status_code=404, detail="目标分组不存在")
        if target_cat.get("type") != "image":
            raise HTTPException(status_code=400, detail="目标分组不支持媒体")
    added = []
    for library in lib.get("libraries", []):
        if payload.library_id and library.get("id") != payload.library_id:
            continue
        for cat in library.get("categories", []):
            if cat.get("type") != "image":
                continue
            source_items = [item for item in (cat.get("items", []) or []) if item.get("id") in ids]
            for item in source_items:
                src = deps.output_file_from_url(item.get("url") or "")
                if not src or not os.path.isfile(src):
                    continue
                try:
                    with Image.open(src) as img:
                        img = img.convert("RGBA")
                        w, h = img.size
                        side = min(w, h)
                        if side <= 0:
                            continue
                        left = max(0, (w - side) // 2)
                        top = max(0, (h - side) // 2)
                        cropped = img.crop((left, top, left + side, top + side))
                        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".png")
                        tmp_path = tmp.name
                        tmp.close()
                        try:
                            cropped.save(tmp_path, "PNG")
                            base_name = os.path.splitext(item.get("name") or "asset")[0] + "_crop.png"
                            dest_cat = target_cat or cat
                            _, next_item = deps.make_asset_library_item(tmp_path, base_name, subdir=dest_cat.get("dir") or "")
                            dest_cat.setdefault("items", []).append(next_item)
                            added.append(next_item)
                        finally:
                            try:
                                os.remove(tmp_path)
                            except Exception:
                                pass
                except Exception:
                    continue
    deps.save_asset_library(lib)
    return {"library": lib, "added": len(added), "items": added}


# ===== canvas-assets 族 =====

_canvas_asset_dims_cache: Dict[str, tuple] = {}


def _canvas_asset_image_dims(url: str):
    """读本地图片真实尺寸（老画布节点没写 natural_w/h 时兜底）；远程/读不到返回 None。"""
    if url in _canvas_asset_dims_cache:
        return _canvas_asset_dims_cache[url]
    dims = None
    try:
        path = deps.output_file_from_url(url)
        if path and os.path.isfile(path):
            with Image.open(path) as img:
                width, height = img.size
            if width > 0 and height > 0:
                dims = (int(width), int(height))
    except Exception:
        dims = None
    if dims:
        _canvas_asset_dims_cache[url] = dims
    return dims

@router.get("/canvas-assets")
async def list_canvas_assets(canvas: str = "", category: str = "", q: str = "", limit: int = 0):
    # canvas_assets_index 会同步遍历并解析所有画布 JSON，放进线程池避免阻塞事件循环
    # （否则画布多时一次请求就会卡住整个 asyncio loop，连 WebSocket 一起掉线）。
    index = await asyncio.to_thread(deps.canvas_assets_index)
    items = index.get("items") or []
    canvases = index.get("canvases") or []
    # 老资产的 natural_w/natural_h 可能没写进画布节点：从资产注册表按 url 补齐一次。
    # 字段名和类型保持 natural_w/natural_h（int），前端仍可自己解码兜底。
    try:
        registry = deps.load_assets_registry() or {}
    except Exception:
        registry = {}
    dimensions = {}
    for record in (registry.get("assets") or []):
        if not isinstance(record, dict) or not str(record.get("url") or "").strip():
            continue
        try:
            width = int(record.get("natural_w") or 0)
            height = int(record.get("natural_h") or 0)
        except (TypeError, ValueError):
            continue
        if width > 0 and height > 0:
            dimensions[str(record["url"])] = (width, height)
    for item in items:
        if not isinstance(item, dict):
            continue
        if int(item.get("natural_w") or 0) > 0 and int(item.get("natural_h") or 0) > 0:
            continue
        url = str(item.get("url") or "")
        size_pair = dimensions.get(url)
        if not size_pair and url:
            # 注册表和画布节点都没有尺寸的老数据：直接读本地图片头，字段仍是 natural_w/natural_h（int）
            size_pair = _canvas_asset_image_dims(url)
        if size_pair:
            item["natural_w"], item["natural_h"] = size_pair
    canvas_key = str(canvas or "").strip().lower()
    category_key = str(category or "").strip().lower()
    query = str(q or "").strip().lower()
    try:
        limit_value = max(0, min(int(limit or 0), 2000))
    except (TypeError, ValueError):
        limit_value = 0

    def _match(canvas_id, title, kinds, haystack, check_query=True):
        if canvas_key and canvas_key not in str(canvas_id or "").lower() and canvas_key not in str(title or "").lower():
            return False
        if category_key and category_key not in ("all", "全部") and category_key not in kinds:
            return False
        if check_query and query and query not in haystack:
            return False
        return True

    filtered_items = []
    for item in items:
        if not isinstance(item, dict):
            continue
        kinds = {str(item.get("kind") or "").lower(), str(item.get("canvas_kind") or "").lower()}
        haystack = " ".join(str(item.get(key) or "") for key in
                            ("name", "url", "canvas_title", "node_title", "gen_prompt", "gen_model")).lower()
        if _match(item.get("canvas_id"), item.get("canvas_title"), kinds, haystack):
            filtered_items.append(item)
    # 素材类目（image/video/audio/text）不是画布种类：这时只保留「含该素材的画布」，
    # 避免 category=image 把画布列表过滤成空；画布种类（smart/classic）仍按画布自身匹配
    asset_kind_category = category_key not in ("", "all", "全部", "smart", "classic")
    matching_canvas_ids = {str(item.get("canvas_id") or "") for item in filtered_items}
    filtered_canvases = []
    for record in canvases:
        if not isinstance(record, dict):
            continue
        if asset_kind_category and str(record.get("id") or "") not in matching_canvas_ids:
            continue
        kinds = {str(record.get("kind") or "").lower()}
        haystack = " ".join(str(record.get(key) or "") for key in ("id", "title", "owner")).lower()
        # q 搜的是素材名，画布列表应保留「含命中的素材」的画布（或标题/id 本身命中），不能因为
        # 素材名不匹配画布标题就被过滤成空
        if query and str(record.get("id") or "") not in matching_canvas_ids and query not in haystack:
            continue
        record_kinds = kinds if not asset_kind_category else {category_key}
        if _match(record.get("id"), record.get("title"), record_kinds, haystack, check_query=False):
            filtered_canvases.append(record)
    result = dict(index)
    result["canvases"] = filtered_canvases
    result["items"] = filtered_items[:limit_value] if limit_value else filtered_items
    # 新增字段（不改既有字段含义）：过滤后数量 + 过滤前总数，方便前端显示「已筛选 N / 共 M」
    result["count"] = len(result["items"])
    result["total"] = len(items)
    return result


@router.post("/canvas-assets/check")
async def check_canvas_assets(payload: CanvasAssetCheckRequest):
    result = {}
    for url in payload.urls[:3000]:
        text = str(url or "").strip()
        if not text:
            continue
        if text.startswith("/output/") or text.startswith("/assets/"):
            result[text] = bool(deps.output_file_from_url(text))
        else:
            result[text] = True
    return {"exists": result}


@router.post("/canvas-assets/download")
async def download_canvas_assets(payload: CanvasAssetDownloadRequest):
    buffer = BytesIO()
    used_names = set()
    count = 0
    raw_items = payload.items or [{"url": url} for url in payload.urls]
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as zf:
        for raw in raw_items[:1000]:
            if isinstance(raw, dict):
                text = str(raw.get("url") or "").strip()
                requested_name = str(raw.get("name") or "").strip()
            else:
                text = str(raw or "").strip()
                requested_name = ""
            if not text:
                continue
            path = deps.output_file_from_url(text)
            content = None
            content_type = ""
            if path and os.path.isfile(path):
                base = deps.sanitize_export_filename(requested_name or os.path.basename(path), os.path.basename(path) or f"image-{count + 1}.png")
            else:
                local_by_name = deps.local_media_file_by_basename(deps.filename_from_media_url(text, ""))
                if local_by_name and os.path.isfile(local_by_name):
                    path = local_by_name
                    base = deps.sanitize_export_filename(requested_name or os.path.basename(path), os.path.basename(path) or f"image-{count + 1}.png")
                else:
                    try:
                        remote = deps.fetch_remote_media_bytes(text)
                    except Exception:
                        remote = None
                    if not remote:
                        continue
                    content, content_type = remote
                    base = deps.sanitize_export_filename(requested_name or deps.filename_from_media_url(text, f"image-{count + 1}.bin"), f"image-{count + 1}.bin")
            name, ext = os.path.splitext(base)
            archive_name = base
            suffix = 2
            while archive_name in used_names:
                archive_name = f"{name}-{suffix}{ext}"
                suffix += 1
            used_names.add(archive_name)
            if path and os.path.isfile(path):
                zf.write(path, archive_name)
            else:
                zf.writestr(archive_name, content)
            count += 1
    if count <= 0:
        raise HTTPException(status_code=404, detail="没有可下载的本地图片")
    buffer.seek(0)
    filename = re.sub(r'[\\/:*?"<>|]+', "_", payload.filename or "canvas-output-images.zip")
    if not filename.lower().endswith(".zip"):
        filename += ".zip"
    encoded = urllib.parse.quote(filename)
    headers = {"Content-Disposition": f"attachment; filename*=UTF-8''{encoded}"}
    return Response(buffer.getvalue(), media_type="application/zip", headers=headers)


# ===== storage 族 =====

@router.get("/storage/settings")
async def api_storage_settings():
    """返回当前素材存储路径配置，供前端资产管理器显示路径信息和估算磁盘用量。"""
    return {
        "data_root": deps._DATA_ROOT,
        "output_dir": deps.OUTPUT_DIR,
        "assets_dir": deps.ASSETS_DIR,
        "assets_input": deps.OUTPUT_INPUT_DIR(),
        "assets_output": deps.OUTPUT_OUTPUT_DIR(),
        "library_dir": deps.ASSET_LIBRARY_DIR,
        "uploads_dir": deps.LOCAL_UPLOAD_DIR(),
        "canvas_dir": deps.CANVAS_DIR,
        "conversation_dir": deps.CONVERSATION_DIR,
    }


@router.put("/storage/settings")
async def api_save_storage_settings(payload: StoragePathPayload):
    """保存自定义素材存储根路径。空字符串表示恢复默认（项目目录）。"""
    new_root = str(payload.data_root or "").strip()
    if not new_root:
        # 恢复默认
        env_updates = {"NOVAI_DATA_DIR": ""}
        deps.update_env_values(env_updates)
        deps.reload_env_globals()
        return {"data_root": deps.BASE_DIR, "message": "已恢复默认存储路径"}
    # 验证路径有效
    expanded = os.path.abspath(os.path.expanduser(new_root))
    if not os.path.isdir(expanded):
        try:
            os.makedirs(expanded, exist_ok=True)
        except OSError as exc:
            raise HTTPException(status_code=400, detail=f"无法创建目录 {expanded}：{exc}") from exc
    env_updates = {"NOVAI_DATA_DIR": expanded}
    deps.update_env_values(env_updates)
    deps.reload_env_globals()
    return {"data_root": expanded, "message": "存储路径已更新"}


@router.post("/storage/apply")
async def api_apply_storage_settings():
    """将当前存储路径配置应用到实际目录结构，确保所有必要子目录存在。"""
    dirs_to_ensure = [
        deps.OUTPUT_DIR, deps.ASSETS_DIR, deps.OUTPUT_INPUT_DIR(), deps.OUTPUT_OUTPUT_DIR(),
        deps.ASSET_LIBRARY_DIR, deps.LOCAL_UPLOAD_DIR(), deps.STATIC_DIR, deps.WORKFLOW_DIR,
        deps.CONVERSATION_DIR, deps.CANVAS_DIR, deps.DATA_DIR, deps.MEDIA_PREVIEW_DIR,
    ]
    created = []
    for d in dirs_to_ensure:
        if not os.path.isdir(d):
            try:
                os.makedirs(d, exist_ok=True)
                created.append(d)
            except OSError as exc:
                raise HTTPException(status_code=400, detail=f"无法创建目录 {d}：{exc}") from exc
    return {"applied": True, "created_dirs": created}


@router.get("/storage-settings")
async def get_storage_settings():
    settings = deps.load_storage_settings()
    return {
        "dirs": settings["dirs"],
        "defaults": {key: os.path.abspath(value) for key, value in deps.DEFAULT_STORAGE_DIRS.items()},
    }


@router.patch("/storage-settings")
async def update_storage_settings(payload: Dict[str, str]):
    return deps.save_storage_settings(payload or {})


@router.get("/storage-files")
async def list_storage_files(kind: str = "generated", offset: int = 0, limit: int = 80):
    root = deps.storage_kind_dir(kind)
    os.makedirs(root, exist_ok=True)
    offset = max(0, int(offset or 0))
    limit = max(20, min(200, int(limit or 80)))
    items = []
    for current, dirs, files in os.walk(root):
        dirs[:] = sorted([d for d in dirs if not d.startswith(".") and not d.startswith("._")], key=str.lower)
        for name in sorted(files, key=str.lower):
            if name.startswith(".") or name.startswith("._"):
                continue
            if os.path.splitext(name)[1].lower() not in deps.STORAGE_IMAGE_EXTS:
                continue
            item = deps.storage_file_item(kind, root, os.path.join(current, name))
            if item:
                items.append(item)
    items.sort(key=lambda item: item.get("created_at") or 0, reverse=True)
    total = len(items)
    page_items = items[offset:offset + limit]
    return {
        "kind": kind,
        "root": root,
        "items": page_items,
        "total": total,
        "offset": offset,
        "limit": limit,
        "has_more": offset + len(page_items) < total,
    }


@router.get("/storage-files/{kind}/{rel_path:path}")
async def get_storage_file(kind: str, rel_path: str):
    path = deps.storage_file_path(kind, rel_path)
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="文件不存在")
    return FileResponse(path, media_type=deps.content_type_for_path(path))


@router.post("/storage-files/delete")
async def delete_storage_files(payload: Dict[str, Any]):
    kind = str((payload or {}).get("kind") or "").strip()
    rels = [str(item or "").strip() for item in ((payload or {}).get("items") or []) if str(item or "").strip()]
    if not rels:
        raise HTTPException(status_code=400, detail="请选择要删除的文件")
    removed = 0
    for rel in rels:
        path = deps.storage_file_path(kind, rel)
        if not path or not os.path.isfile(path):
            continue
        try:
            os.remove(path)
            removed += 1
        except OSError:
            pass
    return {"removed": removed}


# ===== assets 族 =====

@router.post("/assets/register")
async def register_asset_api(payload: AssetRegisterRequest):
    if not str(payload.url or "").strip():
        raise HTTPException(status_code=400, detail="url 不能为空")
    record = deps.register_canvas_asset(
        url=payload.url,
        name=payload.name,
        kind=payload.kind,
        mime=payload.mime,
        natural_w=payload.natural_w,
        natural_h=payload.natural_h,
        canvas_id=payload.canvas_id,
        source=payload.source,
        asset_id_hint=payload.asset_id,
        created_at=payload.created_at,
    )
    return {"asset": record}


@router.get("/assets")
async def list_assets_api(canvas_id: str = ""):
    if canvas_id:
        canvas = deps.load_canvas(canvas_id)
        assets = deps.collect_canvas_assets(canvas)
        return {"assets": assets, "canvas_id": canvas_id, "total": len(assets)}
    registry = deps.load_assets_registry()
    assets = registry.get("assets", [])
    return {"assets": assets, "total": len(assets)}


@router.get("/assets/{asset_id}")
async def get_asset_api(asset_id: str):
    registry = deps.load_assets_registry()
    rec = deps.find_asset_registry_record(registry, asset_id=str(asset_id or ""))
    if not rec:
        raise HTTPException(status_code=404, detail="资产不存在")
    return {"asset": rec}
