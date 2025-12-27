/**
 * Discord Request Signature Verification
 *
 * Discord requires all incoming interactions to be verified using Ed25519 signatures.
 * This prevents attackers from sending fake interactions to your endpoint.
 *
 * @see https://discord.com/developers/docs/interactions/receiving-and-responding#security-and-authorization
 */

import { verifyKey } from 'discord-interactions';

export interface VerificationResult {
  /** Whether the signature is valid */
  isValid: boolean;
  /** The raw request body (needed for parsing after verification) */
  body: string;
  /** Error message if verification failed */
  error?: string;
}

// Maximum request body size (100KB should be plenty for Discord interactions)
const MAX_BODY_SIZE = 100_000;

/**
 * Verifies that a request came from Discord using Ed25519 signature verification.
 *
 * @param request - The incoming HTTP request
 * @param publicKey - Your Discord application's public key
 * @returns Verification result with the request body
 */
export async function verifyDiscordRequest(
  request: Request,
  publicKey: string
): Promise<VerificationResult> {
  // Check Content-Length header first (if present) to reject obviously large requests
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
    return {
      isValid: false,
      body: '',
      error: 'Request body too large',
    };
  }

  // Get required headers
  const signature = request.headers.get('X-Signature-Ed25519');
  const timestamp = request.headers.get('X-Signature-Timestamp');

  if (!signature || !timestamp) {
    return {
      isValid: false,
      body: '',
      error: 'Missing signature headers',
    };
  }

  // Get the raw body
  const body = await request.text();

  // Verify actual body size (Content-Length can be spoofed)
  if (body.length > MAX_BODY_SIZE) {
    return {
      isValid: false,
      body: '',
      error: 'Request body too large',
    };
  }

  // Verify the signature
  try {
    const isValid = await verifyKey(body, signature, timestamp, publicKey);

    return {
      isValid,
      body,
      error: isValid ? undefined : 'Invalid signature',
    };
  } catch (error) {
    return {
      isValid: false,
      body,
      error: error instanceof Error ? error.message : 'Verification failed',
    };
  }
}

/**
 * Creates a 401 Unauthorized response for failed verification.
 */
export function unauthorizedResponse(message = 'Invalid request signature'): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Creates a 400 Bad Request response.
 */
export function badRequestResponse(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Performs a constant-time string comparison to prevent timing attacks.
 */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);

  const maxLength = Math.max(aBytes.length, bBytes.length);

  const aPadded = new Uint8Array(maxLength);
  const bPadded = new Uint8Array(maxLength);
  aPadded.set(aBytes);
  bPadded.set(bBytes);

  try {
    const result = await crypto.subtle.timingSafeEqual(aPadded, bPadded);
    return result && aBytes.length === bBytes.length;
  } catch {
    let diff = aBytes.length ^ bBytes.length;
    for (let i = 0; i < maxLength; i++) {
      diff |= aPadded[i] ^ bPadded[i];
    }
    return diff === 0;
  }
}
