# 🎯 XDViewer
[![Version](https://img.shields.io/badge/Version-1.0.5-orange)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-v22-brightgreen)](https://nodejs.org/)
[![Electron](https://img.shields.io/badge/Electron-v37-blue)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/License-MIT-yellow)](LICENSE)

데이터 시각화를 로컬에서 하기위한 일렉트론 기반의 프로젝트 입니다.

## ⚡ 1. **Electron 메인 프로세스 (index.js)**
- 브라우저 창 생성:
  - 창 크기, 메뉴 숨김, Node.js 및 컨텍스트 격리 설정.
  - preload.js를 활용하여 주고받는 이벤트 처리.
- DevTools 관리:
  - F12 키를 눌렀을 때 DevTools를 열고 닫는 로직을 추가.
  - DevTools 창 크기를 동적으로 조정.
- 파일 선택:
  - dialog.showOpenDialog를 이용하여 파일 열기 다이얼로그를 표시.
  - 선택한 파일 경로를 렌더러 프로세스에 전달.
- globalShortcut:
  - F12 단축키를 등록하여 이벤트 처리.
- 로컬 타일 서버 (127.0.0.1, 임의 포트):
  - XDWorld 엔진은 타일을 HTTP로 요청하므로, 폴더 타일뿐 아니라 **요청 단위로 생성한 타일**을 응답할 수 있다.
  - `/__xdimg__/<id>/{L}/{IDY}/{IDY}_{IDX}.png` — 영상 타일. 세슘(EPSG:3857) 피라미드 재투영, jpg→png 변환, SQLite blob 응답, 표고 커버리지 회색조 렌더.
  - `/__xddem__/<id>/{L}/{IDY}/{IDY}_{IDX}.bil` — 지형 타일. sdb의 gzip bil blob을 그대로 응답.
- SQLite 타일 패키지 (`node:sqlite` 내장 모듈, 네이티브 빌드 불필요):
  - GeoPackage(`gpkg_contents` + `tiles`)와 XDWorld sdb(`tiles(level, idx, idy, data)`)를 열어 스키마·격자·blob 포맷을 판정.
  - 영상(png/jpg) → 영상 레이어, 지형(gzip bil) → demBox, GeoPackage 표고 커버리지(TIFF float) → `geotiff`로 디코딩해 회색조 영상.
- 단일 인스턴스 + 파일 연결:
  - `layer.meta` 더블클릭 시 실행 중인 창으로 경로를 전달해 자동 로딩.

## 🖥️ 2. **렌더러 프로세스 (index.html)**
- UI 디자인:
  - #map: 3D 맵을 렌더링할 컨테이너.
  - #interface: 파일 열기 및 동적으로 생성되는 레이어 관리 버튼.
- 버튼 동작:
  - "Open" 버튼 클릭 시 메인 프로세스와 통신하여 파일 경로를 요청.
  - 새로운 레이어를 추가하고, 해당 버튼을 동적으로 생성.
- 3D 타일 데이터 처리:
  - 파일 경로를 Module.JSLayerList와 연동하여 새로운 레이어로 로드.
  - 레이어 제거 시 대응하는 버튼도 함께 삭제.
- XDWorld 연동:
  - Module 객체를 통해 3D 타일, DEM 데이터 등을 처리.
  - window.onresize 이벤트로 화면 크기 변화에 동적 대응.
- 드래그앤드롭 입력:
  - 파일: `.geojson`, `.csv`, `.meta`(layer.meta), `tileset.json`, `.glb/.gltf`, `.3ds`, `.gpkg/.sdb/.sqlite`
  - 폴더: `layer.meta` 폴더(XDWorld 배치), `tileset.json` 폴더(3D Tiles), 숫자 레벨 피라미드(세슘/raw 영상 타일)
- 경로/URL 입력:
  - 레이어 패널 상단 입력창에 **절대경로(파일·폴더)**, `file://` URL, 또는 **http(s) URL**을 붙여 넣고 Enter. URL은 `tileset.json`(3D Tiles), `layer.meta`(원격 XDWorld 레이어, 타일을 HTTP로 요청), `.geojson`을 지원. 브라우저에서 URL을 끌어다 놓아도 같은 경로로 로딩.
- 레이어 목록:
  - 항목 앞에 종류 아이콘 표시(영상·표고 영상·지형·3D Tiles·3D 모델·벡터·포인트·파이프·포인트클라우드). 체크박스로 표시/숨김, × 로 제거.
- 분석 패널 · 지형 렌더링:
  - Normal / Slope / Aspect / **고도 색상**. 고도 색상은 최소·최대 고도(m, 수심은 음수)와 컬러맵, 불투명도를 정하면 지형(해저 포함)을 높이별 색으로 칠하고 범례를 표시.
  - 컬러맵은 과학계 표준: 지형·수심용 ETOPO1(GMT/NOAA), GMT relief, GMT globe, cmocean topo(해면 0m 기준으로 바다/육지 분리), 범용 matplotlib terrain, viridis, turbo, grayscale, 그리고 XDWorld 샘플의 Terrain Altitude Color(Standard·Warm·Sea·Plant·Sky).
  - 색 단계(8~128, 기본 32)를 줄이면 등고선처럼 띠가 뚜렷해지고, 늘리면 연속에 가까워짐. 범례도 같은 띠로 표시.
  - F12 콘솔에서도 가능: `XDV.terrainColor(-6000, 4000)` · `XDV.terrainColor(0, 600, 'viridis', 0.8, 16)` · `XDV.terrainNormal()`
- 카메라:
  - 줌아웃 고도 상한 5,000만 m. 무제한으로 멀어져 지구본이 사라지는 것을 막는다(휠 차단 + 프레임 단위 되돌림).

## 🧪 3. **테스트 환경**
| 구분             | OS                  | 주요 버전            | Node.js  | npm    | 기타             |
| -------------- | ------------------- | ---------------- | -------- | ------ | -------------- |
| 🪟 **Windows** | Windows 10 Pro 22H2 |                  | v20.18.1 | 10.8.2 |                |
| 🐧 **WSL 2.0** | Ubuntu 22.04 LTS    | fusermount 2.9.9 | v22.13.0 | 11.0.0 | (1.0은 GUI 미지원) |
| 🧱 **Linux**   | Ubuntu 20.04 LTS    | fusermount 2.9.9 | v10.19.0 | 6.14.4 |                |
| 🍎 **Mac OS**  | macOS 15.1.1        | brew 4.4.16      | v23.6.0  | 10.9.2 |                |

## 🛠️ 4. **Node.js 설치방법**
- Windows에서 Node.js 설치
  - Node.js 공식 다운로드 페이지로 이동합니다.
  - LTS 또는 Current 버전 중에서 선택하여 다운로드합니다.
  - 다운로드한 .msi 설치 파일을 실행합니다.
  - 설치 마법사에서 Next를 클릭하고, 기본 설정을 그대로 선택하여 설치를 진행합니다.
  - 설치 완료 후, 명령 프롬프트나 PowerShell을 열고 node -v와 npm -v 명령어를 입력하여 Node.js와 npm이 정상적으로 설치되었는지 확인합니다.
```bash
> node -v
> npm -v
```
- macOS에서 Node.js 설치(Homebrew)  
  - 터미널을 열고 Homebrew가 설치되어 있지 않다면 아래 명령어로 Homebrew를 설치합니다.
  - Homebrew가 설치된 후, 아래 명령어로 Node.js를 설치합니다.
`brew install node`
  - 설치 후, 아래 명령어로 Node.js와 npm 버전을 확인하여 설치가 잘 되었는지 확인합니다.
```bash
$ node -v
$ npm -v
```
- Linux(Ubuntu)에서 설치
  - 터미널을 열고, NodeSource의 설치 스크립트를 사용하여 Node.js를 설치합니다. 예를 들어, 최신 버전인 Node.js 23을 설치하려면:
```bash
$ curl -fsSL https://deb.nodesource.com/setup_16.x | sudo -E bash -
$ sudo apt-get install -y nodejs
```
  - 설치 후, 아래 명령어로 Node.js와 npm버전을 확인합니다.
```baseh
$ node -v
$ npm -v
```

- WSL (Windows Subsystem for Linux)에서 Node.js 설치
WSL2에서 Node.js를 설치하려면, Ubuntu와 같은 리눅스 배포판을 사용하고 위의 리눅스 방법에 따라 설치할 수 있습니다.
  - WSL2 터미널을 열고 아래 명령어로 Node.js를 설치합니다.
```bash
$ sudo apt update
$ sudo apt install nodejs npm
```
- nvm (Node Version Manager) 사용
nvm을 사용하면 여러 버전의 Node.js를 쉽게 관리하고, 버전을 전환할 수 있습니다. nvm은 Windows에서 별도의 도구인 nvm-windows를 사용합니다.
  - nvm-windows
    - 웹페이지 : https://github.com/coreybutler/nvm-windows/releases
    - 사용법 
```shell
# 설치된 버전 확인 
> nvm list
    23.6.0
    22.13.0
  * 20.18.1 (Currently using 64-bit executable)
    18.16.1
# 지정한 버전을 설치
> npm install <버전>
# 설치한 버전을 사용
> nvm use <버전>
> nvm use 18.16.1
# 설치한 버전을 삭제
> nvm uninstall <버전>
```
## 🚀 5. **빌드방법**
```bash
$ git clone https://github.com/iyeti78/XDViewer.git
$ cd XDViewer
$ npm install
$ npm start
```
![실행](image.png)

앱 아이콘 원본은 `build/icon.svg`이고, 바꾼 뒤에는 `electron build/make-icon.js`로 `icon.ico`/`icon.png`를 다시 만든다.

배포본(Windows NSIS 설치 파일)은 `dist/` 아래에 생성된다.
```bash
$ npm run dist            # electron-builder (publish 설정은 package.json의 build.publish)
$ npx electron-builder --publish never   # GitHub 업로드 없이 로컬 빌드만
```
> VS Code 터미널에서 `npm start`가 Node 모드로 뜨면 `ELECTRON_RUN_AS_NODE` 환경변수가 상속된 것이다. 지우고 실행한다.

## ✅ 6. **로딩확인 레이어**   
- 🧱 3DTiles 1.0 (ELT_3DTILES)
  - ELT_3DTILES
- 🖼️ 영상 (ETLT_PNG_IMAGE)
  - TILE_LAYER_TYPE_IMAGE
- 🚇 파이프 (ETLT_VECTOR_PIPE)
  - TILE_LAYER_TYPE_VECTOR_PIPE
- 🏙️ 건물 (ETLT_REAL3D)
  - TILE_LAYER_TYPE_REAL3D
- 📍 POI (ETLT_3DPOINT)
  - TILE_LAYER_TYPE_POI
- 🏔️ 지형 (ETLT_BASE_DEM)
  - ETLT_BASE_DEM (bil) — 폴더 또는 sdb(gzip bil blob)
- 🗺️ 로컬 영상 타일 피라미드
  - 세슘 EPSG:3857 (`layer.json`/`tilemapresource.xml`/XYZ 기본) → 요청 단위 EPSG:4326 재투영
  - XDWorld 배치 jpg → 요청 단위 png 변환
- 🗄️ SQLite 타일 패키지 (`.gpkg` / `.sdb` / `.sqlite`)
  - GeoPackage `tiles`(png/jpg) → 영상 레이어. XDWorld(vworld) 격자(EPSG:4326, 레벨0 10×5)만 지원
  - GeoPackage `2d-gridded-coverage`(TIFF float) → 표고 회색조 영상(QGIS 단일밴드 회색조와 유사)
  - sdb `tiles(level, idx, idy, data)` gzip bil → 지형(demBox)
- 🧭 GeoJSON / CSV(위경도 포인트), 🧊 glTF / 3DS 모델

## 📦 7. **변경 이력**
- **1.0.5** (2026-09-03)
  - SQLite 타일 패키지 드롭 로딩: GeoPackage/sdb 영상, sdb 지형(bil), GeoPackage 표고 커버리지(TIFF) 회색조 영상
  - 레이어 목록 종류 아이콘
  - 줌아웃 고도 상한(지구본 소실 방지)
- **1.0.4** — layer.meta 드래그 시 경로 존재 여부 검사, 분석 패널 지형 렌더링 모드(Normal/Slope/Aspect), 나침반 tilt 수평선
- **1.0.3 이하** — 로컬 영상 타일(세슘/XDWorld/raw 피라미드) 로딩, layer.meta 더블클릭 실행, GeoJSON 레이어 기능

## 💡 8. **팁**
- DevTools는 Electron 개발 시 필수! F12로 언제든 열어서 디버깅 가능

