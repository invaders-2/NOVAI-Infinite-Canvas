import { useEffect, useRef, useState } from "react";

export function Model3DViewer({ url }: { url: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      const THREE = await import("three");
      const loaderModule: any = await import("three/examples/jsm/loaders/GLTFLoader.js");
      const LoaderCtor = loaderModule.GLTFLoader || loaderModule.default;
      const host = hostRef.current;
      if (!host || disposed) return;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
      camera.position.set(2.2, 1.6, 3.2);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      host.appendChild(renderer.domElement);
      scene.add(new THREE.AmbientLight(0xffffff, 1.4));
      const light = new THREE.DirectionalLight(0xffffff, 2.2);
      light.position.set(3, 5, 4); scene.add(light);
      const resize = () => { const w = host.clientWidth || 1; const h = host.clientHeight || 1; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
      resize();
      let frame = 0;
      const render = () => { frame = window.requestAnimationFrame(render); renderer.render(scene, camera); };
      const onPointer = (() => { let down = false; let lastX = 0; let lastY = 0; return {
        down: (event: PointerEvent) => { down = true; lastX = event.clientX; lastY = event.clientY; host.setPointerCapture?.(event.pointerId); },
        move: (event: PointerEvent) => { if (!down) return; const dx = event.clientX - lastX; const dy = event.clientY - lastY; lastX = event.clientX; lastY = event.clientY; scene.rotation.y += dx * 0.01; scene.rotation.x += dy * 0.01; },
        up: () => { down = false; },
        wheel: (event: WheelEvent) => { event.preventDefault(); camera.position.multiplyScalar(event.deltaY > 0 ? 1.08 : 0.92); },
      }; })();
      host.addEventListener("pointerdown", onPointer.down); host.addEventListener("pointermove", onPointer.move); host.addEventListener("pointerup", onPointer.up); host.addEventListener("wheel", onPointer.wheel, { passive: false });
      window.addEventListener("resize", resize);
      const loader = new LoaderCtor();
      loader.load(url, (gltf: any) => { if (disposed) return; scene.add(gltf.scene); setState("ready"); }, undefined, (caught: any) => { setError(String((caught && caught.message) || "GLB 加载失败")); setState("error"); });
      render();
      cleanup = () => { disposed = true; window.cancelAnimationFrame(frame); window.removeEventListener("resize", resize); host.removeEventListener("pointerdown", onPointer.down); host.removeEventListener("pointermove", onPointer.move); host.removeEventListener("pointerup", onPointer.up); host.removeEventListener("wheel", onPointer.wheel); renderer.dispose(); renderer.domElement.remove(); };
    })().catch((caught) => { setError(String((caught && caught.message) || "3D 初始化失败")); setState("error"); });
    return () => cleanup();
  }, [url]);
  return <div className="rc-model3d-host" ref={hostRef} data-testid="model3d-canvas" data-state={state}>{state === "loading" ? <span data-testid="model3d-loading">加载 3D…</span> : null}{state === "error" ? <span className="rc-model3d-error" data-testid="model3d-error">{error || "GLB 加载失败"}</span> : null}</div>;
}
