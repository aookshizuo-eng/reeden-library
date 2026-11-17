import {useEffect} from "react";
import {createRoot} from "react-dom/client";
import Shell from "./shell";
import "./styles.css";
import "./ui.css";

const vendors = new Map();

function loadVendor(file) {
  if (vendors.has(file)) return vendors.get(file);
  const task = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = new URL(file, document.baseURI);
    script.onload = resolve;
    script.onerror = () => { vendors.delete(file); script.remove(); reject(new Error(`无法加载 ${file}`)); };
    document.head.append(script);
  });
  vendors.set(file, task);
  return task;
}

function App() {
  useEffect(() => {
    if (location.hostname.endsWith(".github.io")) window.REEDEN_API_BASE = "https://red-garden-sync.pages.dev";
    else if (location.hostname.endsWith(".pages.dev")) window.REEDEN_API_BASE = location.origin;
    window.loadReedenVendor = loadVendor;
    import(/* @vite-ignore */ new URL("app.js", document.baseURI).href)
      .catch(error => {
        const status = document.getElementById("startupError");
        status.hidden = false;
        status.textContent = `页面未能启动：${error.message}。请刷新重试。`;
        console.error(error);
      });
  }, []);
  return <Shell />;
}

createRoot(document.getElementById("root")).render(<App />);
