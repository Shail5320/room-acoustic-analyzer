/**
 * src/ui/help.js — In-App Help Cards & Privacy Guide.
 *
 * Provides plain-language explanations of room acoustic concepts, reachable
 * from every screen.
 */

export const HELP_TOPICS = [
  {
    id: 'rt60',
    title: '1. What RT60 Is',
    summary: 'The standard measure of room reverberation ("echoiness").',
    content: `
      <p><strong>Reverberation Time (RT60)</strong> is the time (in seconds) it takes for sound energy to drop by <strong>60 decibels (dB)</strong> after the sound stops.</p>
      <p>In plain language, it measures how long sound lingers in a room:</p>
      <ul>
        <li><strong>High RT60 (&gt; 0.8 s):</strong> Rooms sound echoey, hollow, and boomy. Spoken words blur together and speech clarity suffers.</li>
        <li><strong>Low RT60 (&lt; 0.3 s):</strong> Rooms sound "dry", dead, and quiet, like a recording booth or walk-in closet.</li>
        <li><strong>Balanced target (0.3 – 0.5 s):</strong> Ideal for home studios, podcasting, and living rooms.</li>
      </ul>
    `,
  },
  {
    id: 'absorption-vs-insulation',
    title: '2. Absorption vs Sound Insulation',
    summary: 'Tuning internal room echo is NOT the same as soundproofing.',
    content: `
      <p>Acoustic treatment and soundproofing solve two completely different problems:</p>
      <ul>
        <li><strong>Absorption (EchoMap’s focus):</strong> Soft, porous panels (fiberglass, acoustic foam, rockwool) soak up sound reflections <em>inside</em> the room. This stops flutter echoes and clarifies speech.</li>
        <li><strong>Sound Insulation (Soundproofing):</strong> Heavy, airtight, decoupled walls stop sound from traveling <em>between</em> rooms.</li>
      </ul>
      <p><strong>Important:</strong> Hanging acoustic foam panels on your wall will <strong>not</strong> stop neighbors from hearing your music or block outside traffic noise.</p>
    `,
  },
  {
    id: 'dsp-processing-off',
    title: '3. Why Noise Reduction & Auto Gain Must Be OFF',
    summary: 'Smart phone speech enhancements destroy acoustic decay measurements.',
    content: `
      <p>Modern phones use aggressive digital processing designed for phone calls:</p>
      <ul>
        <li><strong>Auto Gain Control (AGC):</strong> Automatically boosts quiet sounds. When the room response decays, AGC turns up the volume, distorting the decay slope.</li>
        <li><strong>Noise Suppression / Voice Isolation:</strong> Assumes reverberant room reflections are unwanted background noise and abruptly cuts off the decay tail.</li>
      </ul>
      <p>For an accurate measurement, use a voice recorder app with all "Noise Reduction", "Wind Filter", "Voice Isolation", and "AGC" options disabled, or record uncompressed 48 kHz WAV.</p>
    `,
  },
  {
    id: 'heatmap-limitations',
    title: '4. What the Heatmap Shows (and Doesn’t)',
    summary: 'A spatial interpolation between samples, not a full-room scan.',
    content: `
      <p>The heatmap calculates an <strong>Inverse Distance Weighted (IDW)</strong> estimate between your recorded points for each octave band.</p>
      <ul>
        <li><strong>What it shows:</strong> General spatial trends and hotspots where reverberation lingers longer.</li>
        <li><strong>What it doesn’t:</strong> It does not know about room furniture, alcoves, or wall materials unless you measure near them.</li>
        <li><strong>Data density:</strong> If you measure only 2 or 3 points, the map is only a rough guess. We recommend at least <strong>9 well-spaced points</strong> for a reliable acoustic map.</li>
      </ul>
    `,
  },
  {
    id: 'validity-tiers',
    title: '5. What Validity Tiers Mean',
    summary: 'Strict mathematical confidence rating based on noise margin.',
    content: `
      <p>Every octave band calculation is audited for decay linearity (R² &ge; 0.95) and distance to the noise floor:</p>
      <ul>
        <li><strong style="color: var(--success-color);">Valid:</strong> Clean decay with at least 10 dB safety margin above the noise floor. On benchmark tests in simulated rooms, valid metrics recovered true decay times within about <strong>5% to 10%</strong> (from &plusmn;2% at 4 kHz to ~&plusmn;10% at 125 Hz). In real rooms, expect greater physical variation.</li>
        <li><strong style="color: var(--warning-color);">Approximate (≈):</strong> Meets the required fit depth and linearity, but has less than 10 dB noise margin or slight truncation. Usable for guidance, but treat numbers as estimates.</li>
        <li><strong style="color: var(--danger-color);">Invalid (—):</strong> Noise floor too high or non-linear decay. The result is discarded and excluded from treatment calculations.</li>
      </ul>
    `,
  },
  {
    id: 'pnr-and-dynamic-range',
    title: '6. PNR and Usable Decay Depth',
    summary: 'Understanding signal-to-noise quality metrics.',
    content: `
      <p>Two key quality metrics appear at the top of every analysis:</p>
      <ul>
        <li><strong>Peak-to-Noise Ratio (PNR):</strong> The volume difference (in dB) between the direct sound burst and the quiet room noise before the sweep. PNR must exceed 15 dB to confirm the sweep was played loudly and cleanly.</li>
        <li><strong>Usable Decay Depth:</strong> How many decibels the sound decayed cleanly before hitting background noise. T30 requires 35 dB of clean decay; T20 requires 25 dB.</li>
      </ul>
    `,
  },
  {
    id: 'real-vs-simulated',
    title: '7. Real vs Simulated Data',
    summary: 'Mathematical simulations are for learning, not room decisions.',
    content: `
      <p>EchoMap includes a built-in room acoustic simulator (the <em>Simulate Room</em> slider) to let you test the analyzer without making noise.</p>
      <p><strong>Remember:</strong> Simulated decay curves follow ideal statistical equations. Real rooms contain standing wave resonances, furniture scattering, and flutter echoes. Never purchase acoustic panels based on simulated data.</p>
    `,
  },
  {
    id: 'two-device-workflow',
    title: '8. How to Take a Measurement',
    summary: 'The 5-step two-device WAV workflow.',
    content: `
      <ol>
        <li><strong>Get the sweep:</strong> Tap <em>Download test sweep</em> to save the 5-second 48 kHz WAV file. Put it on a second device (laptop, tablet, or Bluetooth speaker).</li>
        <li><strong>Place the speaker:</strong> Place the playback speaker at a fixed spot (e.g., where your studio monitors or TV are located).</li>
        <li><strong>Start recording:</strong> On your phone, start an uncompressed audio recording with all processing turned off.</li>
        <li><strong>Play the sweep:</strong> Press Play on the playback device. Let the 5-second sweep play and record at least 3 seconds of room reverberation after it stops (~12–15 seconds total).</li>
        <li><strong>Analyze and attach:</strong> Choose the audio file in EchoMap. Review the RT60 results and tap <em>Attach to point</em> to save it to your room plan!</li>
      </ol>
    `,
  },
  {
    id: 'privacy',
    title: '9. Privacy & On-Device Security',
    summary: 'Zero uploads. Your recordings and data never leave your browser.',
    content: `
      <p>EchoMap is committed to absolute privacy:</p>
      <ul>
        <li><strong>100% On-Device Processing:</strong> All audio decoding, Fourier transforms (FFT), filter cascades, and Sabine treatment calculations execute directly inside your browser (via Web Worker or main thread).</li>
        <li><strong>No Uploads:</strong> Audio recordings, room dimensions, and measurement points are <strong>never</strong> transmitted over the internet.</li>
        <li><strong>No Telemetry or Tracking:</strong> The application contains zero analytics, tracking pixels, or third-party tracking scripts.</li>
      </ul>
    `,
  },
];
