#!/usr/bin/env node
/**
 * generate-favicons.js
 *
 * Generates every favicon / PWA / OG image that landing.html and
 * site.webmanifest reference, using the Deskly logo SVG rendered
 * through sharp.
 *
 * Output → website/public/
 *   favicon.ico          (32×32 – actually a PNG served as .ico)
 *   favicon-32x32.png    (32×32)
 *   apple-touch-icon.png (180×180)
 *   android-chrome-192x192.png
 *   android-chrome-512x512.png
 *   og-image.png         (1200×630 social card)
 */

const sharp = require('sharp');
const path  = require('path');
const fs    = require('fs');

const OUT = path.join(__dirname, '..', 'public');

// ── Deskly logo as SVG ─────────────────────────────────────────────────────────
// Rounded-rect background + progress arc + "D" letterform + green status dot
function logoSvg(size) {
    const r = Math.round(size * 0.195);   // corner radius
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="512" height="512" rx="${r}" ry="${r}" fill="url(#bg)"/>
  <g transform="translate(256,256)">
    <circle cx="0" cy="0" r="130" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="28"/>
    <path d="M 0 -130 A 130 130 0 1 1 -92 92" fill="none" stroke="white" stroke-width="28" stroke-linecap="round" opacity="0.9"/>
    <path d="M-45-70L-45 70 15 70Q75 70 75 0 75-70 15-70ZM-5-35L15-35Q40-35 40 0 40 35 15 35L-5 35Z" fill="white" opacity="0.95"/>
    <circle cx="95" cy="-95" r="18" fill="#4ade80"/>
    <circle cx="95" cy="-95" r="10" fill="#22c55e"/>
  </g>
</svg>`;
}

// ── OG image (1200×630) ────────────────────────────────────────────────────────
function ogSvg() {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="bgG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#09090b"/>
      <stop offset="100%" stop-color="#0f0f12"/>
    </linearGradient>
    <linearGradient id="logoG" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#818cf8"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bgG)"/>

  <!-- Subtle border -->
  <rect x="1" y="1" width="1198" height="628" rx="0" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="2"/>

  <!-- Logo icon (left-center area) -->
  <g transform="translate(200,315) scale(0.22)">
    <rect x="0" y="0" width="512" height="512" rx="100" ry="100" fill="url(#logoG)" transform="translate(-256,-256)"/>
    <circle cx="0" cy="0" r="130" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="28"/>
    <path d="M 0 -130 A 130 130 0 1 1 -92 92" fill="none" stroke="white" stroke-width="28" stroke-linecap="round" opacity="0.9"/>
    <path d="M-45-70L-45 70 15 70Q75 70 75 0 75-70 15-70ZM-5-35L15-35Q40-35 40 0 40 35 15 35L-5 35Z" fill="white" opacity="0.95"/>
    <circle cx="95" cy="-95" r="18" fill="#4ade80"/>
    <circle cx="95" cy="-95" r="10" fill="#22c55e"/>
  </g>

  <!-- "Deskly" wordmark -->
  <text x="310" y="290" font-family="system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="72" font-weight="700" fill="#ededef" letter-spacing="-3">Deskly</text>

  <!-- Tagline -->
  <text x="310" y="345" font-family="system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="28" fill="#8b8b92" letter-spacing="0">Know where your time goes</text>

  <!-- Feature pills -->
  <g font-family="system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="18" fill="#5c5c66">
    <text x="310" y="400">1-second precision  ·  56 browsers  ·  100% local</text>
  </g>

  <!-- Accent glow -->
  <circle cx="200" cy="315" r="200" fill="#818cf8" opacity="0.04"/>
</svg>`;
}

async function generate() {
    fs.mkdirSync(OUT, { recursive: true });

    const sizes = {
        'favicon-32x32.png':          32,
        'apple-touch-icon.png':       180,
        'android-chrome-192x192.png': 192,
        'android-chrome-512x512.png': 512,
    };

    // Generate square icon PNGs
    for (const [filename, size] of Object.entries(sizes)) {
        const svg = Buffer.from(logoSvg(size));
        await sharp(svg, { density: 300 })
            .resize(size, size)
            .png()
            .toFile(path.join(OUT, filename));
        console.log(`  ✓ ${filename} (${size}×${size})`);
    }

    // favicon.ico — a 32×32 PNG renamed to .ico (all modern browsers accept this)
    const ico32 = Buffer.from(logoSvg(32));
    await sharp(ico32, { density: 300 })
        .resize(32, 32)
        .png()
        .toFile(path.join(OUT, 'favicon.ico'));
    console.log('  ✓ favicon.ico (32×32 PNG)');

    // OG image (1200×630)
    const ogBuf = Buffer.from(ogSvg());
    await sharp(ogBuf, { density: 150 })
        .resize(1200, 630)
        .png()
        .toFile(path.join(OUT, 'og-image.png'));
    console.log('  ✓ og-image.png (1200×630)');

    console.log('\nAll favicon & OG assets generated in website/public/');
}

generate().catch(err => { console.error(err); process.exit(1); });
