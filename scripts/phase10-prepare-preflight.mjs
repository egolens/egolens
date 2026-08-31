#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { phase10HashV1, sourceManifestHashFromFilesV1 } from './lib/phase10-evidence.mjs'

function args(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    const next = argv[index + 1]
    if (!key.startsWith('--') || !next || next.startsWith('--')) throw new Error(`Invalid argument: ${key}`)
    const name = key.slice(2)
    if (result[name] !== undefined) throw new Error(`Duplicate --${name}`)
    result[name] = argv[++index]
  }
  return result
}

function pathTemplate(value) {
  return value
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/giu, '{uuid}')
    .replace(/\b[0-9a-f]{16,}\b/giu, '{hex}')
    .replace(/\d{6,}/gu, '{number}')
}

function extensionOf(value) {
  const leaf = value.split('/').at(-1) ?? ''
  const index = leaf.lastIndexOf('.')
  return index > 0 ? leaf.slice(index).toLowerCase() : ''
}

function semanticRecipeHash(recipe) {
  const semantic = structuredClone(recipe)
  delete semantic.identity
  delete semantic.provenance
  delete semantic.hashes
  return phase10HashV1(semantic)
}

function formatFingerprint(recipe, files) {
  const entries = files.map((entry) => ({ path: pathTemplate(entry.path), extension: extensionOf(entry.path) }))
  const readers = Object.values(recipe.sources).map((source) => source.reader).sort()
  return phase10HashV1({ version: 1, entries, readers })
}

function operatorSetFingerprint(recipe) {
  const operators = Object.entries(recipe.engine.requiredOperators)
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([name, dependency]) => dependency.provider === 'core'
      ? { name, major: dependency.major, provider: dependency.provider }
      : {
          name, major: dependency.major, provider: dependency.provider,
          package: {
            id: dependency.package.id,
            version: dependency.package.version,
            integrity: dependency.package.integrity,
          },
        })
  return phase10HashV1({ version: 1, operators })
}

function inlineUrl(appUrl, descriptor) {
  const params = new URLSearchParams()
  params.set('shareVersion', '1')
  params.set('data', descriptor.source.rootUrl)
  params.set('catalog', descriptor.source.catalogUrl)
  params.set('catalogHash', descriptor.source.catalogHash)
  params.set('sourceHash', descriptor.source.sourceManifestHash)
  params.set('recipe', descriptor.recipe.url)
  params.set('recipeHash', descriptor.recipe.recipeHash)
  params.set('scene', descriptor.view.sceneId)
  params.set('frame', String(descriptor.view.frameIndex))
  const value = descriptor.presentation
  params.set('cameras', value.cameraStrip ? '1' : '0')
  params.set('colormap', value.colormap)
  params.set('box', value.boxMode)
  params.set('world', value.coordinateMode === 'world' ? '1' : '0')
  params.set('sensors', value.visibleSensorIds.length ? [...value.visibleSensorIds].sort().join(',') : 'none')
  params.set('ps', String(value.pointSize))
  params.set('opacity', String(value.pointOpacity))
  params.set('cam', value.activeCameraId ?? 'none')
  params.set('trail', String(value.trailLength))
  params.set('lidar2d', value.overlays.lidarProjection ? '1' : '0')
  params.set('kp3d', value.overlays.keypoints3d ? '1' : '0')
  params.set('kp2d', value.overlays.keypoints2d ? '1' : '0')
  params.set('camseg', value.overlays.cameraSegmentation ? '1' : '0')
  params.set('speed', String(value.playbackSpeed))
  params.set('follow', value.followCamera ? '1' : '0')
  params.set('cp', value.cameraPose.position.join(','))
  params.set('ct', value.cameraPose.target.join(','))
  params.set('az', String(value.cameraPose.azimuth))
  params.set('cd', String(value.cameraPose.distance))
  params.set('theme', value.theme)
  params.set('accent', value.accent ?? 'default')
  const url = new URL(appUrl)
  url.search = params.toString()
  return url.href
}

const options = args(process.argv.slice(2))
for (const name of [
  'source-case', 'catalog', 'recipe', 'requirements', 'dataset-id', 'host-origin',
  'app-url', 'scene', 'output-dir',
]) if (!options[name]) throw new Error(`Missing --${name}`)
const [sourceCase, catalog, recipe, requirements, shareSchema] = await Promise.all([
  readFile(path.resolve(options['source-case']), 'utf8').then(JSON.parse),
  readFile(path.resolve(options.catalog), 'utf8').then(JSON.parse),
  readFile(path.resolve(options.recipe), 'utf8').then(JSON.parse),
  readFile(path.resolve(options.requirements), 'utf8').then(JSON.parse),
  readFile(path.resolve('src/teachable/schema/egolens-share-v1.schema.json'), 'utf8').then(JSON.parse),
])
const requirement = requirements.datasets?.find((entry) => entry.datasetId === options['dataset-id'])
if (!requirement) throw new Error('Dataset is absent from preflight requirements')
if (sourceCase.release.datasetId !== requirement.datasetId || sourceCase.case.caseId !== requirement.caseId) {
  throw new Error('Source case does not match the reviewed preflight requirement')
}
if (sourceManifestHashFromFilesV1(sourceCase.files) !== sourceCase.sourceManifestHash) {
  throw new Error('Source case manifest integrity failed')
}
const catalogPayload = { schema: catalog.schema, entries: catalog.entries }
if (catalog.schema !== 'egolens-source-catalog-v1' || catalog.catalogHash !== phase10HashV1(catalogPayload)) {
  throw new Error('Source catalog integrity failed')
}
const catalogFiles = catalog.entries.map(({ path: relative, size, sha256 }) => ({ path: relative, size, sha256 }))
if (sourceManifestHashFromFilesV1(catalogFiles) !== sourceCase.sourceManifestHash) {
  throw new Error('Catalog and protected source case do not describe the same bytes')
}
const recipeHash = semanticRecipeHash(recipe)
if (recipeHash !== requirement.recipeHash) throw new Error('Reviewed semantic recipe hash mismatch')
const host = new URL(options['host-origin'])
if (host.protocol !== 'http:' || host.hostname !== '127.0.0.1' || host.pathname !== '/' || host.search || host.hash) {
  throw new Error('--host-origin must be an exact loopback HTTP origin')
}
const appUrl = new URL(options['app-url'])
if (appUrl.protocol !== 'http:' || appUrl.hostname !== '127.0.0.1') throw new Error('--app-url must be loopback HTTP')
const presentation = {
  cameraStrip: Boolean(recipe.outputs.cameraImages),
  coordinateMode: 'ego',
  visibleSensorIds: recipe.scene.sensors
    .filter((sensor) => sensor.modality !== 'camera')
    .map((sensor) => sensor.id)
    .sort(),
  activeCameraId: null,
  colormap: recipe.scene.pointLayout.colorModes.includes('intensity') ? 'intensity' : recipe.scene.pointLayout.colorModes[0],
  boxMode: recipe.outputs.boxes3d ? 'box' : 'off',
  trailLength: 10,
  pointSize: 0.08,
  pointOpacity: 0.85,
  overlays: { lidarProjection: false, keypoints3d: false, keypoints2d: false, cameraSegmentation: false },
  playbackSpeed: 4,
  followCamera: false,
  cameraPose: { position: [8, 8, 8], target: [0, 0, 0], azimuth: Math.PI / 4, distance: Math.sqrt(192) },
  theme: 'dark',
  accent: null,
}
const descriptor = {
  schema: 'egolens-share-v1',
  source: {
    rootUrl: `${host.href}source/`, catalogUrl: `${host.href}catalog.json`,
    catalogHash: catalog.catalogHash, sourceManifestHash: sourceCase.sourceManifestHash,
  },
  recipe: { url: `${host.href}recipe.json`, recipeHash },
  view: { sceneId: options.scene, frameIndex: 0 },
  presentation,
}
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validate = ajv.compile(shareSchema)
if (!validate(descriptor)) throw new Error(`Generated descriptor is invalid: ${ajv.errorsText(validate.errors)}`)
const shareDescriptorHash = phase10HashV1(descriptor)
const remoteUrl = inlineUrl(appUrl.href, descriptor)
const referenced = new URL(appUrl.href)
referenced.searchParams.set('share', `${host.href}share.json`)
referenced.searchParams.set('shareHash', shareDescriptorHash)
const common = {
  datasetId: requirement.datasetId,
  caseId: requirement.caseId,
  sourceManifestHash: sourceCase.sourceManifestHash,
  recipeHash,
  formatFingerprint: formatFingerprint(recipe, sourceCase.files),
  operatorSetFingerprint: operatorSetFingerprint(recipe),
}
const identities = {
  local: { ...common, catalogHash: null, shareDescriptorHash: null },
  remote: { ...common, catalogHash: catalog.catalogHash, shareDescriptorHash: null },
  share: { ...common, catalogHash: catalog.catalogHash, shareDescriptorHash },
}
const output = path.resolve(options['output-dir'])
await mkdir(output, { recursive: true })
const writes = [
  ['descriptor.json', descriptor, 0o600],
  ['presentation.json', presentation, 0o644],
  ['local-identity.json', identities.local, 0o644],
  ['remote-identity.json', identities.remote, 0o644],
  ['share-identity.json', identities.share, 0o644],
  ['runtime.json', {
    schema: 'egolens-phase10-preflight-runtime-v1', datasetId: requirement.datasetId,
    caseId: requirement.caseId, sceneId: options.scene, localUrl: appUrl.href,
    remoteUrl, shareUrl: referenced.href, shareDescriptorHash,
  }, 0o600],
]
await Promise.all(writes.map(([filename, value, mode]) =>
  writeFile(path.join(output, filename), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode })))
process.stdout.write(`${JSON.stringify({
  schema: 'egolens-phase10-preflight-preparation-summary-v1',
  datasetId: requirement.datasetId,
  caseId: requirement.caseId,
  sourceManifestHash: common.sourceManifestHash,
  catalogHash: catalog.catalogHash,
  recipeHash,
  formatFingerprint: common.formatFingerprint,
  operatorSetFingerprint: common.operatorSetFingerprint,
  shareDescriptorHash,
}, null, 2)}\n`)
