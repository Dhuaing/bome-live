/**
 * 把 src/assets/tabbar/*.svg 渲染成微信小程序可用的 PNG。
 *
 * 背景：微信小程序 tabBar 的 iconPath 只支持 png/jpg/jpeg，不支持 svg。
 * 官方建议尺寸 81×81px、单文件小于 40KB。
 *
 * 用法：node scripts/svg2png-tabbar.js
 * 依赖：puppeteer-core + 本机 Chrome/Edge（不额外下载浏览器）
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const SRC_DIR = path.join(__dirname, '..', 'src', 'assets', 'tabbar');
const SIZE = 81;

/** 找一个本机可用的 Chromium（Edge / Chrome 都行） */
function findBrowser() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('未找到 Chrome/Edge，无法渲染 PNG');
}

(async () => {
  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.svg'));
  if (!files.length) {
    console.error('没有找到 svg 文件');
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: findBrowser(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });

    for (const file of files) {
      const svg = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
      // 让 svg 铺满 81×81 画布
      const html = `<!DOCTYPE html><html><head><style>
        html,body{margin:0;padding:0;width:${SIZE}px;height:${SIZE}px;background:transparent;}
        svg{display:block;width:${SIZE}px;height:${SIZE}px;}
      </style></head><body>${svg}</body></html>`;

      await page.setContent(html, { waitUntil: 'load' });

      const out = path.join(SRC_DIR, file.replace(/\.svg$/, '.png'));
      await page.screenshot({ path: out, omitBackground: true, type: 'png' });

      const size = fs.statSync(out).size;
      console.log(`✓ ${path.basename(out)}  ${SIZE}x${SIZE}  ${size} B${size > 40 * 1024 ? '  ⚠️ 超过 40KB' : ''}`);
    }
  } finally {
    await browser.close();
  }
})();
