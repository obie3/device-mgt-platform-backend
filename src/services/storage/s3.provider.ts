import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import path from 'path';
import type { StorageProvider, UploadOptions, UploadResult } from './types.js';

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional custom endpoint for S3-compatible stores (Cloudflare R2, MinIO, etc.) */
  endpoint?: string;
  /** Base URL used to construct public object URLs.
   *  AWS standard: `https://<bucket>.s3.<region>.amazonaws.com`
   *  R2 / custom CDN: `https://cdn.example.com`
   *  Do NOT include a trailing slash. */
  publicBaseUrl: string;
}

/**
 * AWS S3 storage provider (also compatible with Cloudflare R2 and MinIO via
 * the `endpoint` option).
 *
 * Objects are stored under `<folder>/<uuid><ext>`.  The `publicBaseUrl` is
 * prepended to produce the public URL returned to clients.
 *
 * IAM minimum permissions required:
 *   s3:PutObject, s3:DeleteObject on arn:aws:s3:::<bucket>/*
 *
 * For private buckets add a bucket policy or CloudFront distribution that
 * allows public GET; for fully private assets use signed URLs instead of
 * a static publicBaseUrl.
 */
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(private readonly cfg: S3Config) {
    this.client = new S3Client({
      region: cfg.region,
      credentials: {
        accessKeyId:     cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
      ...(cfg.endpoint
        ? { endpoint: cfg.endpoint, forcePathStyle: true }
        : {}),
    });
  }

  async upload(
    buffer: Buffer,
    { filename, mimeType, folder = 'device-images' }: UploadOptions,
  ): Promise<UploadResult> {
    const ext = path.extname(filename).toLowerCase() || '.bin';
    const key = `${folder}/${crypto.randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket:      this.cfg.bucket,
        Key:         key,
        Body:        buffer,
        ContentType: mimeType,
      }),
    );

    return { key, url: this.getUrl(key), size: buffer.length, mimeType };
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }),
    ).catch(() => {});
  }

  getUrl(key: string): string {
    return `${this.cfg.publicBaseUrl}/${key}`;
  }
}
