import { useEffect, useRef, useState } from "react";
import type { CanvasNode, Scene3DData } from "./reactCanvasStore";

type Props = { node: CanvasNode; onChange: (scene: Scene3DData) => void; onThumbnail?: (dataUrl: string) => void };

export function Scene3D({ node, onChange, onThumbnail }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState("");
  const sceneRef = useRef<Scene3DData | null>(node.scene || null);
  const threeRef = useRef<typeof import("three") | null>(null);
  const renderRef = useRef<(() => void) | null>(null);
  const sceneObjRef = useRef<any>(null);
  const [glbSupported, setGlbSupported] = useState(false);
  const syncRef = useRef<((scene: Scene3DData) => void) | null>(null);
  const ambientRef = useRef<any>(null);
  const dirRef = useRef<any>(null);
  const cameraApplyRef = useRef<((scene: Scene3DData) => void) | null>(null);
  const gltfRootsRef = useRef<any[]>([]);
  const [importError, setImportError] = useState("");
  const [lightsOpen, setLightsOpen] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const currentScene = (): Scene3DData => sceneRef.current || { objects: [], camera: { position: [6, 5, 8], target: [0, 0, 0] }, background: "#111111", lights: { ambient: 0.55, directional: 1.1, color: "#ffffff" } };
  const commitScene = (next: Scene3DData) => { sceneRef.current = next; syncRef.current?.(next); cameraApplyRef.current?.(next); onChangeRef.current(next); };
  const resetCamera = () => { const next = { ...currentScene(), camera: { position: [6, 5, 8] as [number, number, number], target: [0, 0, 0] as [number, number, number] } }; commitScene(next); };
  const importModel = async (file: File) => {
    setImportError("");
    if (file.size > 8 * 1024 * 1024) { setImportError("模型超过 8MB，已拒绝"); return; }
    const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result || "")); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file); });
    let url = dataUrl;
    try {
      const bridge = (window as unknown as { openarc?: { canvas?: { command?: (request: Record<string, unknown>) => Promise<Record<string, unknown>> } } }).openarc?.canvas;
      if (bridge && typeof bridge.command === "function") {
        const result = await bridge.command({ type: "canvas/assetLibrary/import", name: file.name, mime: file.type || "model/gltf-binary", dataUrl });
        if (result && result.ok === true) url = String(result.url || result.ref || (result.asset as any)?.url || dataUrl);
      }
    } catch { /* fallback data URL */ }
    const next = { ...currentScene(), objects: [...currentScene().objects, { id: "gltf_" + Date.now().toString(36), type: "gltf" as const, position: [0, 1, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number], color: "#ffffff", url, name: file.name }] };
    commitScene(next);
  };

  useEffect(() => { import("three/examples/jsm/exporters/GLTFExporter.js").then(() => setGlbSupported(true)).catch(() => setGlbSupported(false)); }, []);
  const onChangeRef = useRef(onChange);
  const thumbRef = useRef(onThumbnail);
  onChangeRef.current = onChange;
  thumbRef.current = onThumbnail;

  useEffect(() => {
    let disposed = false;
    let frame = 0;
    let cleanup: (() => void) | undefined;
    (async () => {
      const test = document.createElement("canvas");
      const gl = test.getContext("webgl2") || test.getContext("webgl");
      if (!gl) { if (!disposed) setError("当前环境不支持 WebGL，无法渲染 3D 片场"); return; }
      let THREE: typeof import("three");
      try { THREE = await import("three"); } catch { if (!disposed) setError("3D 渲染器加载失败"); return; }
      if (disposed || !hostRef.current) return;
      threeRef.current = THREE;
      const width = hostRef.current.clientWidth || 600;
      const height = hostRef.current.clientHeight || 300;
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
      (window as unknown as { __openarcScene3D?: unknown }).__openarcScene3D = { renderer, scene: null, group: null };
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(width, height);
      renderer.domElement.className = "rc-scene3d-canvas";
      hostRef.current.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      sceneObjRef.current = scene;
      const initial = sceneRef.current || { objects: [], camera: { position: [6, 5, 8], target: [0, 0, 0] }, background: "#111111" };
      scene.background = new THREE.Color(initial.background);
      const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 200);
      const target = new THREE.Vector3(...initial.camera.target);
      const spherical = new THREE.Spherical().setFromVector3(new THREE.Vector3(...initial.camera.position).sub(target));
      camera.position.setFromSpherical(spherical).add(target);
      camera.lookAt(target);
      const ambient = new THREE.AmbientLight(0xffffff, 0.55); scene.add(ambient); ambientRef.current = ambient;
      const dir = new THREE.DirectionalLight(0xffffff, 1.1);
      dir.position.set(5, 8, 4);
      scene.add(dir); dirRef.current = dir;
      const grid = new THREE.GridHelper(20, 20, 0x444444, 0x2a2a2a);
      scene.add(grid);
      const group = new THREE.Group();
      scene.add(group);
      const meshes: any[] = [];
      let GltfLoader: any = null;
      try { const mod: any = await import("three/examples/jsm/loaders/GLTFLoader.js"); GltfLoader = mod.GLTFLoader || mod.default; } catch { GltfLoader = null; }
      const cameraApply = (data: Scene3DData) => { target.set(...data.camera.target); spherical.setFromVector3(new THREE.Vector3(...data.camera.position).sub(target)); camera.position.setFromSpherical(spherical).add(target); camera.lookAt(target); render(); };
      cameraApplyRef.current = cameraApply;
      const syncObjects = (data: Scene3DData) => {
        for (const root of gltfRootsRef.current) { try { group.remove(root); } catch { /* ignore */ } }
        gltfRootsRef.current = [];
        if (data.background) scene.background = new THREE.Color(data.background);
        if (ambientRef.current) ambientRef.current.intensity = data.lights?.ambient ?? 0.55;
        if (dirRef.current) { dirRef.current.intensity = data.lights?.directional ?? 1.1; dirRef.current.color = new THREE.Color(data.lights?.color || "#ffffff"); }
        for (const mesh of meshes) { group.remove(mesh); mesh.geometry.dispose(); (mesh.material as any).dispose(); }
        meshes.length = 0;
        for (const obj of data.objects) {
          const geometry = obj.type === "sphere" ? new THREE.SphereGeometry(0.5, 24, 16) : obj.type === "cylinder" ? new THREE.CylinderGeometry(0.5, 0.5, 1, 24) : obj.type === "plane" ? new THREE.PlaneGeometry(1.5, 1.5) : new THREE.BoxGeometry(1, 1, 1);
          const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(obj.color), roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide });
          const mesh = new THREE.Mesh(geometry, material);
          mesh.position.set(...obj.position);
          mesh.rotation.set(...obj.rotation);
          mesh.scale.set(...obj.scale);
          mesh.userData.objectId = obj.id;
          group.add(mesh);
          meshes.push(mesh);
        }
        for (const obj of data.objects.filter((item) => item.type === "gltf" && item.url)) {
          if (!GltfLoader) { setImportError("GLTFLoader 不可用"); continue; }
          try { new GltfLoader().load(String(obj.url), (gltf: any) => { gltf.scene.position.set(...obj.position); gltf.scene.rotation.set(...obj.rotation); gltf.scene.scale.set(...obj.scale); group.add(gltf.scene); gltfRootsRef.current.push(gltf.scene); render(); }, undefined, () => setImportError("模型解析失败：" + (obj.name || "GLB"))); } catch { setImportError("模型加载失败：" + (obj.name || "GLB")); }
        }
      };
      syncRef.current = syncObjects;
      (window as unknown as { __openarcScene3D?: unknown }).__openarcScene3D = { renderer, scene, group };
      syncObjects(initial);
      const render = () => { if (!disposed) { renderer.render(scene, camera); } };
      renderRef.current = render;
      const publishCamera = () => {
        if (!sceneRef.current) return;
        const next: Scene3DData = { ...sceneRef.current, camera: { position: [camera.position.x, camera.position.y, camera.position.z], target: [target.x, target.y, target.z] } };
        sceneRef.current = next;
        onChangeRef.current(next);
      };
      let dragging = false;
      let lastX = 0;
      let lastY = 0;
      const onPointerDown = (event: PointerEvent) => { dragging = true; lastX = event.clientX; lastY = event.clientY; renderer.domElement.setPointerCapture?.(event.pointerId); };
      const onPointerMove = (event: PointerEvent) => {
        if (!dragging) return;
        spherical.theta -= (event.clientX - lastX) * 0.008;
        spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi - (event.clientY - lastY) * 0.008));
        lastX = event.clientX; lastY = event.clientY;
        camera.position.setFromSpherical(spherical).add(target);
        camera.lookAt(target);
        render();
      };
      const onPointerUp = (event: PointerEvent) => { if (!dragging) return; dragging = false; renderer.domElement.releasePointerCapture?.(event.pointerId); publishCamera(); };
      const onWheel = (event: WheelEvent) => { event.preventDefault(); spherical.radius = Math.max(2, Math.min(40, spherical.radius * (event.deltaY > 0 ? 1.08 : 0.92))); camera.position.setFromSpherical(spherical).add(target); camera.lookAt(target); render(); publishCamera(); };
      renderer.domElement.addEventListener("pointerdown", onPointerDown);
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
      renderer.domElement.addEventListener("wheel", onWheel, { passive: false });
      const timer = window.setTimeout(() => { try { thumbRef.current?.(renderer.domElement.toDataURL("image/png")); } catch { /* ignore */ } }, 400);
      const resize = () => { if (!hostRef.current) return; const w = hostRef.current.clientWidth; const h = hostRef.current.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); render(); };
      const observer = new ResizeObserver(resize);
      if (hostRef.current) observer.observe(hostRef.current);
      render();
      const loop = () => { frame = window.requestAnimationFrame(loop); };
      loop();
      cleanup = () => {
        window.clearTimeout(timer);
        window.cancelAnimationFrame(frame);
        observer.disconnect();
        renderer.domElement.removeEventListener("pointerdown", onPointerDown);
        window.removeEventListener("pointermove", onPointerMove);
        window.removeEventListener("pointerup", onPointerUp);
        renderer.domElement.removeEventListener("wheel", onWheel);
        syncRef.current = null;
        renderRef.current = null;
        renderer.dispose();
        if (renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
      };
    })();
    return () => { disposed = true; cleanup?.(); };
  }, []);

  useEffect(() => {
    sceneRef.current = node.scene || null;
    if (node.scene) { syncRef.current?.(node.scene); cameraApplyRef.current?.(node.scene); }
    if (node.scene && threeRef.current && hostRef.current) {
      const rendererCanvas = hostRef.current.querySelector("canvas");
      if (rendererCanvas) {
        const three = threeRef.current;
        try {
          const scene = new three.Scene();
          scene.background = new three.Color(node.scene.background);
          renderRef.current?.();
        } catch { /* ignore */ }
      }
    }
  }, [node.scene]);

  const download = (href: string, name: string) => { const link = document.createElement("a"); link.href = href; link.download = name; document.body.appendChild(link); link.click(); link.remove(); };
  const exportScreenshot = () => { const canvas = hostRef.current?.querySelector("canvas"); if (!canvas) { setError("3D 画布尚未就绪"); return; } try { download(canvas.toDataURL("image/png"), "scene3d.png"); } catch (caught: any) { setError(String((caught && caught.message) || "截图失败")); } };
  const exportGlb = async () => { try { const mod: any = await import("three/examples/jsm/exporters/GLTFExporter.js"); const Exporter = mod.GLTFExporter || mod.default; const exporter = new Exporter(); exporter.parse(sceneObjRef.current, (result: any) => { const blob = result instanceof Blob ? result : new Blob([result], { type: "model/gltf-binary" }); const href = URL.createObjectURL(blob); download(href, "scene3d.glb"); setTimeout(() => URL.revokeObjectURL(href), 4000); }, (caught: any) => setError(String((caught && caught.message) || "GLB 导出失败")), { binary: true }); } catch (caught) { setError("GLB 导出不可用"); } };
  return <div className="rc-scene3d-shell">
    <div ref={hostRef} className="rc-scene3d-viewport" data-testid="scene3d-viewport" />
    {error ? <div className="rc-scene3d-fallback" data-testid="scene3d-error">{error}</div> : null}
    {importError ? <div className="rc-scene3d-import-error" data-testid="scene3d-import-error">{importError}</div> : null}
    <div className="rc-scene3d-export">
      <button data-testid="scene3d-import" onClick={() => importInputRef.current?.click()}>导入模型</button>
      <button data-testid="scene3d-reset-camera" onClick={resetCamera}>重置视角</button>
      <button data-testid="scene3d-lights-toggle" onClick={() => setLightsOpen(!lightsOpen)}>灯光</button>
      <button data-testid="scene3d-export-png" onClick={exportScreenshot}>导出截图</button>
      <button data-testid="scene3d-export-glb" disabled={!glbSupported} title={glbSupported ? "导出 GLB" : "GLTFExporter 不可用"} onClick={() => void exportGlb()}>导出 GLB</button>
    </div>
    <input ref={importInputRef} type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden data-testid="scene3d-import-input" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) void importModel(file); }} />
    {lightsOpen ? <div className="rc-scene3d-lights" data-testid="scene3d-lights">
      <label>环境光 <input type="range" min="0" max="5" step="0.05" data-testid="scene3d-ambient" value={currentScene().lights?.ambient ?? 0.55} onChange={(event) => commitScene({ ...currentScene(), lights: { ...(currentScene().lights || { directional: 1.1, color: "#ffffff" }), ambient: Number(event.target.value) } })} /></label>
      <label>平行光 <input type="range" min="0" max="8" step="0.05" data-testid="scene3d-directional" value={currentScene().lights?.directional ?? 1.1} onChange={(event) => commitScene({ ...currentScene(), lights: { ...(currentScene().lights || { ambient: 0.55, color: "#ffffff" }), directional: Number(event.target.value) } })} /></label>
      <label>光色 <input type="color" data-testid="scene3d-light-color" value={currentScene().lights?.color || "#ffffff"} onChange={(event) => commitScene({ ...currentScene(), lights: { ...(currentScene().lights || { ambient: 0.55, directional: 1.1 }), color: event.target.value } })} /></label>
      <label>背景 <input type="color" data-testid="scene3d-background" value={currentScene().background} onChange={(event) => commitScene({ ...currentScene(), background: event.target.value })} /></label>
    </div> : null}
  </div>;
}
