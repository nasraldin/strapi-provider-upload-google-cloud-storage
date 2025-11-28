import type { Config } from 'jest';

const config: Config = {
  testMatch: ['**/__tests__/?(*.)+(spec|test).(t|j)s'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: {
          ignoreCodes: [2578, 2322], // Ignore unused @ts-expect-error and type errors in tests
        },
      },
    ],
  },
  preset: 'ts-jest',
  coverageDirectory: './coverage/',
  collectCoverage: true,
  reporters: ['default', 'jest-junit'],
};

export default config;
