import type { Bucket, Storage } from '@google-cloud/storage';
import { Transform } from 'node:stream';
import { z } from 'zod';
import {
  optionsSchema,
  type DefaultOptions,
  type File,
  type FileAttributes,
  type Options,
} from './types';

/**
 * Sanitize file path to prevent path traversal attacks
 *
 * Removes path traversal attempts (../), normalizes slashes, and replaces
 * unsafe characters to ensure secure file paths.
 *
 * @param path - File path to sanitize
 * @returns Sanitized file path safe for use in GCS
 *
 * @example
 * ```typescript
 * sanitizePath('../../../etc/passwd'); // 'etc_passwd'
 * sanitizePath('path//to//file.jpg'); // 'path/to/file.jpg'
 * ```
 */
export const sanitizePath = (path: string): string => {
  if (!path) return '';
  return path
    .replaceAll('..', '') // Remove path traversal attempts
    .replace(/\/+/g, '/') // NOSONAR: Normalize multiple slashes
    .replace(/^\/+/, '') // Remove leading slashes
    .replace(/\/+$/, '') // Remove trailing slashes
    .replace(/[^a-zA-Z0-9._/-]/g, '_'); // NOSONAR:Replace unsafe characters
};

/**
 * Validate file size against maximum allowed size
 *
 * @param file - File object with size or sizeInBytes property
 * @param maxFileSize - Maximum allowed file size in bytes
 * @throws {Error} If file size exceeds maximum allowed size
 *
 * @example
 * ```typescript
 * validateFileSize(file, 100 * 1024 * 1024); // Throws if > 100MB
 * ```
 */
export const validateFileSize = (file: File, maxFileSize: number): void => {
  const fileSize = file.sizeInBytes || file.size || 0;
  if (fileSize > maxFileSize) {
    throw new Error(
      `File size (${(fileSize / 1024 / 1024).toFixed(2)}MB) exceeds maximum allowed size (${(maxFileSize / 1024 / 1024).toFixed(2)}MB)`,
    );
  }
};

/**
 * Validate file extension against allowlist (if provided)
 *
 * If no allowlist is provided, validation passes (no restrictions).
 * Extension comparison is case-insensitive.
 *
 * @param file - File object with ext property
 * @param allowedExtensions - Optional array of allowed extensions (without leading dot)
 * @throws {Error} If extension is not in allowlist (when allowlist is provided)
 *
 * @example
 * ```typescript
 * validateFileExtension(file, ['jpg', 'png', 'pdf']); // Throws if ext not in list
 * validateFileExtension(file, undefined); // Always passes
 * ```
 */
export const validateFileExtension = (
  file: File,
  allowedExtensions?: string[],
): void => {
  if (!allowedExtensions || allowedExtensions.length === 0) {
    return; // No restrictions
  }

  const fileExt = file.ext?.toLowerCase().replace(/^\./, '') || '';
  if (!fileExt || !allowedExtensions.includes(fileExt)) {
    throw new Error(
      `File extension "${fileExt}" is not allowed. Allowed extensions: ${allowedExtensions.join(', ')}`,
    );
  }
};

/**
 * Validate MIME type against file extension
 *
 * Compares the file's MIME type with expected MIME types for the given extension.
 * Logs a warning if there's a mismatch but doesn't throw (allows flexibility).
 *
 * @param file - File object with ext and mime properties
 * @returns void (logs warning on mismatch, doesn't throw)
 *
 * @example
 * ```typescript
 * validateMimeType({ ext: '.jpg', mime: 'image/jpeg' }); // OK
 * validateMimeType({ ext: '.jpg', mime: 'text/plain' }); // Warns
 * ```
 */
export const validateMimeType = (file: File): void => {
  const ext = file.ext?.toLowerCase().replace(/^\./, '') || '';
  const mime = file.mime?.toLowerCase() || '';

  // Common MIME type mappings
  const mimeMap: Record<string, string[]> = {
    jpg: ['image/jpeg'],
    jpeg: ['image/jpeg'],
    png: ['image/png'],
    gif: ['image/gif'],
    webp: ['image/webp'],
    svg: ['image/svg+xml'],
    pdf: ['application/pdf'],
    zip: ['application/zip'],
    json: ['application/json'],
    xml: ['application/xml', 'text/xml'],
    txt: ['text/plain'],
    html: ['text/html'],
    css: ['text/css'],
    js: ['application/javascript', 'text/javascript'],
    mp4: ['video/mp4'],
    mp3: ['audio/mpeg'],
  };

  if (ext && mime) {
    const expectedMimes = mimeMap[ext];
    if (expectedMimes && !expectedMimes.includes(mime)) {
      console.warn(
        `MIME type mismatch: file extension "${ext}" suggests "${expectedMimes.join(' or ')}" but got "${mime}"`,
      );
    }
  }
};

/**
 * Mask sensitive information in error messages and logs
 *
 * Replaces private_key, client_email, and project_id values with masked placeholders
 * to prevent credential leakage in logs and error messages.
 *
 * @param message - Error message or log string that may contain credentials
 * @returns Message with credentials masked as "***MASKED***"
 *
 * @example
 * ```typescript
 * maskCredentials('private_key="abc123"'); // 'private_key="***MASKED***"'
 * ```
 */
export const maskCredentials = (message: string): string => {
  return message
    .replace(/private_key["\s:=]+[^"}\s,]+/gi, 'private_key="***MASKED***"') // NOSONAR
    .replace(/client_email["\s:=]+[^"}\s,]+/gi, 'client_email="***MASKED***"') // NOSONAR
    .replace(/project_id["\s:=]+[^"}\s,]+/gi, 'project_id="***MASKED***"'); // NOSONAR
};

/**
 * Check if an error is retryable (transient failure)
 *
 * Determines if an error represents a transient failure that should be retried,
 * such as network errors, timeouts, or 5xx/429 HTTP status codes.
 *
 * @param error - Error object to check
 * @returns true if error is retryable, false otherwise
 *
 * @example
 * ```typescript
 * if (isRetryableError(error)) {
 *   // Retry the operation
 * }
 * ```
 */
export const isRetryableError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;

  // Network errors
  if (
    error.message.includes('ECONNRESET') ||
    error.message.includes('ETIMEDOUT') ||
    error.message.includes('ENOTFOUND') ||
    error.message.includes('socket hang up')
  ) {
    return true;
  }

  // GCS specific retryable errors
  if (
    error.message.includes('429') || // Too many requests
    error.message.includes('500') || // Internal server error
    error.message.includes('502') || // Bad gateway
    error.message.includes('503') || // Service unavailable
    error.message.includes('504') // Gateway timeout
  ) {
    return true;
  }

  // Check for error code property
  if ('code' in error) {
    const code = String(error.code);
    if (
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === '429' ||
      code === '500' ||
      code === '502' ||
      code === '503' ||
      code === '504'
    ) {
      return true;
    }
  }

  return false;
};

/**
 * Retry function with exponential backoff
 *
 * Executes a function with automatic retries on transient failures.
 * Uses exponential backoff (1s, 2s, 4s, ...) between retries.
 * Only retries errors classified as retryable by isRetryableError().
 *
 * @param fn - Async function to execute and retry
 * @param maxRetries - Maximum number of retry attempts (0 = no retries, just try once)
 * @param baseDelay - Base delay in milliseconds for exponential backoff (default: 1000ms)
 * @returns Promise resolving to the function's result
 * @throws Last error encountered if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await retryWithBackoff(
 *   () => uploadFile(file),
 *   3 // Retry up to 3 times
 * );
 * ```
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  maxRetries: number,
  baseDelay: number = 1000,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await fn();
      // If we successfully got a result, return it immediately
      return result;
    } catch (error) {
      lastError = error;

      // Don't retry if error is not retryable - throw immediately
      if (!isRetryableError(error)) {
        throw error;
      }

      // Don't retry on last attempt - break and throw the error
      if (attempt === maxRetries) {
        break;
      }

      // Calculate delay with exponential backoff
      const delay = baseDelay * Math.pow(2, attempt);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // If we get here, we've exhausted all retries
  // Ensure we always throw an error
  if (lastError !== undefined && lastError !== null) {
    throw lastError;
  }
  // This should never happen, but provide a fallback
  throw new Error('Retry failed but no error was captured');
};

/**
 * Timeout wrapper for async operations
 *
 * Wraps a promise with a timeout, rejecting if the operation doesn't complete
 * within the specified time. Automatically cleans up the timeout timer.
 *
 * @param promise - Promise to wrap with timeout
 * @param timeoutMs - Timeout duration in milliseconds
 * @param operation - Optional operation name for error message (default: 'Operation')
 * @returns Promise that rejects with timeout error if operation exceeds timeout
 * @throws {Error} If operation times out
 *
 * @example
 * ```typescript
 * const result = await withTimeout(
 *   uploadFile(file),
 *   60000, // 60 second timeout
 *   'File upload'
 * );
 * ```
 */
export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string = 'Operation',
): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `${operation} timed out after ${timeoutMs}ms. Consider increasing uploadTimeout configuration.`,
        ),
      );
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  });
};

/**
 * Create a progress tracking stream
 *
 * Creates a Transform stream that tracks bytes uploaded and calls
 * the progress callback for each chunk processed.
 *
 * @param onProgress - Callback function called with (bytesUploaded, totalBytes)
 * @param totalBytes - Total number of bytes expected to be uploaded
 * @returns Transform stream that tracks progress
 *
 * @example
 * ```typescript
 * const progressStream = createProgressStream(
 *   (uploaded, total) => console.log(`${uploaded}/${total} bytes`),
 *   1024 * 1024 // 1MB
 * );
 * ```
 */
export const createProgressStream = (
  onProgress: (bytesUploaded: number, totalBytes: number) => void,
  totalBytes: number,
) => {
  let bytesUploaded = 0;
  return new Transform({
    transform(chunk: Buffer, encoding, callback) {
      bytesUploaded += chunk.length;
      onProgress(bytesUploaded, totalBytes);
      callback(null, chunk);
    },
  });
};

/**
 * Simple circuit breaker implementation
 *
 * Circuit breaker pattern to prevent cascading failures. Opens after threshold
 * failures, blocks requests for timeout duration, then attempts half-open state.
 *
 * States:
 * - closed: Normal operation, requests pass through
 * - open: Too many failures, requests blocked
 * - half-open: Testing if service recovered, allows one request
 *
 * @example
 * ```typescript
 * const breaker = new CircuitBreaker(5, 60000); // 5 failures, 60s timeout
 * try {
 *   const result = await breaker.execute(() => riskyOperation());
 * } catch (error) {
 *   // Handle error or circuit breaker open
 * }
 * ```
 */
export class CircuitBreaker {
  private failures = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  /**
   * Create a new circuit breaker instance
   *
   * @param threshold - Number of failures before opening circuit
   * @param timeout - Time in milliseconds before attempting half-open state
   */
  constructor(
    private readonly threshold: number,
    private readonly timeout: number,
  ) {}

  /**
   * Execute a function through the circuit breaker
   *
   * @param fn - Async function to execute
   * @returns Promise resolving to function result
   * @throws {Error} If circuit is open or function fails
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastFailureTime >= this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error(
          `Circuit breaker is OPEN. Too many failures. Retry after ${Math.ceil((this.timeout - (now - this.lastFailureTime)) / 1000)}s`,
        );
      }
    }

    try {
      const result = await fn();
      if (this.state === 'half-open') {
        this.state = 'closed';
        this.failures = 0;
      }
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();

      if (this.failures >= this.threshold) {
        this.state = 'open';
      }

      throw error;
    }
  }

  /**
   * Reset circuit breaker to closed state
   *
   * Clears failure count and resets state. Useful for manual recovery.
   */
  reset() {
    this.failures = 0;
    this.state = 'closed';
    this.lastFailureTime = 0;
  }

  /**
   * Get current circuit breaker state
   *
   * @returns Current state: 'closed' | 'open' | 'half-open'
   */
  getState() {
    return this.state;
  }
}

/**
 * lodash _.get native port
 * Safely get nested property from object
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = (obj: any, path: string, defaultValue: any = undefined): any => {
  const travel = (regexp: RegExp) =>
    String.prototype.split
      .call(path, regexp)
      .filter(Boolean)
      .reduce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (res: any, key: string) =>
          res !== null && res !== undefined ? res[key] : res,
        obj,
      );
  const result = travel(/[,[\]]+/) || travel(/[,[\].]+/);
  return result === undefined || result === obj ? defaultValue : result;
};

/**
 * Merge uploadProvider config with gcs key in custom Strapi config
 * This allows users to override provider config from strapi.config.gcs
 * and strapi.config.currentEnvironment.gcs
 */
/**
 * Merge upload provider config with Strapi config
 *
 * Merges provider configuration with Strapi's global config (strapi.config.gcs)
 * and environment-specific config (strapi.config.currentEnvironment.gcs).
 * Allows overriding provider config from Strapi configuration files.
 *
 * @param providerConfig - Provider configuration passed to init()
 * @returns Merged configuration (Strapi config takes precedence)
 *
 * @example
 * ```typescript
 * // In strapi.config.js:
 * // module.exports = { gcs: { maxFileSize: 50 * 1024 * 1024 } };
 * const merged = mergeConfigs({ bucketName: 'my-bucket' });
 * // merged.maxFileSize will be 50MB from Strapi config
 * ```
 */
export const mergeConfigs = (providerConfig: DefaultOptions): DefaultOptions => {
  // Access global strapi object if available (Strapi providers have access to it)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const globalStrapi = (globalThis as any).strapi;

  if (globalStrapi) {
    const customGcsConfig = get(globalStrapi, 'config.gcs', {});
    const customEnvGcsConfig = get(
      globalStrapi,
      'config.currentEnvironment.gcs',
      {},
    );
    return { ...providerConfig, ...customGcsConfig, ...customEnvGcsConfig };
  }

  // If strapi is not available, return config as-is
  return providerConfig;
};

/**
 * Get configuration with default values applied
 *
 * Validates configuration using Zod schema and applies default values
 * for optional properties. Creates default metadata function if not provided.
 *
 * @param config - Configuration object (may be partial)
 * @returns Validated configuration with all defaults applied
 * @throws {Error} If configuration validation fails
 *
 * @example
 * ```typescript
 * const validated = getConfigDefaultValues({
 *   bucketName: 'my-bucket'
 *   // Other options use defaults
 * });
 * ```
 */
export const getConfigDefaultValues = (config: DefaultOptions) => {
  try {
    const parsedConfig = optionsSchema.parse(config);

    // If no custom metadata function is provided, use the default one with the configured cacheMaxAge
    if (!config.metadata) {
      const defaultGetMetadata = (cacheMaxAge: number) => (file: File) => {
        const asciiFileName = file.name
          .normalize('NFKD')
          .replace(/[\u0300-\u036f]/g, ''); // NOSONAR: Replace unicode characters (needed for filename normalization)
        return {
          contentDisposition: `inline; filename="${asciiFileName}"`,
          cacheControl: `public, max-age=${cacheMaxAge}`,
        };
      };
      parsedConfig.metadata = defaultGetMetadata(parsedConfig.cacheMaxAge);
    }

    return parsedConfig;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(err.issues[0]?.message, { cause: err });
    } else {
      throw err;
    }
  }
};

/**
 * Convert expires configuration to timestamp or Date
 *
 * Converts expires configuration (number, Date, or string) to appropriate format
 * for GCS signed URL generation. Numbers are treated as milliseconds from now.
 *
 * @param expires - Expiration time as number (ms from now), Date, or ISO string
 * @returns Date object or number timestamp suitable for GCS getSignedUrl
 *
 * @example
 * ```typescript
 * getExpires(15 * 60 * 1000); // Returns Date.now() + 15 minutes
 * getExpires(new Date('2024-12-31')); // Returns the Date object
 * ```
 */
export const getExpires = (expires: Date | number | string) => {
  if (typeof expires === 'number') {
    return Date.now() + expires;
  }
  return expires;
};

// Bucket existence cache
interface BucketCacheEntry {
  exists: boolean;
  checkedAt: number;
}

const bucketCache = new Map<string, BucketCacheEntry>();
const BUCKET_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Clear the bucket existence cache (useful for testing)
 *
 * Clears the internal cache that stores bucket existence checks.
 * Useful in tests to ensure fresh bucket checks.
 *
 * @example
 * ```typescript
 * clearBucketCache(); // Clear cache before test
 * ```
 */
export const clearBucketCache = () => {
  bucketCache.clear();
};

/**
 * Check if a GCS bucket exists (with caching)
 *
 * Checks bucket existence with a 5-minute TTL cache to reduce API calls.
 * Throws an error if bucket doesn't exist.
 *
 * @param bucket - GCS Bucket instance
 * @param bucketName - Name of the bucket to check
 * @returns Promise that resolves if bucket exists
 * @throws {Error} If bucket doesn't exist
 *
 * @example
 * ```typescript
 * await checkBucket(bucket, 'my-bucket'); // Throws if bucket doesn't exist
 * ```
 */
export const checkBucket = async (
  bucket: Bucket,
  bucketName: string,
): Promise<void> => {
  // Check cache first
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

  // Check bucket existence
  const [exists] = await bucket.exists();
  bucketCache.set(bucketName, { exists, checkedAt: now });

  if (!exists) {
    throw new Error(
      `An error occurs when we try to retrieve the Bucket "${bucketName}". Check if bucket exist on Google Cloud Platform.`,
    );
  }
};

/**
 * Prepare file for upload with validation and bucket setup
 *
 * Performs all pre-upload validation and setup:
 * - Validates file size, extension, and MIME type
 * - Sanitizes file path
 * - Checks bucket existence (with caching)
 * - Checks if file already exists
 * - Prepares file attributes (content type, metadata, etc.)
 *
 * @param file - File object to prepare
 * @param config - Provider configuration options
 * @param basePath - Base path for file storage
 * @param GCS - Google Cloud Storage instance
 * @returns Object containing fileAttributes, bucketFile, fullFileName, and fileExists
 * @throws {Error} If validation fails or bucket doesn't exist
 *
 * @example
 * ```typescript
 * const { fileAttributes, bucketFile, fullFileName, fileExists } =
 *   await prepareUploadFile(file, config, basePath, GCS);
 * ```
 */
export const prepareUploadFile = async (
  file: File,
  config: Options,
  basePath: string,
  GCS: Storage,
) => {
  // Validate file size
  validateFileSize(file, config.maxFileSize);

  // Validate file extension (if allowlist is configured)
  if ((config as Options & { allowedExtensions?: string[] }).allowedExtensions) {
    validateFileExtension(
      file,
      (config as Options & { allowedExtensions?: string[] }).allowedExtensions,
    );
  }

  // Validate MIME type
  validateMimeType(file);

  // Sanitize the generated file name
  const rawFileName = await config.generateUploadFileName(basePath, file);
  const fullFileName = sanitizePath(rawFileName);

  const bucket = GCS.bucket(config.bucketName);
  if (!config.skipCheckBucket) {
    await checkBucket(bucket, config.bucketName);
  }

  const bucketFile = bucket.file(fullFileName);
  const [fileExists] = await bucketFile.exists();

  const fileAttributes: FileAttributes = {
    contentType: config.getContentType(file),
    gzip: config.gzip,
    metadata: config.metadata!(file),
  };

  if (!config.uniform) {
    fileAttributes.public = config.publicFiles;
  }

  return { fileAttributes, bucketFile, fullFileName, fileExists };
};
