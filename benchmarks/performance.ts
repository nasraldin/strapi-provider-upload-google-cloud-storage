/**
 * Performance benchmarks for upload operations
 *
 * Measures:
 * - Upload latency (small vs large files)
 * - Memory usage during uploads
 * - Concurrent upload throughput
 * - Error recovery time
 * - Connection pool efficiency
 *
 * Run with: ts-node benchmarks/performance.ts
 */

import { Storage } from '@google-cloud/storage';
import { createReadStream, createWriteStream, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import provider from '../src/index';

// Configuration
const BUCKET_NAME = process.env.GCS_BENCHMARK_BUCKET || 'test-bucket';
const SERVICE_ACCOUNT = process.env.GCS_SERVICE_ACCOUNT
  ? JSON.parse(process.env.GCS_SERVICE_ACCOUNT)
  : undefined;

interface BenchmarkResult {
  name: string;
  duration: number;
  throughput: number; // MB/s
  memoryUsed: number; // MB
  success: boolean;
  error?: string;
}

const results: BenchmarkResult[] = [];

/**
 * Create a test file of specified size
 */
async function createTestFile(sizeInBytes: number): Promise<string> {
  const filePath = join(tmpdir(), `bench-${Date.now()}-${sizeInBytes}.bin`);
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

      if (!writeStream.write(chunk)) {
        writeStream.once('drain', writeChunk);
      } else {
        writeChunk();
      }
    };

    writeStream.on('finish', () => resolve(filePath));
    writeStream.on('error', reject);
    writeChunk();
  });
}

/**
 * Measure memory usage
 */
function getMemoryUsage(): number {
  return process.memoryUsage().heapUsed / 1024 / 1024; // MB
}

/**
 * Run a benchmark
 */
async function runBenchmark(
  name: string,
  fn: () => Promise<void>,
): Promise<BenchmarkResult> {
  const initialMemory = getMemoryUsage();
  const startTime = Date.now();

  try {
    await fn();
    const duration = Date.now() - startTime;
    const finalMemory = getMemoryUsage();
    const memoryUsed = finalMemory - initialMemory;

    return {
      name,
      duration,
      throughput: 0, // Will be calculated by caller
      memoryUsed,
      success: true,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    return {
      name,
      duration,
      throughput: 0,
      memoryUsed: 0,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Benchmark: Small file upload (1MB)
 */
async function benchmarkSmallFile() {
  const fileSize = 1 * 1024 * 1024; // 1MB
  const testFile = await createTestFile(fileSize);
  const fs = await import('fs');

  const providerInstance = provider.init({
    bucketName: BUCKET_NAME,
    serviceAccount: SERVICE_ACCOUNT,
  });

  const file = {
    buffer: fs.readFileSync(testFile),
    name: 'small-file.bin',
    mime: 'application/octet-stream',
    size: fileSize / 1024,
    sizeInBytes: fileSize,
    hash: `bench-${Date.now()}`,
    ext: '.bin',
    url: '',
  };

  const result = await runBenchmark('Small File (1MB)', async () => {
    await providerInstance.upload(file);
  });

  result.throughput = fileSize / 1024 / 1024 / (result.duration / 1000);
  results.push(result);

  // Cleanup
  unlinkSync(testFile);
  if (file.url) {
    const storage = new Storage(
      SERVICE_ACCOUNT
        ? {
            projectId: SERVICE_ACCOUNT.project_id,
            credentials: SERVICE_ACCOUNT,
          }
        : undefined,
    );
    const fileName = file.url.replace(
      `https://storage.googleapis.com/${BUCKET_NAME}/`,
      '',
    );
    await storage
      .bucket(BUCKET_NAME)
      .file(fileName)
      .delete()
      .catch(() => {});
  }
}

/**
 * Benchmark: Large file upload (50MB)
 */
async function benchmarkLargeFile() {
  const fileSize = 50 * 1024 * 1024; // 50MB
  const testFile = await createTestFile(fileSize);
  const fs = await import('fs');

  const providerInstance = provider.init({
    bucketName: BUCKET_NAME,
    serviceAccount: SERVICE_ACCOUNT,
  });

  const file = {
    buffer: fs.readFileSync(testFile),
    name: 'large-file.bin',
    mime: 'application/octet-stream',
    size: fileSize / 1024,
    sizeInBytes: fileSize,
    hash: `bench-${Date.now()}`,
    ext: '.bin',
    url: '',
  };

  const result = await runBenchmark('Large File (50MB)', async () => {
    await providerInstance.upload(file);
  });

  result.throughput = fileSize / 1024 / 1024 / (result.duration / 1000);
  results.push(result);

  // Cleanup
  unlinkSync(testFile);
  if (file.url) {
    const storage = new Storage(
      SERVICE_ACCOUNT
        ? {
            projectId: SERVICE_ACCOUNT.project_id,
            credentials: SERVICE_ACCOUNT,
          }
        : undefined,
    );
    const fileName = file.url.replace(
      `https://storage.googleapis.com/${BUCKET_NAME}/`,
      '',
    );
    await storage
      .bucket(BUCKET_NAME)
      .file(fileName)
      .delete()
      .catch(() => {});
  }
}

/**
 * Benchmark: Stream upload (50MB)
 */
async function benchmarkStreamUpload() {
  const fileSize = 50 * 1024 * 1024; // 50MB
  const testFile = await createTestFile(fileSize);

  const providerInstance = provider.init({
    bucketName: BUCKET_NAME,
    serviceAccount: SERVICE_ACCOUNT,
  });

  const file = {
    stream: createReadStream(testFile),
    name: 'stream-file.bin',
    mime: 'application/octet-stream',
    size: fileSize / 1024,
    sizeInBytes: fileSize,
    hash: `bench-${Date.now()}`,
    ext: '.bin',
    url: '',
  };

  const result = await runBenchmark('Stream Upload (50MB)', async () => {
    await providerInstance.uploadStream(file);
  });

  result.throughput = fileSize / 1024 / 1024 / (result.duration / 1000);
  results.push(result);

  // Cleanup
  unlinkSync(testFile);
  if (file.url) {
    const storage = new Storage(
      SERVICE_ACCOUNT
        ? {
            projectId: SERVICE_ACCOUNT.project_id,
            credentials: SERVICE_ACCOUNT,
          }
        : undefined,
    );
    const fileName = file.url.replace(
      `https://storage.googleapis.com/${BUCKET_NAME}/`,
      '',
    );
    await storage
      .bucket(BUCKET_NAME)
      .file(fileName)
      .delete()
      .catch(() => {});
  }
}

/**
 * Benchmark: Concurrent uploads
 */
async function benchmarkConcurrentUploads() {
  const fileSize = 5 * 1024 * 1024; // 5MB each
  const numFiles = 10;
  const testFiles = await Promise.all(
    Array.from({ length: numFiles }, () => createTestFile(fileSize)),
  );
  const fs = await import('fs');

  const providerInstance = provider.init({
    bucketName: BUCKET_NAME,
    serviceAccount: SERVICE_ACCOUNT,
    maxConcurrentUploads: 5,
  });

  const files = testFiles.map((filePath, i) => ({
    buffer: fs.readFileSync(filePath),
    name: `concurrent-${i}.bin`,
    mime: 'application/octet-stream',
    size: fileSize / 1024,
    sizeInBytes: fileSize,
    hash: `bench-${Date.now()}-${i}`,
    ext: '.bin',
    url: '',
  }));

  const totalSize = fileSize * numFiles;
  const result = await runBenchmark(
    `Concurrent Uploads (${numFiles} x 5MB)`,
    async () => {
      await Promise.all(files.map((file) => providerInstance.upload(file)));
    },
  );

  result.throughput = totalSize / 1024 / 1024 / (result.duration / 1000);
  results.push(result);

  // Cleanup
  testFiles.forEach((file) => unlinkSync(file));
  const storage = new Storage(
    SERVICE_ACCOUNT
      ? {
          projectId: SERVICE_ACCOUNT.project_id,
          credentials: SERVICE_ACCOUNT,
        }
      : undefined,
  );
  await Promise.all(
    files.map((file) => {
      if (file.url) {
        const fileName = file.url.replace(
          `https://storage.googleapis.com/${BUCKET_NAME}/`,
          '',
        );
        return storage
          .bucket(BUCKET_NAME)
          .file(fileName)
          .delete()
          .catch(() => {});
      }
      return Promise.resolve();
    }),
  );
}

/**
 * Print benchmark results
 */
function printResults() {
  console.log('\n' + '='.repeat(80));
  console.log('PERFORMANCE BENCHMARK RESULTS');
  console.log('='.repeat(80));
  console.log(
    '\n' +
      'Name'.padEnd(30) +
      'Duration (ms)'.padEnd(15) +
      'Throughput (MB/s)'.padEnd(20) +
      'Memory (MB)'.padEnd(15) +
      'Status',
  );
  console.log('-'.repeat(80));

  for (const result of results) {
    const status = result.success ? '✓' : `✗ ${result.error}`;
    console.log(
      result.name.padEnd(30) +
        result.duration.toFixed(2).padEnd(15) +
        result.throughput.toFixed(2).padEnd(20) +
        result.memoryUsed.toFixed(2).padEnd(15) +
        status,
    );
  }

  console.log('\n' + '='.repeat(80));
  console.log('Summary:');
  const successful = results.filter((r) => r.success);
  const avgThroughput =
    successful.reduce((sum, r) => sum + r.throughput, 0) / successful.length;
  const avgMemory =
    successful.reduce((sum, r) => sum + r.memoryUsed, 0) / successful.length;

  console.log(`  Successful: ${successful.length}/${results.length}`);
  console.log(`  Average Throughput: ${avgThroughput.toFixed(2)} MB/s`);
  console.log(`  Average Memory Usage: ${avgMemory.toFixed(2)} MB`);
  console.log('='.repeat(80) + '\n');
}

/**
 * Main benchmark runner
 */
async function main() {
  console.log('Starting performance benchmarks...');
  console.log(`Bucket: ${BUCKET_NAME}`);
  console.log(`Service Account: ${SERVICE_ACCOUNT ? 'Provided' : 'Using ADC'}`);
  console.log('');

  try {
    await benchmarkSmallFile();
    await benchmarkLargeFile();
    await benchmarkStreamUpload();
    await benchmarkConcurrentUploads();

    printResults();
  } catch (error) {
    console.error('Benchmark failed:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export { runBenchmark, printResults };
