import { vi } from 'vitest';

// Global test setup — runs before each test file.
// Add global mocks or polyfills here if needed.

// Suppress console.warn output from withRetry backoff logs during tests.
vi.spyOn(console, 'warn').mockImplementation(() => {});
