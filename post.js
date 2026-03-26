import fs from 'fs'
import path from 'path'
import process from 'node:process'
import * as cache from '@actions/cache'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import config from './config.js'
import { getFolderSize } from './util.js'
import { unmountAndCommitStickyDisk } from './stickydisk.js'

async function run() {
  try {
    await cleanupStickyDisks()
    await saveExternalCaches(config.externalCache)
  } catch (error) {
    core.setFailed(error.message)
  }
  process.exit(0)
}

async function cleanupStickyDisks() {
  const mountsJson = core.getState('sticky-disk-mounts')
  if (!mountsJson) {
    core.debug('No sticky disk mounts found in state')
    return
  }

  const mounts = JSON.parse(mountsJson)
  core.debug(`Mounts: ${JSON.stringify(mounts, null, 2)}`)

  await Promise.all(Object.entries(mounts).map(async ([path, mountInfo]) => {
    await unmountAndCommitStickyDisk(path, mountInfo, mountInfo.stickyDiskKey)
  }))
}

async function saveExternalCaches(cacheConfig) {
  if (!cacheConfig.enabled) {
    return
  }

  const globber = await glob.create(
    `${config.paths.bazelExternal}/*`,
    { implicitDescendants: false }
  )
  const externalPaths = await globber.glob()
  const savedCaches = []

  for (const externalPath of externalPaths) {
    const size = await getFolderSize(externalPath)
    const sizeMB = (size / 1024 / 1024).toFixed(2)
    core.debug(`${externalPath} size is ${sizeMB}MB`)

    if (sizeMB >= cacheConfig.minSize) {
      const name = path.basename(externalPath)
      await saveCache({
        enabled: cacheConfig[name]?.enabled ?? cacheConfig.default.enabled,
        files: cacheConfig[name]?.files || cacheConfig.default.files,
        name: cacheConfig.default.name(name),
        paths: cacheConfig.default.paths(name)
      })
      savedCaches.push(name)
    }
  }

  if (savedCaches.length > 0) {
    const manifestPath = cacheConfig.manifest.path
    fs.writeFileSync(manifestPath, savedCaches.join('\n'))
    await saveCache({
      enabled: true,
      files: cacheConfig.manifest.files,
      name: cacheConfig.manifest.name,
      paths: [manifestPath]
    })
  }
}

async function saveCache(cacheConfig) {
  if (!cacheConfig.enabled) {
    return
  }

  const cacheHit = core.getState(`${cacheConfig.name}-cache-hit`)
  core.debug(`${cacheConfig.name}-cache-hit is ${cacheHit}`)
  if (cacheHit === 'true') {
    return
  }

  try {
    core.startGroup(`Save cache for ${cacheConfig.name}`)
    const paths = cacheConfig.paths
    const hash = await glob.hashFiles(
      cacheConfig.files.join('\n'),
      undefined,
      // We don't want to follow symlinks as it's extremely slow on macOS.
      { followSymbolicLinks: false }
    )
    const key = `${config.baseCacheKey}-${cacheConfig.name}-${hash}`
    core.debug(`Attempting to save ${paths} cache to ${key}`)
    await cache.saveCache(paths, key)
    core.info('Successfully saved cache')
  } catch (error) {
    core.warning(error.stack)
  } finally {
    core.endGroup()
  }
}

run()
