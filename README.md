<div align="center" style="max-width: 10rem; margin: 0 auto">
  <img style="width: 150px; height: auto;" src="https://www.sensinum.com/img/open-source/strapi-provider-upload-google-cloud-storage/logo.png" alt="Logo - Strapi Provider Upload - Google Cloud Storage" />
</div>
<div align="center">
  <h1>
    <span style="display: block">Strapi Provider Upload</span>
    <span style="display: block; font-size: 1.75rem">Google Cloud Storage</span>
  </h1>
  <p><strong>Production-Ready</strong> Google Cloud Storage Provider for Strapi Upload</p>
  <a href="https://www.npmjs.org/package/nasraldin/strapi-provider-upload-gcs-x">
    <img alt="NPM version" src="https://img.shields.io/npm/v/@strapi-community/strapi-provider-upload-google-cloud-storage.svg">
  </a>
  <a href="https://www.npmjs.org/package/nasraldin/strapi-provider-upload-gcs-x">
    <img src="https://img.shields.io/npm/dm/@strapi-community/strapi-provider-upload-google-cloud-storage.svg" alt="Monthly download on NPM" />
  </a>
  <a href="https://codecov.io/gh/strapi-community/strapi-provider-upload-google-cloud-storage">
    <img src="https://codecov.io/gh/strapi-community/strapi-provider-upload-google-cloud-storage/branch/master/graph/badge.svg?token=p4KW9ytA6u" alt="codecov.io" />
  </a>
</div>

---

## 🚀 What's New (2025 Refactor)

This library has been **completely refactored** from JavaScript to TypeScript with enterprise-grade improvements:

- **🔒 Security-First**: File size validation, path sanitization, extension/MIME type validation, credential masking, and secure signed URL policies
- **⚡ High Performance**: Resumable uploads for large files, automatic buffer-to-stream conversion, connection pooling, concurrent upload queue, and bucket existence caching
- **🛡️ Production Resilience**: Exponential backoff retry logic, operation timeouts, circuit breaker pattern, health checks, and progress tracking
- **📚 Full TypeScript**: Strict type safety, comprehensive JSDoc documentation, and Zod schema validation
- **🧪 Testing & Benchmarks**: Integration tests for large file uploads and performance benchmarking tools

**All enhancements are opt-in and fully backward compatible** with existing Strapi projects.

---

## 📋 Table of Contents

- [Installation](#-installation)
- [Quick Start](#-quick-start)
- [Configuration Reference](#-configuration-reference)
- [Security Features](#-security-features)
- [Performance Features](#-performance-features)
- [Advanced Features](#-advanced-features)
- [Testing & Benchmarks](#-testing--benchmarks)
- [FAQ & Troubleshooting](#-faq--troubleshooting)
- [Community Support](#-community-support)
- [License](#-license)

---

## 📦 Installation

Install the package from your app root directory:

**with npm:**

```bash
npm install strapi-provider-upload-gcs-x --save
```

**or with yarn:**

```bash
yarn add strapi-provider-upload-gcs-x
```

---

## 🪣 Create Your Bucket on Google Cloud Storage

The bucket should be created with **fine-grained** access control, as the plugin will configure uploaded files with public read access.

- **How to create a bucket**: https://cloud.google.com/storage/docs/creating-buckets
- **Bucket locations**: https://cloud.google.com/storage/docs/locations

---

## 🔐 Setting up Google Authentication

### For GCP Environments (App Engine, Cloud Run, Cloud Functions, GKE, Compute Engine)

If you're deploying to a Google Cloud Platform product that supports [Application Default Credentials](https://cloud.google.com/docs/authentication/production#finding_credentials_automatically), you can skip explicit credential configuration. The provider will automatically detect the GCP environment and use ADC.

### For Non-GCP Environments

Follow these steps to set up authentication:

1. In the GCP Console, go to the **Create service account key** page:
   - **[Go to the create service account key page](https://console.cloud.google.com/apis/credentials/serviceaccountkey)**
2. From the **Service account** list, select **New service account**
3. In the **Service account name** field, enter a name
4. From the **Role** list, select **Cloud Storage > Storage Admin**
5. Select `JSON` for **Key Type**
6. Click **Create**. A JSON file that contains your key downloads to your computer
7. Copy the full content of the downloaded JSON file
8. Open the Strapi configuration file
9. Paste it into the `serviceAccount` field (as `string` or `JSON`, be careful with indentation)

---

## ⚙️ Quick Start

### Minimal Setup (GCP Environments)

For GCP deployments using Application Default Credentials:

```js
// config/plugins.js
module.exports = {
  upload: {
    config: {
      provider: 'strapi-provider-upload-gcs-x',
      providerOptions: {
        bucketName: 'your-bucket-name',
        publicFiles: false,
        uniform: false,
        basePath: '',
      },
    },
  },
};
```

### With Service Account (Non-GCP Environments)

```js
// config/plugins.js
module.exports = {
  upload: {
    config: {
      provider: 'strapi-provider-upload-gcs-x',
      providerOptions: {
        bucketName: 'your-bucket-name',
        publicFiles: true,
        uniform: false,
        serviceAccount: {
          project_id: 'your-project-id',
          client_email: 'your-service-account@your-project.iam.gserviceaccount.com',
          private_key:
            '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n',
        },
        baseUrl: 'https://storage.googleapis.com/your-bucket-name',
        basePath: '',
      },
    },
  },
};
```

### With Environment Variables

```js
// config/plugins.js
module.exports = ({ env }) => ({
  upload: {
    config: {
      provider: 'strapi-provider-upload-gcs-x',
      providerOptions: {
        serviceAccount: env.json('GCS_SERVICE_ACCOUNT'),
        bucketName: env('GCS_BUCKET_NAME'),
        basePath: env('GCS_BASE_PATH'),
        baseUrl: env('GCS_BASE_URL'),
        publicFiles: env.bool('GCS_PUBLIC_FILES', true),
        uniform: env.bool('GCS_UNIFORM', false),
      },
    },
  },
});
```

### Environment-Specific Configuration

You can override the configuration per environment:

- `config/env/development/plugins.js`
- `config/env/production/plugins.js`

Files under `config/env/{env}/` will override the default configuration in the main `config` folder.

---

## 📝 Configuration Reference

### Core Options

#### `bucketName` (Required)

The name of the bucket on Google Cloud Storage.

```js
bucketName: 'my-strapi-bucket';
```

#### `serviceAccount` (Optional)

Service account credentials for authentication. Can be omitted in GCP environments using Application Default Credentials.

**Behavior:**

- **GCP environment + no serviceAccount**: Uses ADC for signed URLs ✅
- **GCP environment + explicit serviceAccount**: Uses provided credentials ✅
- **Non-GCP environment + no serviceAccount + publicFiles: true**: Returns direct URLs with warning ⚠️
- **Non-GCP environment + no serviceAccount + publicFiles: false**: Throws error ❌
- **Non-GCP environment + explicit serviceAccount**: Uses provided credentials ✅

Can be set as a String, JSON Object, or omitted.

**Example:**

```js
serviceAccount: {
  project_id: 'your-project-id',
  client_email: 'your-service-account@your-project.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n',
}
```

#### `baseUrl` (Optional)

Define your base URL. Default value: `https://storage.googleapis.com/{bucket-name}`

```js
baseUrl: 'https://storage.googleapis.com/your-bucket-name';
// or
baseUrl: 'https://your-bucket-name.storage.googleapis.com';
// or custom CDN
baseUrl: 'https://cdn.yourdomain.com';
```

#### `basePath` (Optional)

Define base path to save each media document.

```js
basePath: 'uploads';
```

#### `publicFiles` (Optional)

Boolean to define public attribute for files when uploading to storage.

- **Default**: `true`
- **When `false`**: Files are signed and only visible to authenticated users in Content Manager (not Content API)

```js
publicFiles: false;
```

#### `uniform` (Optional)

Boolean to define uniform bucket-level access. Set to `true` when uniform bucket-level access is enabled on your bucket.

- **Default**: `false`

```js
uniform: true;
```

#### `skipCheckBucket` (Optional)

Boolean to skip bucket existence check. Useful for private buckets where the check might fail due to permissions.

- **Default**: `false`

```js
skipCheckBucket: true;
```

#### `cacheMaxAge` (Optional)

Number to set the cache-control header for uploaded files in seconds.

- **Default**: `3600` (1 hour)

```js
cacheMaxAge: 604800; // 7 days
```

**Note**: If you provide a custom `metadata` function, the `cacheMaxAge` option will be ignored. You'll need to handle caching in your custom metadata function.

#### `gzip` (Optional)

Value to define if files are uploaded and stored with gzip compression.

- **Possible values**: `true`, `false`, `auto`
- **Default**: `auto`

```js
gzip: 'auto';
```

#### `expires` (Optional)

Expiration time for signed URLs. Files are signed when `publicFiles` is set to `false`.

- **Possible values**: `Date`, `number` (milliseconds), `string`
- **Default**: `900000` (15 minutes)
- **Minimum**: `60000` (1 minute)
- **Maximum**: `604800000` (7 days)

```js
expires: 3600000; // 1 hour
```

---

### Security Options

#### `maxFileSize` (Optional)

Maximum file size in bytes. Files exceeding this limit will be rejected.

- **Default**: `104857600` (100 MB)

```js
maxFileSize: 50 * 1024 * 1024; // 50 MB
```

#### `allowedExtensions` (Optional)

Array of allowed file extensions (without leading dot). If provided, only files with these extensions will be accepted.

- **Default**: `undefined` (all extensions allowed)

```js
allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'pdf', 'mp4'];
```

---

### Performance Options

#### `uploadTimeout` (Optional)

Timeout in milliseconds for upload operations. Operations exceeding this timeout will be rejected.

- **Default**: `300000` (5 minutes)

```js
uploadTimeout: 600000; // 10 minutes
```

#### `maxConcurrentUploads` (Optional)

Maximum number of concurrent uploads. Uploads exceeding this limit will be queued.

- **Default**: `10`

```js
maxConcurrentUploads: 5;
```

#### `maxRetries` (Optional)

Maximum number of retry attempts for failed operations with exponential backoff.

- **Default**: `3`
- **Range**: `0-10`

```js
maxRetries: 5;
```

---

### Advanced Options

#### `metadata` (Optional)

Function that computes metadata for a file when it is uploaded.

When no function is provided, the following metadata is used (using the configured `cacheMaxAge` value):

```ts
{
  contentDisposition: `inline; filename="${file.name}"`,
  cacheControl: `public, max-age=${cacheMaxAge}`,
}
```

**Example:**

```ts
metadata: (file) => ({
  cacheControl: `public, max-age=${60 * 60 * 24 * 7}`, // One week
  contentLanguage: 'en-US',
  contentDisposition: `attachment; filename="${file.name}"`,
}),
```

The available properties can be found in the [Cloud Storage JSON API documentation](https://cloud.google.com/storage/docs/json_api/v1/objects/insert#request_properties_JSON).

#### `generateUploadFileName` (Optional)

Function that generates the name of the uploaded file. This method provides control over file naming and can be used to include custom hashing functions or dynamic paths.

When no function is provided, the default algorithm is used (see [src/types.ts](src/types.ts)).

**Example:**

```ts
generateUploadFileName: async (basePath, file) => {
  const hash = await computeHash(file.buffer); // Your hashing function
  const extension = file.ext?.toLowerCase().substring(1) || 'bin';
  return `${extension}/${slugify(file.name)}-${hash}.${extension}`;
},
```

#### `getContentType` (Optional)

Function that determines the content type for a file when it is uploaded.

When no function is provided, `file.mime` is used.

**Important**: When a custom `getContentType` function is provided, the file's MIME type will be updated both in Google Cloud Storage metadata and in the Strapi database to ensure consistency.

**Example:**

```ts
getContentType: (file) => {
  if (file.ext === '.csv') {
    return 'text/csv';
  }
  return file.mime; // Fallback to original MIME type
},
```

#### `onUploadProgress` (Optional)

Callback function that tracks upload progress. Called with `(bytesUploaded, totalBytes)`.

**Example:**

```ts
onUploadProgress: (uploaded, total) => {
  const percentage = ((uploaded / total) * 100).toFixed(2);
  console.log(`Upload progress: ${percentage}%`);
},
```

#### `enableCircuitBreaker` (Optional)

Enable circuit breaker pattern to prevent cascading failures.

- **Default**: `false`

```js
enableCircuitBreaker: true,
circuitBreakerThreshold: 5, // Number of failures before opening circuit
circuitBreakerTimeout: 60000, // Time in ms before attempting to close circuit
```

---

## 🔒 Security Features

This provider includes multiple security enhancements:

### File Size Validation

Files exceeding `maxFileSize` are automatically rejected:

```js
providerOptions: {
  maxFileSize: 50 * 1024 * 1024, // 50 MB limit
}
```

### Path Sanitization

All file paths are automatically sanitized to prevent path traversal attacks (`../` sequences are removed, unsafe characters are replaced).

### Extension Allowlist

Restrict uploads to specific file extensions:

```js
providerOptions: {
  allowedExtensions: ['jpg', 'jpeg', 'png', 'pdf'],
}
```

### MIME Type Validation

MIME types are validated against file extensions with warnings for mismatches.

### Credential Masking

Sensitive credentials are automatically masked in error messages and logs to prevent credential leakage.

### Signed URL Security

Signed URLs have enforced expiration limits (minimum 1 minute, maximum 7 days) and are validated before use.

---

## ⚡ Performance Features

### Resumable Uploads

Large files (>5MB) automatically use resumable uploads for better reliability and recovery from network interruptions.

### Buffer-to-Stream Conversion

Large buffers (>10MB) are automatically converted to streams to reduce memory usage.

### Connection Pooling

HTTP connections are pooled and reused for better performance:

```js
// Automatically enabled when serviceAccount is provided
// Configurable via Storage options
```

### Concurrent Upload Queue

Uploads are managed in a queue with configurable concurrency limits:

```js
providerOptions: {
  maxConcurrentUploads: 10, // Default
}
```

### Bucket Existence Caching

Bucket existence checks are cached for 5 minutes to reduce API calls.

### Optimized Delete Flow

File deletions are fire-and-forget (non-blocking) to improve upload performance.

---

## 🛡️ Stability Features

### Retry Logic with Exponential Backoff

Failed operations are automatically retried with exponential backoff:

```js
providerOptions: {
  maxRetries: 3, // Default, with exponential backoff: 1s, 2s, 4s
}
```

### Operation Timeouts

All async operations are wrapped with timeouts to prevent hanging:

```js
providerOptions: {
  uploadTimeout: 300000, // 5 minutes default
}
```

### Circuit Breaker Pattern

Prevent cascading failures with circuit breaker:

```js
providerOptions: {
  enableCircuitBreaker: true,
  circuitBreakerThreshold: 5,
  circuitBreakerTimeout: 60000,
}
```

### Health Check

Monitor provider health:

```ts
const health = await provider.healthCheck();
// Returns: { status: 'healthy' | 'unhealthy', details: {...} }
```

### Error Classification

Errors are automatically classified as retryable (network errors, 5xx, 429) or non-retryable (auth errors, 4xx).

---

## 🔒 Setting up `strapi::security` Middlewares

To avoid CSP blocked URLs, edit `./config/middlewares.js`:

```js
module.exports = [
  'strapi::errors',
  {
    name: 'strapi::security',
    config: {
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'connect-src': ["'self'", 'https:'],
          'img-src': ["'self'", 'data:', 'blob:', 'storage.googleapis.com'],
          'media-src': ["'self'", 'data:', 'blob:', 'storage.googleapis.com'],
          upgradeInsecureRequests: null,
        },
      },
    },
  },
  'strapi::cors',
  'strapi::poweredBy',
  'strapi::logger',
  'strapi::query',
  'strapi::body',
  'strapi::favicon',
  'strapi::public',
];
```

Replace `storage.googleapis.com` with your custom CDN URL if applicable.

---

## 🧪 Testing & Benchmarks

### Unit Tests

Run unit tests:

```bash
yarn test:unit
```

### Integration Tests

Integration tests for large file uploads and resumable uploads:

```bash
yarn test:integration
```

**Note**: Integration tests require GCS credentials. Set the following environment variables:

```bash
export GCS_SERVICE_ACCOUNT='{"project_id":"...","client_email":"...","private_key":"..."}'
export GCS_BUCKET_NAME='your-test-bucket'
```

### Performance Benchmarks

Run performance benchmarks:

```bash
yarn benchmark
```

Benchmarks measure:

- Small file uploads (1MB)
- Large file uploads (50MB)
- Stream uploads
- Concurrent uploads

See [benchmarks/README.md](benchmarks/README.md) for details.

---

## ❓ FAQ & Troubleshooting

### Common Errors

#### Uniform Access Error

**Error**: `Cannot insert legacy ACL for an object when uniform bucket-level access is enabled`

**Solution**: Set `uniform: true` in your configuration:

```js
providerOptions: {
  uniform: true,
}
```

#### Service Account JSON Error

**Error**: `Error parsing data "Service Account JSON", please be sure to copy/paste the full JSON file`

**Solution**:

1. Open your `ServiceAccount` JSON file
2. Copy the full content of the file
3. Paste it under the `serviceAccount` variable in `plugins.js` config file as JSON

#### Signed URL Generation Issues

**Error**: `Cannot generate signed URLs without service account credentials`

This occurs when:

1. You're running in a **non-GCP environment** (local development, other cloud providers)
2. You have `publicFiles: false` (requiring signed URLs)
3. You haven't provided explicit `serviceAccount` credentials

**Solutions**:

- For **GCP environments**: Ensure your service account has proper permissions (`Storage Object Admin` or `Storage Admin` role)
- For **non-GCP environments**: Provide explicit `serviceAccount` configuration with `client_email` and `private_key`
- Alternatively: Set `publicFiles: true` to use direct URLs instead of signed URLs

**Error**: `Failed to generate signed URL in GCP environment`

This occurs in GCP environments when Application Default Credentials (ADC) cannot sign URLs, typically due to:

1. Insufficient permissions on the default service account
2. Missing IAM roles for URL signing

**Solutions**:

- Ensure your GCP service account has `Storage Object Admin` or `Storage Admin` role
- Verify that the default service account has signing permissions
- Consider providing explicit `serviceAccount` credentials if ADC continues to fail

---

## 🔗 Links

- [Strapi website](http://strapi.io/)
- [Strapi community on Slack](http://slack.strapi.io)
- [Strapi news on Twitter](https://twitter.com/strapijs)

---

## 💬 Community Support

- [GitHub](https://github.com/strapi-community/strapi-provider-upload-google-cloud-storage) (Bug reports, contributions)

You can also use the official support platform of Strapi, and search for `[VirtusLab]` prefixed people (maintainers):

- [Discord](https://discord.strapi.io) (For live discussion with the Community and Strapi team)
- [Community Forum](https://forum.strapi.io) (Questions and Discussions)

---

## 📄 License

See the [MIT License](LICENSE) file for licensing information.
