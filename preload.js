const { contextBridge, ipcRenderer, webUtils, shell } = require('electron');
const fs = require('fs');
const GeoTIFF = require('geotiff');

contextBridge.exposeInMainWorld('electronInfo', {
  chrome: process.versions.chrome,
  electron: process.versions.electron,
  node: process.versions.node
});
// 렌더러에서 메인 프로세스 호출 및 결과 받기
contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.send('open-file-dialog'),
  onFilePathReceived: (callback) => ipcRenderer.on('file-path', callback),
  focusWindow: () => ipcRenderer.invoke('focus-window'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  readGeoJSON: (filePath) => {
    return new Promise((resolve, reject) => {
      // fs 모듈은 렌더러 프로세스에서 사용할 수 없으므로, 메인 프로세스에서 처리
      // 메인 프로세스에서 파일을 읽어와서 렌더러로 전달
      ipcRenderer.invoke('read-geojson', filePath)
        .then(data => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        })
        .catch(err => reject(err));
    });
  },
  readMeta: (filePath) => {
    return ipcRenderer.invoke('read-meta', filePath);
  },
  readJsonFile: (path) => {
    const jsonStr = fs.readFileSync(path, 'utf8');
    return JSON.parse(jsonStr);
  },
  getPathForFile: (file) => {
    // Electron의 webUtils를 사용하여 File 객체로부터 경로 가져오기
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      console.error('Error getting file path:', error);
      return null;
    }
  },
   parseLASHeader: (filePath) => {
    try {
      const headerSize = 227; // LAS 1.2 기준 헤더 기본 크기
      const headerBuffer = Buffer.alloc(headerSize);

      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, headerBuffer, 0, headerSize, 0);
      fs.closeSync(fd);

      const pointCount = headerBuffer.readUInt32LE(107);
      const xMin = headerBuffer.readDoubleLE(36);
      const xMax = headerBuffer.readDoubleLE(44);
      const yMin = headerBuffer.readDoubleLE(52);
      const yMax = headerBuffer.readDoubleLE(60);
      const zMin = headerBuffer.readDoubleLE(68);
      const zMax = headerBuffer.readDoubleLE(76);

      return {
        pointCount,
        bbox: { xMin, xMax, yMin, yMax, zMin, zMax }
      };
    } catch (err) {
      console.error('LAS parse error:', err);
      return null;
    }
  },
   parseTIFHeader: (filePath) => {
    try {      
      // GeoTIFF 헤더만 읽기
      return GeoTIFF.fromFile(filePath)
        .then(tiff => tiff.getImage()) // IFD만 읽어서 width/height/bbox 확인
        .then(image => ({
          width: image.getWidth(),
          height: image.getHeight(),
          bbox: image.getBoundingBox(),
          samplesPerPixel: image.getSamplesPerPixel(),
          bitsPerSample: image.getBitsPerSample()
        }))
        .catch(err => {
          console.error('TIF parse error (헤더만):', err);
          return null;
        });

    } catch (err) {
      console.error('TIF read error:', err);
      return Promise.resolve(null);
    }
  },
  readCsvFile: (filePath) => {
    try {
      const buf = fs.readFileSync(filePath);

      // UTF-8 BOM 체크
      if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        return buf.subarray(3).toString('utf8');
      }

      // UTF-8 유효성 검사 - 잘못된 바이트가 있으면 EUC-KR로 시도
      const utf8Str = buf.toString('utf8');
      if (utf8Str.includes('\uFFFD')) {
        // 깨진 문자가 있으면 EUC-KR로 디코딩
        const decoder = new TextDecoder('euc-kr');
        return decoder.decode(buf);
      }

      return utf8Str;
    } catch (err) {
      console.error('CSV read error:', err);
      return null;
    }
  },
  openExternal: (url) => shell.openExternal(url),
  getLocalFileUrl: (filePath) => ipcRenderer.invoke('get-local-file-url', filePath),
  getLocalServerPort: () => ipcRenderer.sendSync('get-local-server-port'),
  listEngineReleases: () => ipcRenderer.invoke('list-engine-releases'),
  getReleaseNotes: () => ipcRenderer.invoke('get-release-notes'),
  ensureWorker: (version, urlTemplate) => ipcRenderer.invoke('ensure-worker', version, urlTemplate),
  listCachedWorkers: () => ipcRenderer.invoke('list-cached-workers'),
  clearWorkerCache: () => ipcRenderer.invoke('clear-worker-cache'),
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
  pathExists: (dirPath) => fs.existsSync(dirPath),
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch (err) {
      return false;
    }
  },
  listDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch (err) {
      return [];
    }
  },
  // 영상 소스 등록 -> 엔진에 넘길 로컬 HTTP layerPath (타일은 요청 시 생성)
  registerImageSource: (opts) => ipcRenderer.invoke('register-image-source', opts),
  unregisterImageSource: (id) => ipcRenderer.invoke('unregister-image-source', id),
  setDemScale: (id, scale) => ipcRenderer.invoke('set-dem-scale', id, scale),
  setBaseDemScale: (scale) => ipcRenderer.invoke('set-base-dem-scale', scale),
  updateDemColor: (id, opts) => ipcRenderer.invoke('update-dem-color', id, opts),
  setDemUpsample: (levels) => ipcRenderer.invoke('set-dem-upsample', levels),
  clearTileCaches: () => ipcRenderer.invoke('clear-tile-caches'),
  // URL 텍스트 받기 (렌더러 fetch는 file:// 출처라 CORS에 막힐 수 있어 메인에서 받는다)
  fetchText: (url) => ipcRenderer.invoke('fetch-text', url)

});
