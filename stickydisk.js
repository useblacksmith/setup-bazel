import { promisify } from 'util'
import { exec } from 'child_process'
import * as core from '@actions/core'
import { createStickyDiskClient } from './util.js'

const execAsync = promisify(exec);

async function getStickyDisk(stickyDiskKey, options = {}) {
  const client = createStickyDiskClient();

  core.debug(`Getting sticky disk for ${stickyDiskKey}`);
  const response = await client.getStickyDisk(
    {
      stickyDiskKey: stickyDiskKey,
      region: process.env.BLACKSMITH_REGION || "eu-central",
      installationModelId: process.env.BLACKSMITH_INSTALLATION_MODEL_ID || "",
      vmId: process.env.BLACKSMITH_VM_ID || "",
      stickyDiskType: "stickydisk",
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN,
      repoName: process.env.GITHUB_REPO_NAME || "",
    },
    {
      signal: options?.signal,
    },
  );

  return {
    expose_id: response.exposeId,
    device: response.diskIdentifier,
  };
}

async function maybeFormatBlockDevice(device) {
  try {
    try {
      const { stdout } = await execAsync(
        `sudo blkid -o value -s TYPE ${device}`,
      );
      if (stdout.trim() === "ext4") {
        core.debug(`Device ${device} is already formatted with ext4`);
        try {
          await execAsync(`sudo resize2fs -f ${device}`);
          core.debug(`Resized ext4 filesystem on ${device}`);
        } catch (error) {
          core.warning(`Error resizing ext4 filesystem on ${device}: ${error}`);
        }
        return device;
      }
    } catch {
      core.debug(`No filesystem found on ${device}, will format it`);
    }

    core.debug(`Formatting device ${device} with ext4`);
    await execAsync(
      `sudo mkfs.ext4 -m0 -E root_owner=$(id -u):$(id -g) -Enodiscard,lazy_itable_init=1,lazy_journal_init=1 -F ${device}`,
    );
    core.debug(`Successfully formatted ${device} with ext4`);

    // Remove lost+found directory to prevent permission issues.
    // mkfs.ext4 always creates lost+found with root:root 0700 permissions for fsck recovery.
    // This causes EACCES errors when tools (pnpm, yarn, npm, docker buildx) recursively scan
    // directories mounted from sticky disks (e.g., ./node_modules, ./build-cache).
    // For ephemeral CI cache filesystems, lost+found is unnecessary - corruption can be
    // resolved by rebuilding the cache. Removing it prevents unpredictable build failures.
    core.debug(`Removing lost+found directory from ${device}`);
    const tempMount = `/tmp/stickydisk-init-${Date.now()}`;
    try {
      await execAsync(`sudo mkdir -p ${tempMount}`);
      await execAsync(`sudo mount ${device} ${tempMount}`);
      await execAsync(`sudo rm -rf ${tempMount}/lost+found`);
      await execAsync(`sudo umount ${tempMount}`);
      await execAsync(`sudo rmdir ${tempMount}`);
      core.debug(`Removed lost+found directory from ${device}`);
    } catch (error) {
      core.warning(
        `Failed to remove lost+found directory: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return device;
  } catch (error) {
    core.error(`Failed to format device ${device}: ${error}`);
    throw error;
  }
}

async function mountStickyDisk(
  stickyDiskKey,
  stickyDiskPath,
  signal,
  controller,
) {
  const timeoutId = globalThis.setTimeout(() => controller.abort(), 45000);
  const stickyDiskResponse = await getStickyDisk(stickyDiskKey, { signal });
  const device = stickyDiskResponse.device;
  const exposeId = stickyDiskResponse.expose_id;
  clearTimeout(timeoutId);

  await maybeFormatBlockDevice(device);

  await execAsync(`sudo mkdir -p ${stickyDiskPath}`);
  await execAsync(`sudo chown $(id -u):$(id -g) ${stickyDiskPath}`);

  await execAsync(`sudo mount ${device} ${stickyDiskPath}`);

  await execAsync(`sudo chown $(id -u):$(id -g) ${stickyDiskPath}`);

  core.debug(
    `${device} has been mounted to ${stickyDiskPath} with expose ID ${exposeId}`,
  );
  return { device, exposeId };
}

async function commitStickydisk(
  exposeId,
  stickyDiskKey,
  fsDiskUsageBytes = null,
) {
  core.info(
    `Committing sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
  );
  if (!exposeId || !stickyDiskKey) {
    core.warning(
      "No expose ID or sticky disk key found, cannot report sticky disk to Blacksmith",
    );
    return;
  }

  try {
    const client = createStickyDiskClient();

    const commitRequest = {
      exposeId,
      stickyDiskKey,
      vmId: process.env.BLACKSMITH_VM_ID || "",
      shouldCommit: true,
      repoName: process.env.GITHUB_REPO_NAME || "",
      stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
    };

    if (fsDiskUsageBytes !== null && fsDiskUsageBytes > 0) {
      commitRequest.fsDiskUsageBytes = BigInt(fsDiskUsageBytes);
      core.debug(`Reporting fs usage: ${fsDiskUsageBytes} bytes`);
    } else {
      core.debug(
        "No fs usage data available, storage agent will use fallback sizing",
      );
    }

    await client.commitStickyDisk(commitRequest, {
      timeoutMs: 30000,
    });
    core.info(
      `Successfully committed sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
    );
  } catch (error) {
    core.warning(
      `Error committing sticky disk: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function cleanupStickyDiskWithoutCommit(exposeId, stickyDiskKey) {
  core.info(
    `Cleaning up sticky disk ${stickyDiskKey} with expose ID ${exposeId}`,
  );
  if (!exposeId || !stickyDiskKey) {
    core.warning(
      "No expose ID or sticky disk key found, cannot report sticky disk to Blacksmith",
    );
    return;
  }

  try {
    const client = createStickyDiskClient();
    await client.commitStickyDisk(
      {
        exposeId,
        stickyDiskKey,
        vmId: process.env.BLACKSMITH_VM_ID || "",
        shouldCommit: false,
        repoName: process.env.GITHUB_REPO_NAME || "",
        stickyDiskToken: process.env.BLACKSMITH_STICKYDISK_TOKEN || "",
      },
      {
        timeoutMs: 30000,
      },
    );
  } catch (error) {
    core.warning(
      `Error reporting build failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function unmountAndCommitStickyDisk(
  path,
  { device, exposeId },
  stickyDiskKey,
) {
  try {
    try {
      const { stdout: mountOutput } = await execAsync(`mount | grep "${path}"`);
      if (!mountOutput) {
        core.debug(`${path} is not mounted, skipping unmount`);
        return;
      }
    } catch {
      core.debug(`${path} is not mounted, skipping unmount`);
      return;
    }

    try {
      await execAsync("sync");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      core.warning(`sync command failed: ${errorMsg}`);
    }

    let fsDiskUsageBytes = null;
    const actionFailed = core.getState("action-failed") === "true";

    if (!actionFailed) {
      try {
        const { stdout } = await execAsync(
          `df -B1 --output=used "${path}" | tail -n1`,
        );
        const parsedValue = parseInt(stdout.trim(), 10);

        if (isNaN(parsedValue) || parsedValue <= 0) {
          core.warning(
            `Invalid filesystem usage value from df: "${stdout.trim()}". Will not report fs usage.`,
          );
        } else {
          fsDiskUsageBytes = parsedValue;
          core.info(
            `Filesystem usage: ${fsDiskUsageBytes} bytes (${(
              fsDiskUsageBytes /
              (1 << 30)
            ).toFixed(2)} GiB)`,
          );
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        core.warning(
          `Failed to get filesystem usage: ${errorMsg}. Will not report fs usage.`,
        );
      }
    }

    try {
      await execAsync("sudo sh -c 'echo 3 > /proc/sys/vm/drop_caches'");
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      core.warning(`drop_caches command failed: ${errorMsg}`);
    }

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await execAsync(`sudo umount "${path}"`);
        core.info(`Successfully unmounted ${path}`);
        break;
      } catch (error) {
        if (attempt === 10) {
          throw error;
        }
        core.warning(`Unmount failed, retrying (${attempt}/10)...`);
        await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
      }
    }

    if (!actionFailed) {
      await commitStickydisk(exposeId, stickyDiskKey, fsDiskUsageBytes);
    } else {
      await cleanupStickyDiskWithoutCommit(exposeId, stickyDiskKey);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.error(
        `Failed to cleanup and commit sticky disk at ${path}: ${error}`,
      );
    }
  }
}

export {
  getStickyDisk,
  maybeFormatBlockDevice,
  mountStickyDisk,
  unmountAndCommitStickyDisk,
  commitStickydisk,
  cleanupStickyDiskWithoutCommit,
}
