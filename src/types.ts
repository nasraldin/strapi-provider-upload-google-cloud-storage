import type { FileMetadata } from '@google-cloud/storage';
import type { ReadStream } from 'node:fs';
import path from 'node:path';
import slugify from 'slugify';
import { z } from 'zod';

/**
 * Zod schema for file validation
 *
 * Validates file objects passed to upload methods. Includes all standard
 * Strapi file properties plus optional stream and buffer for uploads.
 */
export const fileSchema = z.object({
  name: z.string(),
  alternativeText: z.string().optional(),
  caption: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  formats: z.record(z.string(), z.unknown()).optional(),
  hash: z.string(),
  ext: z.string().optional(),
  mime: z.string(),
  size: z.number(),
  sizeInBytes: z.number(),
  url: z.string(),
  previewUrl: z.string().optional(),
  path: z.string().optional(),
  provider: z.string().optional(),
  provider_metadata: z.record(z.string(), z.unknown()).optional(),
  related: z.array(z.object({ ref: z.string() })).optional(), // For generateUploadFileName fallback
  stream: z.unknown().optional(), // `ReadStream` can't be validated easily, so `any` or skip
  buffer: z.unknown().optional(), // same for `Buffer`
});

/**
 * File type for upload operations
 *
 * Represents a file to be uploaded to Google Cloud Storage.
 * Extends the validated schema with stream and buffer properties.
 */
export type File = z.infer<typeof fileSchema> & {
  stream?: ReadStream;
  buffer?: Buffer;
};

/**
 * File attributes for GCS upload
 *
 * Metadata and configuration for file uploads including content type,
 * compression, public/private access, and custom metadata.
 */
export type FileAttributes = {
  contentType: string;
  gzip: Options['gzip'];
  metadata: FileMetadata;
  public?: boolean;
};

/**
 * Zod schema for Google Cloud service account validation
 *
 * Validates service account JSON with required fields: project_id,
 * client_email, and private_key. Used for authentication with GCS.
 */
export const serviceAccountSchema = z.object({
  project_id: z.string({
    error: (issue) =>
      issue.input === undefined
        ? 'Error parsing data "Service Account JSON". Missing "project_id" field in JSON file.'
        : 'Error parsing data "Service Account JSON". Property "project_id" must be a string.',
  }),
  client_email: z.string({
    error: (issue) =>
      issue.input === undefined
        ? 'Error parsing data "Service Account JSON". Missing "client_email" field in JSON file.'
        : 'Error parsing data "Service Account JSON". Property "client_email" must be a string.',
  }),
  private_key: z.string({
    error: (issue) =>
      issue.input === undefined
        ? 'Error parsing data "Service Account JSON". Missing "private_key" field in JSON file.'
        : 'Error parsing data "Service Account JSON". Property "private_key" must be a string.',
  }),
});

/**
 * Google Cloud service account credentials
 *
 * Required for authentication when not using Application Default Credentials (ADC).
 * Can be provided as object or JSON string (parsed automatically).
 */
export type ServiceAccount = z.infer<typeof serviceAccountSchema>;

type MetadataFn = (file: File) => FileMetadata;
type GetContentTypeFn = (file: File) => string;
type GenerateUploadFileNameFn = (
  basePath: string,
  file: File,
) => Promise<string> | string;

const defaultGetContentType = (file: File) => file.mime;

const defaultGenerateUploadFileName = (basePath: string, file: File) => {
  // Use file.related[0].ref as fallback if available (matching old behavior)
  const backupPath =
    file.related && file.related.length > 0 && file.related[0]?.ref
      ? `${file.related[0].ref}`
      : `${file.hash}`;
  // Old version: file.path is used as-is, but we need to handle leading slash
  // If file.path starts with /, remove it to avoid double slashes with basePath
  const normalizedPath = file.path ? file.path.replace(/^\/+/, '') : backupPath;
  const filePath = `${normalizedPath}/`;
  const extension = file.ext?.toLowerCase() || '';
  const fileName = slugify(path.basename(file.hash));
  return `${basePath}${filePath}${fileName}${extension}`;
};

/**
 * Zod schema for provider configuration options
 *
 * Validates and provides defaults for all provider configuration options
 * including security, performance, and stability settings.
 */
export const optionsSchema = z.object({
  serviceAccount: z
    .preprocess((input) => {
      if (typeof input === 'string') {
        try {
          return JSON.parse(input);
        } catch {
          throw new Error(
            'Error parsing data "Service Account JSON", please be sure to copy/paste the full JSON file.',
          );
        }
      }
      return input;
    }, serviceAccountSchema)
    .optional(),
  bucketName: z.string({
    error: (issue) =>
      issue.input === undefined
        ? 'Property "bucketName" is required'
        : 'Property "bucketName" must be a string',
  }),
  baseUrl: z.string().default('https://storage.googleapis.com/{bucket-name}'),
  basePath: z.string().default(''),
  publicFiles: z.boolean().or(z.stringbool()).default(true),
  uniform: z.boolean().or(z.stringbool()).default(false),
  skipCheckBucket: z.boolean().or(z.stringbool()).default(false),
  gzip: z.boolean().or(z.stringbool()).or(z.literal('auto')).default('auto'),
  cacheMaxAge: z.number().default(3600),
  expires: z
    .union([
      z.string(),
      z.date(),
      z
        .number()
        .min(60) // Minimum 1 minute for security
        .max(1000 * 60 * 60 * 24 * 7), // Maximum 7 days
    ])
    .default(15 * 60 * 1000),
  maxFileSize: z.preprocess(
    (val) =>
      typeof val === 'number' && Number.isFinite(val) && val > 0 ? val : undefined,
    z
      .number()
      .positive()
      .default(100 * 1024 * 1024),
  ), // Coerce NaN/invalid to 100MB default
  uploadTimeout: z.number().positive().default(300000), // 5 minutes default
  maxRetries: z.number().int().min(0).max(10).default(3),
  maxConcurrentUploads: z.number().int().positive().default(10),
  allowedExtensions: z.array(z.string()).optional(),
  onUploadProgress: z
    .custom<
      (bytesUploaded: number, totalBytes: number) => void
    >((val) => typeof val === 'function')
    .optional(),
  enableCircuitBreaker: z.boolean().or(z.stringbool()).default(false),
  circuitBreakerThreshold: z.number().int().positive().default(5),
  circuitBreakerTimeout: z.number().int().positive().default(60000), // 1 minute
  metadata: z.custom<MetadataFn>((val) => typeof val === 'function').optional(),
  getContentType: z
    .custom<GetContentTypeFn>((val) => typeof val === 'function')
    .optional()
    .default(() => defaultGetContentType),
  generateUploadFileName: z
    .custom<GenerateUploadFileNameFn>((val) => typeof val === 'function')
    .optional()
    .default(() => defaultGenerateUploadFileName),
});

/**
 * Validated provider options type
 *
 * All configuration options with defaults applied and validated.
 */
export type Options = z.infer<typeof optionsSchema>;

/**
 * Default options type for provider initialization
 *
 * Allows partial configuration with only bucketName required.
 * ServiceAccount can be provided as object or JSON string.
 * All other options are optional with sensible defaults.
 */
export type DefaultOptions = Partial<
  Omit<Options, 'serviceAccount' | 'bucketName'>
> & {
  bucketName: string;
  serviceAccount?: ServiceAccount | string;
};
