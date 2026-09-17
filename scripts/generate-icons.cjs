/**
 * Generate PNG icons from SVG
 *
 * Run: bun scripts/generate-icons.cjs
 *
 * Requires sharp (a devDependency): bun install
 */

const fs = require('fs');
const path = require('path');

// Check if sharp is available
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.log('sharp not installed. Creating placeholder icons...');
  createPlaceholderIcons();
  process.exit(0);
}

const sizes = [16, 32, 48, 128];
const svgPath = path.join(__dirname, '../assets/icons/icon.svg');
const outputDir = path.join(__dirname, '../assets/icons');

async function generateIcons() {
  const svg = fs.readFileSync(svgPath);

  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}.png`);

    await sharp(svg)
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`Generated: icon-${size}.png`);
  }

  console.log('All icons generated successfully!');
}

function createPlaceholderIcons() {
  // Create minimal valid PNG files (1x1 purple pixel)
  // This is just for development - replace with real icons later
  const sizes = [16, 32, 48, 128];

  for (const size of sizes) {
    const outputPath = path.join(outputDir, `icon-${size}.png`);

    // Minimal PNG header + IHDR + IDAT + IEND for a 1x1 purple image
    // This is a valid PNG that Chrome will accept
    const pngData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, // IHDR length
      0x49, 0x48, 0x44, 0x52, // IHDR
      0x00, 0x00, 0x00, 0x01, // width: 1
      0x00, 0x00, 0x00, 0x01, // height: 1
      0x08, 0x02, // bit depth: 8, color type: RGB
      0x00, 0x00, 0x00, // compression, filter, interlace
      0x90, 0x77, 0x53, 0xde, // CRC
      0x00, 0x00, 0x00, 0x0c, // IDAT length
      0x49, 0x44, 0x41, 0x54, // IDAT
      0x08, 0xd7, 0x63, 0x68, 0x60, 0xf8, 0xcf, 0x00, 0x00, 0x00, 0x82, 0x00, 0x81, // compressed data
      0x4a, 0x6f, 0x4a, 0x09, // CRC
      0x00, 0x00, 0x00, 0x00, // IEND length
      0x49, 0x45, 0x4e, 0x44, // IEND
      0xae, 0x42, 0x60, 0x82, // CRC
    ]);

    fs.writeFileSync(outputPath, pngData);
    console.log(`Created placeholder: icon-${size}.png`);
  }

  console.log('\nPlaceholder icons created. Install sharp and re-run to generate proper icons:');
  console.log('  bun install');
  console.log('  bun scripts/generate-icons.cjs');
}

generateIcons().catch(console.error);
