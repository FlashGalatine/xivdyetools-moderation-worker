/**
 * Preset API Client (Moderation-focused)
 *
 * Functional module for communicating with the xivdyetools-worker preset API.
 * This is a subset containing only moderation-related functions.
 *
 * Uses Cloudflare Service Bindings for Worker-to-Worker communication when available.
 *
 * @module services/preset-api
 */

import type { Env } from '../types/env.js';
import type { ExtendedLogger } from '@xivdyetools/logger';
import type {
  CommunityPreset,
  PresetListResponse,
  ModerationStats,
  ModerationLogEntry,
  PresetFilters,
} from '../types/preset.js';
import { PresetAPIError } from '../types/preset.js';

// ============================================================================
// HMAC Signature Generation
// ============================================================================

/**
 * Generate HMAC-SHA256 signature for bot authentication
 */
async function generateRequestSignature(
  timestamp: number,
  userDiscordId: string | undefined,
  userName: string | undefined,
  signingSecret: string
): Promise<string> {
  const message = `${timestamp}:${userDiscordId || ''}:${userName || ''}`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ============================================================================
// Core Request Function
// ============================================================================

/**
 * Make an authenticated request to the preset API
 */
async function request<T>(
  env: Env,
  method: string,
  path: string,
  options: {
    body?: unknown;
    userDiscordId?: string;
    userName?: string;
    requestId?: string;
    logger?: ExtendedLogger;
  } = {}
): Promise<T> {
  if (!env.PRESETS_API && (!env.PRESETS_API_URL || !env.BOT_API_SECRET)) {
    throw new PresetAPIError(503, 'Preset API not configured');
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (options.requestId) {
    headers['X-Request-ID'] = options.requestId;
  }

  if (env.BOT_API_SECRET) {
    headers['Authorization'] = `Bearer ${env.BOT_API_SECRET}`;
  }

  if (options.userDiscordId) {
    headers['X-User-Discord-ID'] = options.userDiscordId;
  }
  if (options.userName) {
    headers['X-User-Discord-Name'] = options.userName;
  }

  if (env.BOT_SIGNING_SECRET) {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await generateRequestSignature(
      timestamp,
      options.userDiscordId,
      options.userName,
      env.BOT_SIGNING_SECRET
    );
    headers['X-Request-Timestamp'] = String(timestamp);
    headers['X-Request-Signature'] = signature;
  }

  try {
    let response: Response;

    if (env.PRESETS_API) {
      response = await env.PRESETS_API.fetch(
        new Request(`https://internal${path}`, {
          method,
          headers,
          body: options.body ? JSON.stringify(options.body) : undefined,
        })
      );
    } else {
      const url = `${env.PRESETS_API_URL}${path}`;
      response = await fetch(url, {
        method,
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    }

    const data = (await response.json()) as T & { message?: string; error?: string };

    if (!response.ok) {
      throw new PresetAPIError(
        response.status,
        data.message || data.error || `API request failed with status ${response.status}`,
        data
      );
    }

    return data;
  } catch (error) {
    if (error instanceof PresetAPIError) {
      throw error;
    }
    if (options.logger) {
      options.logger.error('Preset API request failed', error instanceof Error ? error : undefined);
    }
    throw new PresetAPIError(500, 'Failed to communicate with preset API', error);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if the preset API is configured and available
 */
export function isApiEnabled(env: Env): boolean {
  return Boolean(env.PRESETS_API || (env.PRESETS_API_URL && env.BOT_API_SECRET));
}

/**
 * Check if a user is a moderator based on MODERATOR_IDS environment variable
 */
export function isModerator(env: Env, userId: string): boolean {
  if (!env.MODERATOR_IDS) return false;
  const moderatorIds = env.MODERATOR_IDS.split(',').map((id) => id.trim());
  return moderatorIds.includes(userId);
}

// ============================================================================
// Preset Functions (Read-only for moderation)
// ============================================================================

/**
 * Get a paginated list of presets with optional filtering
 */
export async function getPresets(
  env: Env,
  filters: PresetFilters = {}
): Promise<PresetListResponse> {
  const params = new URLSearchParams();

  if (filters.category) params.set('category', filters.category);
  if (filters.search) params.set('search', filters.search);
  if (filters.status) params.set('status', filters.status);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.page) params.set('page', String(filters.page));
  if (filters.limit) params.set('limit', String(filters.limit));

  const query = params.toString();
  return request<PresetListResponse>(env, 'GET', `/api/v1/presets${query ? `?${query}` : ''}`);
}

/**
 * Get a single preset by ID
 */
export async function getPreset(env: Env, id: string): Promise<CommunityPreset | null> {
  try {
    return await request<CommunityPreset>(env, 'GET', `/api/v1/presets/${id}`);
  } catch (error) {
    if (error instanceof PresetAPIError && error.statusCode === 404) {
      return null;
    }
    throw error;
  }
}

// ============================================================================
// Moderation Functions
// ============================================================================

/**
 * Get presets pending moderation
 */
export async function getPendingPresets(
  env: Env,
  moderatorId: string
): Promise<CommunityPreset[]> {
  const response = await request<{ presets: CommunityPreset[] }>(
    env,
    'GET',
    '/api/v1/moderation/pending',
    { userDiscordId: moderatorId }
  );
  return response.presets;
}

/**
 * Approve a preset
 */
export async function approvePreset(
  env: Env,
  presetId: string,
  moderatorId: string,
  reason?: string
): Promise<CommunityPreset> {
  const response = await request<{ preset: CommunityPreset }>(
    env,
    'PATCH',
    `/api/v1/moderation/${presetId}/status`,
    {
      body: { status: 'approved', reason },
      userDiscordId: moderatorId,
    }
  );
  return response.preset;
}

/**
 * Reject a preset
 */
export async function rejectPreset(
  env: Env,
  presetId: string,
  moderatorId: string,
  reason: string
): Promise<CommunityPreset> {
  const response = await request<{ preset: CommunityPreset }>(
    env,
    'PATCH',
    `/api/v1/moderation/${presetId}/status`,
    {
      body: { status: 'rejected', reason },
      userDiscordId: moderatorId,
    }
  );
  return response.preset;
}

/**
 * Get moderation statistics
 */
export async function getModerationStats(
  env: Env,
  moderatorId: string
): Promise<ModerationStats> {
  const response = await request<{ stats: ModerationStats }>(
    env,
    'GET',
    '/api/v1/moderation/stats',
    { userDiscordId: moderatorId }
  );
  return response.stats;
}

/**
 * Get moderation history for a preset
 */
export async function getModerationHistory(
  env: Env,
  presetId: string,
  moderatorId: string
): Promise<ModerationLogEntry[]> {
  const response = await request<{ history: ModerationLogEntry[] }>(
    env,
    'GET',
    `/api/v1/moderation/${presetId}/history`,
    { userDiscordId: moderatorId }
  );
  return response.history;
}

/**
 * Revert a preset to its previous values (moderators only)
 */
export async function revertPreset(
  env: Env,
  presetId: string,
  reason: string,
  moderatorId: string
): Promise<CommunityPreset> {
  const response = await request<{ success: boolean; preset: CommunityPreset }>(
    env,
    'PATCH',
    `/api/v1/moderation/${presetId}/revert`,
    {
      body: { reason },
      userDiscordId: moderatorId,
    }
  );
  return response.preset;
}

// ============================================================================
// Autocomplete Helpers
// ============================================================================

/**
 * Search presets for autocomplete suggestions
 */
export async function searchPresetsForAutocomplete(
  env: Env,
  query: string,
  options: {
    status?: 'approved' | 'pending';
    limit?: number;
    logger?: ExtendedLogger;
  } = {}
): Promise<Array<{ name: string; value: string }>> {
  try {
    const filters: PresetFilters = {
      status: options.status || 'pending',
      limit: options.limit || 25,
    };

    if (query.length > 0) {
      filters.search = query;
    }

    const response = await getPresets(env, filters);

    return response.presets.map((preset) => ({
      name: preset.author_name
        ? `${preset.name} (${preset.vote_count}\u2605) by ${preset.author_name}`
        : `${preset.name} (${preset.vote_count}\u2605)`,
      value: preset.id,
    }));
  } catch (error) {
    if (options.logger) {
      options.logger.error(
        'Preset autocomplete search failed',
        error instanceof Error ? error : undefined
      );
    }
    return [];
  }
}
