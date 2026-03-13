# Multi-Dataset Refactoring Plan

**Date:** 2026-03-13
**Goal:** nuScenes 데이터셋 지원을 시작으로, 향후 KITTI / Argoverse 등으로 확장 가능한 데이터셋-독립적 아키텍처를 만든다.
**Approach:** 기존 Waymo 파이프라인을 깨뜨리지 않으면서 점진적으로 추상화 레이어를 추출한다.

---

## 1. 현재 아키텍처의 Waymo 커플링 분석

코드베이스 전체를 조사하여 Waymo 전용 의존성을 3개 레이어로 분류했다.

### Layer 1 — 데이터 포맷 (깊은 커플링, 변경 비용 높음)

| 파일 | 커플링 포인트 | 설명 |
|---|---|---|
| `workers/dataWorker.ts:104-109` | `LIDAR_COLUMNS` 배열 | Waymo Parquet 컬럼명 하드코딩: `[LiDARComponent].range_image_return1.*` |
| `workers/dataWorker.ts:192-198` | range image 파싱 | `shape` + `values`를 `RangeImage` 타입으로 조립 → `convertAllSensors()` 호출 |
| `workers/cameraWorker.ts` | 카메라 JPEG 추출 | `[CameraImageComponent].image` 컬럼에서 JPEG bytes 추출 |
| `utils/rangeImage.ts` | spherical→cartesian 변환 | Waymo 전용 range image 포맷. nuScenes/KITTI에는 존재하지 않는 연산 |
| `stores/useSceneStore.ts:876-1030` | `loadStartupData()` | 20+ Waymo Parquet 컬럼명 직접 참조 (포즈, 캘리브, 박스, 어소시에이션, 통계) |

### Layer 2 — 센서 구성 (중간 커플링, 변경 비용 중간)

| 파일 | 커플링 포인트 | 설명 |
|---|---|---|
| `types/waymo.ts:7-13` | `LidarName` enum | 5개 센서 (TOP, FRONT, SIDE_LEFT, SIDE_RIGHT, REAR) |
| `types/waymo.ts:17-23` | `CameraName` enum | 5개 카메라 (FRONT, FRONT_LEFT, FRONT_RIGHT, SIDE_LEFT, SIDE_RIGHT) |
| `types/waymo.ts:27-33` | `BoxType` enum | 5개 타입 (UNKNOWN, VEHICLE, PEDESTRIAN, SIGN, CYCLIST) |
| `types/waymo.ts:49-55` | `CAMERA_RESOLUTION` | 카메라별 해상도 (1920×1280 / 1920×886) |
| `stores/useSceneStore.ts:774` | `visibleSensors` 초기값 | `new Set([1, 2, 3, 4, 5])` 하드코딩 |
| `stores/useSceneStore.ts:725-728` | `components` 배열 | 9개 Waymo 컴포넌트명 + `/waymo_data/` 경로 |

### Layer 3 — UI 레이블 (얕은 커플링, 변경 비용 낮음)

| 파일 | 커플링 포인트 | 설명 |
|---|---|---|
| `components/LidarViewer/LidarViewer.tsx:39-45` | 센서 토글 UI | 5개 Waymo 센서 이름이 레이블로 표시 |
| `components/CameraPanel/CameraPanel.tsx:22-28` | 카메라 패널 배치 | 5카메라 서라운드 뷰 레이아웃 |
| `App.tsx` | 타이틀, 다운로드 안내 | "for Waymo Open Dataset", gsutil 명령어 |

### 이미 제네릭인 코드 (변경 불필요)

| 코드 | 이유 |
|---|---|
| `PointCloud.tsx`, `BoundingBoxes.tsx`, `CameraFrustums.tsx` | `Float32Array`, `ParquetRow[]`만 소비 — 데이터 출처 무관 |
| `workerPool.ts`, `cameraWorkerPool.ts` | 메시지 프로토콜 기반 — 어떤 워커든 관리 가능 |
| `FrameData` 타입 | 센서 ID가 `number`로 추상화, `Map<number, PointCloud>` |
| Timeline, 플레이백 로직 | 프레임 인덱스 기반, 데이터셋과 무관 |
| 4×4 행렬 연산 (world mode, trails) | 수학은 데이터셋 독립적 |
| `memoryLogger.ts`, `MemoryOverlay.tsx` | 완전 범용 인프라 |

---

## 2. Waymo vs nuScenes 데이터 비교

v1.0-mini 실물 데이터 조사를 기반으로 한 비교.

### 센서 구성

| | Waymo | nuScenes |
|---|---|---|
| LiDAR | 5대 (64빔 TOP + 4× short-range) | **1대** (Velodyne HDL-32E, 32빔) |
| 카메라 | 5대 (1920×1280/886) | **6대** (1600×900, 360° 커버) |
| 레이더 | 없음 | **5대** (PCD v0.7, ~125 pts/sweep) |
| Keyframe 빈도 | 10 Hz | **2 Hz** |

### 데이터 포맷

| | Waymo | nuScenes |
|---|---|---|
| 메타데이터 | Parquet columnar | **JSON 관계형 DB** (13 테이블, token-linked) |
| LiDAR 저장 | Parquet → range image (spherical) | **`.pcd.bin`** (flat float32: x,y,z,intensity,ring) |
| LiDAR 파싱 비용 | sin/cos + matrix (~4초/RG) | **`new Float32Array(buf)`** (~0ms) |
| LiDAR 포인트 수 | ~168K/frame (5 sensors) | **~34K/frame** (1 sensor) |
| 카메라 저장 | Parquet column (JPEG bytes) | **개별 `.jpg` 파일** |
| Ego pose | Parquet column (4×4 matrix) | **JSON** (quaternion + translation) |
| 박스 좌표계 | vehicle-frame | **global-frame** (→ vehicle 변환 필요) |
| 박스 카테고리 | 5 int enum | **23 string hierarchy** (e.g. `vehicle.car`) |
| 프레임 인덱싱 | bigint timestamp | **token linked list** (sample.next/prev) |
| Scene 간 데이터 | 세그먼트별 독립 Parquet | **파일 독립, JSON 공유** (scene_token으로 필터) |

### 메모리 프로파일 (1 scene 기준)

| | Waymo (199 frames) | nuScenes (~40 keyframes) |
|---|---|---|
| LiDAR 캐시 | 775 MB (slice 수정 후) | **~27 MB** (34K × 20B × 40) |
| 카메라 캐시 | 310 MB | **~34 MB** (6cam × 140KB × 40) |
| 메타데이터 JSON | N/A (Parquet) | **~33 MB** (mini) / ~400 MB (trainval) |
| **합계** | **~1,085 MB** | **~94 MB** |

---

## 3. 목표 아키텍처: DatasetAdapter 패턴

```
┌──────────────────────────────────────────────────────────────────┐
│                         App / UI Layer                          │
│  LidarViewer, CameraPanel, Timeline, BoundingBoxes              │
│  ← manifest.lidarSensors, manifest.cameraSensors로 동적 구성    │
└───────────────────────────┬──────────────────────────────────────┘
                            │ FrameData (동일 인터페이스)
┌───────────────────────────┴──────────────────────────────────────┐
│                        useSceneStore                             │
│  loadDataset() → adapter.detect() → adapter.loadMetadata()      │
│  프레임 캐시, 플레이백, world mode ← 데이터셋 무관               │
└───────────────┬──────────────────────────────────┬───────────────┘
                │                                  │
    ┌───────────┴───────────┐          ┌───────────┴───────────┐
    │    LiDAR WorkerPool   │          │   Camera WorkerPool   │
    │  adapter.createLidar  │          │  adapter.createCamera  │
    │  Worker()             │          │  Worker()             │
    └───────────┬───────────┘          └───────────┬───────────┘
                │                                  │
    ┌───────────┴───────────┐          ┌───────────┴───────────┐
    │  WaymoLidarWorker     │          │  WaymoCameraWorker    │
    │  (Parquet→rangeImg    │          │  (Parquet→JPEG)       │
    │   →cartesian)         │          │                       │
    ├───────────────────────┤          ├───────────────────────┤
    │  NuScenesLidarWorker  │          │  NuScenesCameraWorker │
    │  (.pcd.bin→Float32)   │          │  (.jpg file→ArrayBuf) │
    └───────────────────────┘          └───────────────────────┘
```

### 핵심 인터페이스

```typescript
// src/types/dataset.ts (신규)

interface DatasetManifest {
  id: string                           // 'waymo' | 'nuscenes'
  name: string                         // 표시명
  lidarSensors: SensorDef[]            // [{id: 1, name: 'TOP', ...}]
  cameraSensors: CameraSensorDef[]     // [{id: 1, name: 'FRONT', width, height}]
  boxTypes: BoxTypeDef[]               // [{id: 1, label: 'Vehicle', color: '#FF9E00'}]
  frameRate: number                    // 10 (Waymo) | 2 (nuScenes keyframe)
  hasRadar: boolean
}

interface SensorDef {
  id: number
  name: string
}

interface CameraSensorDef extends SensorDef {
  width: number
  height: number
}

interface BoxTypeDef {
  id: number
  label: string
  color: string
}

interface MetadataBundle {
  timestamps: bigint[]                              // 정렬된 프레임 타임스탬프
  poses: Map<bigint, number[]>                      // ts → 4x4 row-major matrix
  lidarCalibrations: Map<number, LidarCalibration>  // sensorId → calib
  cameraCalibrations: CameraCalibration[]
  boxes3D: Map<bigint, ParquetRow[]>                // ts → boxes (통일된 필드명)
  boxes2D: Map<bigint, ParquetRow[]>                // ts → camera boxes
  associations: {
    camToLaser: Map<string, string>
    laserToCams: Map<string, Set<string>>
  }
  trajectories: Map<string, TrajectoryPoint[]>
  segmentMeta?: SegmentMeta
}

interface DatasetAdapter {
  /** 파일/폴더 구조로 이 데이터셋인지 감지 */
  detect(files: Map<string, File | string>): boolean

  /** 센서 구성, 박스 타입 등 정적 매니페스트 반환 */
  getManifest(): DatasetManifest

  /** Scene/Segment 목록 반환 */
  discoverScenes(files: Map<string, File | string>): Promise<SceneInfo[]>

  /** 메타데이터 로드 (포즈, 캘리브, 박스 등) */
  loadMetadata(
    files: Map<string, File | string>,
    sceneId: string,
  ): Promise<MetadataBundle>

  /** 데이터셋 전용 LiDAR 워커 URL 반환 */
  createLidarWorkerUrl(): string

  /** LiDAR 워커 초기화 메시지 생성 */
  buildLidarWorkerInit(
    files: Map<string, File | string>,
    calibrations: Map<number, LidarCalibration>,
    workerIndex: number,
  ): object

  /** 데이터셋 전용 카메라 워커 URL 반환 */
  createCameraWorkerUrl(): string

  /** 카메라 워커 초기화 메시지 생성 */
  buildCameraWorkerInit(
    files: Map<string, File | string>,
    workerIndex: number,
  ): object
}
```

### 워커 출력 프로토콜 (통일)

LiDAR와 카메라 워커의 출력 타입은 이미 제네릭에 가깝다. 이것은 변경하지 않는다:

```typescript
// 이미 존재하는 타입 — 그대로 유지
interface SensorCloudResult {
  laserName: number         // 센서 ID (데이터셋마다 다른 번호 체계)
  positions: Float32Array   // [x,y,z,intensity,range,elongation, ...]
  pointCount: number
}

interface FrameResult {
  timestamp: string
  sensorClouds: SensorCloudResult[]
  convertMs: number
}
```

nuScenes 워커는 동일한 `FrameResult`를 반환하되, `positions`의 stride가 다를 수 있다:
- Waymo: stride 6 (x, y, z, intensity, range, elongation)
- nuScenes: stride 5 (x, y, z, intensity, ring)

→ `POINT_STRIDE`를 manifest에서 가져오거나, 최소 공통 stride (x,y,z,intensity = 4)를 정의한다.

---

## 4. 구현 로드맵 (5 Phases)

### Phase 0 — 타입 정의 + 자동 감지 (Half Day)

**변경 범위:** 신규 파일만, 기존 코드 변경 없음

1. `src/types/dataset.ts` 생성 — 위의 인터페이스 정의
2. `src/adapters/registry.ts` 생성 — 어댑터 레지스트리 + `detectDataset()` 함수
3. `src/adapters/waymo/manifest.ts` 생성 — 현재 `waymo.ts`의 센서 정의를 `DatasetManifest`로 래핑

**자동 감지 로직:**
```typescript
// Waymo: *.parquet 파일에 lidar/, camera_image/ 등의 컴포넌트 폴더
// nuScenes: v1.0-*/ 폴더 + samples/ + sweeps/ + *.json 메타데이터
function detectDataset(files: Map<string, File | string>): DatasetAdapter
```

**검증:** 기존 Waymo 로딩이 깨지지 않음을 확인 (기존 테스트 27개 통과)

### Phase 1 — UI 제네릭화 (1 Day)

**변경 범위:** UI 컴포넌트 + Store 일부

1. `LidarViewer.tsx` — 하드코딩된 5 센서 → `manifest.lidarSensors`에서 동적 생성
2. `CameraPanel.tsx` — 하드코딩된 5 카메라 → `manifest.cameraSensors`에서 동적 레이아웃
3. `useSceneStore.ts` — `visibleSensors` 초기값을 manifest에서 파생
4. `App.tsx` — 데이터셋 이름 표시, 다운로드 안내를 adapter에서 제공

**핵심 원칙:** manifest가 센서 목록을 제공하면 UI가 자동으로 적응한다.

**레이아웃 전략:** 카메라 패널은 카메라 수에 따라:
- 5개 (Waymo): 현재 1행 5열
- 6개 (nuScenes): 2행 3열 (front 3 + rear 3) 또는 1행 6열
- 유연하게: `manifest.cameraSensors.length`에 따른 CSS grid

### Phase 2 — MetadataLoader 추출 (1-2 Days)

**변경 범위:** Store의 `loadStartupData()` 리팩토링

현재 `loadStartupData()`는 875-1030번째 줄에서 Waymo Parquet 컬럼을 20개 이상 직접 참조한다. 이것을 `adapter.loadMetadata()`로 추출한다.

**Waymo adapter:**
```
vehicle_pose parquet     → poses: Map<bigint, number[]>         (4×4 matrix 그대로)
lidar_calibration parquet → lidarCalibrations: Map<number, LC>   (parseLidarCalibration 유지)
lidar_box parquet        → boxes3D: Map<bigint, Row[]>          (컬럼명만 정규화)
camera_box parquet       → boxes2D: Map<bigint, Row[]>
association parquet      → associations
stats parquet            → segmentMeta
```

**nuScenes adapter:**
```
ego_pose.json            → poses: Map<bigint, number[]>         (quat→4×4 변환)
calibrated_sensor.json   → lidarCalibrations + cameraCalibrations (quat→4×4 + intrinsic)
sample_annotation.json   → boxes3D: Map<bigint, Row[]>          (global→vehicle 변환)
                           boxes2D: 없음 (nuScenes에 2D box 없음)
                           associations: 없음
scene.json + sample.json → timestamps (linked list → sorted array)
category.json + instance → boxType 매핑 (string hierarchy → int)
```

**nuScenes 특수 변환:**

1. **Quaternion → 4×4 matrix:** ego_pose와 calibrated_sensor 모두 quaternion(w,x,y,z) + translation(x,y,z)을 사용. 4×4 row-major matrix로 변환하는 유틸 필요.

2. **Global → vehicle frame 박스:** nuScenes annotation은 global 좌표계. 렌더러는 vehicle frame을 기대하므로 `inv(ego_pose) × annotation_pose` 변환 필요.

3. **Category hierarchy → BoxType int:** `human.pedestrian.*` → PEDESTRIAN, `vehicle.*` → VEHICLE 등의 매핑 테이블.

**Store 변경:** `loadStartupData()` → `adapter.loadMetadata()` 호출 후 결과를 동일한 internal 구조에 저장. 나머지 Store 로직(캐싱, 플레이백, world mode)은 변경 없음.

### Phase 3 — LiDAR Worker 추상화 (2-3 Days, 핵심)

**변경 범위:** Worker 생성 로직 + nuScenes용 신규 Worker

이것이 가장 큰 변경이다. 현재 `dataWorker.ts`는 Parquet I/O + range image 변환이 결합되어 있다.

**구조 변경:**

```
src/workers/
├── dataWorker.ts           → waymoLidarWorker.ts (이름 변경, 내용 유지)
├── nuScenesLidarWorker.ts  (신규)
├── workerPool.ts           (변경 없음 — 이미 제네릭)
├── cameraWorker.ts         → waymoCameraWorker.ts (이름 변경)
├── nuScenesCameraWorker.ts (신규)
└── cameraWorkerPool.ts     (변경 없음)
```

**nuScenesLidarWorker 구현:**

nuScenes LiDAR는 이미 xyz 좌표이므로 worker가 극도로 단순해진다:

```typescript
// 핵심 로직 — Waymo의 4초 변환 대신 ~0ms
async function loadFrame(filePath: string): SensorCloudResult {
  const buffer = await fetch(filePath).then(r => r.arrayBuffer())
  const floats = new Float32Array(buffer)
  const pointCount = floats.length / 5  // x,y,z,intensity,ring
  return { laserName: 1, positions: floats, pointCount }
}
```

**nuScenesCameraWorker 구현:**

개별 `.jpg` 파일을 `ArrayBuffer`로 읽기만 하면 된다. Parquet 디컴프레션이 없으므로 역시 단순.

**WorkerPool 변경:**

`WorkerPool.init()`이 현재 worker URL을 하드코딩. `adapter.createLidarWorkerUrl()`에서 URL을 받도록 변경.

```typescript
// 현재
const worker = new Worker(new URL('../workers/dataWorker.ts', import.meta.url))

// 변경 후
const workerUrl = adapter.createLidarWorkerUrl()
const worker = new Worker(workerUrl)
```

**Row Group vs File-per-Frame:**

Waymo는 row group 단위(~51 frames/RG), nuScenes는 file-per-frame. 워커의 메시지 프로토콜을 통일해야 한다:

| | Waymo Worker | nuScenes Worker |
|---|---|---|
| Init | Parquet URL + calibrations | base URL + file list |
| Request | `loadRowGroup(rgIndex)` | `loadFrameBatch(fileList)` |
| Response | `FrameResult[]` (동일) | `FrameResult[]` (동일) |

WorkerPool이 `requestRowGroup(index)`를 호출하는 현재 패턴을 `requestBatch(index)` 같은 범용 이름으로 변경하고, 어댑터가 배치 전략을 결정하게 한다.

### Phase 4 — nuScenes Adapter 통합 테스트 (1 Day)

**변경 범위:** 테스트 + 통합

1. v1.0-mini 데이터로 end-to-end 테스트
2. 10 scenes 모두 로딩 확인
3. 메모리 프로파일링 (memoryLogger 재활용)
4. 기존 Waymo 27개 테스트 regression 확인
5. scene 간 전환 테스트

**예상 결과:**
- Scene 로딩: JSON 파싱 ~500ms + 파일 fetch ~200ms (mini 기준)
- 메모리: ~94 MB per scene (vs Waymo 1,085 MB)
- LiDAR 워커 시간: Parquet 디컴프레션 없음, 변환 없음 → <100ms

---

## 5. nuScenes 전용 구현 상세

### 5.1 JSON 메타데이터 로딩 전략

v1.0-mini JSON 파일 크기:
- `sample_data.json`: 15.9 MB (31,206 entries)
- `sample_annotation.json`: 9.3 MB (18,538 entries)
- `ego_pose.json`: 7.6 MB (31,206 entries)
- 나머지: <1 MB 합산

**전략:** 전체 JSON을 한 번 파싱하고, scene_token으로 필터링하여 인메모리 인덱스 구축. Full trainval (~400 MB)에서도 `JSON.parse()`는 2-3초면 충분하고, 이후 scene 전환은 필터링만 하면 되므로 즉시.

```
로드 시점:
1. sensor.json, calibrated_sensor.json, category.json → 작음, 즉시 파싱
2. scene.json, sample.json → scene 목록 구축
3. ego_pose.json, sample_data.json → 대형, 한 번 파싱 → token 기반 Map 구축
4. sample_annotation.json → 한 번 파싱 → sample_token 기반 Map 구축

Scene 선택 시:
1. scene.first_sample_token에서 linked list 순회 → sample tokens 수집
2. sample_data에서 해당 samples의 센서 파일 경로 추출
3. ego_pose에서 해당 timestamps의 포즈 추출
4. annotations에서 해당 samples의 박스 추출 + category 매핑
```

### 5.2 좌표계 변환

**Ego pose (quaternion → 4×4):**
```
입력: translation [x, y, z], rotation [w, x, y, z] (스칼라 first)
출력: 4×4 row-major matrix
```

기존 `invertRowMajor4x4()`, `multiplyRowMajor4x4()`를 그대로 활용. 쿼터니언→회전행렬 변환 유틸만 추가.

**Box 좌표 변환:**

nuScenes annotation은 global frame. vehicle frame으로 변환:
```
box_vehicle = inv(ego_pose) × box_global
```

이 변환은 Waymo의 world mode에서 이미 하는 `inv(pose₀) × poseₙ` 패턴과 동일.

### 5.3 카테고리 매핑

nuScenes의 23 카테고리 → 렌더러의 BoxType int:

```typescript
const NUSCENES_CATEGORY_MAP: Record<string, number> = {
  // Vehicle types
  'vehicle.car': 1,
  'vehicle.truck': 1,
  'vehicle.bus.bendy': 1,
  'vehicle.bus.rigid': 1,
  'vehicle.construction': 1,
  'vehicle.emergency.ambulance': 1,
  'vehicle.emergency.police': 1,
  'vehicle.trailer': 1,
  'vehicle.motorcycle': 4,      // → CYCLIST (closest match)
  'vehicle.bicycle': 4,         // → CYCLIST

  // Pedestrian types
  'human.pedestrian.adult': 2,
  'human.pedestrian.child': 2,
  'human.pedestrian.wheelchair': 2,
  'human.pedestrian.stroller': 2,
  'human.pedestrian.personal_mobility': 2,
  'human.pedestrian.police_officer': 2,
  'human.pedestrian.construction_worker': 2,

  // Other
  'animal': 0,                  // → UNKNOWN
  'movable_object.barrier': 0,
  'movable_object.trafficcone': 3,  // → SIGN (closest visual match)
  'movable_object.pushable_pullable': 0,
  'movable_object.debris': 0,
  'static_object.bicycle_rack': 0,
}
```

### 5.4 Sweep 지원 (Phase 4+, 선택적)

nuScenes keyframe은 2Hz지만, sweep (중간 프레임)을 포함하면 LiDAR 20Hz, 카메라 12Hz까지 올라간다. 초기 구현은 keyframe만 지원하고, sweep은 향후 옵션으로:

- `sample_data.json`에서 `is_key_frame: false`인 entries = sweep
- sweep에는 annotation이 없음 (보간 필요)
- 워커가 sweep 파일도 batch로 로드 가능 (같은 `.pcd.bin` 포맷)

---

## 6. 폴더 구조 변경안

```
src/
├── types/
│   ├── waymo.ts          (유지 — Waymo 전용 상수/타입)
│   └── dataset.ts        (신규 — 공통 인터페이스)
├── adapters/
│   ├── registry.ts       (신규 — detectDataset, 어댑터 등록)
│   ├── waymo/
│   │   ├── manifest.ts   (waymo.ts에서 추출한 manifest)
│   │   ├── adapter.ts    (DatasetAdapter 구현)
│   │   └── metadata.ts   (loadStartupData에서 추출한 Parquet 파싱)
│   └── nuscenes/
│       ├── manifest.ts   (센서 정의, 카테고리 매핑)
│       ├── adapter.ts    (DatasetAdapter 구현)
│       ├── metadata.ts   (JSON 파싱 + 좌표 변환)
│       └── quaternion.ts (quat→matrix 유틸)
├── workers/
│   ├── waymoLidarWorker.ts    (기존 dataWorker.ts 이름 변경)
│   ├── waymoCameraWorker.ts   (기존 cameraWorker.ts 이름 변경)
│   ├── nuScenesLidarWorker.ts (신규)
│   ├── nuScenesCameraWorker.ts(신규)
│   ├── workerPool.ts          (유지 — 이미 제네릭)
│   └── cameraWorkerPool.ts    (유지)
├── stores/
│   └── useSceneStore.ts       (adapter 호출로 리팩토링)
├── utils/
│   ├── rangeImage.ts          (유지 — Waymo 워커에서만 import)
│   ├── parquet.ts             (유지 — Waymo 워커에서만 import)
│   └── merge.ts               (유지)
└── components/                (manifest 기반 동적 UI)
```

---

## 7. 리스크 및 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| Waymo 파이프라인 regression | 높음 | Phase별로 기존 27개 테스트 통과 확인. Phase 0에서 기존 코드 변경 없음. |
| Full trainval JSON 파싱 속도 | 중간 | ~400 MB JSON.parse는 2-3초. 필요시 Web Worker에서 파싱. |
| POINT_STRIDE 불일치 | 중간 | colormap이 intensity/range/elongation 인덱스를 하드코딩. manifest에서 stride와 필드 오프셋을 정의. |
| nuScenes global-frame 박스 변환 정확도 | 낮음 | 쿼터니언 변환은 잘 알려진 수학. devkit 레퍼런스와 비교 검증. |
| 브라우저 File API 제한 | 낮음 | v1.0-mini 기준 404 LiDAR + 2,424 camera = ~2,828 파일. 드래그&드롭 시 FileSystemDirectoryHandle 사용으로 대량 파일 접근. |

---

## 8. 일정 요약

| Phase | 작업 | 예상 기간 | 변경 영향 |
|---|---|---|---|
| **Phase 0** | 타입 정의 + 자동 감지 | 0.5일 | 신규 파일만 (zero risk) |
| **Phase 1** | UI 제네릭화 | 1일 | UI 컴포넌트 (낮은 risk) |
| **Phase 2** | MetadataLoader 추출 | 1-2일 | Store 리팩토링 (중간 risk) |
| **Phase 3** | Worker 추상화 + nuScenes Worker | 2-3일 | 핵심 파이프라인 (높은 risk) |
| **Phase 4** | 통합 테스트 + 폴리싱 | 1일 | 테스트 + 버그 수정 |
| **합계** | | **5.5-7.5일** | |

Phase 0 → 1은 병렬 가능. Phase 2와 3은 순차적(3이 2의 결과에 의존).
