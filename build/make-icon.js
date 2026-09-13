// build/icon.svg -> build/icon.ico (256·128·64·48·32·24·16, PNG 내장) + build/icon.png (512) + build/icons/icon.png
// 실행: electron build/make-icon.js   (VS Code 터미널이면 ELECTRON_RUN_AS_NODE 환경변수를 지우고)
// 크기마다 svg 폭/높이를 바꿔 벡터로 다시 그려 캡처하므로 16px에서도 선이 뭉개지지 않는다.
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const SIZES = [256, 128, 64, 48, 32, 24, 16];
const dir = __dirname;

app.whenReady().then(async () => {
    const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
    const win = new BrowserWindow({ show: false, width: 512, height: 512, transparent: true, frame: false, backgroundColor: '#00000000', webPreferences: { offscreen: true } });
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));

    const pngs = {};
    for (const size of [512, ...SIZES]) {
        win.setSize(size, size);
        await win.webContents.executeJavaScript(`(() => { const s = document.querySelector('svg'); s.setAttribute('width', ${size}); s.setAttribute('height', ${size}); return 1; })()`);
        await new Promise(r => setTimeout(r, 250));
        pngs[size] = (await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size })).toPNG();
    }
    win.destroy();

    fs.writeFileSync(path.join(dir, 'icon.png'), pngs[512]);
    fs.mkdirSync(path.join(dir, 'icons'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'icons', 'icon.png'), pngs[512]);

    // ICO = ICONDIR(6) + ICONDIRENTRY(16)×N + PNG 데이터. 폭/높이 0은 256.
    const entries = SIZES.map(s => pngs[s]);
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
    const table = Buffer.alloc(16 * entries.length);
    let offset = 6 + table.length;
    entries.forEach((png, i) => {
        const s = SIZES[i], o = i * 16;
        table.writeUInt8(s === 256 ? 0 : s, o);
        table.writeUInt8(s === 256 ? 0 : s, o + 1);
        table.writeUInt16LE(1, o + 4);      // planes
        table.writeUInt16LE(32, o + 6);     // bpp
        table.writeUInt32LE(png.length, o + 8);
        table.writeUInt32LE(offset, o + 12);
        offset += png.length;
    });
    fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, table, ...entries]));
    console.log(`icon.ico ${offset} bytes (${SIZES.join('/')}), icon.png 512`);
    app.quit();
});
