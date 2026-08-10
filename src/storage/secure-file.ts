import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

const PRIVATE_FILE_MODE = 0o600;

function assertSafeTarget(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) {
      throw new Error(`Refusing to overwrite symbolic link: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function syncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, constants.O_RDONLY);
    fsyncSync(fd);
  } catch {
    // Directory fsync is not available on every supported filesystem.
  } finally {
    if (typeof fd === 'number') {
      try {
        closeSync(fd);
      } catch {
        // The file contents were already published atomically.
      }
    }
  }
}

export function secureAtomicWriteFile(filePath: string, contents: string): void {
  const targetPath = path.resolve(filePath);
  const directory = path.dirname(targetPath);
  const tempPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  );

  assertSafeTarget(targetPath);

  let fd: number | undefined;
  try {
    fd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, PRIVATE_FILE_MODE);
    writeFileSync(fd, contents, { encoding: 'utf8' });
    fsyncSync(fd);
    fchmodSync(fd, PRIVATE_FILE_MODE);
    closeSync(fd);
    fd = undefined;

    assertSafeTarget(targetPath);
    renameSync(tempPath, targetPath);
    chmodSync(targetPath, PRIVATE_FILE_MODE);
    syncDirectory(directory);
  } catch (error) {
    if (typeof fd === 'number') {
      try {
        closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    if (existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        // Preserve the original write error.
      }
    }
    throw error;
  }
}
