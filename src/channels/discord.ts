import fs from 'fs/promises';
import path from 'path';

import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  Partials,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, buildTriggerPattern, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const DISCORD_ATTACHMENT_TIMEOUT_MS = 15_000;
const DISCORD_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const DISCORD_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const DISCORD_ATTACHMENT_MAX_REDIRECTS = 3;
const DISCORD_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
  'attachments.discordapp.net',
]);
let attachmentSaveCounter = 0;

interface DiscordAttachmentLike {
  id?: string;
  name?: string | null;
  filename?: string | null;
  contentType?: string | null;
  content_type?: string | null;
  url?: string | null;
  size?: number | null;
}

function attachmentContentType(att: DiscordAttachmentLike): string {
  return att.contentType || att.content_type || '';
}

function attachmentName(att: DiscordAttachmentLike): string {
  return att.name || att.filename || 'file';
}

function attachmentKind(contentType: string): string {
  if (contentType.startsWith('image/')) return 'Image';
  if (contentType.startsWith('video/')) return 'Video';
  if (contentType.startsWith('audio/')) return 'Audio';
  if (contentType === 'application/pdf') return 'PDF';
  return 'File';
}

function attachmentPlaceholderKind(contentType: string): string {
  if (contentType.startsWith('image/')) return 'Image';
  if (contentType.startsWith('video/')) return 'Video';
  if (contentType.startsWith('audio/')) return 'Audio';
  return 'File';
}

function attachmentPlaceholder(att: DiscordAttachmentLike): string {
  const contentType = attachmentContentType(att);
  return `[${attachmentPlaceholderKind(contentType)}: ${attachmentName(att)}]`;
}

function ensureWithinBase(baseDir: string, targetPath: string): void {
  const relative = path.relative(baseDir, targetPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes base directory: ${targetPath}`);
  }
}

async function ensureRealPathWithinBase(
  baseDir: string,
  targetPath: string,
): Promise<void> {
  const [realBase, realTarget] = await Promise.all([
    fs.realpath(baseDir),
    fs.realpath(targetPath),
  ]);
  ensureWithinBase(realBase, realTarget);
}

function validateDiscordAttachmentUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') {
    throw new Error('Discord attachment URL must use HTTPS');
  }
  if (!DISCORD_ATTACHMENT_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error(`Discord attachment host is not allowed: ${url.hostname}`);
  }
  return url;
}

function safeAttachmentFilename(att: DiscordAttachmentLike): string {
  const base = path
    .basename(attachmentName(att))
    .replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeBase =
    base && base !== '.' && base !== '..' ? base.slice(0, 120) : 'file';
  const prefix = [
    Date.now(),
    att.id ?? (attachmentSaveCounter = (attachmentSaveCounter + 1) % 1_000_000),
  ]
    .filter(
      (part) => part !== undefined && part !== null && String(part).length > 0,
    )
    .map((part) => String(part).replace(/[^a-zA-Z0-9._-]/g, '_'))
    .join('-');
  return `${prefix}-${safeBase}`;
}

async function fetchDiscordAttachment(
  url: URL,
  signal: AbortSignal,
  redirectsRemaining = DISCORD_ATTACHMENT_MAX_REDIRECTS,
): Promise<Response> {
  const response = await fetch(url, { redirect: 'manual', signal });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    if (redirectsRemaining <= 0) {
      throw new Error('Discord attachment redirect limit exceeded');
    }
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Discord attachment redirect missing Location');
    }
    const nextUrl = validateDiscordAttachmentUrl(
      new URL(location, url).toString(),
    );
    return fetchDiscordAttachment(nextUrl, signal, redirectsRemaining - 1);
  }
  return response;
}

async function downloadDiscordAttachmentToFile(
  att: DiscordAttachmentLike,
  destPath: string,
  remainingBytes: number,
): Promise<number> {
  if (!att.url) throw new Error('Discord attachment is missing a URL');
  const url = validateDiscordAttachmentUrl(att.url);
  const maxBytes = Math.min(DISCORD_ATTACHMENT_MAX_BYTES, remainingBytes);
  if (maxBytes <= 0 || (att.size && att.size > maxBytes)) {
    throw new Error(`Discord attachment exceeds ${maxBytes} remaining bytes`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    DISCORD_ATTACHMENT_TIMEOUT_MS,
  );
  const partialPath = `${destPath}.part-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let written = 0;
  try {
    const response = await fetchDiscordAttachment(url, controller.signal);
    if (!response.ok) {
      throw new Error(
        `Discord attachment download failed: HTTP ${response.status}`,
      );
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new Error(`Discord attachment exceeds ${maxBytes} remaining bytes`);
    }
    if (!response.body) {
      throw new Error('Discord attachment response has no body');
    }

    handle = await fs.open(partialPath, 'wx');
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      written += value.byteLength;
      if (written > maxBytes) {
        controller.abort();
        throw new Error(`Discord attachment exceeds ${maxBytes} remaining bytes`);
      }
      await handle.writeFile(value);
    }
    await handle.close();
    handle = undefined;
    await fs.link(partialPath, destPath);
    await fs.rm(partialPath, { force: true });
    return written;
  } finally {
    clearTimeout(timeout);
    await handle?.close().catch(() => undefined);
    await fs.rm(partialPath, { force: true }).catch(() => undefined);
  }
}

async function saveDiscordAttachment(
  att: DiscordAttachmentLike,
  group: RegisteredGroup | undefined,
  remainingBytes: number,
): Promise<{ description: string; bytesSaved: number }> {
  if (!group || !att.url) {
    return { description: attachmentPlaceholder(att), bytesSaved: 0 };
  }

  try {
    const groupDir = path.resolve(GROUPS_DIR, group.folder);
    ensureWithinBase(path.resolve(GROUPS_DIR), groupDir);
    const attachDir = path.resolve(groupDir, 'attachments');
    ensureWithinBase(groupDir, attachDir);
    await fs.mkdir(attachDir, { recursive: true });
    await ensureRealPathWithinBase(path.resolve(GROUPS_DIR), groupDir);
    await ensureRealPathWithinBase(groupDir, attachDir);

    const filename = safeAttachmentFilename(att);
    const filePath = path.resolve(attachDir, filename);
    ensureWithinBase(attachDir, filePath);
    const bytesSaved = await downloadDiscordAttachmentToFile(
      att,
      filePath,
      remainingBytes,
    );

    return {
      description: `[${attachmentKind(attachmentContentType(att))}: attachments/${filename}]`,
      bytesSaved,
    };
  } catch (err) {
    logger.warn(
      { attName: attachmentName(att), err },
      'Failed to download Discord attachment',
    );
    return { description: attachmentPlaceholder(att), bytesSaved: 0 };
  }
}

async function describeDiscordAttachments(
  attachments: Iterable<DiscordAttachmentLike>,
  group: RegisteredGroup | undefined,
): Promise<string[]> {
  const descriptions: string[] = [];
  let remainingBytes = DISCORD_ATTACHMENT_MAX_TOTAL_BYTES;
  for (const att of attachments) {
    const saved = await saveDiscordAttachment(att, group, remainingBytes);
    remainingBytes -= saved.bytesSaved;
    descriptions.push(saved.description);
  }
  return descriptions;
}

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export interface DiscordBotOptions {
  jidPrefix?: string;
  label?: string;
  triggerName?: string;
}

export class DiscordChannel implements Channel {
  // Always 'discord' — used for ChannelType text-style passthrough.
  // Bot identity is tracked via `label` in structured logs, not here.
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private jidPrefix: string;
  private label: string;
  private triggerName: string;
  private triggerPattern: RegExp;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    options?: DiscordBotOptions,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.jidPrefix = options?.jidPrefix ?? 'dc';
    this.label = options?.label ?? 'discord';
    this.triggerName = options?.triggerName ?? ASSISTANT_NAME;
    this.triggerPattern = buildTriggerPattern(`@${this.triggerName}`);
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    // Handle DMs via raw gateway events.
    // discord.js v14 does not reliably emit messageCreate for DMs even with
    // Partials.Channel enabled — the raw gateway event is the only reliable
    // source. Guild messages still go through messageCreate below.
    this.client.on('raw' as any, async (packet: any) => {
      if (packet.t !== 'MESSAGE_CREATE' || packet.d.guild_id) return;

      const d = packet.d;
      if (d.author?.bot) return;

      const channelId = d.channel_id;
      const chatJid = `${this.jidPrefix}:${channelId}`;
      const senderName =
        d.author?.global_name || d.author?.username || 'Unknown';
      const sender = d.author?.id || '';
      const msgId = d.id;
      const timestamp = d.timestamp || new Date().toISOString();
      let content = d.content || '';
      const group = this.opts.registeredGroups()[chatJid];

      // Translate @bot mentions into trigger format
      const botId = this.client?.user?.id;
      if (botId) {
        const isBotMentioned =
          content.includes(`<@${botId}>`) || content.includes(`<@!${botId}>`);
        if (isBotMentioned) {
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          if (!this.triggerPattern.test(content)) {
            content = `@${this.triggerName} ${content}`;
          }
        }
      }

      // Handle attachments
      if (d.attachments?.length > 0) {
        const descriptions = await describeDiscordAttachments(
          d.attachments,
          group,
        );
        content = content
          ? `${content}\n${descriptions.join('\n')}`
          : descriptions.join('\n');
      }

      // Handle reply context — keep DM formatting aligned with guild messages.
      if (d.message_reference?.message_id) {
        try {
          const channel = await this.client?.channels.fetch(channelId);
          if (channel && 'messages' in channel) {
            const repliedTo = await (channel as any).messages.fetch(
              d.message_reference.message_id,
            );
            const replyAuthor =
              repliedTo.member?.displayName ||
              repliedTo.author?.displayName ||
              repliedTo.author?.globalName ||
              repliedTo.author?.global_name ||
              repliedTo.author?.username;
            if (replyAuthor) {
              content = `[Reply to ${replyAuthor}] ${content}`;
            }
          }
        } catch {
          // Referenced message may be unavailable.
        }
      }

      // Store chat metadata
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        senderName,
        'discord',
        false,
      );

      // Only deliver for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName: senderName },
          'DM from unregistered Discord channel',
        );
        return;
      }

      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName: senderName, sender: senderName },
        'Discord DM stored',
      );
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      // Skip DMs — handled by the raw event listener above
      if (!message.guild) return;

      const channelId = message.channelId;
      const chatJid = `${this.jidPrefix}:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;
      const group = this.opts.registeredGroups()[chatJid];

      // Determine chat name
      const textChannel = message.channel as TextChannel;
      const chatName = `${message.guild.name} #${textChannel.name}`;

      // Translate Discord @bot mentions into trigger format.
      // Discord mentions look like <@botUserId> — these won't match
      // the trigger pattern (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned. In multi-bot setups, each bot injects
      // its own triggerName so the correct group receives the message.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend this bot's trigger if not already present
          if (!this.triggerPattern.test(content)) {
            content = `@${this.triggerName} ${content}`;
          }
        }
      }

      // Handle attachments — store placeholders so the agent knows something was sent
      if (message.attachments.size > 0) {
        const attachmentDescriptions = await describeDiscordAttachments(
          message.attachments.values(),
          group,
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to.
      // If the user is replying to the bot's own message, treat it as a trigger
      // so the bot responds even in trigger-only channels.
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;

          // If replying to this bot, inject this bot's trigger
          if (repliedTo.author.id === this.client?.user?.id) {
            if (!this.triggerPattern.test(content)) {
              content = `@${this.triggerName} ${content}`;
            }
          }
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName, 'discord', true);

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName, bot: this.label },
          'Message from unregistered Discord channel',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName, bot: this.label },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error(
        { err: err.message, bot: this.label },
        'Discord client error',
      );
    });

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      this.client!.once(Events.ClientReady, (readyClient) => {
        settled = true;
        logger.info(
          {
            username: readyClient.user.tag,
            id: readyClient.user.id,
            bot: this.label,
          },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot [${this.label}]: ${readyClient.user.tag}`);
        console.log(
          `  JID prefix: ${this.jidPrefix}: — use /chatid or check Discord channel settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken).catch((err: unknown) => {
        if (settled) return;
        settled = true;
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(
          { err: error.message, bot: this.label },
          'Discord bot login failed',
        );
        this.client?.destroy();
        this.client = null;
        reject(error);
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn({ bot: this.label }, 'Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(new RegExp(`^${this.jidPrefix}:`), '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn(
          { jid, bot: this.label },
          'Discord channel not found or not text-based',
        );
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info(
        { jid, length: text.length, bot: this.label },
        'Discord message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err, bot: this.label },
        'Failed to send Discord message',
      );
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(`${this.jidPrefix}:`);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info({ bot: this.label }, 'Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(new RegExp(`^${this.jidPrefix}:`), '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug(
        { jid, err, bot: this.label },
        'Failed to send Discord typing indicator',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Multi-bot configuration
// ---------------------------------------------------------------------------
// Multiple Discord bots can be configured via the DISCORD_BOTS env var.
// Each bot gets its own identity, JID prefix, and trigger name so the
// router can distinguish which bot owns a given channel.
//
// Format:  DISCORD_BOTS=name:token:triggerName;name:token:triggerName
// Example: DISCORD_BOTS=engineer:xMT...abc:Engineer;ops:xMT...xyz:Ops
//
// - name:        used for registry key (discord-{name}) and JID prefix (dc-{name}:)
// - token:       Discord bot token (alphanumeric + . - _ only, no colons)
// - triggerName: the trigger injected on @mention/reply (e.g. "Engineer" → @Engineer)
//
// Falls back to single DISCORD_BOT_TOKEN when DISCORD_BOTS is not set.
// All instances keep name='discord' for text-style passthrough.

interface DiscordBotConfig {
  name: string;
  token: string;
  triggerName: string;
}

// Bot names must be alphanumeric + hyphens only (used in JID prefix and regex).
const VALID_BOT_NAME = /^[a-z0-9-]+$/i;

export function parseDiscordBots(raw?: string): DiscordBotConfig[] {
  const envVars = readEnvFile(['DISCORD_BOTS']);
  const value = raw ?? process.env.DISCORD_BOTS ?? envVars.DISCORD_BOTS ?? '';
  if (!value.trim()) return [];

  const bots: DiscordBotConfig[] = [];
  const seenNames = new Set<string>();
  const entries = value.split(';');
  for (let index = 0; index < entries.length; index += 1) {
    const trimmed = entries[index].trim();
    if (!trimmed) continue;
    // Format: name:token:triggerName — Discord tokens use alphanumeric + . - _
    // and do not contain colons, so exactly 3 colon-delimited parts are expected.
    const parts = trimmed.split(':');
    if (parts.length !== 3) {
      logger.warn(
        { entryIndex: index, fieldCount: parts.length },
        'DISCORD_BOTS: skipping malformed entry (expected exactly name:token:triggerName)',
      );
      continue;
    }
    const name = parts[0].trim();
    const token = parts[1].trim();
    const triggerName = parts[2].trim();
    if (!name || !token || !triggerName) {
      logger.warn(
        {
          entryIndex: index,
          name: name || undefined,
          hasToken: Boolean(token),
          hasTriggerName: Boolean(triggerName),
        },
        'DISCORD_BOTS: skipping entry with empty field',
      );
      continue;
    }
    if (!VALID_BOT_NAME.test(name)) {
      logger.warn(
        { name },
        'DISCORD_BOTS: skipping entry — name must be alphanumeric + hyphens only',
      );
      continue;
    }
    const normalizedName = name.toLowerCase();
    if (seenNames.has(normalizedName)) {
      logger.warn(
        { entryIndex: index, name: normalizedName },
        'DISCORD_BOTS: skipping duplicate bot name',
      );
      continue;
    }
    seenNames.add(normalizedName);
    bots.push({ name: normalizedName, token, triggerName });
  }
  return bots;
}

// Register bots
const discordBots = parseDiscordBots();

if (discordBots.length > 0) {
  if (
    process.env.DISCORD_BOT_TOKEN ||
    readEnvFile(['DISCORD_BOT_TOKEN']).DISCORD_BOT_TOKEN
  ) {
    logger.info(
      'DISCORD_BOTS is set — ignoring DISCORD_BOT_TOKEN (multi-bot takes precedence)',
    );
  }
  for (const bot of discordBots) {
    const registryName = `discord-${bot.name}`;
    const jidPrefix = `dc-${bot.name}`;
    registerChannel(
      registryName,
      (opts: ChannelOpts) =>
        new DiscordChannel(bot.token, opts, {
          jidPrefix,
          label: bot.name,
          triggerName: bot.triggerName,
        }),
    );
  }
} else {
  // Single-bot fallback: original behavior
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (token) {
    registerChannel(
      'discord',
      (opts: ChannelOpts) => new DiscordChannel(token, opts),
    );
  } else {
    logger.warn('Discord: no bot tokens set');
  }
}
