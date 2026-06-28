import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { StorageProvider, UploadOptions, UploadResult } from './types.js';

/**
 * Filesystem storage provider (default, development-friendly).
 *
 * Writes files directly to `uploadDir` (the resolved UPLOAD_DIR path).
 * The `folder` upload option is intentionally ignored — the upload dir is
 * already scoped (e.g. `./uploads/device-images`), so nesting further would
 * create `device-images/device-images/…`.
 *
 * URLs are root-relative (/uploads/<filename>) so they flow through the Vite
 * dev proxy in development and a reverse-proxy rewrite in production without
 * needing to know the server origin.
 */
export class LocalStorageProvider implements StorageProvider {
  constructor(private readonly uploadDir: string) {
    // Ensure the directory exists at startup (sync is fine here — called once
    // during app initialisation before requests arrive).
    fs.mkdir(uploadDir, { recursive: true }).catch(() => {});
  }

  async upload(buffer: Buffer, { filename, mimeType }: UploadOptions): Promise<UploadResult> {
    const ext  = path.extname(filename).toLowerCase() || '.bin';
    const name = `${crypto.randomUUID()}${ext}`;

    await fs.mkdir(this.uploadDir, { recursive: true });
    await fs.writeFile(path.join(this.uploadDir, name), buffer);

    return { key: name, url: this.getUrl(name), size: buffer.length, mimeType };
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(path.join(this.uploadDir, key)).catch(() => {});
  }

  getUrl(key: string): string {
    // Root-relative: works with Vite proxy (/uploads → :3001/uploads) in dev
    // and a reverse-proxy rewrite in production.
    return `/uploads/${key}`;
  }
}
