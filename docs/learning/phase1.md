# Phase 1: App Shell & Progressive Web App (PWA)

## 1. Concepts in Plain Language

A **Progressive Web App (PWA)** is a standard website built with HTML, CSS, and JavaScript that behaves like a native mobile application when installed on a phone or tablet.

### How Does a Web Page Become an "App"?
A regular website requires an active internet connection and only runs inside a browser tab. To become an installable app, two key components are needed:
1. **The Web App Manifest (`manifest.webmanifest`):** A JSON metadata file that tells the operating system (e.g. Android) how to present the app. It defines the app name, icons, theme colors, and the `display: "standalone"` property, which removes the browser's URL address bar and navigation buttons so it feels like a native app.
2. **The Service Worker (`sw.js`):** A special background script that the browser runs independently of the web page. It acts as an in-browser programmable network proxy. Every time the page requests a file (HTML, CSS, image), the request first passes through the service worker. The service worker can intercept the request and respond immediately from an offline cache (`caches.match`), even if the device has no internet access or is in airplane mode.

### The App Shell Architecture
In an **App Shell** architecture, we separate the static user interface framework (header, navigation, container styling, icons) from dynamic content. By pre-caching this "shell", the app loads instantly on repeat visits regardless of network speed.

---

## 2. Technical Specifications & Formulas

### Relative Paths Under Subpath Hosting
When an app is hosted at the root domain (e.g., `https://example.com/`), absolute paths like `/index.html` or `/sw.js` work fine. However, GitHub Pages hosts project sites under a repository subpath:
$$\text{URL} = \text{https://<username>.github.io/<repo-name>/}$$

If an app at `https://shail5320.github.io/room-acoustic-analyzer/` references `/style.css`, the browser attempts to fetch `https://shail5320.github.io/style.css` (404 Not Found), completely missing the repository folder.

**Specification:** All URLs in `index.html`, `manifest.webmanifest`, and `sw.js` must be strictly relative:
- Manifest link: `./manifest.webmanifest`
- Stylesheet: `./style.css`
- Manifest start URL & scope: `"start_url": "./"`, `"scope": "./"`
- Pre-cache list in `sw.js`: `'./'`, `'./index.html'`, `'./style.css'`, etc.

### Service Worker Lifecycle & Versioned Caching
The service worker lifecycle follows three distinct phases:
1. **Registration:** The web page registers `./sw.js` with scope `./`.
2. **Installation (`install` event):** The browser downloads the service worker. We open a named cache (e.g. `echomap-v1`) and download all shell assets into it using `cache.addAll()`. `self.skipWaiting()` is called to activate without waiting for existing tabs to close.
3. **Activation (`activate` event):** The worker takes control. We iterate over all cache keys using `caches.keys()` and delete any cache whose name does not match `CACHE_NAME`. This removes old, obsolete versions. `self.clients.claim()` ensures the new worker immediately controls all open tabs.
4. **Fetch Interception (`fetch` event):**
   $$\text{Response} = \text{Cache}(\text{Request}) \;\lor\; \text{Network}(\text{Request})$$
   We check `caches.match(event.request)`. If found, we return the cached response (Cache-First). Otherwise, we fetch from the network and store the fresh response in the cache.

---

## 3. Code Implementation Map

| Component / Function | File | Purpose |
|---|---|---|
| Semantic markup & SW loader | [`index.html`](../../index.html) | Defines app shell structure, responsive viewport, and registers `sw.js` with `{ scope: './' }`. |
| Light/Dark mobile layout | [`style.css`](../../style.css) | Implements single-column design, `prefers-color-scheme` CSS variables, and $\ge 48\text{ px}$ touch targets. |
| PWA metadata & display mode | [`manifest.webmanifest`](../../manifest.webmanifest) | Declares app name `EchoMap`, standalone display mode, orientation, theme colors, and icons. |
| App icons | [`icons/icon-192.png`](../../icons/icon-192.png), [`icons/icon-512.png`](../../icons/icon-512.png) | 192×192 and 512×512 PNG icons required for Android home screen and splash screens. |
| Pre-caching & cache eviction | [`sw.js`](../../sw.js) | Handles `install`, `activate` (cache eviction), and `fetch` (cache-first proxying). |

---

## 4. Common Beginner Mistakes

1. **The Stale-Cache Trap:**
   A service worker using a Cache-First strategy will keep serving old files forever if you modify `index.html` or `style.css` without updating the cache name in `sw.js`. Always bump the version identifier (e.g., `echomap-v1` $\rightarrow$ `echomap-v2`) when assets change so that the `activate` listener purges stale files.
2. **Absolute vs. Relative URLs in Pre-caching:**
   Writing `'/index.html'` instead of `'./index.html'` breaks on GitHub Pages or any subpath deployment.
3. **Missing HTTPS:**
   Service workers and device sensor APIs (like microphone access in future phases) strictly require a **Secure Context** (`https://` or `http://localhost`). Loading `http://<laptop-lan-ip>:8000` on a phone over Wi-Fi will block the service worker from registering.
4. **Touch Target Size (< 48 px):**
   Buttons smaller than 48×48 px lead to missed taps and accidental clicks on mobile devices. Always enforce `min-height: 48px; min-width: 48px;` for interactive elements.

---

## 5. Check Your Understanding

1. **Why does GitHub Pages require relative paths (`./`) in the Web App Manifest and Service Worker pre-cache list instead of root-relative paths (`/`)?**
2. **If you update `style.css` on your server but do not change `CACHE_NAME` in `sw.js`, what will a user who previously visited the app see when they reload? Why?**
3. **What is the difference between opening a web app in a mobile browser tab versus launching it as an installed standalone PWA from the home screen?**
