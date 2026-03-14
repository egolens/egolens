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

→ 새 데이터셋 추가할 때 manifest만 정의하면 UI가 자동으로 따라옴.
→ 같은 데이터셋이라도 세그먼트마다 데이터 유무가 다르면 store 플래그가 동적으로 반영.

---

## 1. lidar_segmentation — LiDAR 23클래스 Semantic Segmentation

**목표**: 컬러맵 모드에 `segment` 추가 (nuScenes처럼 포인트별 색상)

**데이터 형식**: range image와 동일 구조 `[H, W, 2]` — channel 0 = semantic class, channel 1 = instance ID
- 컬럼: `[LiDARSegmentationComponent].range_image_return1.values` + `.shape`
- 키: `key.frame_timestamp_micros`, `key.laser_name`
- 파일 크기: ~531KB (startup 로딩 가능)

**남은 구현 작업**:
1. `waymoLidarWorker.ts` — segmentation parquet을 worker init에서 열고, lidar RG 처리 시 동일 frame의 seg RG를 같이 읽음
   - **선결 확인**: lidar와 lidar_segmentation의 row group 구조가 동일한지 (같은 RG에 같은 프레임?)
   - 다르면 timestamp 기반 매칭 필요 → worker 로직 복잡도 증가
2. range image → point cloud 변환 과정에서 per-point label 추출 (range image 좌표 대응)
3. `PointCloud` 인터페이스의 `segLabels: Uint8Array`에 저장 (nuScenes와 동일 필드!)
4. ~~23클래스 컬러 팔레트 정의~~ → **완료** (`WAYMO_SEG_PALETTE` in `waymoSemanticClasses.ts`)
5. `computePointColor()` — manifest의 `semanticPalette`에서 팔레트 resolve하도록 수정 (현재 nuScenes `LIDARSEG_PALETTE` 하드코딩 제거)
6. `waymoManifest.colormapModes`에 `'segment'` 추가 — **단, store에서 실제 데이터 존재 확인 후 동적으로**

**Data-Driven UI**:
- segmentation parquet 없음 → `hasSegmentation = false` → colormap 선택지에서 'segment' 숨김
- 파일은 있지만 현재 프레임에 라벨 없음 → fallback colormap (intensity) 자동 전환
- 199프레임 중 ~10프레임만 라벨 있을 수 있음 (sparse annotation) → 라벨 있는 프레임만 segment 모드 활성
- **타임라인 마커**: 세그멘테이션 라벨이 존재하는 프레임 위치에 점(dot) 마커 표시
  - metadata 로딩 시 라벨 존재 프레임 인덱스 Set 구성 → store에 `segLabelFrames: Set<number>` 저장
  - Timeline 컴포넌트에서 scrubber 위에 작은 점으로 렌더링 (seg 컬러맵 활성일 때만)

**주의사항**:
- segmentation은 일부 세그먼트에만 존재
- instance ID (channel 1)는 panoptic 모드용 — segment 모드에서는 semantic만 사용

---

## 2. camera_segmentation — Camera Panoptic Segmentation

**목표**: 카메라 패널 위에 반투명 세그멘테이션 오버레이

**데이터 형식**: PNG-encoded uint16 이미지 (카메라 해상도와 동일)
- 컬럼: `[CameraSegmentationComponent].panoptic_label`, `...panoptic_label_divisor`
- 인코딩: `pixel_value = semantic_class * divisor + instance_id`
- 1Hz (10프레임당 1프레임만 존재)
- 파일 크기: ~2.3MB

**남은 구현 작업**:
1. metadata에서 panoptic_label (PNG bytes) + divisor 읽기
2. ~~PNG 디코딩 라이브러리~~ → **완료** (`upng-js` 설치 + 타입 선언)
3. `UPNG.decode(buffer)` → uint16 배열 → semantic/instance 분리 (`depth=16` 보존)
4. `CameraPanel` 컴포넌트에 segmentation overlay 캔버스 추가
5. 토글 버튼으로 on/off (2D bbox와 동시 표시 가능하지만 시각적으로 복잡)
6. ~~같은 23 클래스 팔레트~~ → **완료** (manifest의 `semanticPalette`에서 resolve)

**Data-Driven UI**:
- camera_segmentation parquet 없음 → `hasCameraSegmentation = false` → 오버레이 토글 자체 숨김
- 2D bbox / segmentation overlay / LiDAR overlay 는 독립 토글 (동시 on 가능)
- 현재 프레임에 seg 데이터 없음 (1Hz sparse) → 오버레이 자동 비활성 (토글은 보이되 비어있음)
- **타임라인 마커**: camera seg 라벨 존재 프레임에 점 마커 (lidar seg과 동일 패턴, 색상 구분)

**주의사항**:
- divisor 값이 세그먼트마다 다를 수 있음
- **메모리**: 5카메라 × 1920×1280 × RGBA overlay Canvas → ~49MB. 캐싱 전략 필요 (현재 프레임 + 인접 1Hz 프레임만 유지)

---

## 3. lidar_hkp — 3D Human Keypoints (14 joints)

**목표**: 3D 씬에 사람 관절 위치를 sphere + bone line으로 렌더링

**데이터 형식**: per-object keypoint 좌표
- 컬럼: `[LiDARKeypointComponent].keypoint.location_m.{x,y,z}`, `.type` (int8)
- 키: `key.frame_timestamp_micros`, `key.laser_object_id`
- 파일 크기: ~29KB (매우 작음)

**남은 구현 작업**:
1. `metadata.ts` — keypoint parquet 파싱 → frame별 Map 구성
2. `KeypointSkeleton.tsx` 컴포넌트 생성 (Three.js sphere + line)
   - ~~Skeleton bone 정의~~ → **완료** (`WAYMO_SKELETON_BONES` in `waymoSemanticClasses.ts`)
   - ~~14 keypoint types~~ → **완료** (`WAYMO_KEYPOINT_TYPES`)
3. 바운딩 박스 모드 옆에 keypoint 토글 추가 (BoxMode와 독립)
4. `laser_object_id`로 바운딩 박스와 매칭 → 같은 트래킹 컬러 사용
5. world mode에서는 vehicle_pose 적용

**Data-Driven UI**:
- lidar_hkp parquet 없음 → `hasKeypoints = false` → keypoint 토글 숨김
- boxMode 패널에 keypoint 토글 추가 (BoxMode와 독립, 동시 표시 가능)
- `[Off] [Boxes] [Models]` 옆에 `[Skeleton]` 토글 별도
- **타임라인 마커**: keypoint 데이터 존재 프레임에 점 마커 표시

---

## 4. camera_hkp — 2D Camera Keypoints (14 joints)

**목표**: 카메라 패널 위에 SVG로 2D 관절 + 뼈대 렌더링

**데이터 형식**: per-object 2D keypoint 좌표
- 컬럼: `[CameraKeypointComponent].keypoint_2d.location_px.{x,y}`, `.type`, `.is_occluded`
- 키: `key.frame_timestamp_micros`, `key.camera_name`, `key.camera_object_id`
- 파일 크기: ~116KB

**남은 구현 작업**:
1. metadata 로딩 시 파싱 → frame × camera별 Map
2. `CameraPanel`의 기존 SVG 오버레이 (2D bbox)에 keypoint 렌더링 추가
3. 관절: 작은 원(r=3px), 뼈대: 선(stroke-width=2px)
   - ~~Skeleton bone 정의~~ → **완료** (lidar_hkp와 공유)
4. occluded 관절은 투명도 낮추거나 점선
5. `camera_object_id` → `camera_to_lidar_box_association` → 3D bbox와 hover 연동
6. lidar_hkp 토글과 연동 (3D keypoints on → 2D도 자동 on)

**Data-Driven UI**:
- camera_hkp parquet 없음 → 2D keypoint 오버레이 숨김
- lidar_hkp 토글과 연동: 하나의 `showKeypoints` 상태로 3D+2D 동시 제어

---

## 5. Camera RGB GPU 가속 (별도 이슈 권장)

Segmentation/keypoints와 무관한 독립 성능 최적화. WebGPU compute shader로 168K 포인트 projection + sampling 병렬화.

현재 JS 메인스레드 ~50ms → GPU ~1ms 기대. 단, WebGPU availability + WebGL fallback 등 복잡도가 높아 별도 작업으로 분리 권장.

상세 계획은 별도 문서로 이동 예정.

---

## 구현 순서 (권장)

```
✅ 0. 선행작업 (완료)        — DatasetManifest 확장, palette, upng-js, 타입 선언
→ 1. lidar_segmentation     — worker 확장 + computePointColor palette resolve
→ 2. lidar_hkp              — metadata 파싱 + KeypointSkeleton.tsx
→ 3. camera_hkp             — SVG overlay (skeleton 정의 공유)
→ 4. camera_segmentation    — UPNG.decode + overlay canvas + 메모리 관리
   5. camera RGB GPU 가속    — 별도 이슈
```

## 파일 영향 범위

```
신규 파일:
  src/components/LidarViewer/KeypointSkeleton.tsx  — 3D skeleton 렌더러
✅ src/utils/waymoSemanticClasses.ts                — 23 클래스 팔레트 + 라벨 + keypoint/bone 정의 (완료)
  src/components/CameraPanel/CameraSegOverlay.tsx  — camera seg overlay 캔버스
  src/components/CameraPanel/KeypointOverlay.tsx   — 2D keypoint SVG overlay

수정 파일:
  src/workers/waymoLidarWorker.ts    — seg parquet 읽기 + per-point label 추출
  src/workers/types.ts               — worker 메시지 프로토콜 확장 (seg File 전달)
  src/stores/useSceneStore.ts        — has* 플래그 + *LabelFrames: Set<number> + showKeypoints
  src/utils/colormaps.ts             — computePointColor()에서 manifest palette resolve
  src/adapters/waymo/metadata.ts     — hkp + seg 메타 파싱
  src/components/LidarViewer/LidarViewer.tsx  — keypoint 토글 UI
  src/components/CameraPanel/CameraPanel.tsx  — 2D keypoint + seg overlay
  src/components/Timeline/Timeline.tsx        — sparse annotation 프레임 마커

완료 파일 (변경 불필요):
✅ src/types/dataset.ts               — OverlayMode, AnnotationMode, manifest 확장
✅ src/types/upng-js.d.ts             — upng-js 타입 선언
✅ src/adapters/waymo/manifest.ts     — overlayModes, annotationModes, palette 연결
✅ src/adapters/nuscenes/manifest.ts  — overlayModes, annotationModes, palette 연결
```
