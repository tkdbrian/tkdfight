import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf-8")) as { version: string };
const apiTarget = `http://localhost:${process.env.API_PORT ?? "3001"}`;
// Opt-in for the isolated web demo build; portable and existing remote builds keep their PWA behavior.
const browserDemoBuild = process.env.TKD_BROWSER_DEMO_BUILD === "1";
const baseManifest = {
  name: "TKD Fight",
  short_name: "TKDFight",
  description: "Sistema de scoring para torneos de Taekwondo",
  theme_color: "#0f172a",
  background_color: "#0f172a",
  display: "standalone" as const,
  orientation: "landscape" as const,
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

// Only the opt-in web demo build emits two scoped workers. The root bridge keeps
// the old server desk's API cache but lets /demo navigate to its own app shell.
const dualWorkerRegistration: Plugin = {
  name: "tkd-dual-worker-registration",
  transformIndexHtml(html) {
    const bootstrap = `<script id="tkd-demo-canonical">if(location.pathname==='/demo')location.replace('/demo/'+location.search+location.hash)</script>
<script id="tkd-demo-legacy-bridge">if(location.pathname==='/tv/demo'){document.documentElement.dataset.tkdDemoBridge='1';(async()=>{try{if('serviceWorker' in navigator){const reg=await navigator.serviceWorker.register('/demo-sw.js',{scope:'/demo/'});const deadline=Date.now()+15000;while(reg.active?.state!=='activated'){if(Date.now()>deadline)throw Error('No se pudo activar la demo');await new Promise(resolve=>setTimeout(resolve,100))}}location.replace('/demo/'+location.search+location.hash)}catch{const show=()=>{const root=document.getElementById('root');if(root)root.textContent='No se pudo preparar la demo. Comprobá la conexión y recargá esta página.'};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});else show()}})()}</script>
<script id="tkd-worker-registration">if('serviceWorker' in navigator){window.addEventListener('load',()=>{if(location.pathname==='/tv/demo'||location.pathname==='/demo'||location.pathname.startsWith('/demo/'))return;navigator.serviceWorker.register('/sw.js',{scope:'/'}).catch(()=>{})})}</script><script>const manifest=document.createElement('link');manifest.rel='manifest';manifest.href=location.pathname==='/tv/demo'||location.pathname==='/demo'||location.pathname.startsWith('/demo/')?'/demo.webmanifest':'/manifest.webmanifest';document.head.appendChild(manifest)</script>`;
    if (!html.includes("</head>")) throw new Error("Expected closing head for scoped PWA registration");
    return html.replace("</head>", `${bootstrap}</head>`);
  },
  generateBundle() {
    this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify({ ...baseManifest, start_url: "/", scope: "/", lang: "en" }) });
    this.emitFile({ type: "asset", fileName: "demo.webmanifest", source: JSON.stringify({ ...baseManifest, orientation: "any", start_url: "/demo/", scope: "/demo/", lang: "en" }) });
  },
};

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      ...(browserDemoBuild ? { filename: "demo-sw.js", scope: "/demo/", injectRegister: null } : {}),
      includeAssets: ["icon-192.png", "icon-512.png"],
      manifest: browserDemoBuild ? false : baseManifest,
      workbox: {
        globPatterns: browserDemoBuild
          ? ["**/*.{js,css,html,ico,png,svg,webmanifest}"]
          : ["**/*.{js,css,html,ico,png,svg}"],
        maximumFileSizeToCacheInBytes: 5_000_000,
        ...(browserDemoBuild
          ? { skipWaiting: true, clientsClaim: true, cacheId: "tkd-browser-demo", cleanupOutdatedCaches: true }
          : {}),
        // Excluir rutas server-rendered del service worker (no son rutas SPA)
        navigateFallback: browserDemoBuild ? "/index.html" : "index.html",
        ...(browserDemoBuild ? { navigateFallbackAllowlist: [/^\/demo(?:\/|$)/] } : {}),
        navigateFallbackDenylist: browserDemoBuild
          ? [
              /^\/judge/, /^\/tv/, /^\/qr\//,
              /^\/api(?:\/|$)/, /^\/socket\.io(?:\/|$)/,
              /^\/boot-status(?:\/|$)/, /^\/build-id\.json$/,
            ]
          : [/^\/judge/, /^\/tv/, /^\/qr\//],
        runtimeCaching: browserDemoBuild
          ? [] // The browser-local demo must never cache shared-server operational responses.
          : [
              {
                // Existing remote/portable behavior is intentionally unchanged.
                urlPattern: /^\/api\/(?!backup\/|boot-status(?:$|\?)|build-id(?:$|\?))/,
                handler: "NetworkFirst",
                options: { cacheName: "api-cache" },
              },
            ],
      },
    }),
    ...(browserDemoBuild ? [VitePWA({
      registerType: "prompt",
      filename: "sw.js",
      scope: "/",
      injectRegister: null,
      manifest: false,
      workbox: {
        // Root bridge must not claim /demo clients or delete its separate precache.
        skipWaiting: true,
        clientsClaim: false,
        cleanupOutdatedCaches: false,
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        maximumFileSizeToCacheInBytes: 5_000_000,
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/judge/, /^\/tv/, /^\/qr\//, /^\/demo(?:\/|$)/],
        runtimeCaching: [{
          urlPattern: /^\/api\/(?!backup\/|boot-status(?:$|\?)|build-id(?:$|\?))/,
          handler: "NetworkFirst",
          options: { cacheName: "api-cache" },
        }],
      },
    }), dualWorkerRegistration] : []),
  ],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/boot-status": apiTarget,
      "/api": apiTarget,
      "/socket.io": {
        target: apiTarget,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
});
