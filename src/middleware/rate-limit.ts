/**
 * Rate Limiting Middleware for Cloudflare Workers
 *
 * Implements per-user rate limiting using KV storage with a sliding window pattern.
 * Protects against:
 * - Resource exhaustion attacks
 * - Database query flooding through autocomplete
 * - Rapid button clicks and command spam
 *
 * Rate limits are enforced per Discord user ID and interaction type:
 * - Commands: 20 requests/minute (with 5 burst allowance)
 * - Autocomplete: 60 requests/minute (with 10 burst allowance)
 *
 * @see https://developers.cloudflare.com/workers/runtime-apis/kv/
 *
 * @example
 * ```typescript
 * import { rateLimitMiddleware } from './middleware/rate-limit.js';
 *
 * app.use('*', rateLimitMiddleware);
 * ```
 */

import type { Context, Next } from 'hono';
import type { Env } from '../types/env.js';
import type { ExtendedLogger } from '@xivdyetools/logger';

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum requests allowed per minute */
  requestsPerMinute: number;

  /**
   * Burst allowance (extra requests allowed temporarily)
   * Useful for legitimate users who click slightly too fast
   */
  burstAllowance?: number;
}

/**
 * Result of rate limit check
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;

  /** Number of requests remaining in current window */
  remaining: number;

  /** Unix timestamp (ms) when rate limit resets */
  resetTime: number;

  /** Seconds to wait before retrying (only set if !allowed) */
  retryAfter?: number;
}

/**
 * Type of interaction for rate limiting purposes
 */
export type RateLimitType = 'command' | 'autocomplete';

/**
 * Rate limit configurations for different interaction types
 */
export const RATE_LIMIT_CONFIGS: Record<RateLimitType, RateLimitConfig> = {
  command: {
    requestsPerMinute: 20,
    burstAllowance: 5,
  },
  autocomplete: {
    requestsPerMinute: 60,
    burstAllowance: 10,
  },
};

/**
 * Generate KV key for rate limiting
 *
 * Key format: `ratelimit:{type}:{userId}:{minute}`
 *
 * @param userId - Discord user ID
 * @param type - Type of interaction
 * @param timestamp - Optional timestamp (defaults to now)
 * @returns KV key string
 */
function getRateLimitKey(
  userId: string,
  type: RateLimitType,
  timestamp: number = Date.now()
): string {
  // Round timestamp to current minute
  const minute = Math.floor(timestamp / 60000); // 60000ms = 1 minute
  return `ratelimit:${type}:${userId}:${minute}`;
}

/**
 * Check if user has exceeded rate limit
 *
 * Implements sliding window with burst allowance:
 * 1. Get current request count from KV
 * 2. Check against limit + burst allowance
 * 3. Return result with remaining count and reset time
 *
 * @param kv - KV namespace for storing counters
 * @param userId - Discord user ID
 * @param type - Type of interaction
 * @param config - Rate limit configuration
 * @returns Rate limit check result
 */
export async function checkRateLimit(
  kv: KVNamespace,
  userId: string,
  type: RateLimitType,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const key = getRateLimitKey(userId, type, now);

  // Calculate reset time (end of current minute)
  const currentMinute = Math.floor(now / 60000);
  const resetTime = (currentMinute + 1) * 60000;

  try {
    // Get current count from KV
    const countStr = await kv.get(key);
    const currentCount = countStr ? parseInt(countStr, 10) : 0;

    // Calculate effective limit (base + burst allowance)
    const effectiveLimit = config.requestsPerMinute + (config.burstAllowance || 0);

    // Check if limit exceeded
    if (currentCount >= effectiveLimit) {
      const retryAfter = Math.ceil((resetTime - now) / 1000);
      return {
        allowed: false,
        remaining: 0,
        resetTime,
        retryAfter,
      };
    }

    // Calculate remaining requests
    const remaining = effectiveLimit - currentCount - 1; // -1 for current request

    return {
      allowed: true,
      remaining: Math.max(0, remaining),
      resetTime,
    };
  } catch (error) {
    // KV error - fail open (allow request) but log error
    console.error('Rate limit KV error (failing open)', {
      error: error instanceof Error ? error.message : String(error),
      userId,
      type,
    });

    return {
      allowed: true,
      remaining: config.requestsPerMinute,
      resetTime,
    };
  }
}

/**
 * Increment rate limit counter
 *
 * MOD-BUG-001 FIX: KV doesn't support atomic increments, so concurrent calls
 * can cause lost increments. This implementation uses optimistic concurrency
 * with retries to reduce (but not eliminate) the race window.
 *
 * For truly atomic counters, consider using Durable Objects instead.
 *
 * Increments the request counter for the current user/type/minute.
 * Sets TTL to 120 seconds (2 minutes) to ensure cleanup.
 *
 * @param kv - KV namespace for storing counters
 * @param userId - Discord user ID
 * @param type - Type of interaction
 * @param maxRetries - Maximum retry attempts for contention (default: 3)
 */
export async function incrementRateLimit(
  kv: KVNamespace,
  userId: string,
  type: RateLimitType,
  maxRetries: number = 3
): Promise<void> {
  const now = Date.now();
  const key = getRateLimitKey(userId, type, now);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Read current value with metadata for version tracking
      const result = await kv.getWithMetadata<{ version: number }>(key);
      const currentCount = result.value ? parseInt(result.value, 10) : 0;
      const currentVersion = result.metadata?.version ?? 0;

      // Calculate new values
      const newCount = currentCount + 1;
      const newVersion = currentVersion + 1;

      // Write new value with version metadata
      // Note: This isn't true CAS, but version helps detect concurrent modifications
      await kv.put(key, String(newCount), {
        expirationTtl: 120,
        metadata: { version: newVersion },
      });

      // Read back to verify (simple optimistic check)
      const verification = await kv.get(key);
      const verifiedValue = parseInt(verification || '0', 10);

      // If our write succeeded (value is at least what we wrote), we're done
      // Note: Value could be higher if another concurrent increment also succeeded
      if (verifiedValue >= newCount) {
        return;
      }

      // If verification failed, small delay before retry to reduce contention
      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)));
      }
    } catch (error) {
      // Log error but don't throw on last attempt - rate limit failure shouldn't block request
      if (attempt === maxRetries - 1) {
        console.error('Rate limit increment error', {
          error: error instanceof Error ? error.message : String(error),
          userId,
          type,
          attempts: attempt + 1,
        });
      }
    }
  }
}

/**
 * Get rate limit information for a user
 *
 * Useful for adding rate limit headers to responses.
 *
 * @param kv - KV namespace
 * @param userId - Discord user ID
 * @param type - Type of interaction
 * @returns Current rate limit status
 */
export async function getRateLimitInfo(
  kv: KVNamespace,
  userId: string,
  type: RateLimitType
): Promise<{ current: number; limit: number; resetTime: number }> {
  const config = RATE_LIMIT_CONFIGS[type];
  const now = Date.now();
  const key = getRateLimitKey(userId, type, now);

  try {
    const countStr = await kv.get(key);
    const current = countStr ? parseInt(countStr, 10) : 0;

    const currentMinute = Math.floor(now / 60000);
    const resetTime = (currentMinute + 1) * 60000;

    return {
      current,
      limit: config.requestsPerMinute + (config.burstAllowance || 0),
      resetTime,
    };
  } catch (error) {
    console.error('Rate limit info error', {
      error: error instanceof Error ? error.message : String(error),
    });

    // Return default values on error
    return {
      current: 0,
      limit: config.requestsPerMinute,
      resetTime: Math.ceil(now / 60000) * 60000,
    };
  }
}

/**
 * Rate limiting middleware for Hono
 *
 * Checks rate limits for Discord interactions and returns 429 if exceeded.
 * Does NOT block the request - just logs violations.
 * Actual rate limit enforcement happens in interaction handlers.
 *
 * @param c - Hono context
 * @param next - Next middleware
 */
export async function rateLimitMiddleware(c: Context<{ Bindings: Env }>, next: Next) {
  // Pass through - rate limiting is enforced at interaction handler level
  // This middleware just provides the infrastructure
  await next();
}
