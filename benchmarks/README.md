# Performance Benchmarks

This directory contains performance benchmarks for the Strapi GCS upload provider.

## Running Benchmarks

### Prerequisites

Set the following environment variables:

```bash
export GCS_BENCHMARK_BUCKET="your-test-bucket-name"
export GCS_SERVICE_ACCOUNT='{"project_id":"...","client_email":"...","private_key":"..."}'
```

Or use Application Default Credentials (ADC) in GCP environments.

### Run Benchmarks

```bash
# Using ts-node
npx ts-node benchmarks/performance.ts

# Or compile and run
yarn build
node dist/benchmarks/performance.js
```

## Benchmarks Included

1. **Small File Upload (1MB)**
   - Measures latency for small file uploads
   - Tests buffer-based upload path

2. **Large File Upload (50MB)**
   - Measures throughput for large file uploads
   - Tests automatic buffer-to-stream conversion
   - Tests resumable upload functionality

3. **Stream Upload (50MB)**
   - Measures stream-based upload performance
   - Tests memory efficiency

4. **Concurrent Uploads (10 x 5MB)**
   - Measures concurrent upload throughput
   - Tests queue management and connection pooling

## Metrics Collected

- **Duration**: Time taken for operation (ms)
- **Throughput**: Data transfer rate (MB/s)
- **Memory Usage**: Heap memory increase during operation (MB)
- **Success Rate**: Whether operation completed successfully

## Expected Results

Typical performance on good network connection:

- Small File (1MB): ~100-500ms, 2-10 MB/s
- Large File (50MB): ~5-20s, 2.5-10 MB/s
- Stream Upload (50MB): ~5-20s, 2.5-10 MB/s
- Concurrent (10 x 5MB): ~10-30s, 1.5-5 MB/s total

_Note: Actual results depend on network conditions, GCS region, and system resources._
