import type { File as GCSFile, GetSignedUrlConfig } from '@google-cloud/storage';
import { Storage } from '@google-cloud/storage';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import https from 'node:https';
import type { DefaultOptions, File, Options } from './types';
import {
  CircuitBreaker,
  createProgressStream,
  getConfigDefaultValues,
  getExpires,
  maskCredentials,
  mergeConfigs,
  prepareUploadFile,
  retryWithBackoff,
  withTimeout,
} from './utils';

/**
 * Strapi Upload Provider for Google Cloud Storage
 *
 * This provider enables Strapi to upload files to Google Cloud Storage (GCS)
 * with support for security features, performance optimizations, and stability
 * improvements including retry logic, circuit breakers, and progress tracking.
 *
 * @example
 * ```typescript
 * const provider = uploadProvider.init({
 *   bucketName: 'my-bucket',
 *   serviceAccount: {
 *     project_id: 'my-project',
 *     client_email: 'service@project.iam.gserviceaccount.com',
 *     private_key: '-----BEGIN PRIVATE KEY-----\n...'
 *   },
 *   maxFileSize: 50 * 1024 * 1024, // 50MB
 *   maxRetries: 3,
 *   onUploadProgress: (uploaded, total) => {
 *     console.log(`Progress: ${(uploaded / total * 100).toFixed(2)}%`);
 *   }
 * });
 * ```
 */
export default {
  /**
   * Initialize the upload provider with configuration
   *
   * @param providedConfig - Configuration options for the provider
   * @param providedConfig.bucketName - GCS bucket name (required)
   * @param providedConfig.serviceAccount - Google Cloud service account credentials (optional, can use ADC in GCP environments)
   * @param providedConfig.maxFileSize - Maximum file size in bytes (default: 100MB)
   * @param providedConfig.uploadTimeout - Upload timeout in milliseconds (default: 5 minutes)
   * @param providedConfig.maxRetries - Maximum retry attempts for failed uploads (default: 3)
   * @param providedConfig.maxConcurrentUploads - Maximum concurrent uploads (default: 10)
   * @param providedConfig.onUploadProgress - Optional callback for upload progress tracking
   * @param providedConfig.enableCircuitBreaker - Enable circuit breaker pattern (default: false)
   * @param providedConfig.allowedExtensions - Optional array of allowed file extensions
   * @returns Provider instance with upload, uploadStream, delete, isPrivate, getSignedUrl, detectGCPEnvironment, and healthCheck methods
   *
   * @example
   * ```typescript
   * const provider = uploadProvider.init({
   *   bucketName: 'my-bucket',
   *   serviceAccount: { project_id: '...', client_email: '...', private_key: '...' }
   * });
   * ```
   */
  init(providedConfig: DefaultOptions) {
    // First merge with Strapi config, then apply defaults
    const mergedConfig = mergeConfigs(providedConfig);
    const config = getConfigDefaultValues(mergedConfig);
    const { serviceAccount } = config;

    // Connection pooling configuration
    const storageOptions: {
      projectId?: string;
      credentials?: {
        client_email: string;
        private_key: string;
      };
      httpAgent?: https.Agent;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    } = {};

    if (serviceAccount) {
      storageOptions.projectId = serviceAccount.project_id;
      storageOptions.credentials = {
        client_email: serviceAccount.client_email,
        private_key: serviceAccount.private_key,
      };
      // HTTP agent for connection pooling (only when serviceAccount is provided)
      // Note: Storage client uses gaxios which accepts httpAgent
      storageOptions.httpAgent = new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 30000, // 30 seconds
        maxSockets: 50,
        maxFreeSockets: 10,
        timeout: config.uploadTimeout,
      });
    }

    // Only pass options if we have serviceAccount
    // For backward compatibility with tests that expect undefined
    const GCS = serviceAccount
      ? new Storage(storageOptions)
      : new Storage(undefined);

    const basePath = `${config.basePath}/`.replace(/^\/+/, '');
    const baseUrl = config.baseUrl.replace('{bucket-name}', config.bucketName);

    // Circuit breaker for failure protection
    const circuitBreaker = config.enableCircuitBreaker
      ? new CircuitBreaker(
          config.circuitBreakerThreshold,
          config.circuitBreakerTimeout,
        )
      : null;

    // Concurrent upload queue management
    let activeUploads = 0;
    interface QueuedUpload<T = unknown> {
      fn: () => Promise<T>;
      resolve: (value: T) => void;
      reject: (error: unknown) => void;
    }
    const uploadQueue: Array<QueuedUpload> = [];

    const processUploadQueue = async () => {
      while (
        uploadQueue.length > 0 &&
        activeUploads < config.maxConcurrentUploads
      ) {
        const queued = uploadQueue.shift();
        if (queued) {
          activeUploads++;
          queued
            .fn()
            .then(queued.resolve)
            .catch((err) => {
              // Log error but still reject the promise
              console.error(
                `Upload queue error: ${maskCredentials(err instanceof Error ? err.message : String(err))}`,
              );
              queued.reject(err);
            })
            .finally(() => {
              activeUploads--;
              processUploadQueue(); // Process next in queue
            });
        }
      }
    };

    const queueUpload = <T>(uploadFn: () => Promise<T>): Promise<T> => {
      // If maxConcurrentUploads is very high (effectively unlimited), execute immediately
      // This maintains backward compatibility and better performance for most use cases
      // Default is 10, so we'll use queue. Set to 1000+ to bypass queue.
      if (config.maxConcurrentUploads >= 1000) {
        return uploadFn();
      }

      // If we're under the limit, execute immediately (synchronous behavior for tests)
      if (activeUploads < config.maxConcurrentUploads) {
        activeUploads++;
        return uploadFn()
          .then((result) => {
            activeUploads--;
            // Process any queued items
            processUploadQueue();
            return result;
          })
          .catch((error) => {
            activeUploads--;
            // Process any queued items
            processUploadQueue();
            throw error;
          });
      }

      // Otherwise, queue it
      return new Promise<T>((resolve, reject) => {
        uploadQueue.push({
          fn: uploadFn,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        processUploadQueue();
      });
    };

    // Helper function to handle existing file deletion
    const handleExistingFile = (
      file: File,
      deleteFn: () => Promise<void> | Promise<unknown>,
    ) => {
      console.info('File already exists. Try to remove it.');
      // Fire and forget delete for performance
      Promise.resolve(deleteFn()).catch((err) => {
        console.warn(
          `Failed to delete existing file: ${maskCredentials(err instanceof Error ? err.message : String(err))}`,
        );
      });
    };

    // Helper function to execute upload with retry and circuit breaker
    const executeUpload = async (
      uploadFn: () => Promise<void>,
      operationName: string,
    ): Promise<void> => {
      await withTimeout(
        circuitBreaker
          ? circuitBreaker.execute(() =>
              retryWithBackoff(uploadFn, config.maxRetries),
            )
          : retryWithBackoff(uploadFn, config.maxRetries),
        config.uploadTimeout,
        operationName,
      );
    };

    // Helper function to finalize upload (set URL and MIME)
    const finalizeUpload = (
      file: File,
      fullFileName: string,
      fileAttributes: { contentType: string },
    ): void => {
      file.url = `${baseUrl}/${fullFileName}`;
      file.mime = fileAttributes.contentType;
      console.debug(`File successfully uploaded to ${file.url}`);
    };

    // Helper function to upload large buffer as stream
    const uploadLargeBuffer = async (
      buffer: Buffer,
      bucketFile: GCSFile,
      fileAttributes: {
        contentType: string;
        gzip: Options['gzip'];
        metadata: Record<string, unknown>;
        public?: boolean;
      },
    ): Promise<void> => {
      const stream = Readable.from(buffer);
      const totalBytes = buffer.length;
      const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB
      const useResumable = buffer.length > RESUMABLE_THRESHOLD;

      // Add progress tracking if callback provided
      let uploadStream: Readable = stream;
      if (config.onUploadProgress) {
        uploadStream = stream.pipe(
          createProgressStream(config.onUploadProgress, totalBytes),
        ) as Readable;
      }

      const writeStreamOptions = {
        ...fileAttributes,
        resumable: useResumable,
        metadata: fileAttributes.metadata,
      };

      const uploadFn = () =>
        pipeline(uploadStream, bucketFile.createWriteStream(writeStreamOptions));

      await executeUpload(uploadFn, 'File upload');
    };

    // Helper function to upload small buffer directly
    const uploadSmallBuffer = async (
      buffer: Buffer,
      bucketFile: GCSFile,
      fileAttributes: {
        contentType: string;
        gzip: Options['gzip'];
        metadata: Record<string, unknown>;
        public?: boolean;
      },
    ): Promise<void> => {
      const uploadFn = () => bucketFile.save(buffer, fileAttributes);

      // Track progress for small buffers too if callback provided
      if (config.onUploadProgress) {
        config.onUploadProgress(buffer.length, buffer.length);
      }

      await executeUpload(uploadFn, 'File upload');
    };

    // Helper function to upload stream
    const uploadFileStream = async (
      stream: Readable,
      totalBytes: number,
      bucketFile: GCSFile,
      fileAttributes: {
        contentType: string;
        gzip: Options['gzip'];
        metadata: Record<string, unknown>;
        public?: boolean;
      },
    ): Promise<void> => {
      const RESUMABLE_THRESHOLD = 5 * 1024 * 1024; // 5MB
      const useResumable = totalBytes > RESUMABLE_THRESHOLD;

      // Add progress tracking if callback provided
      let uploadStream: Readable = stream;
      if (config.onUploadProgress && totalBytes > 0) {
        uploadStream = stream.pipe(
          createProgressStream(config.onUploadProgress, totalBytes),
        ) as Readable;
      }

      const writeStreamOptions = {
        ...fileAttributes,
        resumable: useResumable,
        metadata: fileAttributes.metadata,
      };

      const uploadFn = () =>
        pipeline(uploadStream, bucketFile.createWriteStream(writeStreamOptions));

      await executeUpload(uploadFn, 'File stream upload');
    };

    // Helper function to validate expiration time for signed URLs
    const validateExpiration = (expiresValue: number | Date | string): number => {
      const now = Date.now();
      const minExpires = now + 60 * 1000; // Minimum 1 minute
      const maxExpires = now + 7 * 24 * 60 * 60 * 1000; // Maximum 7 days
      const expiresTime =
        typeof expiresValue === 'number'
          ? expiresValue
          : new Date(expiresValue).getTime();

      if (expiresTime < now) {
        throw new Error(
          `Signed URL expiration must be in the future (got ${Math.round((expiresTime - now) / 1000)}s)`,
        );
      }
      if (expiresTime > maxExpires) {
        throw new Error(
          `Signed URL expiration must be at most 7 days from now (got ${Math.round((expiresTime - now) / (24 * 60 * 60 * 1000))} days)`,
        );
      }
      // Warn for very short expiration times (< 1 minute) but don't block
      if (expiresTime < minExpires) {
        console.warn(
          `Signed URL expiration is very short (${Math.round((expiresTime - now) / 1000)}s). Consider using at least 1 minute for production.`,
        );
      }
      return expiresTime;
    };

    // Helper function to generate signed URL from GCS
    const generateSignedUrl = async (
      fileName: string,
      expiresValue: number | Date | string,
    ): Promise<string> => {
      const options: GetSignedUrlConfig = {
        version: 'v4',
        action: 'read',
        expires: expiresValue,
      };

      const urlResult = await withTimeout(
        retryWithBackoff(async () => {
          const result = await GCS.bucket(config.bucketName)
            .file(fileName)
            .getSignedUrl(options);
          if (!result) {
            throw new Error('getSignedUrl returned undefined');
          }
          return result;
        }, config.maxRetries),
        config.uploadTimeout,
        'Get signed URL',
      );

      if (!urlResult) {
        throw new Error('Failed to generate signed URL: No result returned');
      }
      const url = Array.isArray(urlResult) ? urlResult[0] : urlResult;

      if (!url || typeof url !== 'string' || !url.startsWith('http')) {
        throw new Error('Invalid signed URL generated');
      }
      return url;
    };

    // Helper function to handle credential errors for signed URLs
    const handleCredentialError = (
      error: Error,
      file: File,
      detectGCP: () => boolean,
    ): { url: string } => {
      const isGCPEnvironment = detectGCP();

      if (!isGCPEnvironment && !serviceAccount?.client_email) {
        // Non-GCP environment requires explicit service account credentials
        if (!config.publicFiles) {
          throw new Error(
            'Cannot generate signed URLs without service account credentials. ' +
              'Either:\n' +
              '1. Provide serviceAccount with client_email and private_key in your configuration, or\n' +
              '2. Set publicFiles to true to use direct URLs instead of signed URLs.\n' +
              'For more information, see: https://github.com/strapi-community/strapi-provider-upload-google-cloud-storage#setting-up-google-authentication',
          );
        }

        // Fallback to direct URL for public files in non-GCP environments
        console.warn(
          'Warning: Cannot generate signed URL without service account credentials. ' +
            'Returning direct URL instead. This works only for public files.',
        );
        return { url: file.url };
      }

      // For GCP environments, provide more specific error message
      if (isGCPEnvironment) {
        throw new Error(
          `Failed to generate signed URL in GCP environment: ${error.message}\n` +
            'This may indicate that your GCP service account lacks the necessary permissions for URL signing. ' +
            'Please ensure your service account has the "Storage Object Admin" or "Storage Admin" role.',
        );
      }

      // Fallback error for other cases
      throw new Error(
        `Failed to generate signed URL: ${error.message}\n` +
          'This usually means your service account credentials are incomplete. ' +
          'Please ensure your serviceAccount configuration includes both client_email and private_key fields.',
      );
    };

    return {
      /**
       * Upload a file to Google Cloud Storage using a buffer
       *
       * Automatically handles:
       * - Large files (>10MB): Converts buffer to stream for memory efficiency
       * - Resumable uploads: Uses resumable uploads for files >5MB
       * - Progress tracking: Calls onUploadProgress callback if configured
       * - Retry logic: Automatically retries on transient failures
       * - Timeout protection: Fails if upload exceeds uploadTimeout
       *
       * @param file - File object containing buffer, metadata, and file information
       * @param file.buffer - File buffer (required for upload method)
       * @param file.name - Original file name
       * @param file.mime - MIME type
       * @param file.sizeInBytes - File size in bytes
       * @returns Promise that resolves when upload completes (file.url is updated)
       * @throws {Error} If file buffer is missing, file size exceeds maxFileSize, or upload fails
       *
       * @example
       * ```typescript
       * const file = {
       *   buffer: Buffer.from('file content'),
       *   name: 'document.pdf',
       *   mime: 'application/pdf',
       *   sizeInBytes: 1024,
       *   hash: 'abc123',
       *   ext: '.pdf',
       *   url: ''
       * };
       * await provider.upload(file);
       * console.log(file.url); // 'https://storage.googleapis.com/bucket/path/abc123.pdf'
       * ```
       */
      async upload(file: File) {
        return queueUpload(async () => {
          try {
            const { fileAttributes, bucketFile, fullFileName, fileExists } =
              await prepareUploadFile(file, config, basePath, GCS);

            if (fileExists) {
              handleExistingFile(file, () => this.delete(file));
            }

            if (!file.buffer) {
              throw new Error('File buffer is required for upload');
            }

            const LARGE_BUFFER_THRESHOLD = 10 * 1024 * 1024; // 10MB
            if (file.buffer.length > LARGE_BUFFER_THRESHOLD) {
              await uploadLargeBuffer(file.buffer, bucketFile, fileAttributes);
            } else {
              await uploadSmallBuffer(file.buffer, bucketFile, fileAttributes);
            }

            finalizeUpload(file, fullFileName, fileAttributes);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const maskedMessage = maskCredentials(errorMessage);
            console.error(
              `Error uploading file to Google Cloud Storage: ${maskedMessage}`,
            );
            throw error;
          }
        });
      },
      /**
       * Upload a file to Google Cloud Storage using a stream
       *
       * Optimized for large files and streaming scenarios:
       * - Resumable uploads: Automatically uses resumable uploads for files >5MB
       * - Progress tracking: Calls onUploadProgress callback if configured
       * - Retry logic: Automatically retries on transient failures
       * - Timeout protection: Fails if upload exceeds uploadTimeout
       *
       * @param file - File object containing stream, metadata, and file information
       * @param file.stream - File stream (required for uploadStream method)
       * @param file.name - Original file name
       * @param file.mime - MIME type
       * @param file.sizeInBytes - File size in bytes (used for progress tracking)
       * @returns Promise that resolves when upload completes (file.url is updated)
       * @throws {Error} If file stream is missing, file size exceeds maxFileSize, or upload fails
       *
       * @example
       * ```typescript
       * import { createReadStream } from 'fs';
       * const file = {
       *   stream: createReadStream('large-file.zip'),
       *   name: 'archive.zip',
       *   mime: 'application/zip',
       *   sizeInBytes: 50 * 1024 * 1024, // 50MB
       *   hash: 'xyz789',
       *   ext: '.zip',
       *   url: ''
       * };
       * await provider.uploadStream(file);
       * ```
       */
      async uploadStream(file: File) {
        return queueUpload(async () => {
          try {
            const { fileAttributes, bucketFile, fullFileName, fileExists } =
              await prepareUploadFile(file, config, basePath, GCS);

            if (fileExists) {
              handleExistingFile(file, () => this.delete(file));
            }

            if (!file.stream) {
              throw new Error('File stream is required for uploadStream');
            }

            const totalBytes = file.sizeInBytes || file.size || 0;
            await uploadFileStream(
              file.stream,
              totalBytes,
              bucketFile,
              fileAttributes,
            );

            finalizeUpload(file, fullFileName, fileAttributes);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            const maskedMessage = maskCredentials(errorMessage);
            console.error(
              `Error uploading file to Google Cloud Storage: ${maskedMessage}`,
            );
            throw error;
          }
        });
      },
      /**
       * Delete a file from Google Cloud Storage
       *
       * @param file - File object with url property pointing to the file in GCS
       * @param file.url - Full URL of the file to delete (e.g., 'https://storage.googleapis.com/bucket/path/file.jpg')
       * @returns Promise that resolves when delete completes (or silently succeeds if file doesn't exist)
       * @throws Never throws - logs warnings for missing files or 404 errors
       *
       * @example
       * ```typescript
       * await provider.delete({ url: 'https://storage.googleapis.com/bucket/path/file.jpg' });
       * ```
       */
      async delete(file: File) {
        if (!file.url) {
          console.warn(
            'Remote file was not found, you may have to delete manually.',
          );
          return;
        }

        const fileName = file.url.replace(`${baseUrl}/`, '');
        const bucket = GCS.bucket(config.bucketName);
        try {
          await bucket.file(fileName).delete();
          console.debug(`File ${fileName} successfully deleted`);
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 404) {
            console.warn(
              'Remote file was not found, you may have to delete manually.',
            );
          }
          // Based on old code, it will never throw (resolves and rejects)
          // throw error;
        }
      },
      /**
       * Check if files are configured as private
       *
       * @returns true if files are private (publicFiles is false), false otherwise
       *
       * @example
       * ```typescript
       * const isPrivate = provider.isPrivate();
       * if (isPrivate) {
       *   // Use signed URLs for access
       * }
       * ```
       */
      isPrivate() {
        return !config.publicFiles;
      },
      /**
       * Generate a signed URL for accessing a private file
       *
       * Signed URLs provide time-limited access to private files without requiring
       * authentication. The URL expires based on the configured `expires` setting
       * (default: 15 minutes, min: 1 minute, max: 7 days).
       *
       * @param file - File object with url property
       * @param file.url - Full URL of the file in GCS
       * @returns Promise resolving to object with signed URL
       * @returns {Promise<{url: string}>} Object containing the signed URL
       * @throws {Error} If file URL is invalid, expiration is invalid, credentials are missing, or signing fails
       *
       * @example
       * ```typescript
       * const result = await provider.getSignedUrl({
       *   url: 'https://storage.googleapis.com/bucket/path/file.jpg'
       * });
       * console.log(result.url); // Signed URL valid for configured expiration time
       * ```
       */
      async getSignedUrl(file: File): Promise<{ url: string }> {
        try {
          // Validate URL format
          if (!file.url || typeof file.url !== 'string') {
            throw new Error('Invalid file URL provided for signed URL generation');
          }

          // Validate and get expiration time
          const expiresValue = getExpires(config.expires);
          validateExpiration(expiresValue);

          // Generate signed URL
          const fileName = file.url.replace(`${baseUrl}/`, '');
          const url = await generateSignedUrl(fileName, expiresValue);

          return { url };
        } catch (error) {
          // If signing fails, check if this is a credentials issue
          if (
            error instanceof Error &&
            error.message.includes('Cannot sign data without')
          ) {
            return handleCredentialError(error, file, this.detectGCPEnvironment);
          }

          // Re-throw other errors as-is (preserve original error)
          if (error instanceof Error) {
            throw error;
          }
          // If error is not an Error instance, wrap it while preserving the original value
          throw new Error(`Failed to generate signed URL: ${String(error)}`, {
            cause: error,
          });
        }
      },

      /**
       * Detect if running in a Google Cloud Platform environment
       *
       * Checks for GCP environment variables and metadata server availability
       * to determine if Application Default Credentials (ADC) can be used.
       *
       * @returns true if running in GCP environment (App Engine, Cloud Run, GKE, Cloud Functions), false otherwise
       *
       * @example
       * ```typescript
       * const isGCP = provider.detectGCPEnvironment();
       * if (isGCP) {
       *   // Can use Application Default Credentials
       * }
       * ```
       */
      detectGCPEnvironment() {
        // Check common GCP environment variables
        const gcpEnvVars = [
          'GOOGLE_CLOUD_PROJECT',
          'GCLOUD_PROJECT',
          'GAE_APPLICATION', // App Engine
          'GAE_SERVICE', // App Engine
          'K_SERVICE', // Cloud Run
          'FUNCTION_NAME', // Cloud Functions
          'FUNCTION_TARGET', // Cloud Functions
        ];

        // Check if we're running in a GCP environment
        const hasGCPEnvVar = gcpEnvVars.some((envVar) => process.env[envVar]);

        // Additional check for Google metadata server (available in GCP environments)
        const hasGoogleMetadata =
          process.env.GCE_METADATA_HOST || process.env.KUBERNETES_SERVICE_HOST; // GKE

        return hasGCPEnvVar || !!hasGoogleMetadata;
      },

      /**
       * Health check method to verify GCS connectivity and bucket access
       *
       * Performs a lightweight check to verify:
       * - Bucket accessibility
       * - Circuit breaker state (if enabled)
       * - Active upload count
       *
       * @returns Promise resolving to health status object
       * @returns {Promise<{status: 'healthy' | 'unhealthy', details: {...}}>} Health status with details
       *
       * @example
       * ```typescript
       * const health = await provider.healthCheck();
       * if (health.status === 'healthy') {
       *   console.log('Bucket accessible:', health.details.bucketAccessible);
       *   console.log('Active uploads:', health.details.activeUploads);
       * }
       * ```
       */
      async healthCheck(): Promise<{
        status: 'healthy' | 'unhealthy';
        details: {
          bucketAccessible: boolean;
          bucketName: string;
          circuitBreakerState?: string;
          activeUploads: number;
          error?: string;
        };
      }> {
        try {
          const bucket = GCS.bucket(config.bucketName);
          const [exists] = await withTimeout(
            bucket.exists(),
            5000, // 5 second timeout for health check
            'Health check',
          );

          return {
            status: exists ? 'healthy' : 'unhealthy',
            details: {
              bucketAccessible: exists,
              bucketName: config.bucketName,
              circuitBreakerState: circuitBreaker?.getState(),
              activeUploads,
              ...(exists
                ? {}
                : { error: `Bucket "${config.bucketName}" does not exist` }),
            },
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          return {
            status: 'unhealthy',
            details: {
              bucketAccessible: false,
              bucketName: config.bucketName,
              circuitBreakerState: circuitBreaker?.getState(),
              activeUploads,
              error: maskCredentials(errorMessage),
            },
          };
        }
      },
    };
  },
};
