/** 独立页：模拟后端 + 示例画布。?empty=1 打开空画布，?speed=4 加快模拟生成 */
import { createRoot } from "react-dom/client";
import { createMockBackend } from "../backend/mock";
import { CanvasApp } from "../CanvasApp";
import { demoDoc } from "./demo";

const q = new URLSearchParams(location.search);
const backend = createMockBackend({ speed: Number(q.get("speed")) || 1, seedDoc: q.get("empty") ? undefined : demoDoc });
const id = q.get("canvas") || (q.get("empty") ? "empty-" + Date.now() : "demo-" + Date.now());
createRoot(document.getElementById("root")!).render(<CanvasApp backend={backend} canvasId={id} name="Halo Buds 2 · 电商套图" onReady={(s) => { (window as unknown as { __cn: unknown }).__cn = s; }} host={{ badge: "模拟后端", user: { name: "L", initial: "L", role: "管理员" }, listCanvases: async () => [{ id, name: "Halo Buds 2 · 电商套图", nodes: 10 }] }} />);
