// Generate native app icons (Android + iOS) from icon.png (512x512)
const fs = require('fs');
const path = require('path');
const { Jimp } = require('jimp');

const root = __dirname;
const src = path.join(root, 'icon.png');

const androidSizes = {
  'mipmap-mdpi': 48,
  'mipmap-hdpi': 72,
  'mipmap-xhdpi': 96,
  'mipmap-xxhdpi': 144,
  'mipmap-xxxhdpi': 192
};

async function main() {
  const image = await Jimp.read(src);

  // Android launcher icons
  for (const [folder, size] of Object.entries(androidSizes)) {
    const dir = path.join(root, 'android', 'app', 'src', 'main', 'res', folder);
    fs.mkdirSync(dir, { recursive: true });
    const img = image.clone().resize({ w: size, h: size });
    await img.write(path.join(dir, 'ic_launcher.png'));
    await img.write(path.join(dir, 'ic_launcher_round.png'));
    console.log('✓', folder, size + 'x' + size);
  }
  // Adaptive foreground (108dp base = 432px at xxxhdpi)
  const fgDir = path.join(root, 'android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi');
  await image.clone().resize({ w: 432, h: 432 }).write(path.join(fgDir, 'ic_launcher_foreground.png'));
  console.log('✓ adaptive foreground 432x432');

  // iOS AppIcon (simple flat icons — iOS 17+ supports single-size)
  const iosDir = path.join(root, 'ios', 'App', 'App', 'Assets.xcassets', 'AppIcon.appiconset');
  fs.mkdirSync(iosDir, { recursive: true });
  const iosSizes = [20, 29, 40, 60, 76, 83.5, 1024];
  const iosImages = [];
  for (const s of iosSizes) {
    const px = Math.round(s * 3); // @3x
    await image.clone().resize({ w: px, h: px }).write(path.join(iosDir, `icon-${px}.png`));
    iosImages.push({ size: `${s}x${s}`, idiom: 'universal', filename: `icon-${px}.png`, scale: '3x' });
  }
  fs.writeFileSync(path.join(iosDir, 'Contents.json'), JSON.stringify({
    images: iosImages,
    info: { version: 1, author: 'xcode' }
  }, null, 2));
  console.log('✓ iOS AppIcon set');

  console.log('\n✅ All native icons generated');
}

main().catch(e => { console.error(e); process.exit(1); });


