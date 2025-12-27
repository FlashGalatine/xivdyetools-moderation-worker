/**
 * Preset Moderation Command Handlers
 *
 * Handles /preset subcommands for the moderation bot:
 * - /preset moderate - Moderation actions (pending, approve, reject, stats)
 * - /preset ban_user - Ban a user from Preset Palettes
 * - /preset unban_user - Unban a user from Preset Palettes
 *
 * @module handlers/commands/preset
 */

import type { ExtendedLogger } from '@xivdyetools/logger';
import type { Env, DiscordInteraction } from '../../types/env.js';
import { InteractionResponseType } from '../../types/env.js';
import type { Translator } from '../../services/bot-i18n.js';
import {
  deferredResponse,
  ephemeralResponse,
  messageResponse,
  errorEmbed,
  successEmbed,
} from '../../utils/response.js';
import { editOriginalResponse, sendMessage } from '../../utils/discord-api.js';
import * as presetApi from '../../services/preset-api.js';
import * as banService from '../../services/ban-service.js';
import { PresetAPIError, STATUS_DISPLAY } from '../../types/preset.js';

// ============================================================================
// Constants
// ============================================================================

const PRESETS_WEB_URL = 'https://xivdyetools.com';

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle /preset command (routes to subcommand handlers)
 */
export async function handlePresetCommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  t: Translator,
  logger?: ExtendedLogger
): Promise<Response> {
  const userId = interaction.member?.user?.id ?? interaction.user?.id;

  if (!userId) {
    return ephemeralResponse(t.t('errors.userNotFound'));
  }

  // Get subcommand and options
  const subcommandOption = interaction.data?.options?.[0];
  const subcommand = subcommandOption?.name;
  const options = subcommandOption?.options;

  if (!subcommand) {
    return ephemeralResponse(t.t('errors.missingSubcommand'));
  }

  switch (subcommand) {
    case 'moderate':
      return handleModerateSubcommand(interaction, env, ctx, t, userId, options, logger);

    case 'ban_user':
      return handleBanUserSubcommand(interaction, env, ctx, t, userId, options, logger);

    case 'unban_user':
      return handleUnbanUserSubcommand(interaction, env, ctx, t, userId, options, logger);

    default:
      return ephemeralResponse(t.t('errors.unknownSubcommand', { name: subcommand }));
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isInModerationChannel(interaction: DiscordInteraction, env: Env): boolean {
  if (!env.MODERATION_CHANNEL_ID) {
    return false;
  }
  return interaction.channel_id === env.MODERATION_CHANNEL_ID;
}

// ============================================================================
// /preset moderate
// ============================================================================

async function handleModerateSubcommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  t: Translator,
  userId: string,
  options?: Array<{ name: string; value?: string | number | boolean }>,
  logger?: ExtendedLogger
): Promise<Response> {
  // Check moderator status
  if (!presetApi.isModerator(env, userId)) {
    return messageResponse({
      embeds: [errorEmbed(t.t('common.error'), t.t('preset.moderation.accessDenied'))],
      flags: 64,
    });
  }

  const action = options?.find((opt) => opt.name === 'action')?.value as string;
  const presetId = options?.find((opt) => opt.name === 'preset_id')?.value as string | undefined;
  const reason = options?.find((opt) => opt.name === 'reason')?.value as string | undefined;

  if (!action) {
    return ephemeralResponse('Missing action');
  }

  const deferResponse = deferredResponse();

  ctx.waitUntil(
    processModerateCommand(interaction, env, t, userId, action, presetId, reason, logger)
  );

  return deferResponse;
}

async function processModerateCommand(
  interaction: DiscordInteraction,
  env: Env,
  t: Translator,
  userId: string,
  action: string,
  presetId?: string,
  reason?: string,
  logger?: ExtendedLogger
): Promise<void> {
  try {
    switch (action) {
      case 'pending': {
        const presets = await presetApi.getPendingPresets(env, userId);

        if (presets.length === 0) {
          await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
            embeds: [
              successEmbed(
                t.t('preset.moderation.pendingQueue'),
                t.t('preset.moderation.noPending')
              ),
            ],
          });
          return;
        }

        const presetLines = presets.slice(0, 10).map((preset, i) => {
          return `**${i + 1}.** ${preset.name} by ${preset.author_name || 'Unknown'}\n   ID: \`${preset.id}\``;
        });

        await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
          embeds: [
            {
              title: `\uD83D\uDCCB ${t.t('preset.moderation.pendingQueue')}`,
              description: [
                t.t('preset.moderation.pendingCount', { count: presets.length }),
                '',
                presetLines.join('\n\n'),
              ].join('\n'),
              color: 0xfee75c,
              footer: { text: 'Use /preset moderate approve <id> or reject <id> <reason>' },
            },
          ],
        });
        break;
      }

      case 'approve': {
        if (!presetId) {
          await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
            embeds: [errorEmbed(t.t('common.error'), t.t('preset.moderation.missingId'))],
          });
          return;
        }

        const preset = await presetApi.approvePreset(env, presetId, userId, reason);

        await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
          embeds: [
            successEmbed(
              t.t('preset.moderation.approved'),
              t.t('preset.moderation.approvedDesc', { name: preset.name })
            ),
          ],
        });

        // Notify submission log
        if (env.SUBMISSION_LOG_CHANNEL_ID) {
          await sendMessage(env.DISCORD_TOKEN, env.SUBMISSION_LOG_CHANNEL_ID, {
            embeds: [
              {
                title: `\u2705 ${preset.name} - Approved`,
                description: `Preset approved`,
                color: STATUS_DISPLAY.approved.color,
                footer: { text: `ID: ${preset.id}` },
              },
            ],
          });
        }
        break;
      }

      case 'reject': {
        if (!presetId) {
          await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
            embeds: [errorEmbed(t.t('common.error'), t.t('preset.moderation.missingId'))],
          });
          return;
        }

        if (!reason) {
          await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
            embeds: [errorEmbed(t.t('common.error'), t.t('preset.moderation.missingReason'))],
          });
          return;
        }

        const preset = await presetApi.rejectPreset(env, presetId, userId, reason);

        await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
          embeds: [
            {
              title: `\u274C ${t.t('preset.moderation.rejected')}`,
              description: t.t('preset.moderation.rejectedDesc', { name: preset.name }),
              color: 0xed4245,
              fields: [{ name: 'Reason', value: reason }],
            },
          ],
        });
        break;
      }

      case 'stats': {
        const stats = await presetApi.getModerationStats(env, userId);

        await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
          embeds: [
            {
              title: `\uD83D\uDCCA ${t.t('preset.moderation.stats')}`,
              color: 0x5865f2,
              fields: [
                { name: '\uD83D\uDFE1 Pending', value: String(stats.pending_count), inline: true },
                { name: '\uD83D\uDFE2 Approved', value: String(stats.approved_count), inline: true },
                { name: '\uD83D\uDD34 Rejected', value: String(stats.rejected_count), inline: true },
                { name: '\uD83D\uDFE0 Flagged', value: String(stats.flagged_count), inline: true },
              ],
            },
          ],
        });
        break;
      }

      default:
        await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
          embeds: [errorEmbed(t.t('common.error'), `Unknown action: ${action}`)],
        });
    }
  } catch (error) {
    if (logger) {
      logger.error('Moderate error', error instanceof Error ? error : undefined);
    }
    const message = error instanceof PresetAPIError ? error.message : 'Moderation action failed.';
    await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
      embeds: [errorEmbed(t.t('common.error'), message)],
    });
  }
}

// ============================================================================
// /preset ban_user
// ============================================================================

async function handleBanUserSubcommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  t: Translator,
  userId: string,
  options?: Array<{ name: string; value?: string | number | boolean }>,
  logger?: ExtendedLogger
): Promise<Response> {
  // Check channel restriction
  if (!isInModerationChannel(interaction, env)) {
    return ephemeralResponse(t.t('ban.channelRestricted'));
  }

  // Check moderator status
  if (!presetApi.isModerator(env, userId)) {
    return ephemeralResponse(t.t('ban.permissionDenied'));
  }

  // Get target user from options
  const targetUserId = options?.find((opt) => opt.name === 'user')?.value as string | undefined;
  if (!targetUserId) {
    return ephemeralResponse('Please specify a user to ban.');
  }

  // Get user details for confirmation
  const confirmationData = await banService.getUserForBanConfirmation(
    env.DB,
    targetUserId,
    PRESETS_WEB_URL
  );

  if (!confirmationData) {
    return ephemeralResponse(t.t('ban.userNotFound'));
  }

  const { user, recentPresets } = confirmationData;

  const presetLinks =
    recentPresets.length > 0
      ? recentPresets.map((p) => `\u2022 [${p.name}](${p.shareUrl})`).join('\n')
      : '_No presets found_';

  return Response.json({
    type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      embeds: [
        {
          title: `\u26A0\uFE0F ${t.t('ban.confirmTitle')}`,
          description: t.t('ban.confirmDesc'),
          color: 0xed4245,
          fields: [
            { name: t.t('ban.username'), value: user.username, inline: true },
            { name: t.t('ban.discordId'), value: user.discordId || 'N/A', inline: true },
            { name: t.t('ban.totalPresets'), value: String(user.presetCount), inline: true },
            { name: t.t('ban.recentPresets'), value: presetLinks, inline: false },
          ],
          footer: {
            text: t.t('ban.confirmFooter'),
          },
        },
      ],
      components: [
        {
          type: 1, // Action Row
          components: [
            {
              type: 2, // Button
              style: 4, // Danger (red)
              label: t.t('ban.yesBan'),
              emoji: { name: '\uD83D\uDD28' },
              custom_id: `ban_confirm_${targetUserId}_${user.username}`,
            },
            {
              type: 2, // Button
              style: 2, // Secondary (gray)
              label: t.t('ban.cancel'),
              emoji: { name: '\u274C' },
              custom_id: `ban_cancel_${targetUserId}`,
            },
          ],
        },
      ],
      flags: 64, // Ephemeral
    },
  });
}

// ============================================================================
// /preset unban_user
// ============================================================================

async function handleUnbanUserSubcommand(
  interaction: DiscordInteraction,
  env: Env,
  ctx: ExecutionContext,
  t: Translator,
  userId: string,
  options?: Array<{ name: string; value?: string | number | boolean }>,
  logger?: ExtendedLogger
): Promise<Response> {
  // Check channel restriction
  if (!isInModerationChannel(interaction, env)) {
    return ephemeralResponse(t.t('ban.channelRestricted'));
  }

  // Check moderator status
  if (!presetApi.isModerator(env, userId)) {
    return ephemeralResponse(t.t('ban.permissionDenied'));
  }

  // Get target user from options
  const targetUserId = options?.find((opt) => opt.name === 'user')?.value as string | undefined;
  if (!targetUserId) {
    return ephemeralResponse('Please specify a user to unban.');
  }

  // Defer response for async processing
  const deferResponse = deferredResponse(true); // Ephemeral

  ctx.waitUntil(processUnban(interaction, env, t, userId, targetUserId, logger));

  return deferResponse;
}

async function processUnban(
  interaction: DiscordInteraction,
  env: Env,
  t: Translator,
  moderatorId: string,
  targetUserId: string,
  logger?: ExtendedLogger
): Promise<void> {
  try {
    // Get ban info before unbanning (for username in response)
    const activeBan = await banService.getActiveBan(env.DB, targetUserId);

    if (!activeBan) {
      await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
        embeds: [errorEmbed(t.t('common.error'), t.t('ban.notBanned'))],
      });
      return;
    }

    // Unban the user
    const result = await banService.unbanUser(env.DB, targetUserId, moderatorId);

    if (!result.success) {
      await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
        embeds: [errorEmbed(t.t('common.error'), result.error || 'Failed to unban user.')],
      });
      return;
    }

    // Success response
    await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
      embeds: [
        {
          title: `\u2705 ${t.t('ban.userUnbanned')}`,
          description: `Successfully unbanned **${activeBan.username}**.`,
          color: 0x57f287, // Green
          fields: [
            { name: 'User ID', value: targetUserId, inline: true },
            { name: t.t('ban.presetsRestored'), value: String(result.presetsRestored), inline: true },
          ],
          footer: { text: `Unbanned by moderator` },
          timestamp: new Date().toISOString(),
        },
      ],
    });

    if (logger) {
      logger.info('User unbanned', {
        targetUserId,
        moderatorId,
        presetsRestored: result.presetsRestored,
      });
    }
  } catch (error) {
    if (logger) {
      logger.error('Failed to unban user', error instanceof Error ? error : undefined);
    }
    await editOriginalResponse(env.DISCORD_CLIENT_ID, interaction.token, {
      embeds: [errorEmbed(t.t('common.error'), 'An unexpected error occurred while unbanning the user.')],
    });
  }
}
