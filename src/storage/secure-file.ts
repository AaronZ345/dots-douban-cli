import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import path from 'node:path';

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;

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

export function ensurePrivateDirectory(directory: string): void {
  const targetPath = path.resolve(directory);
  let existed = false;
  try {
    lstatSync(targetPath);
    existed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const createdPath = existed
    ? undefined
    : mkdirSync(targetPath, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  const stat = lstatSync(targetPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Private storage path is not a regular directory: ${targetPath}`);
  }
  if (createdPath !== undefined) {
    chmodSync(targetPath, PRIVATE_DIRECTORY_MODE);
  } else if (process.platform !== 'win32' && (stat.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error(`Private storage directory is accessible by other users; run chmod 700 "${targetPath}"`);
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

export function migratePrivateFile(
  sourcePath: string,
  targetPath: string,
  validate: (contents: string) => void
): boolean {
  try {
    lstatSync(targetPath);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let sourceStat;
  try {
    sourceStat = lstatSync(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (sourceStat.isSymbolicLink() || !sourceStat.isFile()) {
    throw new Error(`Legacy storage path is not a regular file: ${sourcePath}`);
  }
  if ((sourceStat.mode & 0o077) !== 0) chmodSync(sourcePath, PRIVATE_FILE_MODE);

  const contents = readFileSync(sourcePath, 'utf8');
  validate(contents);
  ensurePrivateDirectory(path.dirname(targetPath));
  secureAtomicWriteFile(targetPath, contents);

  const persisted = readFileSync(targetPath, 'utf8');
  if (persisted !== contents) {
    throw new Error(`Migrated file verification failed: ${targetPath}`);
  }
  validate(persisted);
  unlinkSync(sourcePath);
  return true;
}
