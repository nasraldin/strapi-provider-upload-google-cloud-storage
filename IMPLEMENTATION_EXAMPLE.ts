/**
 * IMPLEMENTATION EXAMPLE
 *
 * This file demonstrates how to implement the recommended improvements.
 * These are examples - integrate them carefully into the existing codebase.
 */

import type { GetSignedUrlConfig } from '@google-cloud/storage';
import { Storage } from '@google-cloud/storage';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import * as https from 'node:https';
import type { DefaultOptions, File } from './src/types';
import {
  getConfigDefaultValues,
  getExpires,
  mergeConfigs,
  prepareUploadFile,
} from './src/utils';

// ============================================================================
// SECURITY IMPROVEMENTS
// ============================================================================

/**
 * Sanitize file path to prevent path traversal attacks
 */
const sanitizePath = (path: string): string => {
  return path
    .replace(/\.\./g, '') // Remove path traversal attempts
    .replace(/\/+/g, '/') // Normalize multiple slashes
    .replace(/^\/+/, '') // Remove leading slashes
    .replace(/\/+$/, '') // Remove trailing slashes
    .replace(/[^a-zA-Z0-9._/-]/g, '_'); // Replace unsafe characters
};

/**
 * Validate file extension against allowlist
 */
const ALLOWED_EXTENSIONS = [
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.svg',
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.mp4',
  '.mov',
  '.avi',
  '.webm',
  '.mp3',
  '.wav',
  '.ogg',
  '.zip',
  '.rar',
  '.7z',
  '.txt',
  '.csv',
  '.json',
  '.xml',
];

const validateExtension = (ext: string): boolean => {
  if (!ext) return false;
  return ALLOWED_EXTENSIONS.includes(ext.toLowerCase());
};

/**
 * Validate MIME type matches file extension
 */
const validateMimeType = (mime: string, ext: string): boolean => {
  const mimeMap: Record<string, string[]> = {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    'image/svg+xml': ['.svg'],
    'application/pdf': ['.pdf'],
    'video/mp4': ['.mp4'],
    'video/quicktime': ['.mov'],
    'audio/mpeg': ['.mp3'],
    'audio/wav': ['.wav'],
    // Add more as needed
  };

  const allowedExts = mimeMap[mime.toLowerCase()];
  if (!allowedExts) return true; // Unknown MIME type, allow but log warning

  return allowedExts.includes(ext.toLowerCase());
};

// ============================================================================
// PERFORMANCE IMPROVEMENTS
// ============================================================================

/**
 * Retry logic with exponential backoff
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const retryWithBackoff = async <T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    initialDelay?: number;
    maxDelay?: number;
    factor?: number;
  } = {},
): Promise<T> => {
  const {
    maxRetries = 3,
    initialDelay = 1000,
    maxDelay = 10000,
    factor = 2,
  } = options;

  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Don't retry on certain errors
      if (
        error instanceof Error &&
        (error.message.includes('permission') ||
          error.message.includes('authentication') ||
          error.message.includes('not found'))
      ) {
        throw error;
      }

      if (attempt < maxRetries) {
        const delay = Math.min(initialDelay * Math.pow(factor, attempt), maxDelay);
        console.warn(
          `Upload attempt ${attempt + 1} failed: ${lastError.message}. Retrying in ${delay}ms...`,
        );
        await sleep(delay);
      }
    }
  }

  throw lastError!;
};

/**
 * Timeout wrapper
 */
const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage?: string,
): Promise<T> => {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(errorMessage || `Operation timed out after ${timeoutMs}ms`),
          ),
        timeoutMs,
      ),
    ),
  ]);
};

/**
 * Check if error is retryable
 */
const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  const retryableCodes = [
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'ECONNREFUSED',
    'EAI_AGAIN',
  ];
  const retryableMessages = ['timeout', 'network', 'connection', 'temporary'];

  const errorAny = error as any;
  return (
    (errorAny.code && retryableCodes.includes(errorAny.code)) ||
    retryableMessages.some((msg) => error.message.toLowerCase().includes(msg))
  );
};

// ============================================================================
// BUCKET CACHE (Performance)
// ============================================================================

interface BucketCacheEntry {
  exists: boolean;
  checkedAt: number;
}

const bucketCache = new Map<string, BucketCacheEntry>();
const BUCKET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const checkBucketCached = async (
  bucket: any,
  bucketName: string,
  skipCheck: boolean,
): Promise<void> => {
  if (skipCheck) return;

  const cached = bucketCache.get(bucketName);
  const now = Date.now();

  if (cached && now - cached.checkedAt < BUCKET_CACHE_TTL) {
    if (!cached.exists) {
      throw new Error(
        `An error occurs when we try to retrieve the Bucket "${bucketName}". Check if bucket exist on Google Cloud Platform.`,
      );
    }
    return;
  }

  const [exists] = await bucket.exists();
  bucketCache.set(bucketName, { exists, checkedAt: now });

  if (!exists) {
    throw new Error(
      `An error occurs when we try to retrieve the Bucket "${bucketName}". Check if bucket exist on Google Cloud Platform.`,
    );
  }
};

// ============================================================================
// IMPROVED UPLOAD IMPLEMENTATION
// ============================================================================

export const createImprovedProvider = (providedConfig: DefaultOptions) => {
  const mergedConfig = mergeConfigs(providedConfig);
  const config = getConfigDefaultValues(mergedConfig);
  const { serviceAccount } = config;

  // Enhanced Storage configuration with connection pooling
  const GCS = new Storage({
    ...(serviceAccount && {
      projectId: serviceAccount.project_id,
      credentials: {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      },
      // Performance optimizations - use httpAgent (not httpOptions)
      httpAgent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000,
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: (config as any).uploadTimeout || 60000,
      }),
    }),
  });

  const basePath = `${config.basePath}/`.replace(/^\/+/, '');
  const baseUrl = config.baseUrl.replace('{bucket-name}', config.bucketName);

  // File size threshold for using streams vs buffers
  const STREAM_THRESHOLD = 10 * 1024 * 1024; // 10MB
  const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB

  return {
    async upload(file: File) {
      // Security: Validate file extension
      if (file.ext && !validateExtension(file.ext)) {
        throw new Error(`File extension ${file.ext} is not allowed`);
      }

      // Security: Validate MIME type
      if (file.ext && !validateMimeType(file.mime, file.ext)) {
        console.warn(`MIME type ${file.mime} does not match extension ${file.ext}`);
      }

      // Security: Validate file size
      const maxFileSize = (config as any).maxFileSize || 100 * 1024 * 1024; // 100MB default
      if (file.sizeInBytes > maxFileSize) {
        throw new Error(
          `File size ${file.sizeInBytes} bytes exceeds maximum allowed size of ${maxFileSize} bytes`,
        );
      }

      // Security: Sanitize file path
      const sanitizedPath = file.path ? sanitizePath(file.path) : file.path;

      return retryWithBackoff(
        async () => {
          const { fileAttributes, bucketFile, fullFileName, fileExists } =
            await prepareUploadFile(
              { ...file, path: sanitizedPath },
              config,
              basePath,
              GCS,
            );

          // Use cached bucket check
          const bucket = GCS.bucket(config.bucketName);
          await checkBucketCached(
            bucket,
            config.bucketName,
            config.skipCheckBucket,
          );

          if (fileExists) {
            console.info('File already exists. Try to remove it.');
            // Don't wait for delete to complete - fire and forget
            this.delete(file).catch((err: Error) => {
              console.warn(`Failed to delete existing file: ${err.message}`);
            });
          }

          // Performance: Use stream for large files even if buffer is provided
          if (file.buffer && file.buffer.length > STREAM_THRESHOLD) {
            const bufferStream = Readable.from(file.buffer);
            const uploadTimeout = (config as any).uploadTimeout || 300000; // 5 minutes

            await withTimeout(
              pipeline(bufferStream, bucketFile.createWriteStream(fileAttributes)),
              uploadTimeout,
              `Upload timed out after ${uploadTimeout}ms`,
            );
          } else if (file.buffer) {
            const uploadTimeout = (config as any).uploadTimeout || 300000;
            await withTimeout(
              bucketFile.save(file.buffer, fileAttributes),
              uploadTimeout,
              `Upload timed out after ${uploadTimeout}ms`,
            );
          } else {
            throw new Error('File must have either buffer or stream');
          }

          file.url = `${baseUrl}/${fullFileName}`;
          file.mime = fileAttributes.contentType;
          console.debug(`File successfully uploaded to ${file.url}`);
        },
        {
          maxRetries: (config as any).maxRetries || 3,
          initialDelay: 1000,
          maxDelay: 10000,
        },
      );
    },

    async uploadStream(file: File) {
      // Same security validations as upload
      if (file.ext && !validateExtension(file.ext)) {
        throw new Error(`File extension ${file.ext} is not allowed`);
      }

      const maxFileSize = (config as any).maxFileSize || 100 * 1024 * 1024;
      if (file.sizeInBytes > maxFileSize) {
        throw new Error(
          `File size ${file.sizeInBytes} bytes exceeds maximum allowed size of ${maxFileSize} bytes`,
        );
      }

      const sanitizedPath = file.path ? sanitizePath(file.path) : file.path;

      return retryWithBackoff(
        async () => {
          const { fileAttributes, bucketFile, fullFileName, fileExists } =
            await prepareUploadFile(
              { ...file, path: sanitizedPath },
              config,
              basePath,
              GCS,
            );

          const bucket = GCS.bucket(config.bucketName);
          await checkBucketCached(
            bucket,
            config.bucketName,
            config.skipCheckBucket,
          );

          if (fileExists) {
            console.info('File already exists. Try to remove it.');
            this.delete(file).catch((err: Error) => {
              console.warn(`Failed to delete existing file: ${err.message}`);
            });
          }

          if (file.stream) {
            const uploadTimeout = (config as any).uploadTimeout || 300000;

            // Use resumable upload for very large files
            const useResumable = file.sizeInBytes > RESUMABLE_THRESHOLD;
            const writeStreamOptions = {
              ...fileAttributes,
              resumable: useResumable,
              metadata: fileAttributes.metadata,
            };

            await withTimeout(
              pipeline(
                file.stream,
                bucketFile.createWriteStream(writeStreamOptions),
              ),
              uploadTimeout,
              `Upload timed out after ${uploadTimeout}ms`,
            );

            file.url = `${baseUrl}/${fullFileName}`;
            file.mime = fileAttributes.contentType;
            console.debug(`File successfully uploaded to ${file.url}`);
          } else {
            throw new Error('File stream is required for uploadStream');
          }
        },
        {
          maxRetries: (config as any).maxRetries || 3,
          initialDelay: 1000,
          maxDelay: 10000,
        },
      );
    },

    // ... rest of the methods (delete, isPrivate, getSignedUrl, etc.)
    // Keep existing implementations but add retry logic where appropriate
  };
};
