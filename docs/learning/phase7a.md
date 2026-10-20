# Phase 7a Learning Note — Accessibility, Error Handling & Mobile Hardening

> **Phase 7a:** Production hardening, accessibility compliance (WCAG AA), graceful error states, in-app acoustics guide, and mobile tab vs standalone verification.

---

## 1. Accessibility (a11y) Basics for Audio & Canvas Web Apps

### WCAG 2.1 AA Contrast Ratio Mathematics
WCAG 2.1 requires a contrast ratio of at least **4.5:1** for normal text and at least **3:1** for large text or essential user interface components.

Because human eye perception of lightness is non-linear, contrast cannot be calculated using linear arithmetic on 8-bit RGB values ($0–255$). Instead, standard sRGB color channels must be gamma-expanded into linear relative luminance:

$$C_\text{linear} = \begin{cases} \frac{C_\text{sRGB}}{12.92}, & C_\text{sRGB} \le 0.04045 \\ \left(\frac{C_\text{sRGB} + 0.055}{1.055}\right)^{2.4}, & C_\text{sRGB} > 0.04045 \end{cases}$$

Relative luminance $L$ is then computed using standard ITU-R BT.709 photometric coefficients reflecting human spectral sensitivity:

$$L = 0.2126 \cdot R_\text{linear} + 0.7152 \cdot G_\text{linear} + 0.0722 \cdot B_\text{linear}$$

The contrast ratio between the lighter color ($L_1$) and darker color ($L_2$) is:

$$\text{Contrast Ratio} = \frac{L_1 + 0.05}{L_2 + 0.05}$$

In EchoMap, `src/ui/contrast.js` parses the CSS design tokens directly from `style.css` and verifies that all text tokens meet $\ge 4.5:1$ in both light mode and dark mode.

### Tap Targets on Mobile Touchscreens
Mobile fingers have an average contact patch of approximately $10\text{ mm}$, corresponding to roughly $48 \times 48\text{ CSS pixels}$ at typical mobile device pixel ratios. Any button, select dropdown, or interactive control with dimensions smaller than $48\text{ px}$ causes accidental mis-taps. All interactive elements in EchoMap enforce `min-height: 48px; min-width: 48px;`.

### `aria-live` Announcement Etiquette
Live regions (`aria-live="polite"`) instruct screen readers (TalkBack on Android, VoiceOver on iOS) to announce asynchronous updates. A common anti-pattern in DSP applications is updating the live region on every numerical progress tick (e.g. `1%`, `2%`, `3%`...): this floods the assistive queue, blocking the user from hearing anything else. The correct pattern is:
- Update visual progress bars continuously for sighted users.
- Announce to `aria-live` **only when the functional stage changes** (e.g., `"Deconvolving impulse response"`, `"Filtering octave bands"`) and when the **final outcome** is reached (e.g., `"Analysis complete: PNR 32 dB, usable decay depth 41 dB"`).

### Text Alternatives for HTML5 Canvases
HTML5 `<canvas>` elements are raster bitmaps invisible to screen readers and non-graphical browsers. EchoMap provides a prominent **"Show as table"** toggle button that replaces the visual canvas with a fully accessible semantic HTML table listing all measurement markers, relative coordinates, status badges, and per-band RT60 values and validity tiers.

### Respecting User Motion Preferences
Users with vestibular motion disorders or motion sensitivity can experience nausea or disorientation from transitions and animations. EchoMap honours the CSS media query:
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

---

## 2. Robust Error Handling & Graceful Degradation

### IndexedDB Quota & In-Memory Fallback
Mobile browsers (particularly Safari iOS and Chrome on low-storage Android devices) can silently reject IndexedDB transactions with `QuotaExceededError` or disable IndexedDB in Private/Incognito modes. EchoMap uses the **Adapter Pattern** (`StorageService`):
- Attempts persistence via `IndexedDBAdapter`.
- If open or write fails with `QuotaExceededError` or permissions issues, it catches the exception, switches to `MemoryStorageAdapter`, keeps the user's session active in memory, and displays a prominent non-blocking notice urging the user to export a JSON backup.

### Audio File Boundaries
To prevent mobile out-of-memory crashes and browser thread exhaustion:
- Audio files $> 50\text{ MB}$ are rejected during header inspection before buffer decoding.
- Audio recordings $> 30.0\text{ s}$ are rejected to prevent oversized FFT buffers ($> 2^{22}$ samples).
- Corrupted or non-standard containers (such as big-endian RIFX or RF64) are intercepted with informative error descriptions.

---

## 3. Hand-Test Checklist: Browser Tab vs. Standalone Installed Mode

When running on real Android hardware (Chrome), several APIs behave differently in a browser tab versus standalone home-screen mode:

| Feature / API | Browser Tab Mode | Standalone Installed Mode | Notes & Expected Behaviour |
|---|---|---|---|
| **Display Mode** | `display-mode: browser` (shows URL bar, navigation tabs, bottom toolbar) | `display-mode: standalone` (full-screen window without browser address chrome) | Status panel correctly displays `"Browser Tab"` vs `"Standalone (Home Screen)"`. |
| **Wake Lock API** | Screen stays awake during measurements; lock automatically releases if user switches tabs | Screen stays awake; lock releases if app is minimized | Handled via `navigator.wakeLock.request('screen')`. Must wrap in `try/catch`. |
| **Audio File Picker** | Opens browser standard file chooser | Opens native Android document / sound recorder provider | Handled via `<input type="file" accept=".wav,audio/*">`. Both modes correctly accept WAV files. |
| **PWA Service Worker Update** | Updates when user refreshes or navigates | Service worker stays waiting until all windows close or update banner is tapped | EchoMap update banner triggers `postMessage({ action: 'skipWaiting' })` and reloads on `controllerchange`. |
| **Offline Reload** | Pull-to-refresh or tap reload button | Swipe down to reload may be disabled by OS; app must load from cache on launch | Tested by toggling Airplane Mode; app loads instantly from cache-first SW. |
| **Back Button / Gesture** | Navigates back in browser history | Closes app or navigates internal state | Back button should dismiss active modals first before exiting. |

---

## 4. Check Questions

### Question 1
**Why does calculating WCAG contrast ratios require non-linear sRGB gamma expansion rather than linear arithmetic on standard 0–255 RGB values?**

*Answer:* Standard 8-bit digital color values ($0–255$) are encoded with a non-linear gamma curve ($\gamma \approx 2.2–2.4$) to optimize storage for human eye response, where the eye is far more sensitive to subtle differences in dark tones than in bright tones. Physical light reflectance and photometric luminance are linear quantities. To determine true physical light contrast $(L_1 + 0.05)/(L_2 + 0.05)$, digital sRGB values must first be mathematically expanded back into linear space using the inverse piecewise sRGB function before weighting by human spectral eye sensitivities (green $71.52\%$, red $21.26\%$, blue $7.22\%$).

---

### Question 2
**Why is updating an `aria-live` region on every numerical progress tick (e.g. 1% to 100%) considered an accessibility anti-pattern, and what is the recommended practice?**

*Answer:* Screen readers queue speech notifications spoken to the user. If an application updates an `aria-live` region 100 times in 2 seconds, the screen reader becomes backlogged, continuously reading rapid percentage numbers and completely preventing the user from navigating, interacting with controls, or hearing critical status updates. The recommended practice is to maintain continuous visual progress for sighted users while updating the screen reader live announcement region **only when the high-level functional stage changes** (e.g., from deconvolution to octave filtering) and when the process reaches its final success or error conclusion.

---

### Question 3
**In mobile web applications, why must storage layers implement an in-memory fallback adapter rather than failing fatally when IndexedDB throws `QuotaExceededError`?**

*Answer:* Mobile operating systems frequently impose strict per-origin storage caps (often as low as 10–50 MB on shared mobile disks or when storage space is low), and private/incognito browsing modes may block IndexedDB writes entirely. If an application throws an uncaught error when saving to IndexedDB, the UI crashes and the user immediately loses all unsaved acoustic measurements and room layouts. By implementing the Adapter Pattern with an in-memory fallback, the application absorbs the storage failure gracefully: the current session continues to work seamlessly in memory, and the user is warned to download an offline JSON backup before closing the browser tab.
