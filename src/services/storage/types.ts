// ---------------------------------------------------------------------------
// Storage provider interface
// ---------------------------------------------------------------------------
// All storage implementations (local filesystem, S3, Cloudinary) satisfy this
// interface so the rest of the app is fully decoupled from the backing store.
// Switch providers by changing the STORAGE_PROVIDER env var — zero code changes.

export interface UploadOptions {
  /** Original filename — used to derive the file extension */
  filename: string;
  /** MIME type to record and pass to remote providers */
  mimeType: string;
  /** Logical subfolder / prefix (e.g. 'device-images').
   *  Local provider ignores this (already scoped by UPLOAD_DIR).
   *  S3 and Cloudinary use it as a key prefix / upload folder. */
  folder?: string;
}

export interface UploadResult {
  /** Opaque storage key — pass back to delete() / getUrl().
   *  Local: uuid filename (e.g. 'a1b2c3.jpg').
   *  S3: full object key (e.g. 'device-images/a1b2c3.jpg').
   *  Cloudinary: public_id (e.g. 'device-images/a1b2c3'). */
  key: string;
  /** Publicly accessible URL ready to serve to clients */
  url: string;
  size: number;
  mimeType: string;
}

export interface StorageProvider {
  upload(buffer: Buffer, opts: UploadOptions): Promise<UploadResult>;
  /** Best-effort delete — should not throw if the key no longer exists */
  delete(key: string): Promise<void>;
  /** Derive the public URL for an already-stored key */
  getUrl(key: string): string;
}
