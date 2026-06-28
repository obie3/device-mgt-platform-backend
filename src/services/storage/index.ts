import path from 'path';
import type { Config } from '../../config.js';
import type { StorageProvider } from './types.js';
import { LocalStorageProvider }      from './local.provider.js';
import { S3StorageProvider }          from './s3.provider.js';
import { CloudinaryStorageProvider }  from './cloudinary.provider.js';

export type { StorageProvider };
export type { UploadOptions, UploadResult } from './types.js';

/**
 * Factory: reads `STORAGE_PROVIDER` from config and returns the matching
 * implementation.  All S3 / Cloudinary env vars are validated at runtime
 * here (at startup) so mis-configurations surface immediately rather than at
 * the first upload request.
 *
 * Usage — set env var, zero code changes required:
 *   STORAGE_PROVIDER=local       (default — writes to UPLOAD_DIR)
 *   STORAGE_PROVIDER=s3          (AWS S3 or any S3-compatible store)
 *   STORAGE_PROVIDER=cloudinary  (Cloudinary media platform)
 */
export function createStorageProvider(config: Config): StorageProvider {
  switch (config.STORAGE_PROVIDER) {
    case 's3': {
      const missing = (['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_BASE_URL'] as const)
        .filter((k) => !config[k]);
      if (missing.length) {
        throw new Error(`S3 storage is missing required env vars: ${missing.join(', ')}`);
      }
      return new S3StorageProvider({
        bucket:          config.S3_BUCKET!,
        region:          config.S3_REGION!,
        accessKeyId:     config.S3_ACCESS_KEY_ID!,
        secretAccessKey: config.S3_SECRET_ACCESS_KEY!,
        endpoint:        config.S3_ENDPOINT,
        publicBaseUrl:   config.S3_PUBLIC_BASE_URL!,
      });
    }

    case 'cloudinary': {
      const missing = (['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'] as const)
        .filter((k) => !config[k]);
      if (missing.length) {
        throw new Error(`Cloudinary storage is missing required env vars: ${missing.join(', ')}`);
      }
      return new CloudinaryStorageProvider({
        cloudName: config.CLOUDINARY_CLOUD_NAME!,
        apiKey:    config.CLOUDINARY_API_KEY!,
        apiSecret: config.CLOUDINARY_API_SECRET!,
      });
    }

    default:
      return new LocalStorageProvider(path.resolve(config.UPLOAD_DIR));
  }
}
