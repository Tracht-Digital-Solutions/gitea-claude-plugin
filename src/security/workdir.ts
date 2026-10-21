import { open } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { GiteaError } from '../gitea/errors.js';

/**
 * Confinement of local file access to the working directory.
 *
 * Tools that upload local files (release assets, packages) or download files (workflow
 * artifacts) may only touch paths inside the project the user works in. This prevents a prompt
 * from exfiltrating files such as SSH keys or from overwriting files elsewhere.
 */

/**
 * Resolves `requested` (relative to `cwd`, or absolute) and returns the absolute path.
 * Throws INVALID_INPUT when the result lies outside `cwd`.
 */
export function resolveInWorkdir(cwd: string, requested: string, purpose: 'read' | 'write'): string {
  const full = isAbsolute(requested) ? resolve(requested) : resolve(cwd, requested);
  const rel = relative(resolve(cwd), full);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new GiteaError(
      'INVALID_INPUT',
      purpose === 'read'
        ? `Only files inside the working directory (${cwd}) can be uploaded.`
        : `Output path must be inside the working directory (${cwd}).`,
      purpose === 'read'
        ? {
            hint: 'This prevents accidentally uploading private files such as SSH keys. Copy the file into the project first.',
          }
        : {},
    );
  }
  return full;
}

export interface WorkdirFile {
  /** Absolute path of the file. */
  path: string;
  /** File name without directories. */
  name: string;
  data: Buffer;
}

/**
 * Reads a regular file inside the working directory. Type and size are checked through the same
 * open handle the content is read from, so the file cannot be swapped between check and read.
 */
export async function readWorkdirFile(
  cwd: string,
  requested: string,
  maxBytes: number,
): Promise<WorkdirFile> {
  const path = resolveInWorkdir(cwd, requested, 'read');
  const handle = await open(path, 'r').catch(() => undefined);
  if (!handle) throw new GiteaError('INVALID_INPUT', `${requested} is not a readable file.`);
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new GiteaError('INVALID_INPUT', `${requested} is not a file.`);
    if (st.size > maxBytes) {
      throw new GiteaError(
        'INVALID_INPUT',
        `${requested} is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`,
      );
    }
    return { path, name: basename(path), data: await handle.readFile() };
  } finally {
    await handle.close();
  }
}
