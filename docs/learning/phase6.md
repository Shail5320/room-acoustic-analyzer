# Phase 6: Treatment Calculator & Physical Sizing

## 1. Concepts in Plain Language

In earlier phases, EchoMap captured audio, deconvolved impulse responses, filtered octave bands, backward-integrated decay curves, and mapped spatial RT60 across the floor plan. In Phase 6, we translate those acoustic measurements into actionable acoustic treatment recommendations.

The calculator supports a **dimension-optional architecture**:
1. **Primary Result (Zero dimensions required):** The dimensionless absorption ratio ($RT60_\text{measured} / RT60_\text{target}$).
2. **Optional Result (When dimensions are provided):** Physical panel area in $\text{m}^2$ calculated via the Sabine equation, cross-checked with the Eyring equation, bounded by mathematical guards, and displayed with uncertainty range propagation.

---

### 1.1 The Dimensionless Absorption Ratio (Primary Result)

In classical acoustics, reverberation time depends inversely on total room absorption:
$$RT60 \propto \frac{V}{A}$$

If room volume $V$ is unknown, we can divide the measured reverberation time by the target reverberation time:
$$\text{ratio} = \frac{RT60_\text{measured}}{RT60_\text{target}} = \frac{A_\text{target}}{A_\text{now}}$$

Notice that **room volume $V$ cancels out completely**!
- If $\text{ratio} \le 1.0$: The room already possesses sufficient absorption. The UI reports:  
  `"target met (no extra absorption needed)"`
- If $\text{ratio} > 1.0$: The space requires $\text{ratio}\times$ its current total absorption to hit the target. The UI reports:  
  `"total absorption must be about X times what it is now (add about X-1 times the current amount)"`  
  *(For instance, a ratio of $3.0$ means the room has 3 times too much reverberation; total absorption must become $3.0\times$ what it is now, adding $2.0\times$ the existing absorption).*

This dimensionless result is mathematically rigorous, requires zero user measurement of room walls, and cannot be biased by incorrect room dimension estimates.

---

### 1.2 Sabine vs. Eyring: When and Why They Differ

When room dimensions ($L \times W \times H$) are provided, EchoMap computes physical panel treatment areas in metric square metres ($\text{m}^2$).

#### Wallace Clement Sabine (1898)
Sabine treated sound as continuous energy flowing through a room like diffuse gas:
$$A = \frac{0.161 \cdot V}{RT60}$$
$$\Delta A = A_\text{target} - A_\text{now} = 0.161 \cdot V \left(\frac{1}{RT60_\text{target}} - \frac{1}{RT60_\text{measured}}\right)$$

When covering an existing wall of absorption coefficient $\alpha_\text{existing}$ (typically painted drywall or concrete, $\alpha \approx 0.05$) with treatment panels of coefficient $\alpha_\text{material}$, the net added absorption per unit area is $(\alpha_\text{material} - \alpha_\text{existing})$. The required panel area is:
$$S_\text{panel, Sabine} = \frac{\Delta A}{\alpha_\text{material} - \alpha_\text{existing}}$$

**The Sabine Limitation:** Sabine assumes sound absorption occurs continuously along ray paths. In reality, sound energy is absorbed in **discrete reflection events** at room boundaries. When rooms have light absorption ($\bar{\alpha} < 0.2$, such as bare living rooms or reverberant halls), Sabine's continuous approximation is accurate. But in heavily treated spaces ($\bar{\alpha} > 0.3$, such as recording control rooms, podcast studios, and vocal booths), Sabine underestimates the required absorption panels.

#### Carl F. Eyring (1930)
Eyring modeled sound decay as discrete reflection bounces, where a fraction $(1 - \bar{\alpha})$ of energy survives each reflection:
$$RT60 = \frac{0.161 \cdot V}{-S_\text{total} \ln(1 - \bar{\alpha})}$$

Rearranging to solve for the mean absorption coefficient $\bar{\alpha}$ directly from reverberation time:
$$\bar{\alpha} = 1 - \exp\left(-\frac{0.161 \cdot V}{S_\text{total} \cdot RT60}\right)$$

Total Eyring absorption is:
$$A_\text{Eyring} = S_\text{total} \cdot \bar{\alpha}$$

The required panel area under Eyring is computed from the difference of the Eyring absorption terms:
$$\Delta A_\text{Eyring} = A_\text{Eyring, target} - A_\text{Eyring, now} = S_\text{total} (\bar{\alpha}_\text{target} - \bar{\alpha}_\text{now})$$
$$S_\text{panel, Eyring} = \frac{\Delta A_\text{Eyring}}{\alpha_\text{material} - \alpha_\text{existing}}$$

EchoMap presents **Sabine and Eyring side-by-side**. When the target mean absorption $\bar{\alpha}_\text{target} > 0.3$, the UI highlights that Eyring is physically more realistic.

---

### 1.3 Mathematical Guards: Protecting Against Nonsensical Numbers

Real-world calculators must guard against edge cases and physical impossibilities:

1. **Target Already Met ($\Delta A \le 0$):**  
   If $RT60_\text{measured} \le RT60_\text{target}$, $\Delta A \le 0$. A naive equation would output a negative panel area. EchoMap clamps $S_\text{panel} = 0.0$ and displays:  
   `"Target met (no extra absorption needed)"`
2. **Material Ineffective ($\alpha_\text{material} \le \alpha_\text{existing}$):**  
   If a proposed material has lower or equal absorption compared to the wall being covered (e.g. glass panels over drywall, $\alpha_\text{mat} \le \alpha_\text{exist}$), covering the wall actually *increases* reverberation or does nothing. Net absorption $\Delta \alpha \le 0$. EchoMap sets $S_\text{panel} = \infty$ and alerts:  
   `"Material absorption (α = X) is less than or equal to existing surface (α = Y). No amount of this panel can help."`
3. **Available Surface Area Exceeded ($S_\text{panel} > S_\text{wall+ceiling}$):**  
   A cuboid room has total boundary area $S_\text{total} = 2(LW + LH + WH)$. Panels are installed on walls ($2LH + 2WH$) and ceilings ($LW$), but rarely on walking floors. Total treatable area is:
   $$S_\text{wall+ceiling} = 2(LH + WH) + LW = S_\text{total} - LW$$
   If the required panel area exceeds $S_\text{wall+ceiling}$, the user cannot reach the target RT60 with this material even by covering every wall and ceiling completely. EchoMap flags:  
   `"Target is not reachable with this material (requires X m², exceeding available wall and ceiling area of Y m²)."`

---

### 1.4 Range Propagation via Monotonic Corners

Acoustic measurements always exhibit statistical spread across measurement positions ($RT60_\text{min}$ to $RT60_\text{max}$). Furthermore, pace step counts carry an estimated $\sim 10\%$ uncertainty per dimension, compounding to $\sim 30\%$ uncertainty in volume:
$$(1.10)^3 \approx 1.33 \implies \pm 30\% \text{ volume bounds } [0.70 \cdot V_\text{nom}, 1.30 \cdot V_\text{nom}]$$

To avoid presenting a misleadingly precise single number, EchoMap propagates this uncertainty into a **recommended range** $[S_\text{panel, min}, S_\text{panel, max}]$.

#### Monotonicity Proof:
Consider the panel area equation:
$$S_\text{panel} = \frac{0.161 \cdot V}{\alpha_\text{mat} - \alpha_\text{exist}} \left(\frac{1}{RT60_\text{target}} - \frac{1}{RT60_\text{measured}}\right)$$

1. **Volume $V$:** Because $0.161 / (\alpha_\text{mat} - \alpha_\text{exist}) > 0$ and $(1/RT_\text{target} - 1/RT_\text{meas}) > 0$, $S_\text{panel}$ is strictly monotonically increasing with $V$.
2. **Reverberation Time $RT60_\text{measured}$:** As $RT60_\text{measured}$ increases, $1/RT60_\text{measured}$ decreases, which makes $(1/RT60_\text{target} - 1/RT60_\text{measured})$ strictly larger. Hence, $S_\text{panel}$ is strictly monotonically increasing with $RT60_\text{measured}$.

Because $S_\text{panel}$ is monotonic in both independent variables over the physical domain:
- **Minimum Area Corner:** $V_\text{min} = 0.70 \cdot V_\text{nom}$ and $RT60_\text{min}$
- **Maximum Area Corner:** $V_\text{max} = 1.30 \cdot V_\text{nom}$ and $RT60_\text{max}$

EchoMap evaluates these exact monotonic corners to display an honest range (e.g. `14.3 – 29.0 m² (nominal 21.5 m²)`).

---

### 1.5 The 125 Hz Room Mode Caveat & Phone Speaker Limits

EchoMap computes panel areas across all 6 octave bands ($125, 250, 500, 1000, 2000, 4000\text{ Hz}$), but the **headline recommendation is computed only from 250 Hz and above**.

Why is 125 Hz separated with an explicit warning?
1. **Room Modes & Standing Waves:** Below the Schroeder frequency ($f_s \approx 200\text{–}250\text{ Hz}$ in domestic rooms), sound waves interfere constructively and destructively, creating standing wave peaks and nulls. Reverberant field theory (Sabine and Eyring) assumes a diffuse sound field; in modal space, that assumption collapses.
2. **Phone Speaker Distortion:** Miniature phone speakers struggle to produce fundamental 125 Hz acoustic power and exhibit high non-linear harmonic distortion.
3. **Porous Absorber Physics:** Standard porous acoustic panels (50 mm thick) only absorb sound efficiently when panel thickness is at least $1/4$ of the acoustic wavelength ($\lambda/4$). At 125 Hz:
   $$\lambda = \frac{343}{125} = 2.74\text{ m} \implies \frac{\lambda}{4} \approx 68.5\text{ cm}$$
   A 5 cm panel placed directly on a rigid wall has virtually zero particle velocity at 125 Hz and cannot absorb bass energy. Controlling 125 Hz requires tuned resonant membrane bass traps or Helmholtz resonators.

---

### 1.6 Sound Absorption is NOT Sound Insulation

A universal beginner misconception is that mounting foam or fiberglass panels on a wall "soundproofs" a room.
- **Sound Absorption (EchoMap's Scope):** Dissipates acoustic reflections *inside* the room into heat, reducing reverberation, flutter echoes, and room muddiness.
- **Sound Insulation / Soundproofing:** Prevents sound transmission *between* rooms or from outdoors. Soundproofing requires **mass** (dense drywall, lead sheets), **decoupling** (resilient channels, double-stud walls), **damping** (viscoelastic compounds), and **airtight seals**. Thin acoustic panels have negligible transmission loss ($< 2\text{ dB}$).

---

### 1.7 Placement Hint on the Heatmap (Heuristic Hotspot)

The heatmap includes an optional **Placement Hint** toggle that highlights cells in the top quartile ($Q_3$, 75th percentile) of RT60.

To prevent false confidence from sparse or uniform data:
- **Condition 1:** Requires at least 6 usable measurement points ($\ge 6$).
- **Condition 2:** The spatial spread ($RT60_\text{max} - RT60_\text{min}$) must exceed $10\%$ of the spatial mean.
- If either condition is not met, the UI displays:  
  `"reverberation is fairly uniform, no hotspot"`
- If active, top-quartile cells are highlighted with the mandatory caveat:  
  `"These areas have the longest reverberation. Consider treating nearby walls or ceiling. This is a heuristic, not a calculated placement."`

---

## 2. Hand-Checked Worked Examples

### Example 1: Primary Dimensionless Result (Zero Dimensions Provided)
A podcast recording room measures:
- Octave band: $500\text{ Hz}$
- Measured mean RT60: $1.20\text{ s}$
- Target RT60 (Broadcast Voice Preset): $0.40\text{ s}$

$$\text{ratio} = \frac{RT60_\text{measured}}{RT60_\text{target}} = \frac{1.20}{0.40} = \mathbf{3.00}$$
$$\text{excessFactor} = \text{ratio} - 1.0 = 3.00 - 1.0 = \mathbf{2.00}$$

**UI Plain-Language Reading:**
`"total absorption must be about 3.0 times what it is now (add about 2.0 times the current amount)"`

---

### Example 2: Physical Treatment Sizing (Dimensions Provided)
A small control room:
- Dimensions: $L = 5.0\text{ m}, W = 4.0\text{ m}, H = 3.0\text{ m}$
- Room Volume: $V = 5.0 \times 4.0 \times 3.0 = \mathbf{60.0\text{ m}^3}$
- Total Surface Area: $S_\text{total} = 2(5\times 4 + 5\times 3 + 4\times 3) = 2(20 + 15 + 12) = \mathbf{94.0\text{ m}^2}$
- Wall + Ceiling Treatable Area: $S_\text{wall+ceiling} = 94.0 - 20.0 = \mathbf{74.0\text{ m}^2}$
- Measured RT60: $1.20\text{ s}$ (with measured spread $1.10\text{ s}$ to $1.30\text{ s}$)
- Target RT60: $0.40\text{ s}$
- Existing Bare Boundary (painted drywall): $\alpha_\text{existing} = 0.05$
- Proposed Absorber (50 mm fiberglass panel): $\alpha_\text{material} = 0.80$
- Net panel absorption: $\Delta \alpha = 0.80 - 0.05 = \mathbf{0.75}$

#### Step A: Sabine Calculation
$$A_\text{now} = \frac{0.161 \times 60.0}{1.20} = \mathbf{8.05\text{ m}^2} \quad (\text{metric Sabins})$$
$$A_\text{target} = \frac{0.161 \times 60.0}{0.40} = \mathbf{24.15\text{ m}^2}$$
$$\Delta A = 24.15 - 8.05 = \mathbf{16.10\text{ m}^2}$$
$$S_\text{panel, Sabine} = \frac{\Delta A}{\Delta \alpha} = \frac{16.10}{0.75} = \mathbf{21.467\text{ m}^2} \approx \mathbf{21.5\text{ m}^2}$$

Check treatable boundary guard:
$$S_\text{panel} = 21.5\text{ m}^2 \le S_\text{wall+ceiling} = 74.0\text{ m}^2 \quad \text{(OK, reachable)}$$

#### Step B: Eyring Cross-Check
Current room mean absorption:
$$\bar{\alpha}_\text{now} = 1 - \exp\left(-\frac{0.161 \times 60.0}{94.0 \times 1.20}\right) = 1 - \exp(-0.085638) = \mathbf{0.0821}$$
$$A_\text{Eyring, now} = 94.0 \times 0.082074 = \mathbf{7.715\text{ m}^2}$$

Target room mean absorption:
$$\bar{\alpha}_\text{target} = 1 - \exp\left(-\frac{0.161 \times 60.0}{94.0 \times 0.40}\right) = 1 - \exp(-0.256915) = \mathbf{0.2266}$$
$$A_\text{Eyring, target} = 94.0 \times 0.226566 = \mathbf{21.297\text{ m}^2}$$

Required Eyring panel area:
$$\Delta A_\text{Eyring} = 21.297 - 7.715 = \mathbf{13.582\text{ m}^2}$$
$$S_\text{panel, Eyring} = \frac{13.582}{0.75} = \mathbf{18.110\text{ m}^2} \approx \mathbf{18.1\text{ m}^2}$$

#### Step C: Monotonic Corner Propagation (Steps Pace Count $\pm 30\%$ Volume)
Volume bounds:
$$V_\text{min} = 60.0 \times 0.70 = \mathbf{42.0\text{ m}^3}, \quad V_\text{max} = 60.0 \times 1.30 = \mathbf{78.0\text{ m}^3}$$
Measured spread:
$$RT60_\text{min} = 1.10\text{ s}, \quad RT60_\text{max} = 1.30\text{ s}$$

- **Minimum Area Corner ($V_\text{min}, RT60_\text{min}$):**
  $$A_\text{now} = \frac{0.161 \times 42.0}{1.10} = 6.147\text{ m}^2, \quad A_\text{target} = \frac{0.161 \times 42.0}{0.40} = 16.905\text{ m}^2$$
  $$\Delta A_\text{min} = 16.905 - 6.147 = 10.758\text{ m}^2$$
  $$S_\text{panel, min} = \frac{10.758}{0.75} = \mathbf{14.34\text{ m}^2}$$

- **Maximum Area Corner ($V_\text{max}, RT60_\text{max}$):**
  $$A_\text{now} = \frac{0.161 \times 78.0}{1.30} = 9.660\text{ m}^2, \quad A_\text{target} = \frac{0.161 \times 78.0}{0.40} = 31.395\text{ m}^2$$
  $$\Delta A_\text{max} = 31.395 - 9.660 = 21.735\text{ m}^2$$
  $$S_\text{panel, max} = \frac{21.735}{0.75} = \mathbf{28.98\text{ m}^2}$$

**UI Range Display:**
`"Expected Range: 14.3 – 29.0 m² (Nominal: 21.5 m²)"`

---

## 3. Code Implementation Map

| File | Primary Functions & Exports | Architectural Role |
|---|---|---|
| [`src/data/targets.json`](file:///home/equator/playground/college/LSSP%20Project/src/data/targets.json) | Presets: Control room, vocal booth, live room, podcast, classroom, home theater | Verifiable standards (EBU Tech 3276, ANSI/ASA S12.60) and explicit "rule of thumb" citations. |
| [`src/data/materials.json`](file:///home/equator/playground/college/LSSP%20Project/src/data/materials.json) | Fiberglass 50/100mm, foam wedge, heavy drapery, wood slat | Placeholder coefficients with mandatory manufacturer verification notice. |
| [`src/analysis/treatment.js`](file:///home/equator/playground/college/LSSP%20Project/src/analysis/treatment.js) | `aggregateSessionBands()`, `formatPrimaryRatio()`, `calculateBandTreatment()`, `computeTreatmentHeadline()`, `evaluateHotspot()` | Pure mathematical logic: session aggregation, ratio formatting, Sabine & Eyring sizing, guards, and monotonic range corners. Zero DOM dependencies. |
| [`reference/treatment_reference.py`](file:///home/equator/playground/college/LSSP%20Project/reference/treatment_reference.py) | Python reference calculation generating `reference/treatment_expected.json` | Pure standard-library Python reference computing ground truth for all worked examples and guards. |
| [`src/ui/heatmap-math.js`](file:///home/equator/playground/college/LSSP%20Project/src/ui/heatmap-math.js) | Re-exports `evaluateHotspot()`, `computePercentile()`, and hotspot constants | Pure mathematical evaluation of the top quartile $Q_3$ threshold. |
| [`src/ui/heatmap.js`](file:///home/equator/playground/college/LSSP%20Project/src/ui/heatmap.js) | `setPlacementHint()`, offscreen canvas top-quartile cell boost | Renders visual hotspot highlight and reports hotspot status to UI. |
| [`src/ui/app.js`](file:///home/equator/playground/college/LSSP%20Project/src/ui/app.js) | `updateTreatmentUI()`, `loadDataFiles()`, custom material listeners | Connects DOM controls, presets, material selection, guard alerts, and reactive model subscription. |
| [`tests/treatment.test.js`](file:///home/equator/playground/college/LSSP%20Project/tests/treatment.test.js) | 9 test suites covering schema honesty, aggregation, ratios, guards, corners, and hotspots | Automated regression testing matching `treatment_expected.json`. |

---

## 4. Common Acoustic Pitfalls & Misconceptions

1. **Equating Soundproofing with Absorption:**  
   Mounting 50 mm foam wedges inside a room will make speech clearer and reduce flutter echo, but your neighbors will still hear music through the wall. Sound transmission loss requires airtight decoupling and high surface mass ($> 25\text{ kg/m}^2$).
2. **Ignoring the Existing Boundary Absorption:**  
   Covering a bare wall does not add the full absorption of the panel; it replaces the wall's existing absorption ($\alpha_\text{existing} \approx 0.05$). Using $\alpha_\text{material}$ instead of $(\alpha_\text{material} - \alpha_\text{existing})$ underestimates required panel area by $5\text{–}10\%$.
3. **Trusting Sabine in Dead Vocal Booths:**  
   In small, heavily damped rooms ($\bar{\alpha} > 0.3$), Sabine overestimates reverberation time (or underestimates required absorption). Eyring accounts for discrete energy losses per reflection.
4. **Expecting Porous Foam to Absorb Bass at 125 Hz:**  
   Porous panels absorb sound via particle velocity friction. Near a rigid wall boundary, air particle velocity drops to zero (pressure antinode). At 125 Hz, a 50 mm panel is acoustically invisible. Low-frequency control requires diaphragmatic membrane traps or corner Helmholtz absorbers.

---

## 5. Check Questions

### Question 1
*Why is the primary absorption ratio ($RT60_\text{measured} / RT60_\text{target}$) completely independent of room volume $V$?*

**Answer:**  
Under Sabine's formula, reverberation time is $RT60 = \frac{0.161 \cdot V}{A}$. When forming the ratio of measured to target reverberation time:
$$\frac{RT60_\text{measured}}{RT60_\text{target}} = \frac{\frac{0.161 \cdot V}{A_\text{now}}}{\frac{0.161 \cdot V}{A_\text{target}}} = \frac{A_\text{target}}{A_\text{now}}$$
The volume $V$ and the Sabine constant $0.161$ appear identically in both the numerator and denominator, canceling out completely. The ratio therefore depends exclusively on the relative absorption deficit, requiring zero knowledge of room geometry.

---

### Question 2
*Why is the panel sizing formula monotonic in both room volume $V$ and measured reverberation time $RT60_\text{measured}$? What does this imply for uncertainty propagation?*

**Answer:**  
The panel area formula is:
$$S_\text{panel} = \frac{0.161 \cdot V}{\alpha_\text{mat} - \alpha_\text{exist}} \left(\frac{1}{RT60_\text{target}} - \frac{1}{RT60_\text{measured}}\right)$$
- Differentiating with respect to $V$: $\frac{\partial S}{\partial V} > 0$ for all physical rooms where $RT60_\text{measured} > RT60_\text{target}$.
- Differentiating with respect to $RT60_\text{measured}$: $\frac{\partial S}{\partial RT60_\text{meas}} = \frac{0.161 \cdot V}{(\alpha_\text{mat} - \alpha_\text{exist}) (RT60_\text{meas})^2} > 0$.

Because both partial derivatives are strictly positive everywhere in the physical domain, there are no local extrema or saddle points. The absolute minimum panel area must occur at the minimum volume and minimum RT60 corner $(V_\text{min}, RT60_\text{min})$, and the absolute maximum panel area must occur at the maximum corner $(V_\text{max}, RT60_\text{max})$.

---

### Question 3
*Under what condition does EchoMap highlight Eyring's formula over Sabine's, and why does Sabine fail when this threshold is crossed?*

**Answer:**  
EchoMap highlights Eyring when the room's average absorption coefficient $\bar{\alpha}$ exceeds approximately $0.30$.  
Sabine's equation was derived under the assumption that sound absorption is continuous along ray paths, which is a Taylor series approximation $\ln(1 - \bar{\alpha}) \approx -\bar{\alpha}$. When boundaries are lightly absorptive ($\bar{\alpha} \le 0.10$), this approximation is accurate to within $5\%$. However, as $\bar{\alpha} \to 1.0$ (an open window or anechoic boundary), Sabine predicts a non-zero reverberation time ($RT60 = 0.161 \cdot V / S$), whereas sound cannot reflect at all (physically $RT60 = 0$). Eyring correctly captures the discrete reflection loss $-S \ln(1 - \bar{\alpha})$, which approaches infinity as $\bar{\alpha} \to 1$, correctly yielding $RT60 \to 0$.
