import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Capacitor } from "@capacitor/core";
import App from "./App";
import "./index.css";

// Native Android WebView draws through the app's hwui RenderThread; stacked
// backdrop-filter saveLayers there can corrupt Skia's clip stack (SIGSEGV).
// The .native class disables those effects (see overrides in App.css).
if (Capacitor.isNativePlatform()) {
  document.documentElement.classList.add("native");
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
