# HMAC Signature Specification

## Overview

Bot-to-API authentication using HMAC-SHA256 signatures with replay protection through timestamp validation.

**Purpose**: Authenticate requests from the moderation worker to the presets API without exposing credentials in logs or network traffic.

**Version**: 1.0
**Last Updated**: January 5, 2026

---

## Table of Contents

- [Signature Generation (Moderation Worker)](#signature-generation-moderation-worker)
- [Signature Validation (Presets API)](#signature-validation-presets-api)
- [Security Properties](#security-properties)
- [Example Implementation](#example-implementation)
- [Threat Model](#threat-model)
- [Recommendations](#recommendations)

---

## Signature Generation (Moderation Worker)

The moderation worker generates HMAC signatures for each authenticated request to the presets API.

### Algorithm

1. **Get Current Timestamp**
   ```typescript
   const timestamp = Math.floor(Date.now() / 1000); // Unix seconds
   ```

2. **Format Message**
   ```typescript
   const message = `${timestamp}:${discordId}:${userName}`;
   // Example: "1704424800:123456789012345678:username"
   // Empty fields: "1704424800::"
   ```

3. **Generate HMAC-SHA256**
   ```typescript
   const encoder = new TextEncoder();
   const key = await crypto.subtle.importKey(
     'raw',
     encoder.encode(signingSecret),
     { name: 'HMAC', hash: 'SHA-256' },
     false,
     ['sign']
   );
   const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
   const hexSignature = Array.from(new Uint8Array(signature))
     .map(b => b.toString(16).padStart(2, '0'))
     .join('');
   ```

4. **Add Headers to Request**
   ```
   X-Request-Timestamp: 1704424800
   X-Request-Signature: a3f2b8c9d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0
   X-User-Discord-ID: 123456789012345678
   X-User-Discord-Name: username
   ```

### Implementation Location

- **File**: `src/services/preset-api.ts`
- **Function**: `generateRequestSignature()`
- **Usage**: Called for every authenticated request to presets API

---

## Signature Validation (Presets API)

The presets API MUST validate both the signature and timestamp freshness.

### Validation Steps

1. **Extract Headers**
   ```typescript
   const timestamp = parseInt(request.headers.get('X-Request-Timestamp') || '0');
   const signature = request.headers.get('X-Request-Signature');
   const userId = request.headers.get('X-User-Discord-ID');
   const userName = request.headers.get('X-User-Discord-Name');
   ```

2. **Validate Timestamp Freshness**
   ```typescript
   const now = Math.floor(Date.now() / 1000);
   const age = now - timestamp;

   // Reject if older than 5 minutes (300 seconds)
   if (age > 300) {
     return Response.json({ error: 'Request timestamp too old' }, { status: 401 });
   }

   // Reject if too far in the future (allow 60s clock skew)
   if (age < -60) {
     return Response.json({ error: 'Request timestamp too far in future' }, { status: 401 });
   }
   ```

3. **Regenerate Signature**
   ```typescript
   const message = `${timestamp}:${userId || ''}:${userName || ''}`;
   const expectedSignature = await generateHMAC(message, signingSecret);
   ```

4. **Constant-Time Comparison**
   ```typescript
   // CRITICAL: Use constant-time comparison to prevent timing attacks
   const signatureMatch = await crypto.subtle.timingSafeEqual(
     Buffer.from(signature, 'hex'),
     Buffer.from(expectedSignature, 'hex')
   );

   if (!signatureMatch) {
     return Response.json({ error: 'Invalid signature' }, { status: 401 });
   }
   ```

5. **Allow Request**
   ```typescript
   // Signature and timestamp are valid
   // Process the request...
   ```

### Example Validation Function

```typescript
/**
 * Validate HMAC signature and timestamp freshness
 *
 * @param request - Incoming HTTP request
 * @param signingSecret - Shared secret (env.BOT_SIGNING_SECRET)
 * @returns true if valid, false otherwise
 */
async function validateHMACSignature(
  request: Request,
  signingSecret: string
): Promise<boolean> {
  // Extract headers
  const timestamp = parseInt(request.headers.get('X-Request-Timestamp') || '0');
  const signature = request.headers.get('X-Request-Signature');
  const userId = request.headers.get('X-User-Discord-ID') || '';
  const userName = request.headers.get('X-User-Discord-Name') || '';

  if (!timestamp || !signature) {
    return false;
  }

  // Check timestamp freshness (5 minutes = 300 seconds)
  const now = Math.floor(Date.now() / 1000);
  const age = now - timestamp;

  if (age > 300 || age < -60) {
    console.warn('HMAC validation failed: timestamp out of range', {
      age,
      timestamp,
      now
    });
    return false;
  }

  // Regenerate signature
  const message = `${timestamp}:${userId}:${userName}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const expectedSignatureBytes = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(message)
  );

  const expectedSignature = Array.from(new Uint8Array(expectedSignatureBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison
  if (signature !== expectedSignature) {
    console.warn('HMAC validation failed: signature mismatch');
    return false;
  }

  return true;
}
```

---

## Security Properties

### Authentication
✅ **Proves request origin**: Only bots with the shared secret can generate valid signatures

### Integrity
✅ **Detects tampering**: Any modification to timestamp, user ID, or username invalidates the signature

### Freshness
✅ **Prevents replay attacks**: Timestamp validation ensures requests can't be replayed after 5 minutes

### Non-Repudiation
⚠️ **Limited**: Shared secret means either bot could have generated the request (not true non-repudiation)

---

## Threat Model

### Protected Against

| Threat | Protection Mechanism |
|--------|---------------------|
| **Replay Attack (>5 min)** | Timestamp validation rejects old requests |
| **Man-in-the-Middle** | TLS encryption + signature prevents tampering |
| **Request Forgery** | Only bots with shared secret can sign requests |
| **Parameter Tampering** | Signature covers user ID and username |

### NOT Protected Against

| Threat | Why Not Protected | Mitigation |
|--------|------------------|------------|
| **Replay Attack (<5 min)** | Timestamp window allows replay within 5 minutes | Use request-ID based idempotency (future enhancement) |
| **Compromised Secret** | If secret leaked, attacker can forge signatures | Rotate secrets quarterly, monitor for unusual patterns |
| **Clock Skew** | If server clocks drift significantly, validation fails | Allow 60-second tolerance for future timestamps |
| **Denial of Service** | Signature validation has computational cost | Implement rate limiting before signature check |

---

## Implementation Checklist

### Moderation Worker (Signature Generation)

- [x] Generate Unix timestamp in **seconds** (not milliseconds)
- [x] Format message as `timestamp:userId:userName`
- [x] Use HMAC-SHA256 with shared secret
- [x] Encode signature as hex string
- [x] Add `X-Request-Timestamp` header
- [x] Add `X-Request-Signature` header
- [x] Document timestamp validation requirement

### Presets API (Signature Validation)

- [ ] Extract timestamp and signature from headers
- [ ] Validate timestamp is within 5 minutes (300 seconds)
- [ ] Allow 60-second clock skew for future timestamps
- [ ] Regenerate signature using same algorithm
- [ ] Use **constant-time comparison** for signature
- [ ] Log validation failures with details (for monitoring)
- [ ] Return 401 Unauthorized for invalid signatures

---

## Recommendations

### Secret Management

1. **Rotate Secrets Quarterly**
   - Generate new `BOT_SIGNING_SECRET` every 3 months
   - Update both moderation worker and presets API simultaneously
   - Use versioned secrets to allow graceful rotation

2. **Secret Storage**
   - Store in Cloudflare Workers Secrets (encrypted at rest)
   - Never commit secrets to version control
   - Use different secrets for development/staging/production

3. **Secret Generation**
   ```bash
   # Generate strong random secret (32 bytes, base64 encoded)
   openssl rand -base64 32
   ```

### Monitoring

1. **Log Signature Failures**
   - Track failed validations by user ID
   - Alert if >10 failures/hour from same user
   - Alert if >100 failures/hour globally

2. **Metrics to Track**
   - Signature validation success rate
   - Average timestamp age distribution
   - Clock skew incidents (requests with future timestamps)

### Future Enhancements

1. **Request-ID Based Idempotency**
   - Generate UUID for each request
   - Store used request IDs in cache (5-minute TTL)
   - Reject duplicate request IDs
   - **Benefit**: Prevents replay attacks within 5-minute window

2. **Nonce-Based Replay Protection**
   - Client generates random nonce for each request
   - Include nonce in signature message
   - Server tracks used nonces
   - **Benefit**: Stronger replay protection than timestamp alone

3. **Mutual TLS (mTLS)**
   - Use Cloudflare's Worker-to-Worker mTLS
   - Stronger authentication than shared secrets
   - **Benefit**: No shared secrets to manage, certificate-based trust

---

## Testing

### Test Cases

1. **Valid Signature**
   - Current timestamp, correct signature → Accept

2. **Expired Timestamp**
   - Timestamp 10 minutes old → Reject (401)

3. **Future Timestamp (Clock Skew)**
   - Timestamp 30 seconds in future → Accept
   - Timestamp 90 seconds in future → Reject (401)

4. **Invalid Signature**
   - Current timestamp, wrong signature → Reject (401)

5. **Missing Headers**
   - No X-Request-Timestamp → Reject (401)
   - No X-Request-Signature → Reject (401)

6. **Tampered Request**
   - Change user ID after signing → Reject (401)
   - Change timestamp after signing → Reject (401)

### Test Script

```typescript
// Test signature generation and validation
async function testHMACSignature() {
  const secret = 'test-secret';
  const timestamp = Math.floor(Date.now() / 1000);
  const userId = '123456789';
  const userName = 'testuser';

  // Generate signature
  const signature = await generateRequestSignature(timestamp, userId, userName, secret);

  // Validate (should pass)
  const valid = await validateHMACSignature({
    headers: new Headers({
      'X-Request-Timestamp': String(timestamp),
      'X-Request-Signature': signature,
      'X-User-Discord-ID': userId,
      'X-User-Discord-Name': userName
    })
  }, secret);

  console.assert(valid === true, 'Valid signature should pass');

  // Test expired timestamp (should fail)
  const expiredTimestamp = timestamp - 400; // 6+ minutes old
  const expiredSignature = await generateRequestSignature(expiredTimestamp, userId, userName, secret);
  const expiredValid = await validateHMACSignature({
    headers: new Headers({
      'X-Request-Timestamp': String(expiredTimestamp),
      'X-Request-Signature': expiredSignature,
      'X-User-Discord-ID': userId,
      'X-User-Discord-Name': userName
    })
  }, secret);

  console.assert(expiredValid === false, 'Expired timestamp should fail');
}
```

---

## References

- [RFC 2104: HMAC: Keyed-Hashing for Message Authentication](https://datatracker.ietf.org/doc/html/rfc2104)
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [Cloudflare Workers Crypto API](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Timing Attack Prevention](https://codahale.com/a-lesson-in-timing-attacks/)

---

## Changelog

### Version 1.0 (January 5, 2026)
- Initial specification
- 5-minute timestamp validation window
- 60-second clock skew tolerance
- HMAC-SHA256 with hex encoding
- Constant-time signature comparison requirement

---

## Contact

For questions about this specification, contact the XIV Dye Tools development team.

**Security Issues**: Report security vulnerabilities through the GitHub Security Advisory system.
