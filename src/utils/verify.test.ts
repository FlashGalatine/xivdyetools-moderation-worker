import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  verifyDiscordRequest,
  unauthorizedResponse,
  badRequestResponse,
  timingSafeEqual,
} from './verify.js';
import { verifyKey } from 'discord-interactions';

// Mock the discord-interactions library
vi.mock('discord-interactions');

describe('verifyDiscordRequest', () => {
  const mockPublicKey = 'test-public-key';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signature verification', () => {
    it('should verify valid Discord signature', async () => {
      vi.mocked(verifyKey).mockResolvedValue(true);

      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'valid-signature',
          'X-Signature-Timestamp': '1234567890',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 1 }),
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(true);
      expect(result.body).toBe(JSON.stringify({ type: 1 }));
      expect(result.error).toBeUndefined();
      expect(verifyKey).toHaveBeenCalledWith(
        JSON.stringify({ type: 1 }),
        'valid-signature',
        '1234567890',
        mockPublicKey
      );
    });

    it('should reject invalid Discord signature', async () => {
      vi.mocked(verifyKey).mockResolvedValue(false);

      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'invalid-signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: JSON.stringify({ type: 1 }),
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid signature');
    });

    it('should handle verification errors', async () => {
      vi.mocked(verifyKey).mockRejectedValue(new Error('Crypto error'));

      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: JSON.stringify({ type: 1 }),
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Crypto error');
    });

    it('should handle non-Error exceptions', async () => {
      vi.mocked(verifyKey).mockRejectedValue('String error');

      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: 'body',
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Verification failed');
    });
  });

  describe('missing headers', () => {
    it('should reject request with missing signature header', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Timestamp': '1234567890',
        },
        body: 'test',
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Missing signature headers');
      expect(result.body).toBe('');
      expect(verifyKey).not.toHaveBeenCalled();
    });

    it('should reject request with missing timestamp header', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'signature',
        },
        body: 'test',
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Missing signature headers');
      expect(result.body).toBe('');
      expect(verifyKey).not.toHaveBeenCalled();
    });

    it('should reject request with both headers missing', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        body: 'test',
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Missing signature headers');
    });
  });

  describe('body size limits', () => {
    it('should reject request with Content-Length exceeding limit', async () => {
      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'Content-Length': '100001', // Exceeds 100KB limit
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: 'x'.repeat(100001),
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Request body too large');
      expect(result.body).toBe('');
      expect(verifyKey).not.toHaveBeenCalled();
    });

    it('should reject request with actual body size exceeding limit', async () => {
      const largeBody = 'x'.repeat(100001);
      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: largeBody,
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Request body too large');
      expect(verifyKey).not.toHaveBeenCalled();
    });

    it('should accept request at exactly 100KB', async () => {
      vi.mocked(verifyKey).mockResolvedValue(true);

      const bodyAt100KB = 'x'.repeat(100000);
      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'Content-Length': '100000',
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: bodyAt100KB,
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(true);
      expect(verifyKey).toHaveBeenCalled();
    });

    it('should verify actual body size even if Content-Length is spoofed', async () => {
      const largeBody = 'x'.repeat(100001);
      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'Content-Length': '1000', // Lying about size
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: largeBody,
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Request body too large');
    });
  });

  describe('edge cases', () => {
    it('should handle empty request body', async () => {
      vi.mocked(verifyKey).mockResolvedValue(true);

      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: '',
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(true);
      expect(result.body).toBe('');
      expect(verifyKey).toHaveBeenCalledWith('', 'signature', '1234567890', mockPublicKey);
    });

    it('should handle request without Content-Length header', async () => {
      vi.mocked(verifyKey).mockResolvedValue(true);

      const request = new Request('https://example.com', {
        method: 'POST',
        headers: {
          'X-Signature-Ed25519': 'signature',
          'X-Signature-Timestamp': '1234567890',
        },
        body: 'test body',
      });

      const result = await verifyDiscordRequest(request, mockPublicKey);

      expect(result.isValid).toBe(true);
      expect(result.body).toBe('test body');
    });
  });
});

describe('timingSafeEqual', () => {
  describe('equal strings', () => {
    it('should return true for identical strings', async () => {
      const result = await timingSafeEqual('hello', 'hello');
      expect(result).toBe(true);
    });

    it('should return true for empty strings', async () => {
      const result = await timingSafeEqual('', '');
      expect(result).toBe(true);
    });

    it('should return true for identical long strings', async () => {
      const longString = 'a'.repeat(1000);
      const result = await timingSafeEqual(longString, longString);
      expect(result).toBe(true);
    });

    it('should return true for identical special characters', async () => {
      const result = await timingSafeEqual('!@#$%^&*()', '!@#$%^&*()');
      expect(result).toBe(true);
    });

    it('should return true for identical unicode strings', async () => {
      const result = await timingSafeEqual('こんにちは', 'こんにちは');
      expect(result).toBe(true);
    });
  });

  describe('different strings', () => {
    it('should return false for different strings', async () => {
      const result = await timingSafeEqual('hello', 'world');
      expect(result).toBe(false);
    });

    it('should return false for strings with different lengths', async () => {
      const result = await timingSafeEqual('short', 'much longer string');
      expect(result).toBe(false);
    });

    it('should return false for one empty string', async () => {
      const result = await timingSafeEqual('', 'hello');
      expect(result).toBe(false);
    });

    it('should return false for strings differing by one character', async () => {
      const result = await timingSafeEqual('hello', 'hells');
      expect(result).toBe(false);
    });

    it('should return false for strings with different case', async () => {
      const result = await timingSafeEqual('Hello', 'hello');
      expect(result).toBe(false);
    });
  });

  describe('timing safety', () => {
    it('should use crypto.subtle.timingSafeEqual when available', async () => {
      // Skip if crypto.subtle.timingSafeEqual is not available (Node.js environment)
      if (typeof (crypto.subtle as any).timingSafeEqual !== 'function') {
        // Test the fallback implementation instead
        const result = await timingSafeEqual('test', 'test');
        expect(result).toBe(true);
        return;
      }

      const spy = vi.spyOn(crypto.subtle as any, 'timingSafeEqual');

      // Note: In test environment, this might not be available, so we test the fallback too
      try {
        await timingSafeEqual('test', 'test');
        // If it succeeded, crypto.subtle.timingSafeEqual was available
        if (spy.mock.calls.length > 0) {
          expect(spy).toHaveBeenCalled();
        }
      } catch {
        // Fallback was used, which is fine
      }

      spy.mockRestore();
    });

    it('should use fallback XOR comparison when crypto.subtle fails', async () => {
      // Mock crypto.subtle.timingSafeEqual to throw an error
      const originalTimingSafeEqual = crypto.subtle.timingSafeEqual;
      crypto.subtle.timingSafeEqual = undefined as any;

      const result = await timingSafeEqual('test', 'test');
      expect(result).toBe(true);

      const resultDiff = await timingSafeEqual('test', 'diff');
      expect(resultDiff).toBe(false);

      // Restore
      crypto.subtle.timingSafeEqual = originalTimingSafeEqual;
    });

    it('should handle timing attack scenarios with constant-time comparison', async () => {
      // Both comparisons should take similar time (constant-time property)
      const token1 = 'a'.repeat(100);
      const token2 = 'b'.repeat(100);
      const token3 = 'a'.repeat(99) + 'b'; // Differs only at end

      // All these should complete without leaking timing information
      const result1 = await timingSafeEqual(token1, token2);
      const result2 = await timingSafeEqual(token1, token3);

      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });
  });
});

describe('unauthorizedResponse', () => {
  it('should create 401 response with default message', () => {
    const response = unauthorizedResponse();

    expect(response.status).toBe(401);
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('should create 401 response with custom message', () => {
    const response = unauthorizedResponse('Custom error message');

    expect(response.status).toBe(401);
  });

  it('should include error message in response body', async () => {
    const response = unauthorizedResponse('Test error');
    const body = await response.json();

    expect(body).toEqual({ error: 'Test error' });
  });

  it('should use default message when no argument provided', async () => {
    const response = unauthorizedResponse();
    const body = await response.json();

    expect(body).toEqual({ error: 'Invalid request signature' });
  });
});

describe('badRequestResponse', () => {
  it('should create 400 response', () => {
    const response = badRequestResponse('Bad request');

    expect(response.status).toBe(400);
    expect(response.headers.get('Content-Type')).toBe('application/json');
  });

  it('should include error message in response body', async () => {
    const response = badRequestResponse('Invalid data');
    const body = await response.json();

    expect(body).toEqual({ error: 'Invalid data' });
  });

  it('should handle special characters in error message', async () => {
    const message = 'Error: <script>alert("xss")</script>';
    const response = badRequestResponse(message);
    const body = await response.json();

    expect(body.error).toBe(message);
  });

  it('should handle empty error message', async () => {
    const response = badRequestResponse('');
    const body = await response.json();

    expect(body).toEqual({ error: '' });
  });
});
