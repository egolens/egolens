# Next: Waymo Segmentation + Keypoints 구현 계획

4개 Waymo v2 perception 컴포넌트 시각화.

## 선행작업 완료 (4f74eb2)

다음 항목들은 이미 구현 완료. 각 feature 구현 시 추가 scaffolding 불필요:

- [x] `download.sh` — `lidar_segmentation`, `camera_segmentation`, `lidar_hkp`, `camera_hkp` 포함 (63a539b)
- [x] `DatasetManifest` 타입 확장 — `overlayModes`, `annotationModes`, `semanticPalette`, `semanticLabels` optional 필드 추가 (`src/types/dataset.ts`)
- [x] `waymoManifest` + `nuScenesManifest` 업데이트 — 새 필드 반영, palette 연결
- [x] Waymo 23-class semantic palette — `src/utils/waymoSemanticClasses.ts` (WAYMO_SEG_PALETTE, WAYMO_SEG_LABELS)
- [x] 14 keypoint types + skeleton bone 정의 — `WAYMO_KEYPOINT_TYPES`, `WAYMO_SKELETON_BONES` (같은 파일)
- [x] `upng-js` 설치 + `src/types/upng-js.d.ts` 타입 선언 — camera_segmentation uint16 PNG 디코딩용
- [x] `OverlayMode`, `AnnotationMode` 타입 — `src/types/dataset.ts`에서 export
- [x] `computePointColor()` + `instanceColor()` palette 파라미터화 — manifest.semanticPalette 기반 resolve, LIDARSEG_PALETTE fallback 유지 (4de9fc0)
- [x] lidar vs lidar_segmentation RG 구조 분석 — **RG 구조 완전히 다름** (lidar 4 RGs vs seg 1 RG), TOP 센서만, 매 5프레임 간격, timestamp 매칭 필수, init 전량 로딩 전략 확정

## Spike 검증 완료 (Phase A 착수 전 필수 3건)

### Spike 1: UPNG uint16 디코딩 검증 ✅

실제 `camera_segmentation` parquet 데이터로 end-to-end 검증 완료.

**결과**:
- `UPNG.decode()` → `depth=16`, `ctype=0` (grayscale) 정상 반환
- **주의**: `readAllRows()`에 반드시 `utf8: false` 필요. 기본값은 BYTE_ARRAY를 String으로 디코딩하여 PNG 바이너리 손상
- `UPNG.decode().data`는 **defiltered 데이터 + H trailing bytes** 반환
  - `data.byteLength = W × H × 2 + H` (매 row마다 1바이트 잔여)
  - 유효 픽셀 데이터: 처음 `W × H × 2` 바이트만 사용, big-endian uint16
  - stride = `W × 2`, filter byte 제거 불필요 (UPNG이 이미 defilter 수행)
- 성능: 1920×1280 PNG 디코딩 **~22ms** (5회 평균), 1920×886은 ~15ms 추정
  - 5카메라 동시: ~110ms → 프레임 전환 시 jank 가능 → `requestIdleCallback` 또는 순차 디코딩 권장
- **카메라별 해상도**: FRONT/LEFT/RIGHT = 1920×1280, SIDE_LEFT/SIDE_RIGHT = 1920×886

**중요 발견: Camera Segmentation은 LiDAR와 다른 29-class 팔레트 사용**

| LiDAR seg (23 classes, 0-22) | Camera seg (29 classes, 0-28) |
|------------------------------|-------------------------------|
| 0: Undefined | 0: Undefined |
| 1: Car | 1: Car |
| 2: Truck | 2: Bus |
| 3: Bus | 3: Truck |
| ... | 4: Other Large Vehicle |
| | 5: Trailer |
| | 6: Ego Vehicle |
| 10: Pedestrian | 9: Pedestrian |
| | 12: Ground Animal |
| | 13: Bird |
| 18: Building | 19: Building |
| 14: Road | 20: Road |
| | 25: Sky (camera-only!) |
| | 26: Ground |
| | 27: Static |
| | 28: Dynamic |

**Action required for Phase A**:
- `waymoSemanticClasses.ts`에 `WAYMO_CAMERA_SEG_PALETTE` (29 entries) + `WAYMO_CAMERA_SEG_LABELS` 추가
- `DatasetManifest`에 `cameraSemanticPalette?: [number,number,number][]` optional 필드 추가 (또는 manifest 내 camera seg용 별도 palette 참조)
- 기존 `WAYMO_SEG_PALETTE` (23 classes)는 LiDAR segmentation 전용으로 유지

### Spike 2: segLabelFrames 인덱싱 방식 검증 ✅

`segLabelFrames: Set<number>`에서 `number`는 **frameIndex** (0-based, `timestampToFrame.get(ts)` 결과).

**실측 데이터** (segment `10455472...`):
- Master frame list: 199 frames
- lidar_segmentation: 30 frames, frameIndices = {25, 30, 35, ..., 170}, **정확히 5프레임 간격**
- camera_segmentation: 20 frames, frameIndices = {24, 28, 30, 32, 36, 74, 78, 80, 82, 86, ...}, **불규칙 간격** (4-2-2-4-38 패턴 반복)
- lidar_hkp: 68 frames, 불규칙 간격

**매핑 로직** (Phase A `loadWaymoMetadata()`에 구현):
```typescript
// seg parquet에서 unique timestamps 추출
const segTimestamps = [...new Set(segRows.map(r => r['key.frame_timestamp_micros'] as bigint))]
// master frame list의 timestampToFrame으로 변환
const segLabelFrames = new Set<number>()
for (const ts of segTimestamps) {
  const fi = bundle.timestampToFrame.get(ts)
  if (fi !== undefined) segLabelFrames.add(fi)
}
```

### Spike 3: camera_seg 로딩 성능 — async 분리 불필요 ✅

**벤치마크** (Node.js, 단일 세그먼트):

| Component | File Size | Rows | Load Time |
|-----------|-----------|------|-----------|
| **기존 metadata 합계** | ~2.4 MB | ~63K | **409 ms** |
| lidar_segmentation | 952 KB | 30 | 3 ms |
| lidar_hkp | 66 KB | 139 | 8 ms |
| camera_hkp | 337 KB | 1,807 | 17 ms |
| camera_segmentation | 3,055 KB | 100 | 39 ms |
| **신규 합계** | ~4.4 MB | ~2K | **68 ms** |
| **전체 합계** | | | **476 ms** |

camera_segmentation의 39ms는 전체 로딩(476ms)의 8%에 불과. **async 분리 없이 기존 `loadWaymoMetadata()` 내에서 순차 로딩으로 충분.**
단, `readAllRows()`에 `utf8: false` + 필요 컬럼만 지정하여 불필요한 column 디코딩 회피.

---

## 핵심 원칙: Data-Driven UI

**파일 없으면 graceful skip, 관련 UI 자체를 숨김.**

- parquet 파일이 없거나 열기 실패 → `console.warn` 후 skip, 에러 안 던짐
- 데이터가 로딩되지 않은 기능의 UI 컨트롤은 렌더링하지 않음:
  - `lidar_segmentation` 없음 → colormapModes에서 `'segment'` 제외
  - `lidar_hkp` / `camera_hkp` 없음 → keypoint 토글 버튼 숨김
  - `camera_segmentation` 없음 → 카메라 seg overlay 토글 숨김
- 판별 방법: store에 `hasSegmentation`, `hasKeypoints`, `hasCameraSegmentation` boolean 추가
  - metadata 로딩 시 해당 parquet이 열렸고 데이터가 1행 이상이면 true
  - UI 컴포넌트에서 이 플래그로 조건부 렌더링
- 이미 `hasBoxData` 패턴이 존재 (박스 데이터 없으면 box 모드 UI 숨김) → 동일 패턴 따름

### UI 렌더링 로직: manifest ∩ store

```
manifest가 선언함               store가 확인함              UI에 보임
──────────────────────────    ──────────────────────    ────────────
colormapModes 에 'segment'    hasSegmentation=true      segment 버튼 보임
overlayModes 에 'keypoints2d' hasKeypoints=true         2D keypoint 토글 보임
annotationModes 에 'keypoints3d' hasKeypoints=true      3D skeleton 토글 보임
overlayModes 에 'segmentation'  hasCameraSegmentation=true  cam seg 토글 보임
```

> 새 데이터셋 추가할 때 manifest만 정의하면 UI가 자동으로 따라옴.
> 같은 데이터셋이라도 세그먼트마다 데이터 유무가 다르면 store 플래그가 동적으로 반영.

---

## 의존성 그래프

```
Phase A: Shared Infra (공통 기반)
    │
    ├──→ Phase B1: lidar_segmentation (독립)
    │
    ├──→ Phase B2: lidar_hkp (독립, B1과 병렬 가능)
    │         │
    │         └──→ Phase C1: camera_hkp (B2의 skeleton 정의 + 토글 상태 의존)
    │
    └──→ Phase C2: camera_segmentation (A의 Timeline 마커 + upng infra 의존)
              │
              └──→ Phase D: Integration & Polish (B1+B2+C1+C2 모두 완료 후)
```

**병렬 가능 조합**: B1 ∥ B2, C1 ∥ C2 (단, C1은 B2 완료 필요)

---

## Phase A: Shared Infrastructure

**목표**: 모든 feature가 공유하는 store 플래그, MetadataBundle 확장, worker 프로토콜, Timeline 마커 인프라를 한 번에 구축.

### A-1. Store has* 플래그 + MetadataBundle 확장

**변경 파일**: `src/types/dataset.ts`, `src/stores/useSceneStore.ts`, `src/adapters/waymo/metadata.ts`

**작업 내용**:
1. `MetadataBundle`에 optional 필드 추가:
   - `hasSegmentation?: boolean`
   - `hasKeypoints?: boolean`
   - `hasCameraSegmentation?: boolean`
   - `segLabelFrames?: Set<number>` — seg 라벨 존재 프레임 인덱스
   - `keypointFrames?: Set<number>` — keypoint 존재 프레임 인덱스
   - `cameraSeg?: Map<bigint, Map<number, { panopticLabel: ArrayBuffer, divisor: number }>>` — (Phase C2에서 실제 populate)
   - `keypointsByFrame?: Map<bigint, ParquetRow[]>` — 3D keypoint rows
   - `cameraKeypointsByFrame?: Map<bigint, ParquetRow[]>` — 2D keypoint rows
2. `SceneState`에 추가:
   - `hasSegmentation: boolean` (default false)
   - `hasKeypoints: boolean` (default false)
   - `hasCameraSegmentation: boolean` (default false)
   - `showKeypoints: boolean` (default false, 3D+2D 동시 제어)
   - `segLabelFrames: Set<number>` (default empty)
   - `keypointFrames: Set<number>` (default empty)
   - `cameraSeg: Map<...> | null`
   - `keypointsByFrame: Map<...> | null`
   - `cameraKeypointsByFrame: Map<...> | null`
3. `SceneActions`에 추가:
   - `toggleKeypoints(): void`
4. `loadWaymoMetadata()`에서 seg/hkp/camera_seg/camera_hkp parquet 열기 시도:
   - 열기 실패 → `console.warn` + skip (has* = false)
   - 열기 성공 → has* = true + sparse frame index 구축
   - **hkp/camera_hkp는 ~29KB/~116KB로 매우 작으므로 전량 readAllRows() 가능**
   - **lidar_seg는 worker에서 로딩** (metadata에서는 파일 존재 확인 + 프레임 인덱스만 구축)
   - **camera_seg도 metadata에서 전량 로딩** (~2.3MB, readAllRows() → PNG bytes 캐싱)
5. store의 `loadDataset()` → `unpackMetadata()` 에서 새 필드 언팩

### A-2. Worker Init 프로토콜 확장

**변경 파일**: `src/workers/waymoLidarWorker.ts`, `src/stores/useSceneStore.ts`

**작업 내용**:
1. `WaymoLidarWorkerInit`에 `segUrl?: string | File` 필드 추가
2. Worker init 핸들러에서 `segUrl`이 주어지면:
   - `openParquetFile(segUrl)` → `readAllRows()` → `Map<bigint, Map<number, {shape, values}>>` 구축
   - 이 Map은 worker 내부에 캐싱 (init 1회만)
3. store의 worker init 호출 시 `segUrl` 전달 (parquetFiles.get('lidar_segmentation')의 url/file)
4. `WorkerInitBase`는 변경하지 않음 (dataset-agnostic 유지). Waymo-specific init에만 추가.

### A-3. Timeline 마커 인프라

**변경 파일**: `src/components/Timeline/Timeline.tsx`

**작업 내용**:
1. `Timeline`이 `segLabelFrames`, `keypointFrames`를 store에서 subscribe
2. scrubber 트랙 위에 dot 마커 렌더링 (position = frameIndex / totalFrames × 100%)
3. 마커 색상 체계:
   - seg frames → `#00CCFF` (cyan dot, 2px)
   - keypoint frames → `#CCFF00` (lime dot, 2px)
   - camera seg frames → `#FF44FF` (magenta dot, 2px)
4. 마커는 해당 feature가 활성일 때만 표시:
   - seg 마커 → `colormapMode === 'segment'` 일 때
   - keypoint 마커 → `showKeypoints === true` 일 때
   - camera seg 마커 → camera seg overlay ON 일 때

### A-4. Colormap 'segment' 동적 게이팅

**변경 파일**: `src/adapters/waymo/manifest.ts`, `src/components/LidarViewer/LidarViewer.tsx`

**작업 내용**:
1. `waymoManifest.colormapModes`에 `'segment'` 추가 (정적 선언)
2. UI 쪽 colormap 버튼 렌더링 시 필터: `manifest.colormapModes.filter(mode => mode !== 'segment' || hasSegmentation)`
3. 이렇게 하면 manifest는 "이 데이터셋은 segment를 지원할 수 있다"를 선언하고, store의 `hasSegmentation`이 "이 세그먼트에 실제 데이터가 있다"를 확인하는 2단계 게이팅.

**Acceptance Criteria**:
- [ ] `hasBoxData`가 있는 세그먼트에서 기존 기능이 정상 동작 (regression 없음)
- [ ] seg/hkp/camera_seg/camera_hkp parquet 없는 세그먼트 로딩 시 에러 없이 has*=false
- [ ] Timeline 컴포넌트에 마커 렌더링 슬롯이 준비됨 (빈 Set이면 마커 0개)
- [ ] `showKeypoints` 토글이 존재하고 동작함 (데이터 없으면 UI 숨김)
- [ ] segment 모드 버튼이 hasSegmentation=false일 때 숨겨짐
- [ ] 기존 27개 테스트 통과

**Concerns**:
- `MetadataBundle`에 optional 필드 추가가 nuScenes/AV2 어댑터에 영향 없는지 확인 (optional이므로 OK이지만, 타입 체크)
- ~~`loadWaymoMetadata()` 실행 시간 증가~~ → **벤치마크 완료: +68ms (기존 409ms → 476ms). async 분리 불필요**
- reset() 시 새 state 필드들 초기화 누락 주의
- **camera_segmentation `readAllRows()`에 반드시 `utf8: false` 전달** (PNG bytes를 String으로 변환하면 손상)
- **Camera seg 팔레트**: `WAYMO_CAMERA_SEG_PALETTE` (29 classes) + `WAYMO_CAMERA_SEG_LABELS` 별도 정의 필요. `waymoManifest`에 `cameraSemanticPalette` 참조 추가

**예상 소요**: 2–3시간

---

## Phase B1: lidar_segmentation — LiDAR 23클래스 Semantic Segmentation

**선행 의존성**: Phase A (store 플래그, worker 프로토콜, Timeline 마커, colormap 게이팅)
**후행 의존성**: 없음 (독립 완결)

### 데이터 형식

range image와 동일 구조 `[H, W, 2]` — channel 0 = semantic class, channel 1 = instance ID
- 컬럼: `[LiDARSegmentationLabelComponent].range_image_return1.values` + `.shape`
- 키: `key.frame_timestamp_micros`, `key.laser_name`
- 파일 크기: ~850KB (startup 전량 로딩 가능)

### RG 구조 분석 결과 (실제 데이터 검증 완료)

```
                    lidar                    lidar_segmentation
RG 수               4 (256, 256, 256, 222)   1 (전량)
총 rows             990                      20~30
frames              198 (전체)               20~30 (sparse, 매 5번째 프레임)
sensors/frame       5 (laser 1~5)            1 (laser 1 = TOP only)
파일 크기            ~176MB                   ~850KB
```

- **RG 구조 완전히 다름** → RG index 동기화 불가, timestamp 매칭 필수
- **TOP 센서(laser_name=1)만** seg 라벨 존재 → 나머지 4센서는 segLabels=null
- **매 5프레임 간격** (2Hz), 프레임 24부터 시작. 세그먼트마다 20~30프레임
- seg 프레임이 lidar의 **4개 RG에 걸쳐 분산** 배치됨

### 구현 전략 (RG 분석 기반)

seg 파일이 ~850KB로 매우 작으므로 **worker init에서 전량 로딩 + timestamp Map 인덱싱**:

```
init 시점:
  segFile → readAllRows() → Map<bigint, Map<number, {shape, values}>>
  (timestamp → laser_name → range image seg data, ~30 entries)

loadBatch(batchIndex) 시점:
  lidar RG 디코딩 → frameGroups (by timestamp)
  각 frame, 각 sensor에 대해:
    segMap.get(timestamp)?.get(laserName) 존재?
      → range image와 동일 좌표로 per-point label 추출
      → SensorCloudResult.segLabels = Uint8Array
    없으면 → segLabels = undefined (이 프레임/센서는 seg 없음)
```

### 구현 작업

1. **waymoLidarWorker.ts** — init에서 seg parquet `readAllRows()` → timestamp Map 구축
   - `segUrl`이 없으면 skip (seg 없는 세그먼트)
   - init 시간 목표: +50ms 이하 (850KB readAllRows)
2. **waymoLidarWorker.ts** — loadBatch에서 timestamp lookup + per-point label 추출
   - range image `[H, W, 2]`에서 channel 0 = semantic class
   - lidar range image 변환 시 valid pixel만 추출하는 것과 동일 인덱싱 (`ri_row * W + ri_col`)
   - `convertAllSensors()` 또는 후처리에서 segLabels 주입
3. **SensorCloudResult** — `segLabels: Uint8Array` 필드 이미 존재 (nuScenes용), Waymo에서도 동일 사용
4. **PointCloud.tsx** — segment 모드에서 비-TOP 센서 처리:
   - `segLabels`가 없는 센서 → gray (#808080) + opacity 0.3
5. **LidarViewer.tsx** — colormap 토글에 'segment' 추가 (Phase A에서 게이팅 인프라 완료)
6. **Timeline.tsx** — `segLabelFrames` 마커 활성화 (Phase A에서 인프라 완료)

### Acceptance Criteria

- [ ] segment colormap 모드 선택 시, TOP 센서 포인트가 23-class 색상으로 렌더링됨
- [ ] 비-TOP 센서(FRONT, SIDE_L, SIDE_R, REAR) 포인트는 gray (#808080, opacity 0.3)으로 표시
- [ ] seg 라벨이 없는 프레임에서 segment 모드 → 자동으로 이전 colormap(intensity)으로 fallback + 콘솔 경고
- [ ] `lidar_segmentation` parquet 없이 폴더 로딩 → 'segment' 버튼 미표시, 에러 없음
- [ ] Timeline에 seg 프레임 마커(cyan dots)가 정확한 프레임 위치에 표시됨 (segment 모드 활성 시에만)
- [ ] 성능: segment colormap이 기존 colormap 대비 프레임 렌더 시간 **+5ms 이내**
- [ ] worker init 시간: seg 로딩 포함 **+100ms 이내**
- [ ] 세그먼트 전환 시 이전 segMap이 GC됨 (메모리 누수 없음)
- [ ] 기존 intensity/range/elongation/camera colormap 동작 regression 없음
- [ ] Vitest: timestamp 매칭 로직 유닛 테스트 추가 (seg 있는 프레임, 없는 프레임, edge case)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| range image 좌표 인덱싱 오류 — seg와 lidar의 H×W가 다를 경우 | seg 라벨이 잘못된 포인트에 할당 | seg `.shape`과 lidar `.shape` 비교 assert 추가 |
| worker 내 readAllRows() 실패 (corrupt parquet) | worker 전체 init 실패 | try-catch → segMap = null, segLabels 없이 계속 |
| instance ID (channel 1) 무시 시 panoptic 모드 추가 어려움 | 향후 panoptic 추가 시 재파싱 필요 | channel 1도 함께 캐싱 (메모리 +64KB, 무시 가능) |
| seg 프레임 간격이 세그먼트마다 다를 수 있음 (매 5프레임 가정) | 일부 세그먼트에서 마커 위치 부정확 | 가정하지 말고 실제 timestamp에서 동적 계산 |

**예상 소요**: 3–4시간

---

## Phase B2: lidar_hkp — 3D Human Keypoints (14 joints)

**선행 의존성**: Phase A (store 플래그, Timeline 마커, showKeypoints 토글)
**후행 의존성**: Phase C1 (camera_hkp가 skeleton 정의 + 토글 상태 공유)

### 데이터 형식

per-object keypoint 좌표
- 컬럼: `[LiDARKeypointComponent].keypoint.location_m.{x,y,z}`, `.type` (int8)
- 키: `key.frame_timestamp_micros`, `key.laser_object_id`
- 파일 크기: ~29KB (매우 작음)

### 구현 작업

1. **metadata.ts** — `loadWaymoMetadata()`에서 `lidar_hkp` readAllRows()
   - frame×object별 Map 구성: `Map<bigint, KeypointObject[]>`
   - `KeypointObject = { objectId: string, joints: { type: number, x: number, y: number, z: number }[] }`
   - `keypointFrames: Set<number>` 구축 (Timeline 마커용)
2. **KeypointSkeleton.tsx** 신규 생성 (Three.js)
   - Input: `KeypointObject[]` (현재 프레임의 모든 pedestrian keypoints)
   - 관절: `<mesh><sphereGeometry args={[0.08, 8, 8]} />` (8cm 반지름)
   - 뼈대: `<Line points={[jointA, jointB]} lineWidth={2} />` (drei Line)
   - `WAYMO_SKELETON_BONES`에서 bone 연결 정의 읽기 (이미 완료)
3. **색상 매칭**: `laser_object_id` → BoundingBoxes 컴포넌트의 tracking color 동기화
   - 현재 BoundingBoxes는 box type 기반 색상 (Vehicle=orange, Pedestrian=lime 등)
   - keypoint는 pedestrian만이므로 lime (#CCFF00) 고정 or tracking ID 기반 개별 색상
   - **결정 필요**: type 기반 (단순) vs tracking ID 기반 (구분 가능하지만 palette 필요)
   - **권장**: type 기반 lime 고정 — keypoint 간 구분은 위치로 충분, 색상 복잡도 낮춤
4. **world mode**: `showKeypoints && worldMode` → 각 joint 좌표에 `poseByFrameIndex` 적용
5. **LidarViewer.tsx** — BoxMode 패널 옆에 skeleton 토글:
   - `[Off] [Boxes] [Models]  ·  [Skeleton ☐]`
   - BoxMode와 독립 (동시 표시 가능)
6. **Timeline.tsx** — `keypointFrames` 마커 활성화

### Acceptance Criteria

- [ ] showKeypoints ON + 현재 프레임에 keypoint 데이터 → 14-joint skeleton이 각 pedestrian 위에 렌더링
- [ ] skeleton 관절이 정확한 3D 위치에 배치됨 (bounding box 내부에 위치)
- [ ] bone line이 `WAYMO_SKELETON_BONES` 정의에 따라 올바르게 연결됨
- [ ] world mode에서 skeleton이 world 좌표에 올바르게 변환됨
- [ ] showKeypoints ON + 현재 프레임에 keypoint 없음 → 아무것도 렌더링하지 않음 (에러 없음)
- [ ] `lidar_hkp` parquet 없음 → skeleton 토글 UI 자체 숨김
- [ ] Timeline에 keypoint 프레임 마커(lime dots) 표시 (showKeypoints 활성 시에만)
- [ ] 성능: 10명 pedestrian × 14 joints = 140 sphere + ~120 line → 렌더 시간 +2ms 이내
- [ ] Vitest: KeypointSkeleton 유닛 테스트 (joint 위치, bone 연결, empty data)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| joint `.type` 값이 0-indexed vs 1-indexed 불확실 | joint 순서 뒤바뀜 → 잘못된 bone 연결 | 첫 세그먼트 로딩 후 콘솔에 type 값 출력하여 검증 |
| object가 keypoint 14개 미만일 수 있음 (가려진 관절) | bone line이 끊어지거나 NaN 좌표 | joint 존재 여부 체크 후 bone 렌더링 skip |
| tracking color 동기화 방식 미확정 | 설계 변경 시 BoundingBoxes 수정 필요 | Phase B2 시작 전 결정하고 착수 |
| 많은 pedestrian (>20) 시 sphere/line 수 폭발 | 프레임 드랍 | InstancedMesh로 관절 일괄 렌더링 (sphere batch) |

**예상 소요**: 2–3시간

---

## Phase C1: camera_hkp — 2D Camera Keypoints (14 joints)

**선행 의존성**: Phase B2 (skeleton 정의 공유, showKeypoints 토글 상태)
**후행 의존성**: 없음

### 데이터 형식

per-object 2D keypoint 좌표
- 컬럼: `[CameraKeypointComponent].keypoint_2d.location_px.{x,y}`, `.type`, `.is_occluded`
- 키: `key.frame_timestamp_micros`, `key.camera_name`, `key.camera_object_id`
- 파일 크기: ~116KB

### 구현 작업

1. **metadata.ts** — `loadWaymoMetadata()`에서 `camera_hkp` readAllRows()
   - `Map<bigint, Map<number, CameraKeypointObject[]>>` (timestamp → camera_name → objects)
   - `CameraKeypointObject = { objectId: string, joints: { type: number, x: number, y: number, occluded: boolean }[] }`
2. **KeypointOverlay.tsx** 신규 생성 (SVG)
   - 기존 `BBoxOverlayCanvas`와 동일 패턴 (CameraPanel 내부)
   - 관절: `<circle r={3} />` (3px 반지름)
   - 뼈대: `<line strokeWidth={2} />` (2px)
   - occluded 관절: `opacity: 0.3` + `strokeDasharray: "3 2"` (점선)
3. **cross-modal hover 연동**:
   - `camera_object_id` → `assocCamToLaser` → `laser_object_id` 기존 Map 재사용
   - 2D keypoint hover → 3D skeleton highlight (store의 setHoveredBox 재활용)
4. **토글 연동**: `showKeypoints` 하나로 3D + 2D 동시 제어

### Acceptance Criteria

- [ ] showKeypoints ON + 현재 프레임 + 카메라 이미지 위에 → 2D skeleton 오버레이 표시
- [ ] occluded 관절은 반투명(0.3) + 점선으로 구분됨
- [ ] 5개 카메라 패널 각각에 해당 camera_name의 keypoint만 표시
- [ ] 2D keypoint 위에 호버 → 3D 씬의 대응 skeleton/bbox 하이라이트
- [ ] `camera_hkp` parquet 없음 → 2D keypoint 오버레이 숨김, 에러 없음
- [ ] showKeypoints OFF → 2D + 3D 모두 숨김
- [ ] Vitest: SVG 좌표 변환 테스트 (이미지 좌표 → 카메라 패널 좌표 스케일링)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| `camera_object_id`가 `assocCamToLaser`에 없는 경우 | hover 연동 실패 | null check — 연동 불가 시 hover 무시 (silent) |
| camera_hkp 프레임과 camera_image 프레임 불일치 | keypoint가 다른 프레임 이미지 위에 표시 | timestamp 매칭으로 확인, 불일치 시 skip |
| SVG element 수 폭증 (5cam × 10ped × 14joint × 2(circle+line)) | 카메라 패널 렌더 지연 | Canvas 2D로 전환 고려 (SVG 한계 시) |

**예상 소요**: 2–3시간

---

## Phase C2: camera_segmentation — Camera Panoptic Segmentation

**선행 의존성**: Phase A (store 플래그, Timeline 마커)
**후행 의존성**: 없음

### 데이터 형식

PNG-encoded uint16 이미지 (카메라 해상도와 동일)
- 컬럼: `[CameraSegmentationComponent].panoptic_label`, `...panoptic_label_divisor`
- 인코딩: `pixel_value = semantic_class * divisor + instance_id`
- 1Hz (10프레임당 1프레임만 존재)
- 파일 크기: ~2.3MB

### 구현 작업

1. **metadata.ts** — panoptic_label (PNG bytes) + divisor 읽기
   - `readAllRows()` → frame×camera별 `Map<bigint, Map<number, { panopticLabel: ArrayBuffer, divisor: number }>>`
   - `cameraSeg` 필드로 MetadataBundle에 저장
2. **CameraSegOverlay.tsx** 신규 생성 (Canvas 2D)
   - `UPNG.decode(buffer)` → uint16 배열 (depth=16 보존)
   - `semantic_class = pixel_value / divisor | 0`
   - `instance_id = pixel_value % divisor`
   - semantic class → `WAYMO_SEG_PALETTE` → RGBA canvas overlay
   - Alpha: 0.4 (반투명, 아래 카메라 이미지 보임)
3. **토글**: 카메라 패널에 독립 토글 버튼 (2D bbox, lidar overlay와 동시 ON 가능)
4. **메모리 관리**:
   - 현재 프레임의 5카메라 분만 디코딩하여 Canvas에 그리기 (~10MB)
   - 프레임 전환 시 이전 Canvas 클리어 (overlay canvas reuse)
   - PNG bytes 자체는 MetadataBundle에 캐싱 (2.3MB, 세그먼트 수명)
   - decoded RGBA는 캐싱하지 않음 (프레임 전환 시 재디코딩)
5. **Timeline.tsx** — camera seg 프레임 마커 활성화 (magenta dots)

### Acceptance Criteria

- [ ] camera seg overlay ON + 1Hz 프레임 → 5개 카메라 패널에 반투명 색상 오버레이 표시
- [ ] 색상이 WAYMO_SEG_PALETTE와 일치 (road=보라, vehicle=주황, pedestrian=연두 등)
- [ ] 비-1Hz 프레임 → overlay 비활성 (빈 캔버스, 토글은 보이되 "No data" 표시)
- [ ] `camera_segmentation` parquet 없음 → seg overlay 토글 자체 숨김
- [ ] 2D bbox overlay와 동시 ON 시 두 레이어 모두 정상 표시 (z-order: image > seg > bbox)
- [ ] divisor 값이 올바르게 적용됨 (semantic/instance 분리)
- [ ] 메모리: 프레임 전환 시 이전 decoded RGBA가 GC됨 (DevTools Memory snapshot 확인)
- [ ] Timeline에 camera seg 프레임 마커(magenta dots) 표시 (overlay 활성 시에만)
- [ ] 성능: UPNG.decode (1920×1280 uint16 PNG) **< 50ms** per camera
- [ ] Vitest: divisor 적용 로직 테스트 (다양한 divisor 값)

### Concerns & Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| ~~UPNG.decode가 uint16 depth를 지원하지 않을 수 있음~~ | ~~전체 pipeline 무용~~ | **✅ 해소: depth=16 정상, ~22ms/frame** |
| 5카메라 동시 디코딩 (~22ms × 5 = 110ms) | 프레임 전환 시 jank | requestIdleCallback 또는 1개씩 순차 디코딩 + progressive 표시 |
| metadata 전량 로딩 시 3MB PNG bytes가 메인 스레드에 축적 | GC pressure | **벤치마크: 39ms, 무시 가능**. ArrayBuffer로 저장, 세그먼트 전환 시 GC |
| divisor가 프레임별로 다를 수 있음 (세그먼트 내) | semantic/instance 잘못 분리 | per-row divisor 저장 (row-level, not segment-level) |
| 해상도 불일치: SIDE 카메라(1920×886) vs FRONT(1920×1280) | canvas 크기 하드코딩 시 깨짐 | manifest.cameraSensors에서 동적 해상도 읽기. **Spike 확인: FRONT=1920×1280, SIDE=1920×886** |
| `readAllRows()` 기본값이 BYTE_ARRAY를 String으로 변환 | PNG 바이너리 손상, 디코딩 실패 | **반드시 `utf8: false` 옵션 전달** (waymoCameraWorker 동일 패턴) |
| `UPNG.decode().data`에 scanline당 1 trailing byte 포함 | `data.byteLength = W×H×2 + H`, 순수 uint16 아님 | stride = `W × 2`로 H행 읽기, trailing bytes 무시. 또는 `data.slice(0, W*H*2)` |
| **Camera seg 클래스 체계가 LiDAR와 다름 (29 vs 23)** | 기존 `WAYMO_SEG_PALETTE` (23 entries) 사용 시 class 23-28 색상 없음 | **별도 `WAYMO_CAMERA_SEG_PALETTE` (29 entries) 정의 필요** (Phase A 선행작업에 추가) |

**예상 소요**: 3–4시간

---

## Phase D: Integration & Polish

**선행 의존성**: B1 + B2 + C1 + C2 모두 완료

### 작업 내용

1. **Cross-modal 통합 테스트**
   - 3D skeleton + 2D keypoint 동시 표시 시 hover 연동 정상 확인
   - segment colormap + camera seg overlay 동시 활성 시 시각적 일관성
   - 모든 feature ON + playback → 프레임 레이트 측정

2. **Edge case 소탕**
   - seg/hkp/camera_seg/camera_hkp 중 일부만 있는 세그먼트
   - 매우 많은 pedestrian (>30) 시 렌더 성능
   - 세그먼트 전환 시 이전 데이터 정리 (메모리 누수)
   - world mode ↔ vehicle mode 전환 중 keypoint 좌표 전환

3. **UI Polish**
   - 토글 버튼 레이아웃: 기존 frosted glass 패널에 자연스럽게 통합
   - 컨트롤이 너무 많아지면 접기/펼치기(collapse) 도입 검토
   - seg 모드에서 비-TOP 센서가 gray인 이유를 tooltip으로 설명

4. **성능 프로파일링**
   - Chrome DevTools Performance 탭으로 전체 pipeline 프로파일링
   - 메모리 스냅샷: 세그먼트 로딩 전 → 모든 feature ON → 세그먼트 전환 후
   - 목표: 추가 feature로 인한 메모리 증가 < 50MB, 프레임 레이트 유지 ≥ 30fps

5. **테스트 추가**
   - timestamp 매칭 유닛 테스트 (lidar_seg worker)
   - skeleton bone 연결 유닛 테스트
   - divisor 적용 유닛 테스트
   - 통합 테스트: store loadDataset() with seg/hkp 파일

### Acceptance Criteria

- [ ] 모든 feature (seg + hkp + camera_hkp + camera_seg) 동시 ON 시 정상 렌더링
- [ ] 198프레임 전체 playback 시 끊김 없음 (≥30fps, seg/hkp 프레임에서도)
- [ ] 세그먼트 전환 2회 반복 후 메모리가 단조 증가하지 않음
- [ ] 새 테스트 10개+ 추가, 전체 테스트 suite 통과
- [ ] seg/hkp 데이터 없는 nuScenes/AV2 세그먼트에서 regression 없음

**예상 소요**: 2–3시간

---

## 5. Camera RGB GPU 가속 (별도 이슈 권장)

Segmentation/keypoints와 무관한 독립 성능 최적화. WebGPU compute shader로 168K 포인트 projection + sampling 병렬화.

현재 JS 메인스레드 ~50ms → GPU ~1ms 기대. 단, WebGPU availability + WebGL fallback 등 복잡도가 높아 별도 작업으로 분리 권장.

상세 계획은 별도 문서로 이동 예정.

---

## 총 소요 시간 추정

| Phase | 작업 | 시간 |
|-------|------|------|
| A | Shared Infra | 2–3h |
| B1 | lidar_segmentation | 3–4h |
| B2 | lidar_hkp | 2–3h |
| C1 | camera_hkp | 2–3h |
| C2 | camera_segmentation | 3–4h |
| D | Integration & Polish | 2–3h |
| **Total** | | **14–20h** |

B1 ∥ B2 병렬 진행 시 크리티컬 패스: A → B2 → C1 → D = **8–12h**

---

## 파일 영향 범위

```
신규 파일:
  src/components/LidarViewer/KeypointSkeleton.tsx  — 3D skeleton 렌더러
✅ src/utils/waymoSemanticClasses.ts                — 23 클래스 팔레트 + 라벨 + keypoint/bone 정의 (완료)
  src/components/CameraPanel/CameraSegOverlay.tsx  — camera seg overlay 캔버스
  src/components/CameraPanel/KeypointOverlay.tsx   — 2D keypoint SVG overlay

수정 파일:
  src/workers/waymoLidarWorker.ts    — seg parquet 읽기 + per-point label 추출 (Phase B1)
  src/workers/types.ts               — WaymoLidarWorkerInit에 segUrl 추가 (Phase A)
  src/stores/useSceneStore.ts        — has* 플래그 + *Frames: Set<number> + showKeypoints (Phase A)
  src/types/dataset.ts               — MetadataBundle optional 필드 추가 (Phase A)
  src/adapters/waymo/metadata.ts     — hkp + camera_hkp + camera_seg 메타 파싱 (Phase A)
  src/adapters/waymo/manifest.ts     — colormapModes에 'segment' 추가 (Phase A)
  src/components/LidarViewer/LidarViewer.tsx  — keypoint 토글 UI + segment 게이팅 (Phase A/B2)
  src/components/LidarViewer/PointCloud.tsx   — 비-TOP 센서 fallback 처리 (Phase B1)
  src/components/CameraPanel/CameraPanel.tsx  — 2D keypoint + seg overlay 통합 (Phase C1/C2)
  src/components/Timeline/Timeline.tsx        — sparse annotation 프레임 마커 (Phase A)

완료 파일 (변경 불필요):
✅ src/types/dataset.ts               — OverlayMode, AnnotationMode, manifest 확장
✅ src/types/upng-js.d.ts             — upng-js 타입 선언
✅ src/adapters/waymo/manifest.ts     — overlayModes, annotationModes, palette 연결
✅ src/adapters/nuscenes/manifest.ts  — overlayModes, annotationModes, palette 연결
✅ src/utils/colormaps.ts             — computePointColor() + instanceColor() palette 파라미터화 (4de9fc0)
✅ src/components/LidarViewer/PointCloud.tsx     — manifest.semanticPalette 전달 (4de9fc0)
✅ src/components/CameraPanel/LidarProjectionOverlay.tsx — manifest.semanticPalette 전달 (4de9fc0)
```

## Open Decisions — 확정 완료

| # | 결정사항 | 확정 | 근거 |
|---|---------|------|------|
| 1 | keypoint 색상 전략 | **(a) type 기반 lime 고정** | pedestrian만이므로 위치로 충분히 구분, 복잡도↓ |
| 2 | camera_seg 로딩 위치 | **(a) metadata에서 전량** | 벤치마크: 39ms, 전체 대비 8%. async 분리 불필요 |
| 3 | seg 없는 센서 시각적 처리 | **(a) gray + low opacity** | 센서 존재는 보이되 seg 없음을 시각적으로 구분 |
| 4 | UPNG uint16 사전 검증 | **✅ 검증 완료** | depth=16 정상, ~22ms/frame, `utf8:false` 필수 |
| 5 | Camera seg 팔레트 | **신규: 별도 29-class 팔레트** | LiDAR(23)와 Camera(29) 클래스 체계 다름. SKY, Ground Animal 등 camera-only 클래스 존재 |
