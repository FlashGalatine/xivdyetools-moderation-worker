import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createMockKV } from '@xivdyetools/test-utils';
import {
  checkRateLimit,
  incrementRateLimit,
  getRateLimitInfo,
  rateLimitMiddleware,
  RATE_LIMIT_CONFIGS,
  type RateLimitConfig,
} from './rate-limit.js';

describe('rate-limit', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    vi.useFakeTimers();
    // Set a fixed time for consistent testing
    vi.setSystemTime(new Date('2024-01-15T12:30:30.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('RATE_LIMIT_CONFIGS', () => {
    it('should have command config with correct values', () => {
      expect(RATE_LIMIT_CONFIGS.command).toEqual({
        requestsPerMinute: 20,
        burstAllowance: 5,
      });
    });

    it('should have autocomplete config with correct values', () => {
      expect(RATE_LIMIT_CONFIGS.autocomplete).toEqual({
        requestsPerMinute: 60,
        burstAllowance: 10,
      });
    });
  });

  describe('checkRateLimit', () => {
    const testConfig: RateLimitConfig = {
      requestsPerMinute: 10,
      burstAllowance: 2,
    };

    it('should allow requests when under limit', async () => {
      const result = await checkRateLimit(mockKV, 'user123', 'command', testConfig);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(11); // 10 + 2 - 1 = 11
      expect(result.retryAfter).toBeUndefined();
    });

    it('should calculate correct remaining requests', async () => {
      // Set current count to 5
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      await mockKV.put(key, '5');

      const result = await checkRateLimit(mockKV, 'user123', 'command', testConfig);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(6); // 12 - 5 - 1 = 6
    });

    it('should deny requests when at limit', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      // Set count to effective limit (10 + 2 = 12)
      await mockKV.put(key, '12');

      const result = await checkRateLimit(mockKV, 'user123', 'command', testConfig);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeGreaterThan(0);
    });

    it('should deny requests when over limit', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      await mockKV.put(key, '15');

      const result = await checkRateLimit(mockKV, 'user123', 'command', testConfig);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('should calculate correct reset time', async () => {
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const expectedResetTime = (currentMinute + 1) * 60000;

      const result = await checkRateLimit(mockKV, 'user123', 'command', testConfig);

      expect(result.resetTime).toBe(expectedResetTime);
    });

    it('should handle config without burst allowance', async () => {
      const configNoBurst: RateLimitConfig = {
        requestsPerMinute: 10,
      };

      const result = await checkRateLimit(mockKV, 'user123', 'command', configNoBurst);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9); // 10 - 0 - 1 = 9
    });

    it('should calculate retryAfter correctly', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      await mockKV.put(key, '12');

      const result = await checkRateLimit(mockKV, 'user123', 'command', testConfig);

      const currentMinute = Math.floor(now / 60000);
      const resetTime = (currentMinute + 1) * 60000;
      const expectedRetryAfter = Math.ceil((resetTime - now) / 1000);

      expect(result.retryAfter).toBe(expectedRetryAfter);
    });

    it('should fail open on KV error', async () => {
      const errorKV = {
        get: vi.fn().mockRejectedValue(new Error('KV error')),
      } as unknown as KVNamespace;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await checkRateLimit(errorKV, 'user123', 'command', testConfig);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(10); // Returns config limit on error
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should handle autocomplete type', async () => {
      const result = await checkRateLimit(mockKV, 'user456', 'autocomplete', RATE_LIMIT_CONFIGS.autocomplete);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(69); // 60 + 10 - 1 = 69
    });

    it('should track different users separately', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key1 = `ratelimit:command:user1:${minute}`;
      const key2 = `ratelimit:command:user2:${minute}`;
      await mockKV.put(key1, '10');
      await mockKV.put(key2, '5');

      const result1 = await checkRateLimit(mockKV, 'user1', 'command', testConfig);
      const result2 = await checkRateLimit(mockKV, 'user2', 'command', testConfig);

      expect(result1.remaining).toBe(1); // 12 - 10 - 1 = 1
      expect(result2.remaining).toBe(6); // 12 - 5 - 1 = 6
    });

    it('should track different types separately', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const commandKey = `ratelimit:command:user123:${minute}`;
      const autocompleteKey = `ratelimit:autocomplete:user123:${minute}`;
      await mockKV.put(commandKey, '20');
      await mockKV.put(autocompleteKey, '5');

      const commandResult = await checkRateLimit(mockKV, 'user123', 'command', testConfig);
      const autocompleteResult = await checkRateLimit(mockKV, 'user123', 'autocomplete', RATE_LIMIT_CONFIGS.autocomplete);

      expect(commandResult.allowed).toBe(false); // Over limit
      expect(autocompleteResult.allowed).toBe(true); // Under limit
    });
  });

  describe('incrementRateLimit', () => {
    it('should increment counter from 0', async () => {
      await incrementRateLimit(mockKV, 'user123', 'command');

      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      const value = await mockKV.get(key);

      expect(value).toBe('1');
    });

    it('should increment existing counter', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      await mockKV.put(key, '5', { metadata: { version: 1 } });

      await incrementRateLimit(mockKV, 'user123', 'command');

      const value = await mockKV.get(key);
      expect(value).toBe('6');
    });

    it('should set TTL on counter', async () => {
      const putSpy = vi.spyOn(mockKV, 'put');

      await incrementRateLimit(mockKV, 'user123', 'command');

      expect(putSpy).toHaveBeenCalledWith(
        expect.any(String),
        '1',
        expect.objectContaining({ expirationTtl: 120 })
      );
    });

    it('should handle KV errors gracefully', async () => {
      const errorKV = {
        getWithMetadata: vi.fn().mockRejectedValue(new Error('KV error')),
      } as unknown as KVNamespace;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw
      await incrementRateLimit(errorKV, 'user123', 'command', 1);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should use autocomplete type in key', async () => {
      await incrementRateLimit(mockKV, 'user123', 'autocomplete');

      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:autocomplete:user123:${minute}`;
      const value = await mockKV.get(key);

      expect(value).toBe('1');
    });

    it('should store version metadata', async () => {
      await incrementRateLimit(mockKV, 'user123', 'command');

      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      const result = await mockKV.getWithMetadata(key);

      expect(result.metadata).toEqual({ version: 1 });
    });

    it('should increment version on subsequent calls', async () => {
      await incrementRateLimit(mockKV, 'user123', 'command');
      await incrementRateLimit(mockKV, 'user123', 'command');

      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      const value = await mockKV.get(key);

      expect(value).toBe('2');
    });

    it('should respect maxRetries parameter', async () => {
      let attempts = 0;
      const errorKV = {
        getWithMetadata: vi.fn().mockImplementation(() => {
          attempts++;
          throw new Error('KV error');
        }),
      } as unknown as KVNamespace;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await incrementRateLimit(errorKV, 'user123', 'command', 2);

      expect(attempts).toBe(2);
      consoleSpy.mockRestore();
    });
  });

  describe('getRateLimitInfo', () => {
    it('should return current count of 0 for new users', async () => {
      const result = await getRateLimitInfo(mockKV, 'newuser', 'command');

      expect(result.current).toBe(0);
      expect(result.limit).toBe(25); // 20 + 5
    });

    it('should return current count from KV', async () => {
      const now = Date.now();
      const minute = Math.floor(now / 60000);
      const key = `ratelimit:command:user123:${minute}`;
      await mockKV.put(key, '7');

      const result = await getRateLimitInfo(mockKV, 'user123', 'command');

      expect(result.current).toBe(7);
    });

    it('should return correct limit for command type', async () => {
      const result = await getRateLimitInfo(mockKV, 'user123', 'command');

      expect(result.limit).toBe(25); // 20 + 5
    });

    it('should return correct limit for autocomplete type', async () => {
      const result = await getRateLimitInfo(mockKV, 'user123', 'autocomplete');

      expect(result.limit).toBe(70); // 60 + 10
    });

    it('should return correct reset time', async () => {
      const now = Date.now();
      const currentMinute = Math.floor(now / 60000);
      const expectedResetTime = (currentMinute + 1) * 60000;

      const result = await getRateLimitInfo(mockKV, 'user123', 'command');

      expect(result.resetTime).toBe(expectedResetTime);
    });

    it('should handle KV errors gracefully', async () => {
      const errorKV = {
        get: vi.fn().mockRejectedValue(new Error('KV error')),
      } as unknown as KVNamespace;
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await getRateLimitInfo(errorKV, 'user123', 'command');

      expect(result.current).toBe(0);
      expect(result.limit).toBe(20); // Returns base limit on error
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('rateLimitMiddleware', () => {
    it('should pass through to next middleware', async () => {
      const mockContext = {
        env: {},
      } as unknown as Parameters<typeof rateLimitMiddleware>[0];
      const next = vi.fn().mockResolvedValue(undefined);

      await rateLimitMiddleware(mockContext, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
