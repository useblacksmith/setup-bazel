import fs from 'fs'
import crypto from 'crypto'
import { setTimeout } from 'timers/promises'
import * as core from '@actions/core'
import * as cache from '@actions/cache'
import * as github from '@actions/github'
import * as glob from '@actions/glob'
import * as tc from '@actions/tool-cache'
import config from './config.js'
import { mountStickyDisk } from './stickydisk.js'

async function run() {
  try {
    await setupBazel()
  } catch (error) {
    core.saveState('action-failed', 'true')
    core.setFailed(error.stack)
  }
}

async function setupBazel() {
  core.startGroup('Configure Bazel')
  core.info('Configuration:')
  core.info(JSON.stringify(config, null, 2))

  await setupBazelrc()
  core.endGroup()

  await setupBazelisk()
  const bazeliskMounts = await loadStickyDisk(config.bazeliskCache)
  const diskMounts = await loadStickyDisk(config.diskCache)
  const repoMounts = await loadStickyDisk(config.repositoryCache)
  await restoreExternalCaches(config.externalCache)

  const allMounts = {
    ...bazeliskMounts,
    ...diskMounts,
    ...repoMounts,
  };

  core.saveState('sticky-disk-mounts', JSON.stringify(allMounts));

  return allMounts;
}

async function restoreExternalCaches(cacheConfig) {
  if (!cacheConfig.enabled) {
    return
  }

  const path = cacheConfig.manifest.path
  await restoreCache({
    enabled: true,
    files: cacheConfig.manifest.files,
    name: cacheConfig.manifest.name,
    paths: [path]
  })

  if (fs.existsSync(path)) {
    const manifest = fs.readFileSync(path, { encoding: 'utf8' })
    for (const name of manifest.split('\n').filter(s => s)) {
      await restoreCache({
        enabled: cacheConfig[name]?.enabled ?? cacheConfig.default.enabled,
        files: cacheConfig[name]?.files || cacheConfig.default.files,
        name: cacheConfig.default.name(name),
        paths: cacheConfig.default.paths(name)
      })
    }
  }
}

async function restoreCache(cacheConfig) {
  if (!cacheConfig.enabled) {
    return
  }

  const delay = Math.random() * 1000
  await setTimeout(delay)

  core.startGroup(`Restore cache for ${cacheConfig.name}`)
  try {
    const hash = await glob.hashFiles(cacheConfig.files.join('\n'))
    const name = cacheConfig.name
    const paths = cacheConfig.paths
    const restoreKey = `${config.baseCacheKey}-${name}-`
    const key = `${restoreKey}${hash}`

    core.debug(`Attempting to restore ${name} cache from ${key}`)

    const restoredKey = await cache.restoreCache(
      paths, key, [restoreKey],
      { segmentTimeoutInMs: 300000 }
    )

    if (restoredKey) {
      core.info(`Successfully restored cache from ${restoredKey}`)

      if (restoredKey === key) {
        core.saveState(`${name}-cache-hit`, 'true')
      }
    } else {
      core.info(`Failed to restore ${name} cache`)
    }
  } finally {
    core.endGroup()
  }
}

async function setupBazelisk() {
  if (config.bazeliskVersion.length == 0) {
    return
  }

  core.startGroup('Setup Bazelisk')
  let toolPath = tc.find('bazelisk', config.bazeliskVersion)
  if (toolPath) {
    core.debug(`Found in cache @ ${toolPath}`)
  } else {
    toolPath = await downloadBazelisk()
  }
  core.addPath(toolPath)
  core.endGroup()
}

async function downloadBazelisk() {
  const version = config.bazeliskVersion
  core.debug(`Attempting to download ${version}`)

  // Possible values are 'arm', 'arm64', 'ia32', 'mips', 'mipsel', 'ppc', 'ppc64', 's390', 's390x' and 'x64'.
  // Bazelisk filenames use 'amd64' and 'arm64'.
  let arch = config.os.arch
  if (arch == 'x64') {
    arch = 'amd64'
  }

  // Possible values are 'aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos' and 'win32'.
  // Bazelisk filenames use 'darwin', 'linux' and 'windows'.
  let platform = config.os.platform
  if (platform == "win32") {
    platform = "windows"
  }

  let filename = `bazelisk-${platform}-${arch}`
  if (platform == 'windows') {
    filename = `${filename}.exe`
  }

  const token = process.env.BAZELISK_GITHUB_TOKEN
  const octokit = github.getOctokit(token, {
    baseUrl: 'https://api.github.com'
  })
  const { data: releases } = await octokit.rest.repos.listReleases({
    owner: 'bazelbuild',
    repo: 'bazelisk'
  })

  // Find version matching semver specification.
  const tagName = tc.evaluateVersions(releases.map((r) => r.tag_name), version)
  const release = releases.find((r) => r.tag_name === tagName)
  if (!release) {
    throw new Error(`Unable to find Bazelisk version ${version}`)
  }

  const asset = release.assets.find((a) => a.name == filename)
  if (!asset) {
    throw new Error(`Unable to find Bazelisk version ${version} for platform ${platform}/${arch}`)
  }

  const url = asset.browser_download_url
  core.debug(`Downloading from ${url}`)
  const downloadPath = await tc.downloadTool(url, undefined, `token ${token}`)

  core.debug('Adding to the cache...');
  fs.chmodSync(downloadPath, '755');
  let bazel_name = "bazel";
  if (platform == 'windows') {
    bazel_name = `${bazel_name}.exe`
  }
  const cachePath = await tc.cacheFile(downloadPath, bazel_name, 'bazelisk', version)
  core.debug(`Successfully cached bazelisk to ${cachePath}`)

  return cachePath
}

async function setupBazelrc() {
  for (const bazelrcPath of config.paths.bazelrc) {
    fs.writeFileSync(
      bazelrcPath,
      `startup --output_base=${config.paths.bazelOutputBase}\n`
    )
    fs.appendFileSync(bazelrcPath, config.bazelrc.join("\n"))
  }
}

async function loadExternalStickyDisks(cacheConfig) {
  if (!cacheConfig.enabled) {
    return {}
  }

  const path = cacheConfig.manifest.path
  const manifestMounts = await loadStickyDisk({
    enabled: true,
    files: cacheConfig.manifest.files,
    name: cacheConfig.manifest.name,
    paths: [path]
  })

  let allMounts = { ...manifestMounts }

  if (fs.existsSync(path)) {
    process.stderr.write(`Restoring external caches from ${path}\n`)
    const manifest = fs.readFileSync(path, { encoding: 'utf8' })
    for (const name of manifest.split('\n').filter(s => s)) {
      const mounts = await loadStickyDisk({
        enabled: cacheConfig[name]?.enabled ?? cacheConfig.default.enabled,
        files: cacheConfig[name]?.files || cacheConfig.default.files,
        name: cacheConfig.default.name(name),
        paths: cacheConfig.default.paths(name)
      })
      allMounts = { ...allMounts, ...mounts }
    }
  }

  return allMounts
}

async function loadStickyDisk(cacheConfig) {
  if (!cacheConfig.enabled) {
    return {};
  }

  const delay = Math.random() * 1000
  await setTimeout(delay)

  const newMounts = {};
  core.startGroup(`Setting up sticky disk for ${cacheConfig.name}`)
  try {
    const hash = await glob.hashFiles(cacheConfig.files.join('\n'))
    const name = cacheConfig.name
    const paths = cacheConfig.paths
    const baseKey = `${config.baseCacheKey}-${name}-${hash}`

    try {
      const controller = new AbortController();

      const mountResults = await Promise.all(paths.map(async (path) => {
        try {
          const pathHash = crypto
            .createHash('sha256')
            .update(path)
            .digest('hex')
            .slice(0, 8);

          const pathKey = `${baseKey}-${pathHash}`;

          const { device, exposeId } = await mountStickyDisk(
            pathKey,
            path,
            controller.signal,
            controller
          );
          core.debug(`Mounted device ${device} at ${path} with expose ID ${exposeId}`);

          return {
            path,
            mount: { device, exposeId, stickyDiskKey: pathKey }
          };
        } catch (error) {
          core.warning(`Failed to mount sticky disk for ${path}: ${error}`);
          return null;
        }
      }));

      for (const result of mountResults) {
        if (result) {
          newMounts[result.path] = result.mount;
        }
      }

      core.info('Successfully mounted sticky disks');
    } catch (error) {
      core.warning(`Failed to setup sticky disks for ${name}: ${error}`);
    }
  } catch (err) {
    core.warning(`Failed to set up sticky disk for ${cacheConfig.name}: ${err}`)
  } finally {
    core.endGroup()
  }

  return newMounts;
}

run()

export { loadStickyDisk, loadExternalStickyDisks, setupBazel }
