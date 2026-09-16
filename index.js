const { app, BrowserWindow, ipcMain, dialog, session, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const http = require('http');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { DatabaseSync } = require('node:sqlite'); // Electron 37(Node 22) 내장. 네이티브 모듈 불필요
const geotiff = require('geotiff');                 // GeoPackage 표고 커버리지(TIFF float) 타일 디코딩
const jschardet = require('jschardet');
const iconv = require('iconv-lite');

let mainWindow;
let splash;

// 실행 인자(argv)에서 "layer.meta" 파일 경로만 추출 (다른 .meta는 무시)
function getMetaPathFromArgv(argv) {
    for (const arg of argv) {
        if (typeof arg === 'string'
            && path.basename(arg).toLowerCase() === 'layer.meta'
            && fs.existsSync(arg)) {
            return arg;
        }
    }
    return null;
}

// 렌더러로 파일 경로 전달 (드래그앤드롭과 동일 경로로 로딩됨)
function sendFileToRenderer(filePath) {
    if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('file-path', filePath);
    }
}

// 로컬 파일 HTTP 서버 (3DS 등 엔진이 HTTP URL을 요구하는 파일용)
let localFileServer = null;
let localFileServerPort = 0;

// ============ 최소 PNG 인코더 (외부 의존성 없이) ============
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const PNG_CRC_TABLE = (() => {
    const t = new Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function pngCrc32(buf) {
    let c = 0xFFFFFFFF;
    for (const b of buf) c = PNG_CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(pngCrc32(body));
    return Buffer.concat([len, body, crc]);
}

/** colorType: 2 = RGB(3채널), 6 = RGBA(4채널). pixels는 채널 인터리브 버퍼 */
function encodePng(width, height, colorType, pixels) {
    const ch = colorType === 6 ? 4 : 3;
    const stride = width * ch;
    const raw = Buffer.alloc(height * (1 + stride));
    for (let y = 0; y < height; y++) {
        const o = y * (1 + stride);
        raw[o] = 0; // 필터 타입 None
        pixels.copy(raw, o + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;          // bit depth
    ihdr[9] = colorType;  // 10~12: compression/filter/interlace = 0
    return Buffer.concat([
        PNG_SIG,
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', zlib.deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0))
    ]);
}


/**
 * 세슘 피라미드에서 (z, y, x) 타일의 실제 파일 경로. 인자 y는 XYZ(상단 원점) 기준.
 *
 *  - 'xyz'    : 디스크 y도 XYZ(상단 원점) -> 그대로 사용 (웹 표준/세슘)
 *  - 'tms'    : 디스크 y가 TMS(하단 원점)  -> 뒤집어야 함
 *  - 'vworld' : z/y/x (축 순서만 다름)
 */
function resolveTilePath(entry, z, y, x) {
    const { rootDir, scheme, ext } = entry;
    let a, b;
    if (scheme === 'vworld') {
        a = y; b = x;
    } else if (scheme === 'tms') {
        a = x; b = Math.pow(2, z) - 1 - y;     // z/x/y (반전)
    } else {
        a = x; b = y;                          // xyz: z/x/y (그대로)
    }
    return path.join(rootDir, String(z), String(a), `${b}.${ext}`);
}

// ============ 세슘(EPSG:3857) 피라미드 -> XDWorld(EPSG:4326) 영상 레이어 리타일 ============
//
// XDWorld 영상 레이어 격자 (vworld_png 실측으로 검증):
//   IDX = floor((lon+180)/360 * 10 * 2^L)
//   IDY = floor((lat+90)/180 *  5 * 2^L)
//   경로 = {L}/{IDY:08d}/{IDY:08d}_{IDX:08d}.png   (256x256 RGB, 검정=투명 색상키)
// 타일 폭은 36/2^L 도(degree)로 정사각.
//
// Web Mercator z와는 z = L + log2(10) = L + 3.322 관계라 정수 배수가 아니므로
// 파일명 재작성으로는 불가능하고 픽셀 재샘플링이 필요하다.

const EARTH_R = 6378137;
const MERC_MAX = Math.PI * EARTH_R; // 20037508.342789244

const xdIdx = (lon, L) => Math.floor((lon + 180) / 360 * (10 * Math.pow(2, L)));
const xdIdy = (lat, L) => Math.floor((lat + 90) / 180 * (5 * Math.pow(2, L)));
const pad8 = (n) => String(n).padStart(8, '0');

/** 소스 타일 디코딩 캐시 (BGRA). png/jpg만 지원(nativeImage). */
function makeTileCache(srcDir, scheme, ext, limit = 256) {
    const cache = new Map();
    return (z, y, x) => {
        const key = `${z}/${x}/${y}`;
        if (cache.has(key)) return cache.get(key);
        const file = resolveTilePath({ rootDir: srcDir, scheme, ext }, z, y, x);
        let bmp = null;
        if (fs.existsSync(file)) {
            const img = nativeImage.createFromPath(file);
            const size = img.getSize();
            if (size.width === 256 && size.height === 256) bmp = img.toBitmap(); // BGRA
        }
        if (cache.size >= limit) cache.delete(cache.keys().next().value);
        cache.set(key, bmp);
        return bmp;
    };
}

// JPEG 소스는 알파가 없어 nodata가 검정으로 들어온다. 밝기합(r+g+b)이 이 값 이하면 nodata로 본다.
// cesium_png의 알파를 정답지로 실측: nodata 최대 45, 실제 영상 최소 68(하위 0.01%).
// 24로 두면 nodata 99.996% 제거, 실데이터 손실 230만 픽셀 중 1개.
const JPEG_NODATA_MAX_SUM = 24;

/**
 * 하나의 XDWorld 타일(256x256 RGBA)을 소스 피라미드에서 재샘플링.
 * 소스에 데이터가 없는 픽셀은 alpha=0(투명)으로 둔다. 전부 투명이면 null.
 * blackIsNodata: JPEG처럼 알파가 없는 소스일 때 검정을 투명으로 처리
 */
function renderXdTile(getSrc, L, idx, idy, srcZ, blackIsNodata) {
    const span = 36 / Math.pow(2, L);       // 타일 한 변(도)
    const west = -180 + idx * span;
    const north = -90 + (idy + 1) * span;   // 이미지 0행 = 북쪽
    const srcTiles = 256 * Math.pow(2, srcZ);

    const out = Buffer.alloc(256 * 256 * 4); // 기본값 0 = 완전 투명
    let any = false;

    // 열별 소스 좌표는 행마다 동일하므로 미리 계산
    const colTx = new Int32Array(256);
    const colIx = new Int32Array(256);
    for (let px = 0; px < 256; px++) {
        const lon = west + (px + 0.5) * span / 256;
        const mx = EARTH_R * (lon * Math.PI / 180);
        const gx = (mx + MERC_MAX) / (2 * MERC_MAX) * srcTiles;
        colTx[px] = Math.floor(gx / 256);
        colIx[px] = Math.min(255, Math.max(0, Math.floor(gx) % 256));
    }

    for (let py = 0; py < 256; py++) {
        const lat = north - (py + 0.5) * span / 256;
        if (lat <= -85.05113 || lat >= 85.05113) continue;
        const latRad = lat * Math.PI / 180;
        const my = EARTH_R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
        const gy = (MERC_MAX - my) / (2 * MERC_MAX) * srcTiles; // XYZ(상단 원점) 전역 픽셀
        const ty = Math.floor(gy / 256);
        const iy = Math.min(255, Math.max(0, Math.floor(gy) % 256));

        let lastTx = -1, bmp = null;
        for (let px = 0; px < 256; px++) {
            const tx = colTx[px];
            if (tx !== lastTx) { bmp = getSrc(srcZ, ty, tx); lastTx = tx; }
            if (!bmp) continue;

            const s = (iy * 256 + colIx[px]) * 4; // BGRA
            if (bmp[s + 3] === 0) continue;       // 소스가 투명(nodata)이면 건너뜀

            const b = bmp[s], g = bmp[s + 1], r = bmp[s + 2];
            if (blackIsNodata && r + g + b <= JPEG_NODATA_MAX_SUM) continue;

            const d = (py * 256 + px) * 4;        // RGBA
            out[d] = r;
            out[d + 1] = g;
            out[d + 2] = b;
            out[d + 3] = 255;
            any = true;
        }
    }
    return any ? out : null;
}

// ============ 요청 단위(on-demand) 영상 타일 생성 ============
//
// 엔진은 layerPath 뒤에 "/{L}/{IDY}/{IDY}_{IDX}.png" 를 붙여 HTTP로 요청한다(실측).
// layerPath를 로컬 서버 URL로 주면, 요청이 오는 타일만 그때그때 만들면 된다.

const imageSources = new Map(); // id -> { kind, srcDir, scheme, ext, srcMaxLv, cache, getSrc }
let imageSourceSeq = 0;

/** 소스 z에서 XDWorld 레벨 범위 (z = L + log2(10) ≈ L + 3.322) */
function xdLevelsForSource(srcMaxLv) {
    const maxL = Math.max(0, Math.round(srcMaxLv - Math.log2(10)));
    return { minL: Math.max(0, maxL - 4), maxL };
}

/** XDWorld 배치의 jpg 타일 한 장을 png 버퍼로 변환 (검정 = nodata) */
function transcodeJpgTile(file) {
    if (!fs.existsSync(file)) return null;
    return transcodeJpgBuffer(fs.readFileSync(file));
}

/** jpg 바이트 -> png 버퍼 (검정 = nodata). 256x256이 아니면 null */
function transcodeJpgBuffer(buf) {
    const img = nativeImage.createFromBuffer(buf);
    const size = img.getSize();
    if (size.width !== 256 || size.height !== 256) return null;

    const bmp = img.toBitmap(); // BGRA
    const rgba = Buffer.alloc(256 * 256 * 4);
    let any = false;
    for (let i = 0; i < 256 * 256; i++) {
        const b = bmp[i * 4], g = bmp[i * 4 + 1], r = bmp[i * 4 + 2];
        if (r + g + b <= JPEG_NODATA_MAX_SUM) continue;
        rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
        any = true;
    }
    return any ? encodePng(256, 256, 6, rgba) : null;
}

/** 요청된 XDWorld 타일(L, idx, idy) 하나를 png 버퍼로 만든다. 데이터 없으면 null. 커버리지는 Promise 반환 */
function produceXdTile(src, L, idx, idy) {
    if (src.kind === 'demcolor') return renderDemColorTile(src, L, idx, idy);   // DEM → 연속 그라데이션(+힐셰이드) png
    if (src.kind === 'sqlite') {
        if (src.db.info.kind === 'coverage') return renderCoverageTile(src, L, idx, idy);   // Promise<png|null>
        // gpkg/sdb: XDWorld 격자 그대로라 재투영 없음. png는 그대로, jpg는 png로 변환
        const blob = src.db.getTile(L, idx, idy);
        if (!blob) return null;
        return blobFormat(blob) === 'jpg' ? transcodeJpgBuffer(blob) : blob;
    }
    if (src.kind === 'xdjpg') {
        return transcodeJpgTile(path.join(src.srcDir, String(L), pad8(idy), `${pad8(idy)}_${pad8(idx)}.jpg`));
    }
    // cesium: EPSG:3857 피라미드에서 재샘플링
    const srcZ = Math.min(src.srcMaxLv, L + 3);
    const rgba = renderXdTile(src.getSrc, L, idx, idy, srcZ, /^jpe?g$/i.test(src.ext));
    return rgba ? encodePng(256, 256, 6, rgba) : null;
}

// ============ SQLite 타일 패키지 (GeoPackage / XDWorld sdb) ============
//
// terra-gen 등이 폴더 피라미드를 SQLite 하나로 묶은 형태. 두 스키마를 지원한다.
//   GeoPackage : gpkg_contents + tiles(zoom_level, tile_column, tile_row, tile_data)
//                tile_row는 위쪽 원점 -> IDY = 5*2^L - 1 - tile_row
//   sdb        : tiles(level, idx, idy, data)  (XDWorld IDY 그대로, 아래쪽 원점)
// 둘 다 격자가 XDWorld(vworld, EPSG:4326, 레벨0 10x5)일 때만 받는다. 3857 gpkg는 미지원.
// 자체 metadata(name,value) 테이블이 있으면 bounds/minzoom/maxzoom 보조 정보로 쓴다.
// blob 포맷으로 종류를 정한다: png/jpg = 영상(imagery), gzip = XDWorld bil 지형(terrain).
// 지형 blob은 폴더판 {L}/{IDY}/{IDY}_{IDX}.bil 파일과 바이트 단위로 같아(실측) 그대로 응답한다.
// GeoPackage 지형(2d-gridded-coverage, TIFF float blob)은 엔진 지형(bil)으로는 못 넣고,
// QGIS 단일밴드 회색조처럼 표고를 명암으로 그린 영상 레이어(kind 'coverage')로 보여준다.

function blobFormat(buf) {
    if (!buf || buf.length < 12) return 'unknown';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return 'webp';
    if ((buf[0] === 0x49 && buf[1] === 0x49) || (buf[0] === 0x4D && buf[1] === 0x4D)) return 'tiff';
    if (buf[0] === 0x1F && buf[1] === 0x8B) return 'gzip';
    return 'unknown';
}

/** png IHDR에서 폭/높이 */
function pngSize(buf) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * 타일 DB를 열고 스키마를 판정한다. 영상(png/jpg)도 지형(gzip bil)도 아니면 Error를 던진다.
 * 반환: { getTile(L, idx, idy) -> Buffer|null, close(),
 *         info: { kind: 'imagery'|'terrain', schema, format, bounds, minL, maxL, tileSize } }
 */
/**
 * 타일 DB 열기. terra-gen sdb/gpkg는 WAL 모드로 저장되는데, WAL DB는 읽기만 해도 SQLite가 옆에 -shm/-wal
 * 파일을 만들어야 해서 읽기 전용 폴더(네트워크 공유 등)에서는 쿼리 시점에 "unable to open database file"이 난다.
 * 그래서 `file:…?immutable=1` URI로 열어 잠금·shm 없이 읽는다(타일 패키지는 열람 중 바뀌지 않는다고 본다).
 * 단, -wal 사이드카가 실제로 있으면 아직 체크포인트 안 된 내용이 있을 수 있어 일반 모드로 연다.
 */
function openTileDbFile(file) {
    const immutable = () => new DatabaseSync('file:' + file.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/') + '?immutable=1', { readOnly: true });
    // -wal에 내용이 있을 때만 일반 모드를 시도한다(0바이트 -wal은 누가 열어만 둔 흔적). 일반 모드는 읽기 전용 폴더에서
    // 첫 쿼리 때 실패하므로 여기서 한 번 찔러 보고, 안 되면 immutable로 돌아간다.
    let walSize = 0;
    try { walSize = fs.statSync(file + '-wal').size; } catch (_) { /* 없음 */ }
    if (walSize > 0) {
        const db = new DatabaseSync(file, { readOnly: true });
        try {
            db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
            return db;
        } catch (e) {
            try { db.close(); } catch (_) { /* 무시 */ }
            console.warn(`[openTileDb] 일반 모드 실패(${e.message}) -> immutable: ${file}`);
        }
    }
    return immutable();
}

function openTileDb(file) {
    const db = openTileDbFile(file);
    const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
    try {
        const tables = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));

        const meta = {};
        if (tables.has('metadata')) {
            for (const r of db.prepare('SELECT name, value FROM metadata').all()) meta[r.name] = r.value;
        }

        let schema, tileTable = 'tiles', bounds = null, getTile, zoomCol, dataCol, coverageStats = null;

        if (tables.has('gpkg_contents')) {
            schema = 'gpkg';
            const c = db.prepare(`SELECT table_name, data_type, min_x, min_y, max_x, max_y, srs_id
                                  FROM gpkg_contents WHERE data_type IN ('tiles', '2d-gridded-coverage') LIMIT 1`).get();
            if (!c) throw new Error('GeoPackage에 타일 테이블이 없습니다 (gpkg_contents)');
            tileTable = c.table_name;
            if (c.data_type === '2d-gridded-coverage') {
                // 표고 커버리지: 회색조 스트레치용 전역 min/max와 nodata를 확장 테이블에서 읽는다
                const cov = tables.has('gpkg_2d_gridded_coverage_ancillary')
                    ? db.prepare(`SELECT datatype, scale, offset, data_null FROM gpkg_2d_gridded_coverage_ancillary WHERE tile_matrix_set_name = ?`).get(tileTable)
                    : null;
                const st = tables.has('gpkg_2d_gridded_tile_ancillary')
                    ? db.prepare(`SELECT MIN(min) mn, MAX(max) mx FROM gpkg_2d_gridded_tile_ancillary WHERE tpudt_name = ?`).get(tileTable)
                    : null;
                if (!st || st.mn == null) throw new Error('표고 범위(gpkg_2d_gridded_tile_ancillary)가 없어 회색조 스트레치를 정할 수 없습니다');
                coverageStats = {
                    min: num(st.mn), max: num(st.mx),
                    nodata: cov && cov.data_null != null ? num(cov.data_null) : null,
                    scale: cov ? num(cov.scale) : 1, offset: cov ? num(cov.offset) : 0
                };
            }
            bounds = [c.min_x, c.min_y, c.max_x, c.max_y].map(num);

            // XDWorld 격자인지 검증: EPSG:4326, 전구 범위, 레벨 z에서 10*2^z x 5*2^z
            const tms = db.prepare(`SELECT srs_id, min_x, min_y, max_x, max_y FROM gpkg_tile_matrix_set WHERE table_name = ?`).get(tileTable);
            const tm = db.prepare(`SELECT zoom_level, matrix_width, matrix_height FROM gpkg_tile_matrix WHERE table_name = ? ORDER BY zoom_level LIMIT 1`).get(tileTable);
            const isXdGrid = tms && num(tms.srs_id) === 4326
                && num(tms.min_x) === -180 && num(tms.min_y) === -90 && num(tms.max_x) === 180 && num(tms.max_y) === 90
                && tm && num(tm.matrix_width) === 10 * 2 ** num(tm.zoom_level) && num(tm.matrix_height) === 5 * 2 ** num(tm.zoom_level);
            if (!isXdGrid) {
                throw new Error(`XDWorld(vworld) 격자가 아닙니다 (srs ${tms && tms.srs_id}, level ${tm && tm.zoom_level}: ${tm && tm.matrix_width}x${tm && tm.matrix_height}).\n` +
                                'EPSG:4326 전구 범위 / 레벨0 10x5 격자만 지원합니다.');
            }

            zoomCol = 'zoom_level'; dataCol = 'tile_data';
            const stmt = db.prepare(`SELECT tile_data FROM "${tileTable}" WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?`);
            getTile = (L, idx, idy) => {
                const r = stmt.get(L, idx, 5 * 2 ** L - 1 - idy);   // gpkg tile_row는 위쪽 원점
                return r ? Buffer.from(r.tile_data) : null;
            };
        } else if (tables.has('tiles')) {
            const cols = db.prepare('PRAGMA table_info(tiles)').all().map(c => c.name);
            if (!['level', 'idx', 'idy', 'data'].every(c => cols.includes(c))) {
                throw new Error(`알 수 없는 tiles 스키마: (${cols.join(', ')})\n지원: tiles(level, idx, idy, data)`);
            }
            schema = 'sdb';
            if (meta.grid && meta.grid !== 'vworld') throw new Error(`XDWorld(vworld) 격자가 아닙니다 (metadata.grid = ${meta.grid})`);
            if (meta.srs && !/4326$/.test(meta.srs)) throw new Error(`EPSG:4326이 아닙니다 (metadata.srs = ${meta.srs})`);
            if (meta.bounds) {
                const b = meta.bounds.split(',').map(Number);
                if (b.length === 4 && b.every(Number.isFinite)) bounds = b;
            }
            zoomCol = 'level'; dataCol = 'data';
            const stmt = db.prepare('SELECT data FROM tiles WHERE level = ? AND idx = ? AND idy = ?');
            getTile = (L, idx, idy) => {
                const r = stmt.get(L, idx, idy);
                return r && r.data ? Buffer.from(r.data) : null;
            };
        } else {
            throw new Error(`타일 테이블을 찾지 못했습니다. 테이블: ${[...tables].join(', ')}`);
        }

        if (!bounds) throw new Error('타일 범위(bounds)를 알 수 없습니다 (gpkg_contents 또는 metadata.bounds 필요)');

        // 실제 들어있는 레벨 범위 (tile_matrix 선언과 다를 수 있어 데이터 기준).
        // MIN과 MAX를 한 문장에 쓰면 SQLite가 인덱스 전체를 스캔한다(집계가 하나일 때만 끝점 조회로 최적화).
        // 320GB 전구 sdb를 네트워크로 열 때 252초가 걸려 앱이 "응답 없음"이 났으므로 반드시 두 문장으로 나눈다.
        const lvMin = db.prepare(`SELECT MIN(${zoomCol}) v FROM "${tileTable}"`).get();
        const lvMax = db.prepare(`SELECT MAX(${zoomCol}) v FROM "${tileTable}"`).get();
        if (lvMin.v == null) throw new Error('타일이 비어 있습니다');
        const minL = num(lvMin.v), maxL = num(lvMax.v);

        // blob 하나를 떠서 포맷 판정. png/jpg = 영상(엔진은 png만 읽으므로 jpg는 요청 시 변환), gzip = bil 지형
        const sample = db.prepare(`SELECT ${dataCol} d FROM "${tileTable}" WHERE ${zoomCol} = ? LIMIT 1`).get(maxL);
        const sampleBuf = Buffer.from(sample.d);
        const blobFmt = blobFormat(sampleBuf);
        let kind, format = blobFmt, tileSize = null;
        if (blobFmt === 'png' || blobFmt === 'jpg') {
            kind = 'imagery';
            tileSize = blobFmt === 'png' ? pngSize(sampleBuf).width : nativeImage.createFromBuffer(sampleBuf).getSize().width;
        } else if (blobFmt === 'gzip') {
            kind = 'terrain'; format = 'bil';
        } else if (blobFmt === 'tiff' && coverageStats) {
            kind = 'coverage'; tileSize = 256;   // 요청 시 256x256 회색조 png로 렌더
        } else if (blobFmt === 'tiff') {
            throw new Error('TIFF 타일인데 GeoPackage 커버리지 확장 정보가 없습니다 (gpkg_2d_gridded_coverage_ancillary)');
        } else if (coverageStats) {
            throw new Error(`png/jpg 커버리지(정수형 16비트)는 아직 지원하지 않습니다 (blob=${blobFmt})`);
        } else {
            throw new Error(`지원하지 않는 타일 포맷입니다 (blob=${blobFmt}, metadata.format=${meta.format || '?'}).\n영상 png/jpg, 지형 gzip bil만 지원합니다.`);
        }

        return {
            getTile,
            close: () => { try { db.close(); } catch (_) { /* 이미 닫힘 */ } },
            info: { kind, schema, format, bounds, minL, maxL, tileSize, meta, stats: coverageStats }
        };
    } catch (e) {
        try { db.close(); } catch (_) { /* 무시 */ }
        throw e;
    }
}

/** TIFF 커버리지 blob -> { w, h, data } (첫 밴드) */
async function decodeTiffGrid(buf) {
    const tiff = await geotiff.fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const img = await tiff.getImage();
    const rasters = await img.readRasters();
    return { w: img.getWidth(), h: img.getHeight(), data: rasters[0] };
}

/**
 * 표고 격자 타일을 QGIS 단일밴드 회색조처럼 그린 256x256 png (전 타일 공통 min/max 스트레치).
 * nodata(data_null / -32767 / 비유한값)는 투명. 표고는 이중선형 보간, nodata 경계는 최근접 셀로 판정.
 * 전부 nodata면 null.
 */
async function renderCoverageTile(src, L, idx, idy) {
    const blob = src.db.getTile(L, idx, idy);
    if (!blob) return null;
    const { w, h, data } = await decodeTiffGrid(blob);
    const { min, max, nodata, scale, offset } = src.db.info.stats;
    const range = (max - min) || 1;
    const isNodata = (v) => !Number.isFinite(v) || v === nodata || v === -32767;

    const rgba = Buffer.alloc(256 * 256 * 4);
    let any = false;
    for (let py = 0; py < 256; py++) {
        const fy = (py + 0.5) / 256 * h - 0.5;
        const y0 = Math.max(0, Math.min(h - 1, Math.floor(fy))), y1 = Math.min(h - 1, y0 + 1), ty = Math.max(0, fy - y0);
        for (let px = 0; px < 256; px++) {
            const fx = (px + 0.5) / 256 * w - 0.5;
            const x0 = Math.max(0, Math.min(w - 1, Math.floor(fx))), x1 = Math.min(w - 1, x0 + 1), tx = Math.max(0, fx - x0);

            const near = data[(ty < 0.5 ? y0 : y1) * w + (tx < 0.5 ? x0 : x1)];
            if (isNodata(near)) continue;

            let sum = 0, wsum = 0;
            const acc = (v, wgt) => { if (wgt > 0 && !isNodata(v)) { sum += v * wgt; wsum += wgt; } };
            acc(data[y0 * w + x0], (1 - tx) * (1 - ty)); acc(data[y0 * w + x1], tx * (1 - ty));
            acc(data[y1 * w + x0], (1 - tx) * ty);       acc(data[y1 * w + x1], tx * ty);
            const v = (wsum > 0 ? sum / wsum : near) * scale + offset;

            const g = Math.max(0, Math.min(255, Math.round((v - min) / range * 255)));
            const o = (py * 256 + px) * 4;
            rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
            any = true;
        }
    }
    return any ? encodePng(256, 256, 6, rgba) : null;
}

// ============ 지형 타일 폴백 (상위 레벨에서 잘라 만들기) ============
//
// terra-gen 전구 DEM은 바다처럼 평탄한 곳의 상세 레벨(8+) 타일을 생략한다. 엔진은 옆 타일(육지)은 받고
// 자기 타일은 404를 받으면 메시를 이어붙이지 못해 검은 쐐기 모양 이격이 생긴다(하와이 실측).
// 그래서 없는 타일은 가장 가까운 상위 타일의 해당 구간을 이중선형 보간해 응답한다.
// bil 타일 실측: gzip(65x65 float32 LE), 행 0 = 북쪽, 모서리 공유(64 간격). idy는 남쪽 원점.
// cop30 실측: 상위 레벨(≤7) 바다는 수심(-4,700m 안팎)이고 상세 레벨(≥8) 해안 타일의 바다는 0m라,
// 합성 타일을 그대로 붙이면 타일 경계에 수 km 절벽(검은 쐐기)이 선다. 합성 타일은 음수를 0(해면)으로 누른다.
// (상세 타일이 생략된 곳은 바다이므로 해면 아래 육지(사해 등)가 잘릴 일은 없다)
const DEM_N = 65;

/**
 * 폴더(XDWorld 배치) DEM을 sdb와 같은 인터페이스로: {L}/{IDY}/{IDY}_{IDX}.bil 파일을 읽어 준다.
 * terra-gen 폴더는 번호 패딩이 일정하지 않다(실측: 1만 미만은 4자리 `0007_0017.bil`, 이상은 8자리, 한 파일 안에서도
 * `7192_00017487.bil`처럼 섞임) → idy/idx 각각 8자리·4자리·무패딩 후보를 조합해 있는 파일을 찾는다. 맞은 조합을 기억해 다음엔 먼저 시도.
 */
function openDemDir(dir) {
    const pads = [(n) => String(n).padStart(8, '0'), (n) => String(n).padStart(4, '0'), (n) => String(n)];
    let lastHit = null; // [yi, xi]
    const candidates = () => {
        const list = [];
        if (lastHit) list.push(lastHit);
        for (let yi = 0; yi < pads.length; yi++) for (let xi = 0; xi < pads.length; xi++) if (!lastHit || lastHit[0] !== yi || lastHit[1] !== xi) list.push([yi, xi]);
        return list;
    };
    return {
        getTile: (L, idx, idy) => {
            for (const [yi, xi] of candidates()) {
                const y = pads[yi](idy), x = pads[xi](idx);
                const f = path.join(dir, String(L), y, `${y}_${x}.bil`);
                if (fs.existsSync(f)) {
                    lastHit = [yi, xi];
                    try { return fs.readFileSync(f); } catch (_) { return null; }
                }
            }
            return null;
        },
        close: () => {},
        info: { kind: 'terrain', schema: 'dir', format: 'bil' }
    };
}

/**
 * 지형 타일 높이에 배율을 곱한다(수직 과장). 엔진의 demRate는 |r|<1(평탄화)에서만 셰이더가 반응하고
 * 1보다 크면 CPU 높이만 커져 구멍이 생기므로(실측), 과장은 데이터 자체를 바꿔 CPU/GPU를 일치시킨다.
 * gzip(65x65 float32) → 배율 → gzip. nodata(≤ -30000)는 그대로.
 */
function scaleDemTile(blob, scale) {
    let u;
    try { u = zlib.gunzipSync(blob); } catch (_) { return blob; }
    if (u.length % 4 !== 0) return blob;
    const f = new Float32Array(u.buffer, u.byteOffset, u.length / 4);
    for (let i = 0; i < f.length; i++) if (f[i] > -30000) f[i] *= scale;
    return zlib.gzipSync(Buffer.from(f.buffer, f.byteOffset, f.byteLength));
}

// 데이터 최대 레벨 위로 몇 레벨까지 부드럽게 만들어 줄지. 3 = 정점 간격 1/8 (레벨 7 약 500m → 약 60m).
// 엔진은 면 단위로 음영을 넣어 메시가 성기면 삼각형이 그대로 보이므로, ArcGIS처럼 원 해상도 위에서는 3차 보간으로 메시를 촘촘히 한다.
// 그 위는 404 → 엔진이 마지막 레벨을 유지. 개발용 env XDV_DEM_UPSAMPLE로 바꿀 수 있다(0이면 끔).
const DEM_UPSAMPLE_LEVELS = process.env.XDV_DEM_UPSAMPLE !== undefined ? Math.max(0, parseInt(process.env.XDV_DEM_UPSAMPLE, 10) || 0) : 3;
let demUpsampleLevels = DEM_UPSAMPLE_LEVELS;   // 분석 패널 체크박스(set-dem-upsample)로 런타임 변경

function decodeDemGrid(blob) {
    try {
        const u = zlib.gunzipSync(blob);
        if (u.length !== DEM_N * DEM_N * 4) return null;
        return new Float32Array(u.buffer, u.byteOffset, DEM_N * DEM_N);
    } catch (_) {
        return null;
    }
}

/**
 * 부모 레벨 격자에서 3차(Catmull-Rom) 보간으로 자식 타일을 만든다. 타일 가장자리에서는 이웃 부모 타일의 샘플을
 * 끌어와 경계에서도 기울기가 이어지게 한다(없으면 가장자리 값으로 고정). nodata(≤ -30000)가 섞인 곳은 최근접 값.
 * clampNegative: 피라미드 안의 빠진 타일을 메울 때(cop30처럼 바다 상세 타일이 생략된 경우) 해안 타일(0m)과 절벽이
 *   안 생기게 음수를 0으로. 최대 레벨 위 업샘플링에서는 수심을 살려야 하니 false.
 */
function synthesizeDemTile(src, L, idx, idy, maxUp = 6, clampNegative = true) {
    for (let k = 1; k <= maxUp && L - k >= 0; k++) {
        const f = 2 ** k;
        const pL = L - k, pIdx = Math.floor(idx / f), pIdy = Math.floor(idy / f);
        const center = src.db.getTile(pL, pIdx, pIdy);
        if (!center) continue;
        const centerGrid = decodeDemGrid(center);
        if (!centerGrid) return null;

        // 이웃 부모 타일 격자 (dx: 동+, dy: 북+). 필요할 때만 읽고 캐시. 모서리 공유라 이웃의 0열 == 내 64열.
        const grids = new Map([['0,0', centerGrid]]);
        const grid = (dx, dy) => {
            const key = `${dx},${dy}`;
            if (!grids.has(key)) {
                const b = src.db.getTile(pL, pIdx + dx, pIdy + dy);
                grids.set(key, b ? decodeDemGrid(b) : null);
            }
            return grids.get(key);
        };
        const M = DEM_N - 1; // 64
        // 부모 격자 좌표 (col, rowFromNorth) — 범위 밖이면 이웃 타일에서
        const sample = (col, row) => {
            let dx = 0, dy = 0, c = col, r = row;
            if (c < 0) { dx = -1; c += M; } else if (c > M) { dx = 1; c -= M; }
            if (r < 0) { dy = 1; r += M; } else if (r > M) { dy = -1; r -= M; }   // 행 0이 북쪽: 위로 벗어나면 북쪽 이웃(idy+1)
            const g = (dx === 0 && dy === 0) ? centerGrid : grid(dx, dy);
            if (!g) return centerGrid[Math.min(M, Math.max(0, row)) * DEM_N + Math.min(M, Math.max(0, col))];
            return g[r * DEM_N + c];
        };
        const cubic = (p0, p1, p2, p3, t) => 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);

        const span = M / f;
        const ox = (idx - pIdx * f) * span;
        const oyTop = M - (idy - pIdy * f) * span - span;
        const out = new Float32Array(DEM_N * DEM_N);
        const col = new Float64Array(4);
        for (let r = 0; r < DEM_N; r++) {
            const fy = oyTop + r * span / M;
            const y0 = Math.floor(fy), ty = fy - y0;
            for (let c = 0; c < DEM_N; c++) {
                const fx = ox + c * span / M;
                const x0 = Math.floor(fx), tx = fx - x0;
                let bad = false;
                for (let j = -1; j <= 2; j++) {
                    const a = sample(x0 - 1, y0 + j), b = sample(x0, y0 + j), cc = sample(x0 + 1, y0 + j), d = sample(x0 + 2, y0 + j);
                    if (a <= -30000 || b <= -30000 || cc <= -30000 || d <= -30000) { bad = true; break; }
                    col[j + 1] = cubic(a, b, cc, d, tx);
                }
                let v = bad ? sample(Math.round(fx), Math.round(fy)) : cubic(col[0], col[1], col[2], col[3], ty);
                if (clampNegative && v < 0) v = 0;
                out[r * DEM_N + c] = v;
            }
        }
        return zlib.gzipSync(Buffer.from(out.buffer, out.byteOffset, out.byteLength));
    }
    return null;
}

// ============ DEM 고도 색상 영상 (연속 그라데이션 + 힐셰이드) ============
//
// 엔진의 지형 색상은 셰이더가 u_demColorList[32]에서 구간 색 하나를 고르는 구조라(보간 없음, 32색 상한) 부드럽게 못 만든다.
// 대신 DEM 타일에서 256px 컬러 PNG를 만들어 영상 레이어로 덮는다. 램프는 렌더러가 256색으로 샘플해 넘기고 여기서 선형 보간.
// 힐셰이드는 격자 기울기로 계산(북서광 315°/고도각 45°), 배율(hillshade)로 강도 조절. 0이면 끔.

/** 색상 영상용 높이 격자: 실제 타일 → 없으면 상위에서 3차 보간(수심 유지). 영상은 어떤 레벨이든 만들어 준다(최대 8레벨 위까지). */
function demGridForColor(dem, L, idx, idy) {
    let blob = dem.db.getTile(L, idx, idy);
    if (!blob) blob = synthesizeDemTile(dem, L, idx, idy, 8, false);
    return blob ? decodeDemGrid(blob) : null;
}

function renderDemColorTile(src, L, idx, idy) {
    const dem = imageSources.get(src.demSourceId);
    if (!dem || !dem.db) return null;
    const g = demGridForColor(dem, L, idx, idy);
    if (!g) return null;

    const { min, max, colors, alpha } = src.ramp;
    const range = (max - min) || 1;
    const nC = colors.length;
    const M = DEM_N - 1;
    // 격자 셀 크기(m): 타일 폭 36°/2^L, 65샘플. 위도 보정
    const tileDeg = 36 / 2 ** L;
    const latC = ((idy + 0.5) / (5 * 2 ** L)) * 180 - 90;
    const cellY = tileDeg / M * 111320;
    const cellX = cellY * Math.max(0.05, Math.cos(latC * Math.PI / 180));
    const shade = src.hillshade > 0;
    const zf = src.hillshade || 0;
    // 광원: 방위 315°(북서), 고도 45°
    const az = 315 * Math.PI / 180, el = 45 * Math.PI / 180;
    const lx = Math.sin(az) * Math.cos(el), ly = Math.cos(az) * Math.cos(el), lz = Math.sin(el);

    const at = (c, r) => g[Math.min(M, Math.max(0, r)) * DEM_N + Math.min(M, Math.max(0, c))];
    const rgba = Buffer.alloc(256 * 256 * 4);
    let any = false;
    for (let py = 0; py < 256; py++) {
        const fy = (py + 0.5) / 256 * M - 0.5;
        const y0 = Math.max(0, Math.min(M - 1, Math.floor(fy))), ty = Math.min(1, Math.max(0, fy - y0));
        for (let px = 0; px < 256; px++) {
            const fx = (px + 0.5) / 256 * M - 0.5;
            const x0 = Math.max(0, Math.min(M - 1, Math.floor(fx))), tx = Math.min(1, Math.max(0, fx - x0));
            const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
            if (a <= -30000 || b <= -30000 || c <= -30000 || d <= -30000) continue; // nodata → 투명
            const h = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;

            // 램프 선형 보간
            const t = Math.min(1, Math.max(0, (h - min) / range)) * (nC - 1);
            const i0 = Math.floor(t), i1 = Math.min(nC - 1, i0 + 1), u = t - i0;
            let r = colors[i0][0] + (colors[i1][0] - colors[i0][0]) * u;
            let gg = colors[i0][1] + (colors[i1][1] - colors[i0][1]) * u;
            let bb = colors[i0][2] + (colors[i1][2] - colors[i0][2]) * u;

            if (shade) {
                // 중앙차분 기울기 (격자 단위 → m)
                const xi = Math.round(fx), yi = Math.round(fy);
                const dzdx = (at(xi + 1, yi) - at(xi - 1, yi)) * zf / (2 * cellX);
                const dzdy = (at(xi, yi - 1) - at(xi, yi + 1)) * zf / (2 * cellY);   // 행 0이 북쪽 → 북쪽이 +y
                const nl = Math.hypot(dzdx, dzdy, 1);
                const nx = -dzdx / nl, ny = -dzdy / nl, nz = 1 / nl;
                const s = Math.max(0, nx * lx + ny * ly + nz * lz);
                const k = 0.45 + 0.75 * s;   // 0.45(그늘) ~ 1.2(밝은 면)
                r *= k; gg *= k; bb *= k;
            }
            const o = (py * 256 + px) * 4;
            rgba[o] = Math.max(0, Math.min(255, Math.round(r)));
            rgba[o + 1] = Math.max(0, Math.min(255, Math.round(gg)));
            rgba[o + 2] = Math.max(0, Math.min(255, Math.round(bb)));
            rgba[o + 3] = alpha;
            any = true;
        }
    }
    return any ? encodePng(256, 256, 6, rgba) : null;
}

function ensureLocalFileServer() {
    if (localFileServer) return Promise.resolve(localFileServerPort);

    return new Promise((resolve) => {
        localFileServer = http.createServer((req, res) => {
            const urlPath = decodeURIComponent(req.url.split('?')[0]);

            // 요청 단위 영상 타일: /__xdimg__/<id>/<L>/<IDY>/<IDY>_<IDX>.png
            if (urlPath.startsWith('/__xdimg__/')) {
                const m = urlPath.match(/^\/__xdimg__\/(\d+)\/(\d+)\/(\d+)\/\d+_(\d+)\.png$/);
                const src = m && imageSources.get(Number(m[1]));
                if (!src) {
                    res.writeHead(404);
                    return res.end('Unknown image source');
                }
                const L = Number(m[2]), idy = Number(m[3]), idx = Number(m[4]);

                const key = `${m[1]}/${L}/${idy}/${idx}`;
                const finish = (png) => {
                    if (process.env.XDREQ_DEBUG) console.log(`[srv] ${png ? '200' : '404'} xdimg ${key}`);
                    if (!png) {
                        res.writeHead(404);
                        return res.end('No data');
                    }
                    res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' });
                    res.end(png);
                };
                const remember = (png) => {
                    if (src.cache.size >= 512) src.cache.delete(src.cache.keys().next().value);
                    src.cache.set(key, png);
                    return png;
                };
                const cached = src.cache.get(key);
                if (cached !== undefined) return finish(cached);

                const out = produceXdTile(src, L, idx, idy);   // Buffer|null, 커버리지 렌더는 Promise
                if (out && typeof out.then === 'function') {
                    out.then(remember).then(finish).catch((e) => {
                        console.warn(`[srv] xdimg ${key}: ${e.message}`);
                        res.writeHead(500);
                        res.end(e.message);
                    });
                    return;
                }
                return finish(remember(out));
            }

            // 요청 단위 지형 타일: /__xddem__/<id>/<L>/<IDY>/<IDY>_<IDX>.bil  (gzip bil blob 그대로)
            if (urlPath.startsWith('/__xddem__/')) {
                const m = urlPath.match(/^\/__xddem__\/(\d+)\/(\d+)\/(\d+)\/\d+_(\d+)\.bil$/);
                const src = m && imageSources.get(Number(m[1]));
                if (!src || !src.db) {
                    if (process.env.XDREQ_DEBUG) console.log(`[srv] 404 xddem (unmatched) ${urlPath}`);
                    res.writeHead(404);
                    return res.end(m ? 'Unknown terrain source' : 'Bad terrain tile path');
                }
                const L = Number(m[2]), idy = Number(m[3]), idx = Number(m[4]);
                // 데이터 최대 레벨 위 DEM_UPSAMPLE_LEVELS 레벨까지는 3차 보간으로 촘촘한 메시를 만들어 주고(부드러운 음영),
                // 그 위는 404 → 엔진이 마지막 레벨을 유지. 최대 레벨 안의 빠진 타일은 음수를 0으로 눌러 메운다(cop30 바다).
                const maxL = src.db.info.maxL;
                const beyond = Number.isFinite(maxL) && L > maxL;
                if (beyond && L > maxL + demUpsampleLevels) {
                    if (process.env.XDREQ_DEBUG) console.log(`[srv] 404 xddem ${m[1]}/${L}/${idy}/${idx} (> maxL ${maxL}+${demUpsampleLevels})`);
                    res.writeHead(404);
                    return res.end('Beyond max level');
                }
                let blob = beyond ? null : src.db.getTile(L, idx, idy);
                let synthesized = false;
                if (!blob) {
                    // 없는 타일은 상위 레벨에서 만들어 준다 (결과는 null 포함 캐시)
                    const key = `dem/${L}/${idy}/${idx}`;
                    if (src.cache.has(key)) {
                        blob = src.cache.get(key);
                    } else {
                        blob = synthesizeDemTile(src, L, idx, idy, 6, !beyond);
                        if (src.cache.size >= 512) src.cache.delete(src.cache.keys().next().value);
                        src.cache.set(key, blob);
                    }
                    synthesized = !!blob;
                }
                if (blob && src.demScale && src.demScale !== 1) blob = scaleDemTile(blob, src.demScale);
                if (process.env.XDREQ_DEBUG) console.log(`[srv] ${blob ? (synthesized ? '200*' : '200') : '404'} xddem ${m[1]}/${L}/${idy}/${idx}${src.demScale && src.demScale !== 1 ? ` x${src.demScale}` : ''}`);
                if (!blob) {
                    res.writeHead(404);
                    return res.end('No data');
                }
                res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' });
                return res.end(blob);
            }

            const filePath = urlPath.substring(1); // 선행 / 제거
            if (process.env.XDREQ_DEBUG && urlPath.startsWith('/__xd')) console.log(`[srv] ??? unrouted ${urlPath}`);
            if (process.env.XDREQ_DEBUG && /\.(png|jpe?g|bil)$/i.test(filePath)) {
                console.log(`[srv] ${fs.existsSync(filePath) ? '200' : '404'} ${filePath}`);
            }
            if (fs.existsSync(filePath)) {
                const m = filePath.match(/\.(png|jpe?g)$/i);
                res.writeHead(200, {
                    'Access-Control-Allow-Origin': '*',
                    'Content-Type': m ? (/png/i.test(m[1]) ? 'image/png' : 'image/jpeg') : 'application/octet-stream'
                });
                fs.createReadStream(filePath).pipe(res);
            } else {
                res.writeHead(404);
                res.end('Not found');
            }
        });
        localFileServer.listen(0, '127.0.0.1', () => {
            localFileServerPort = localFileServer.address().port;
            console.log('Local file server on port', localFileServerPort);
            resolve(localFileServerPort);
        });
    });
}

// 자동 업데이트 설정
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

/** 메인 창 생성 */
function createWindow() {

    // 1. GPU 강제 활성화
    app.commandLine.appendSwitch('ignore-gpu-blacklist');
    app.commandLine.appendSwitch('enable-gpu-rasterization');
    app.commandLine.appendSwitch('enable-zero-copy');
    app.commandLine.appendSwitch('enable-native-gpu-memory-buffers');

    // 2. 메모리 확장
    app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

    // 브라우저 창 생성
    mainWindow = new BrowserWindow({
        width:  1024, // 창 너비
        height: 768, // 창 높이
        title: `XDViewer v${app.getVersion()}`, // 타이틀바에 버전 표시
        icon: path.join(__dirname, 'build', 'icon.ico'), // 창·작업표시줄 아이콘 (설치본 exe 아이콘은 electron-builder win.icon)
        // 개발용: XDV_HIDDEN=1이면 화면 밖(-32000,-32000)에 두고 작업표시줄에서도 숨겨 사용자 눈에 안 띄게 한다(CDP 검증용).
        // show:false로 숨기면 Chromium이 그리기를 멈춰 카메라 이동·렌더 검증이 안 된다(실측) → 화면 밖 배치.
        ...(process.env.XDV_HIDDEN ? { x: -32000, y: -32000, skipTaskbar: true, focusable: false } : {}),
        autoHideMenuBar: true, // 메뉴바 자동 숨김
        webPreferences: {
            webgl: true,
            backgroundThrottling: false,
            nodeIntegration: false, // Node.js 통합 비활성화
            contextIsolation: true, // 컨텍스트 격리 활성화
            preload: path.join(__dirname, 'preload.js'), // 프리로드 스크립트 경로
            sandbox: false
        }
    });
    

    // 브라우저 창에 HTML 파일 로드
    mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // 앱이 꺼진 상태에서 layer.meta 더블클릭으로 실행된 경우, 경로를 렌더러에 전달
    // (렌더러는 엔진 준비 전까지 큐에 보관 후 처리)
    const initialFile = getMetaPathFromArgv(process.argv);
    if (initialFile) {
        mainWindow.webContents.once('did-finish-load', () => {
            sendFileToRenderer(initialFile);
        });
    }

    // XDTILE_DEBUG=1 실행 시 렌더러 콘솔을 메인 stdout으로 전달
    if (process.env.XDTILE_DEBUG) {
        mainWindow.webContents.on('console-message', (...args) => {
            const ev = args[0];
            const msg = (ev && typeof ev === 'object' && 'message' in ev) ? ev.message : args[2];
            console.log('[renderer]', msg);
        });
    }

    // 기본 F12 키 동작 비활성화 (DevTools 토글 방지)
    mainWindow.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'F12') {
            event.preventDefault(); // 기본 동작 방지
            if (mainWindow.webContents.isDevToolsOpened()) {
                mainWindow.webContents.closeDevTools(); // DevTools 닫기
            } else {
                mainWindow.webContents.openDevTools({}); // DevTools 열기
            }
        }
    });



// 창 닫힘 처리
    mainWindow.on('closed', () => {
        mainWindow = null; // 창 참조 제거
    });

    // 파일 경로 선택 처리
    ipcMain.on('open-file-dialog', async (event) => {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'JSON/GeoJSON Files', extensions: ['json', 'geojson', 'meta'] }
            ]
        });

        if (!result.canceled && result.filePaths.length > 0) {
            const filePath = result.filePaths[0]; // 선택한 파일 경로
            event.sender.send('file-path', filePath); // 렌더러 프로세스로 파일 경로 전달
        }
    });
}

// 단일 인스턴스 보장: 이미 실행 중이면 새 창 대신 기존 창에 파일 전달
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (event, argv) => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
        const filePath = getMetaPathFromArgv(argv);
        if (filePath) sendFileToRenderer(filePath);
    });
}

/** Application이 준비된 후 실행할 스크립트를 지정 */
app.whenReady().then(() => {
    // 스플래시 창 생성


    createWindow(); // 메인 창 생성

    // XDWorld 엔진이 타일 URL을 file:// 프로토콜로 요청하는 문제 수정
    // file://mt1.google.com/... → https://mt1.google.com/... 로 리다이렉트
    const tileHosts = ['google.com', 'openstreetmap.org', 'arcgisonline.com', 'arcgis.com'];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        if (details.url.startsWith('file://') && tileHosts.some(host => details.url.includes(host))) {
            callback({ redirectURL: details.url.replace('file://', 'https://') });
        } else {
            callback({});
        }
    });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
            responseHeaders: {
            ...details.responseHeaders,
            'Access-Control-Allow-Origin': ['*']
            }
        });
    });
    // 자동 업데이트 체크 (프로덕션 환경에서만)
    if (app.isPackaged) {
        autoUpdater.checkForUpdatesAndNotify();
    }

// 앱 활성화 시 처리 (macOS)
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0)
            createWindow(); // 창이 없을 경우 새 창 생성
    });
});

// 자동 업데이트 이벤트 처리
autoUpdater.on('checking-for-update', () => {
    console.log('업데이트 확인 중...');
});

autoUpdater.on('update-available', (info) => {
    console.log('업데이트가 있습니다:', info.version);
});

autoUpdater.on('update-not-available', () => {
    console.log('최신 버전입니다.');
});

autoUpdater.on('download-progress', (progressObj) => {
    console.log(`다운로드 중: ${Math.round(progressObj.percent)}%`);
});

autoUpdater.on('update-downloaded', (info) => {
    dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '업데이트 완료',
        message: `새 버전(${info.version})이 다운로드되었습니다. 앱을 재시작하면 업데이트가 적용됩니다.`,
        buttons: ['지금 재시작', '나중에']
    }).then((result) => {
        if (result.response === 0) {
            autoUpdater.quitAndInstall();
        }
    });
});

autoUpdater.on('error', (err) => {
    console.error('업데이트 오류:', err);
});

// 모든 창이 닫혔을 때의 처리
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit(); // macOS가 아닌 경우 앱 종료
});


// 창 포커스 요청 처리 (동기 방식)
ipcMain.handle('focus-window', async () => {
    if (!mainWindow) return false;

    if (mainWindow.isMinimized()) mainWindow.restore();

    mainWindow.setAlwaysOnTop(true);
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.blur();
    mainWindow.focus();
    mainWindow.webContents.focus();
    mainWindow.setAlwaysOnTop(false);

    return true;
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

// 로컬 파일을 HTTP URL로 변환 (디렉토리 구조 유지하여 텍스처 상대경로 해결)
ipcMain.handle('get-local-file-url', async (event, filePath) => {
    await ensureLocalFileServer();
    // 경로의 각 세그먼트를 개별 인코딩하여 디렉토리 구조 유지
    const segments = filePath.replace(/\\/g, '/').split('/');
    const encodedPath = segments.map(s => encodeURIComponent(s)).join('/');
    return `http://127.0.0.1:${localFileServerPort}/${encodedPath}`;
});

/**
 * 영상 소스를 등록하고, 엔진에 넘길 layerPath(로컬 HTTP URL)를 돌려준다.
 * 타일은 요청이 올 때마다 생성되므로 사전 변환이 없다.
 *   kind 'xdjpg'  : XDWorld 배치의 jpg 타일 -> png 변환
 *   kind 'cesium' : EPSG:3857 피라미드 -> EPSG:4326 재투영
 */
ipcMain.handle('register-image-source', async (event, opts) => {
    await ensureLocalFileServer();
    const id = ++imageSourceSeq;

    const src = {
        kind: opts.kind,
        srcDir: opts.srcDir ? path.normalize(opts.srcDir) : null,
        scheme: opts.scheme,
        ext: opts.ext,
        srcMaxLv: opts.srcMaxLv,
        cache: new Map()      // 출력 png 캐시
    };
    let info = null;
    if (opts.kind === 'cesium') {
        src.getSrc = makeTileCache(src.srcDir, src.scheme, src.ext);
    } else if (opts.kind === 'demdir') {
        // 폴더 DEM도 서버를 거치게 해 배율(수직 과장)·합성이 되도록
        if (!opts.srcDir || !fs.existsSync(opts.srcDir)) return { error: '폴더를 찾을 수 없습니다: ' + opts.srcDir };
        src.db = openDemDir(src.srcDir);
        if (Number.isFinite(Number(opts.maxLevel))) src.db.info.maxL = Number(opts.maxLevel); // layer.meta level.max
        if (Array.isArray(opts.bounds) && opts.bounds.length === 4) src.db.info.bounds = opts.bounds.map(Number);
        info = src.db.info;
    } else if (opts.kind === 'demcolor') {
        // DEM 소스에서 색상 영상 타일을 만드는 영상 소스
        const dem = imageSources.get(Number(opts.demSourceId));
        if (!dem || !dem.db || dem.db.info.kind !== 'terrain') return { error: 'DEM 소스를 찾을 수 없습니다: ' + opts.demSourceId };
        src.demSourceId = Number(opts.demSourceId);
        src.ramp = opts.ramp;                 // { min, max, colors: [[r,g,b]…], alpha }
        src.hillshade = Number(opts.hillshade) || 0;
        info = { kind: 'imagery', bounds: opts.bounds || dem.db.info.bounds, minL: opts.minL, maxL: opts.maxL };
    } else if (opts.kind === 'sqlite') {
        // 열기 실패(지형/미지원 격자/스키마)는 예외 대신 error 문자열로 돌려 렌더러가 안내한다
        try {
            src.db = openTileDb(path.normalize(opts.file));
        } catch (e) {
            console.warn(`[register-image-source] ${opts.file}: ${e.message}`);
            return { error: e.message };
        }
        info = src.db.info;
    }
    imageSources.set(id, src);

    const route = info && info.kind === 'terrain' ? '__xddem__' : '__xdimg__';
    const url = `http://127.0.0.1:${localFileServerPort}/${route}/${id}`;
    if (process.env.XDREQ_DEBUG) console.log(`[register-image-source] id=${id} kind=${opts.kind} -> ${url}`);
    return { id, url, levels: opts.kind === 'cesium' ? xdLevelsForSource(opts.srcMaxLv) : null, info };
});

// 지형 메시 업샘플 레벨 수 (0 = 끔). 지형 소스 캐시를 비우고, 렌더러가 XDEPlanetRefresh로 다시 받는다
ipcMain.handle('set-dem-upsample', (event, levels) => {
    demUpsampleLevels = Math.max(0, Math.min(6, parseInt(levels, 10) || 0));
    for (const src of imageSources.values()) if (src.db && src.db.info.kind === 'terrain') src.cache.clear();
    return demUpsampleLevels;
});

// 색상 영상 소스의 램프/힐셰이드 갱신 (타일은 렌더러가 레이어를 다시 만들어 다시 받는다)
ipcMain.handle('update-dem-color', (event, id, opts) => {
    const src = imageSources.get(id);
    if (!src || src.kind !== 'demcolor') return false;
    if (opts.ramp) src.ramp = opts.ramp;
    if (opts.hillshade !== undefined) src.hillshade = Number(opts.hillshade) || 0;
    src.cache.clear();
    return true;
});

// 지형 소스의 높이 배율. 캐시(합성 타일 포함)는 원본 기준이라 응답 시점에 곱하므로 비우기만 한다
ipcMain.handle('set-dem-scale', (event, id, scale) => {
    const src = imageSources.get(id);
    if (!src || !src.db || src.db.info.kind !== 'terrain') return false;
    src.demScale = Number(scale) || 1;
    return true;
});

ipcMain.handle('unregister-image-source', (event, id) => {
    const src = imageSources.get(id);
    if (src && src.db) src.db.close();
    return imageSources.delete(id);
});

// URL 텍스트 받기. 렌더러는 file:// 출처라 원격 서버가 CORS 헤더를 안 주면 fetch가 막히므로 메인에서 받는다.
ipcMain.handle('fetch-text', async (event, url) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('http(s) URL만 받을 수 있습니다');
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
});

ipcMain.handle('read-geojson', async (event, filePath) => {
    return await fs.promises.readFile(filePath, 'utf-8');
});

ipcMain.handle('read-meta', async (event, filePath) => {
    const fileBuffer = await fs.promises.readFile(filePath);
    const detected = jschardet.detect(fileBuffer);

    if (detected.encoding === 'EUC-KR') {
        return iconv.decode(fileBuffer, 'EUC-KR');
    } else {
        return fileBuffer.toString(detected.encoding);
    }
});
