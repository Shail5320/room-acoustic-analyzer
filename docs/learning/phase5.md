# Phase 5 — Spatial RT60 Heatmap & Inverse-Distance Weighting (IDW)

> **Context:** EchoMap room acoustic analyzer. This learning document details the mathematical formulation, physical acoustics basis, design decisions, and computational implementation of the 2D reverberation time (RT60) spatial interpolation engine.

---

## 1. Introduction & Overview

Reverberation time ($RT_{60}$) in real enclosed spaces is rarely completely uniform. Acoustic energy distribution is influenced by room geometry, room modes (standing waves), boundary surface materials, localized absorption (carpets, acoustic panels, furniture), and opening apertures. While measuring at every point in a room is physically impossible, collecting a set of distributed measurements across the floor plan allows estimating the spatial variation of decay rates.

In Phase 5, EchoMap introduces a continuous, 2D reverberation heatmap rendered across the floor plan for each octave band ($125\,\text{Hz}$ to $4000\,\text{Hz}$). The interpolation must satisfy strict acoustic and user-trust requirements:
1. **Aspect-ratio fidelity:** Distance calculations must represent physical room proportions, not distorted square coordinates.
2. **Exact data reproduction:** At any measurement point, the interpolated field must reproduce the measured value exactly, without numerical singularities or division by zero.
3. **Acoustic metric integrity:** Interpolation only incorporates valid or approximate metric values actually chosen by the DSP analysis stage ($T_{30}$ if $T_{30}$ was used, $T_{20}$ if $T_{20}$ was used), never falling back to rejected or invalid metrics.
4. **Perceptual and accessible visualization:** Colour scales must be colour-blind friendly and perceptually monotonic.
5. **Radical honesty:** The UI must never convey false confidence. When data is sparse ($< 4$ usable points), the map is dimmed and an honest caveat is displayed. All maps carry a permanent disclaimer that values are interpolated estimates, not direct measurements.

---

## 2. Inverse-Distance Weighting (IDW) Formulation

### 2.1 General IDW Equation

Inverse-Distance Weighting (Shepard's method) is a deterministic spatial interpolation technique based on Tobler's first law of geography: *"everything is related to everything else, but near things are more related than distant things."*

Given $N$ measured points with coordinates $(x_i, y_i)$ and measured values $v_i$, the estimated value $V(x, y)$ at an unmeasured query position $(x, y)$ is given by the normalized weighted sum:

$$V(x, y) = \frac{\sum_{i=1}^{N} w_i(x, y) \cdot v_i}{\sum_{i=1}^{N} w_i(x, y)}$$

where the weighting factor $w_i(x, y)$ is an inverse power of the Euclidean distance $d_i$:

$$w_i(x, y) = \frac{1}{d_i(x, y)^p}, \quad p > 0$$

### 2.2 Aspect-Corrected Distance Metric

EchoMap stores room positions in normalized relative coordinates $(x, y) \in [0, 1] \times [0, 1]$, where $(0, 0)$ represents the top-left corner and $(1, 1)$ represents the bottom-right corner. However, rooms are rarely square.

Let $L$ be the room width (length) and $W$ be the room depth (height). The room aspect ratio is:

$$R = \frac{\text{Width}}{\text{Height}} = \frac{L}{W}$$

In normalized relative coordinates, moving $\Delta x = 0.1$ horizontally corresponds to a physical distance of $0.1 \cdot L$, whereas moving $\Delta y = 0.1$ vertically corresponds to $0.1 \cdot W = 0.1 \cdot \frac{L}{R}$.

If we computed distance directly on raw relative coordinates $\sqrt{\Delta x^2 + \Delta y^2}$, a wide room (e.g. $R = 2:1$) would treat 1 meter horizontally as having the same weight as 2 meters vertically! This would severely distort the interpolation contours, elongating them along the narrow dimension.

To maintain physical Euclidean metric proportions up to a constant scale factor $W$, the aspect-corrected distance between query point $(x, y)$ and measurement point $(x_i, y_i)$ is formulated as:

$$d_i(x, y) = \sqrt{\left((x - x_i) \cdot R\right)^2 + (y - y_i)^2}$$

#### Proof of Equivalence to Physical Distance:
Let physical coordinates be $X = x \cdot L$ and $Y = y \cdot W$. The true physical distance is:

$$D_i = \sqrt{(X - X_i)^2 + (Y - Y_i)^2} = \sqrt{(x - x_i)^2 L^2 + (y - y_i)^2 W^2}$$

Factoring out $W$:

$$D_i = W \cdot \sqrt{\left((x - x_i) \cdot \frac{L}{W}\right)^2 + (y - y_i)^2} = W \cdot \sqrt{\left((x - x_i) \cdot R\right)^2 + (y - y_i)^2} = W \cdot d_i(x, y)$$

Because IDW weights are normalized by their sum, any constant global scaling factor $W$ cancels out completely:

$$V(x, y) = \frac{\sum_{i=1}^N \frac{1}{(W \cdot d_i)^p} v_i}{\sum_{i=1}^N \frac{1}{(W \cdot d_i)^p}} = \frac{\frac{1}{W^p} \sum_{i=1}^N \frac{1}{d_i^p} v_i}{\frac{1}{W^p} \sum_{i=1}^N \frac{1}{d_i^p}} = \frac{\sum_{i=1}^N \frac{1}{d_i^p} v_i}{\sum_{i=1}^N \frac{1}{d_i^p}}$$

Thus, aspect-corrected distance $d_i = \sqrt{((x - x_i) \cdot R)^2 + (y - y_i)^2}$ yields the exact physical Euclidean interpolation without requiring absolute room dimensions in metres.

### 2.3 Singularity Handling at $d \to 0$

As the query position approaches an exact measurement position $(x_i, y_i)$, $d_i \to 0$ and $w_i \to \infty$. A naive implementation would produce a division by zero (`1 / 0 = Infinity`) resulting in `Infinity / Infinity = NaN`.

In `src/ui/heatmap-math.js`, we enforce exact reproduction using an $\epsilon$-threshold ($\epsilon = 10^{-6}$):

$$\text{if } d_i(x, y)^2 < \epsilon^2 \implies V(x, y) = v_i$$

This mathematical guarantee satisfies:
1. $V(x_i, y_i) = v_i$ exactly (zero error at measurement points).
2. Complete elimination of floating-point division by zero and `NaN` propagation.

---

## 3. Why Power $p = 2$?

The choice of power parameter $p$ fundamentally determines the smoothness, curvature, and locality of the interpolated field.

### 3.1 Comparison of Power Parameters

| Power $p$ | Spatial Behavior | Derivative at Data Points | Acoustic / Mathematical Suitability |
|:---:|---|---|---|
| **$p < 1$** | Distant points dominate excessively; very blurry field | Discontinuous gradient (cusp) | Unphysical; ignores spatial locality |
| **$p = 1$** | Linear decay; tent-like peaks around measurements | Non-differentiable cone/cusp at $(x_i, y_i)$ | Sharp creases across the room |
| **$p = 2$ (Chosen)** | Inverse-square decay; smooth gradient transitions | Continuous first derivative ($C^1$ smoothness); zero gradient at $(x_i, y_i)$ | Matches energy diffusion; numerically optimal |
| **$p \ge 3$** | Highly localized; resembles Voronoi nearest-neighbor step functions | Flat plateaus surrounded by steep cliffs | Unrealistic stepped decay rates |

### 3.2 Physical Acoustics Rationale

In free-field and semi-diffuse sound propagation, acoustic intensity obeys the inverse-square law:

$$I(r) \propto \frac{1}{r^2}$$

Reverberant field energy density decays across space following diffusion-like differential equations. Choosing $p = 2$ models the influence of localized boundary absorption as radiating an influence that falls off proportionally to $\frac{1}{d^2}$, mirroring spherical acoustic energy dissipation.

### 3.3 Computational Efficiency

For $p = 2$, the weight is:

$$w_i = \frac{1}{d_i^2} = \frac{1}{\left((x - x_i) \cdot R\right)^2 + (y - y_i)^2}$$

Notice that computing $w_i$ requires **zero square root (`Math.sqrt`) and zero power (`Math.pow`) calls** in the inner loop! Avoiding transcendental functions allows evaluating coarse grids ($48 \times 36 = 1,728$ cells) in under $1.5\,\text{ms}$ on a mobile processor.

---

## 4. Limitations with Few Points & The $\ge 4$ Rule

While IDW is intuitive and fast, it has intrinsic mathematical properties that must be understood to prevent misinterpreting acoustic heatmaps.

### 4.1 Convex Combination Constraint

Because weights $w_i > 0$ and $\sum \frac{w_i}{\sum w_k} = 1$, IDW is a convex combination. Consequently, the interpolated value at any point is strictly bounded by the extreme measurements:

$$\min_{i} (v_i) \le V(x, y) \le \max_{i} (v_i)$$

IDW can **never** extrapolate beyond the minimum or maximum measured values. If an unmeasured corner of the room has severe bass trapping or resonance that causes RT60 to reach $1.5\,\text{s}$, but the highest measured point was $1.1\,\text{s}$, the heatmap will never show values higher than $1.1\,\text{s}$.

### 4.2 "Bullseye" Artifacts

Around isolated measurement points that differ significantly from neighbors (for example, a measurement taken right in front of a thick velvet curtain), IDW creates concentric circular or elliptical contours called **"bullseye" artifacts**. As distance increases from the point, its weight drops and the field quickly relaxes to the weighted average of surrounding points.

### 4.3 Spatial Aliasing & The $\ge 4$ (Recommended $\ge 9$) Threshold

Room modes create standing wave pressure distributions with spatial wavelength $\lambda = c / f$. At $125\,\text{Hz}$ in air ($c = 343\,\text{m/s}$):

$$\lambda = \frac{343}{125} \approx 2.74\,\text{m}$$

Nodal pressure lines occur every $\lambda / 2 \approx 1.37\,\text{m}$. By the spatial Nyquist theorem, sampling spatial variations requires at least 2 measurement points per half-wavelength.

With only 1, 2, or 3 measurement points:
- 1 point: The map is a flat single value everywhere.
- 2 points: The map is a simple 1D linear ramp along the line connecting the two points.
- 3 points: The map forms a planar triangular gradient, with no ability to represent localized absorption or room corners.

Therefore, **EchoMap enforces an honest 4-point minimum**:
- With $< 4$ usable points, the UI displays a clear amber warning banner:
  > *"Not enough data for a reliable heatmap. We recommend at least 9 measurement points spread across the room."*
- The heatmap canvas layer is heavily dimmed ($18\%$ opacity) to prevent users from making treatment decisions based on undersampled data.
- 9 points (a $3 \times 3$ distributed grid) represents the practical engineering threshold for identifying corner vs center acoustic variation in rectangular rooms.

---

## 5. Edge Effects & Room Boundaries

In standard IDW, room boundaries (walls, ceiling, floor) do not act as physical barriers. The interpolation treats space as unbounded Euclidean space:

1. **Boundary Pull:** At the perimeter and corners of the floor plan, unmeasured areas are pulled toward the value of the closest perimeter point, because distance to that point is smaller than distance to interior points.
2. **Lack of Wall Occlusion:** If an interior partition or pillar exists, standard IDW cannot "shadow" the acoustic decay behind the obstacle without complex visibility graph calculations.

To address these limitations honestly:
- Every heatmap display in EchoMap includes a persistent caption:  
  **`"Interpolated between measurement points; not a measurement."`**
- If simulated development data is loaded, a prominent **`"DEV DATA"`** banner warns that values do not reflect real acoustic readings.

---

## 6. Perceptually Uniform Colour Mapping

### 6.1 Why Rainbow ("Jet") Palettes Fail

Historically, software used "rainbow" colormaps (blue $\to$ cyan $\to$ green $\to$ yellow $\to$ red). Rainbow palettes are disastrous in scientific and acoustic visualization:
1. **Luminance Inversion & False Contours:** Yellow has dramatically higher perceived lightness than cyan and red. The human eye perceives sharp boundaries at color band transitions (e.g. green to yellow) even where the underlying RT60 changes smoothly.
2. **Colour-Blind Inaccessibility:** Approximately $8\%$ of men and $0.5\%$ of women have red-green colour vision deficiency (deuteranopia or protanopia). To these users, green and red appear nearly identical in hue, making high and low RT60 regions indistinguishable.

### 6.2 The Viridis Colormap

EchoMap implements an 8-stop perceptually uniform **Viridis-like colour ramp**:

```
t = 0.00:  #440154  (Deep Purple / Dark Indigo)   — Lowest RT60 (most dead/dry)
t = 0.15:  #482878  (Purple)
t = 0.30:  #3e4a89  (Indigo / Blue)
t = 0.45:  #31688e  (Blue-Green)
t = 0.60:  #26828e  (Teal)
t = 0.75:  #35b779  (Green)
t = 0.90:  #6ece58  (Light Yellow-Green)
t = 1.00:  #fde725  (Bright Yellow)               — Highest RT60 (most reverberant/live)
```

#### Mathematical Properties of Viridis:
1. **Monotonically Increasing Perceived Luminance:**  
   Perceived luminance $Y = 0.2126 R + 0.7152 G + 0.0722 B$ increases strictly monotonically from $Y = 21.2$ at $t = 0.0$ to $Y = 221.7$ at $t = 1.0$. Even when printed in black and white or viewed on a greyscale screen, higher values are unambiguously brighter.
2. **Colour-Blind Safe:** The palette transitions simultaneously across hue and lightness without relying on red-green discrimination.

### 6.3 Dynamic Auto-Scale vs Fixed Comparative Scale

EchoMap provides two range scaling modes:
1. **Auto Range (Default):**  
   $$\text{min} = \max(0, \text{dataMin} - 0.05 \cdot \text{span}), \quad \text{max} = \text{dataMax} + 0.05 \cdot \text{span}$$  
   Maximizes visual contrast within the active octave band. Handles zero-width edge cases (single point or all equal values) by symmetrically padding $\pm 0.2\,\text{s}$ so the scale never divides by zero.
2. **Fixed Range ($0.0\,\text{s}$ to $2.0\,\text{s}$):**  
   Keeps the color scale identical across all octave bands. This allows users to switch between $125\,\text{Hz}$ and $4000\,\text{Hz}$ and directly observe how low frequencies have longer reverberation than high frequencies without mental recalibration.

---

## 7. Rendering Pipeline & Architecture

To achieve 60 FPS performance on mobile devices with zero external libraries, EchoMap separates math from rendering:

```
src/ui/heatmap-math.js (Pure Logic, Node-testable)
  ├── extractPointBandValue()      --> Strict T30/T20 metric extraction & tier qualification
  ├── getUsablePoints()            --> Filters valid & approximate measured points
  ├── aspectCorrectedDist()        --> d = sqrt((dx*R)^2 + dy^2)
  ├── interpolateIDW()             --> Power-2 IDW with exact distance-0 short-circuit
  ├── computeHeatmapGrid()         --> Coarse 48xN matrix evaluation
  ├── computeHeatmapRange()        --> Auto (padded) vs Fixed (0-2s) bounds
  └── interpolateViridis()         --> Perceptually uniform color lookup

src/ui/heatmap.js (Canvas & DOM Controller)
  ├── HeatmapRenderer              --> Offscreen canvas caching, bilinear upscaling
  ├── drawHeatmapMeasurementMarker --> Distinct approximate markers (dashed amber + '≈')
  └── renderHeatmapLegendCanvas    --> High-DPI gradient color bar with ticks and units (s)
```

### Coarse Grid & Bilinear GPU Upscaling

Rather than evaluating IDW at every screen pixel ($800 \times 600 = 480,000$ points), EchoMap evaluates a coarse grid:
- Columns: $N_\text{cols} = 48$
- Rows: $N_\text{rows} = \text{round}(48 / R)$ (e.g. 36 rows for $4:3$)
- Total cells: $1,728$ cells (a $277\times$ computational reduction).

The grid is drawn onto an offscreen canvas as raw image data (`ImageData`), and then drawn onto the main display canvas using the 2D canvas context:

```javascript
ctx.imageSmoothingEnabled = true;
ctx.imageSmoothingQuality = 'high';
ctx.drawImage(offscreenCanvas, bounds.x, bounds.y, bounds.width, bounds.height);
```

The browser's hardware-accelerated bilinear/bicubic filtering smoothly blends between coarse cells, producing smooth gradients with zero visible pixelation or edge artifacts.

---

## 8. Check Questions

### Question 1: Aspect Ratio Correction
**Question:**  
In a rectangular room with aspect ratio $R = 16/9$ ($1.778$), two points are located relative to query point $P(0.5, 0.5)$:  
Point $A$ is at $(0.2, 0.5)$ ($\Delta x = -0.3, \Delta y = 0$).  
Point $B$ is at $(0.5, 0.2)$ ($\Delta x = 0, \Delta y = -0.3$).  
Which point has a larger influence (larger weight $w_i$) on the interpolated value at point $P$, and why?

**Answer:**  
Point $B$ has a significantly larger influence.  
Although their normalized coordinate differences are equal ($|\Delta x| = |\Delta y| = 0.3$), the aspect-corrected distance to Point $A$ is $d_A = \sqrt{(0.3 \cdot \frac{16}{9})^2 + 0} \approx 0.533$, whereas for Point $B$, $d_B = \sqrt{0 + 0.3^2} = 0.300$.  
Since distance $d_B < d_A$, Point $B$ is physically much closer to $P$ in real room space than Point $A$. Because weight $w = 1 / d^2$, $w_B = 1 / 0.09 \approx 11.11$, while $w_A = 1 / 0.284 \approx 3.52$. Point $B$ exerts more than $3\times$ the weighting power of Point $A$.

---

### Question 2: Why Power $p = 2$ Eliminates Cusps
**Question:**  
Why does an IDW power of $p = 1$ produce sharp, tent-like cusps at measurement points, while $p = 2$ produces smooth transitions with a horizontal tangent ($C^1$ smoothness)?

**Answer:**  
For $p = 1$, the first derivative of weight $w_i = \frac{1}{d_i}$ with respect to distance $d_i$ is $\frac{\partial w_i}{\partial d_i} = -\frac{1}{d_i^2}$. As $d_i \to 0$, the slope does not flatten; it approaches infinity from all directions, creating a conical peak or valley (a non-differentiable cusp).  
For $p = 2$, normalized weighting yields $\frac{\partial V}{\partial d_i} \to 0$ as $d_i \to 0$. The slope flattens out smoothly at the measurement point, ensuring continuous first derivatives and physically realistic, smooth acoustic gradients.

---

### Question 3: The Convex Combination Trap
**Question:**  
A sound engineer takes 5 measurements in a rectangular tracking room. All 5 points are measured along the center line of the room, and their RT60 values at $1000\,\text{Hz}$ range between $0.45\,\text{s}$ and $0.55\,\text{s}$. The corners of the room have untreated bare drywall. Can the IDW heatmap show that the corners have an RT60 of $0.80\,\text{s}$?

**Answer:**  
No. IDW is strictly a convex combination: for all points in the space, $V(x, y)$ is mathematically constrained to lie within the interval $[\min(v_i), \max(v_i)]$, which is $[0.45\,\text{s}, 0.55\,\text{s}]$. Because IDW cannot extrapolate outside the measured dynamic range, unmeasured long reverberation in the corners will remain completely invisible. This highlights why EchoMap insists on distributed measurements spread across the room perimeter and corners before trusting a heatmap.
