/**
 * Integration tests for large file uploads and resumable upload recovery
 *
 * These tests require actual GCS credentials and a test bucket.
 * Set the following environment variables to run:
 * - GCS_TEST_BUCKET_NAME: Name of test bucket
 * - GCS_TEST_SERVICE_ACCOUNT: JSON string of service account (or use ADC in GCP)
 *
 * Tests are skipped if credentials are not available.
 */

import { Storage } from '@google-cloud/storage';
import {
  createReadStream,
  createWriteStream,
  unlinkSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import provider from '../index';
import { clearBucketCache } from '../utils';

// Test configuration from environment
const TEST_BUCKET_NAME = process.env.GCS_TEST_BUCKET_NAME;
const TEST_SERVICE_ACCOUNT = process.env.GCS_TEST_SERVICE_ACCOUNT
  ? JSON.parse(process.env.GCS_TEST_SERVICE_ACCOUNT)
  : undefined;

// Skip all tests if credentials not available
const shouldSkip =
  !TEST_BUCKET_NAME ||
  (!TEST_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS);

const describeIf = shouldSkip ? describe.skip : describe;

describeIf('Integration Tests (Large Files)', () => {
  let providerInstance: ReturnType<typeof provider.init>;
  let testFilePaths: string[] = [];

  beforeAll(() => {
    if (shouldSkip) {
      console.log('Skipping integration tests: GCS credentials not available');
      return;
    }

    providerInstance = provider.init({
      bucketName: TEST_BUCKET_NAME || '',
      serviceAccount: TEST_SERVICE_ACCOUNT,
      maxFileSize: 200 * 1024 * 1024, // 200MB for large file tests
      uploadTimeout: 600000, // 10 minutes for large uploads
      maxRetries: 3,
      maxConcurrentUploads: 5,
    });
  });

  afterEach(async () => {
    // Clean up test files from disk
    for (const filePath of testFilePaths) {
      if (existsSync(filePath)) {
        try {
          unlinkSync(filePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    }
    testFilePaths = [];
    clearBucketCache();
  });

  /**
   * Create a test file of specified size
   */
  async function createTestFile(
    sizeInBytes: number,
    filename?: string,
  ): Promise<string> {
    const filePath = join(
      tmpdir(),
      filename || `test-${Date.now()}-${sizeInBytes}.bin`,
    );
    const writeStream = createWriteStream(filePath);
    const chunkSize = 1024 * 1024; // 1MB chunks
    let written = 0;

    return new Promise<string>((resolve, reject) => {
      const writeChunk = () => {
        if (written >= sizeInBytes) {
          writeStream.end();
          return;
        }

        const remaining = sizeInBytes - written;
        const chunk = Buffer.alloc(Math.min(chunkSize, remaining), 'A');
        written += chunk.length;

        if (writeStream.write(chunk)) {
          writeChunk();
        } else {
          writeStream.once('drain', writeChunk);
        }
      };

      writeStream.on('finish', () => {
        testFilePaths.push(filePath);
        resolve(filePath);
      });
      writeStream.on('error', reject);
      writeChunk();
    });
  }

  describe('Large File Uploads (>100MB)', () => {
    test('Upload 100MB file using buffer', async () => {
      if (shouldSkip) return;

      const fileSize = 100 * 1024 * 1024; // 100MB
      const testFile = await createTestFile(fileSize);

      const fs = await import('node:fs');
      const file = {
        buffer: fs.readFileSync(testFile),
        name: 'large-file-100mb.bin',
        mime: 'application/octet-stream',
        size: fileSize / 1024,
        sizeInBytes: fileSize,
        hash: `test-${Date.now()}`,
        ext: '.bin',
        url: '',
      };

      const startTime = Date.now();
      await providerInstance.upload(file);
      const duration = Date.now() - startTime;

      expect(file.url).toBeTruthy();
      expect(file.url).toContain(TEST_BUCKET_NAME);
      console.log(
        `Uploaded 100MB in ${duration}ms (${(fileSize / 1024 / 1024 / (duration / 1000)).toFixed(2)} MB/s)`,
      );

      // Verify file exists in GCS
      const storage = new Storage(
        TEST_SERVICE_ACCOUNT
          ? {
              projectId: TEST_SERVICE_ACCOUNT.project_id,
              credentials: TEST_SERVICE_ACCOUNT,
            }
          : undefined,
      );
      const bucket = storage.bucket(TEST_BUCKET_NAME);
      const fileName = file.url.replace(
        `https://storage.googleapis.com/${TEST_BUCKET_NAME}/`,
        '',
      );
      const [exists] = await bucket.file(fileName).exists();
      expect(exists).toBe(true);

      // Cleanup
      await bucket.file(fileName).delete();
    }, 600000); // 10 minute timeout

    test('Upload 150MB file using stream', async () => {
      if (shouldSkip) return;

      const fileSize = 150 * 1024 * 1024; // 150MB
      const testFile = await createTestFile(fileSize);

      const file = {
        stream: createReadStream(testFile),
        name: 'large-file-150mb.bin',
        mime: 'application/octet-stream',
        size: fileSize / 1024,
        sizeInBytes: fileSize,
        hash: `test-${Date.now()}`,
        ext: '.bin',
        url: '',
      };

      const startTime = Date.now();
      await providerInstance.uploadStream(file);
      const duration = Date.now() - startTime;

      expect(file.url).toBeTruthy();
      expect(file.url).toContain(TEST_BUCKET_NAME);
      console.log(
        `Uploaded 150MB stream in ${duration}ms (${(fileSize / 1024 / 1024 / (duration / 1000)).toFixed(2)} MB/s)`,
      );

      // Verify file exists in GCS
      const storage = new Storage(
        TEST_SERVICE_ACCOUNT
          ? {
              projectId: TEST_SERVICE_ACCOUNT.project_id,
              credentials: TEST_SERVICE_ACCOUNT,
            }
          : undefined,
      );
      const bucket = storage.bucket(TEST_BUCKET_NAME);
      const fileName = file.url.replace(
        `https://storage.googleapis.com/${TEST_BUCKET_NAME}/`,
        '',
      );
      const [exists] = await bucket.file(fileName).exists();
      expect(exists).toBe(true);

      // Cleanup
      await bucket.file(fileName).delete();
    }, 600000); // 10 minute timeout
  });

  describe('Resumable Upload Recovery', () => {
    test('Large file upload with progress tracking', async () => {
      if (shouldSkip) return;

      const fileSize = 50 * 1024 * 1024; // 50MB
      const testFile = await createTestFile(fileSize);

      const progressUpdates: Array<{ uploaded: number; total: number }> = [];

      const providerWithProgress = provider.init({
        bucketName: TEST_BUCKET_NAME,
        serviceAccount: TEST_SERVICE_ACCOUNT,
        maxFileSize: 200 * 1024 * 1024,
        uploadTimeout: 600000,
        onUploadProgress: (uploaded, total) => {
          progressUpdates.push({ uploaded, total });
        },
      });

      const fs = await import('node:fs');
      const file = {
        buffer: fs.readFileSync(testFile),
        name: 'progress-test.bin',
        mime: 'application/octet-stream',
        size: fileSize / 1024,
        sizeInBytes: fileSize,
        hash: `test-${Date.now()}`,
        ext: '.bin',
        url: '',
      };

      await providerWithProgress.upload(file);

      expect(progressUpdates.length).toBeGreaterThan(0);
      expect(progressUpdates.at(-1)?.uploaded).toBe(fileSize);
      expect(progressUpdates.at(-1)?.total).toBe(fileSize);
      console.log(`Progress updates received: ${progressUpdates.length}`);

      // Cleanup
      const storage = new Storage(
        TEST_SERVICE_ACCOUNT
          ? {
              projectId: TEST_SERVICE_ACCOUNT.project_id,
              credentials: TEST_SERVICE_ACCOUNT,
            }
          : undefined,
      );
      const bucket = storage.bucket(TEST_BUCKET_NAME);
      const fileName = file.url.replace(
        `https://storage.googleapis.com/${TEST_BUCKET_NAME}/`,
        '',
      );
      await bucket.file(fileName).delete();
    }, 600000);
  });

  describe('Concurrent Uploads', () => {
    test('Upload multiple files concurrently', async () => {
      if (shouldSkip) return;

      const fileSize = 10 * 1024 * 1024; // 10MB each
      const numFiles = 5;
      const testFiles = await Promise.all(
        Array.from({ length: numFiles }, (_, i) =>
          createTestFile(fileSize, `concurrent-${i}.bin`),
        ),
      );

      const fs = await import('node:fs');
      const files = testFiles.map((filePath, i) => ({
        buffer: fs.readFileSync(filePath),
        name: `concurrent-${i}.bin`,
        mime: 'application/octet-stream',
        size: fileSize / 1024,
        sizeInBytes: fileSize,
        hash: `test-${Date.now()}-${i}`,
        ext: '.bin',
        url: '',
      }));

      const startTime = Date.now();
      await Promise.all(files.map((file) => providerInstance.upload(file)));
      const duration = Date.now() - startTime;

      // Verify all files uploaded
      for (const file of files) {
        expect(file.url).toBeTruthy();
      }

      const totalSize = fileSize * numFiles;
      console.log(
        `Uploaded ${numFiles} files (${totalSize / 1024 / 1024}MB total) in ${duration}ms (${(totalSize / 1024 / 1024 / (duration / 1000)).toFixed(2)} MB/s)`,
      );

      // Cleanup
      const storage = new Storage(
        TEST_SERVICE_ACCOUNT
          ? {
              projectId: TEST_SERVICE_ACCOUNT.project_id,
              credentials: TEST_SERVICE_ACCOUNT,
            }
          : undefined,
      );
      const bucket = storage.bucket(TEST_BUCKET_NAME);
      await Promise.all(
        files.map((file) => {
          const fileName = file.url.replace(
            `https://storage.googleapis.com/${TEST_BUCKET_NAME}/`,
            '',
          );
          return bucket.file(fileName).delete();
        }),
      );
    }, 600000);
  });

  describe('Memory Efficiency', () => {
    test('Large buffer converted to stream (>10MB threshold)', async () => {
      if (shouldSkip) return;

      const fileSize = 15 * 1024 * 1024; // 15MB (above 10MB threshold)
      const testFile = await createTestFile(fileSize);

      // Monitor memory usage
      const initialMemory = process.memoryUsage().heapUsed;

      const fs = await import('node:fs');
      const file = {
        buffer: fs.readFileSync(testFile),
        name: 'memory-test.bin',
        mime: 'application/octet-stream',
        size: fileSize / 1024,
        sizeInBytes: fileSize,
        hash: `test-${Date.now()}`,
        ext: '.bin',
        url: '',
      };

      await providerInstance.upload(file);

      const finalMemory = process.memoryUsage().heapUsed;
      const memoryIncrease = finalMemory - initialMemory;

      // Memory increase should be reasonable (not double the file size)
      // Large buffers should be converted to streams
      expect(memoryIncrease).toBeLessThan(fileSize * 1.5); // Allow some overhead
      console.log(
        `Memory increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)}MB for ${(fileSize / 1024 / 1024).toFixed(2)}MB file`,
      );

      // Cleanup
      const storage = new Storage(
        TEST_SERVICE_ACCOUNT
          ? {
              projectId: TEST_SERVICE_ACCOUNT.project_id,
              credentials: TEST_SERVICE_ACCOUNT,
            }
          : undefined,
      );
      const bucket = storage.bucket(TEST_BUCKET_NAME);
      const fileName = file.url.replace(
        `https://storage.googleapis.com/${TEST_BUCKET_NAME}/`,
        '',
      );
      await bucket.file(fileName).delete();
    }, 600000);
  });
});
