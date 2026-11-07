import { createRoot } from "react-dom/client";
import "../../design-system/tokens.css";
import "../../design-system/primitives.css";
import "../../styles.css";
import { ReactCanvasApp } from "./ReactCanvasApp";
import "./reactCanvas.css";

if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark");
}
document.body.classList.add("rc-standalone");

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ReactCanvasApp />);
}
