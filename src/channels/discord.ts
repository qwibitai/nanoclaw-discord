import fs from 'fs';
import path from 'path';

import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN, GROUPS_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { processImage } from '../image.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
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
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Store chat metadata for discovery
      const isGroup = message.guild !== null;
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'discord',
        isGroup,
      );

      // Look up registered group early — needed for attachment saving
      const group = this.opts.registeredGroups()[chatJid];

      // Handle attachments — download and save files so the agent can access them
      if (message.attachments.size > 0) {
        const attachmentDescriptions: string[] = [];

        for (const att of message.attachments.values()) {
          const contentType = att.contentType || '';

          try {
            if (contentType.startsWith('image/') && group) {
              // Download image and save via processImage (resizes, saves as JPEG)
              const response = await fetch(att.url);
              const arrayBuffer = await response.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const groupDir = path.join(GROUPS_DIR, group.folder);
              const caption = att.description || '';
              const result = await processImage(buffer, groupDir, caption);
              if (result) {
                attachmentDescriptions.push(result.content);
              } else {
                attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
              }
            } else if (
              (contentType.startsWith('video/') ||
                contentType.startsWith('audio/') ||
                contentType === 'application/pdf' ||
                contentType.startsWith('application/') ||
                contentType.startsWith('text/')) &&
              group
            ) {
              // Download and save non-image files to attachments dir
              const response = await fetch(att.url);
              const arrayBuffer = await response.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const groupDir = path.join(GROUPS_DIR, group.folder);
              const attachDir = path.join(groupDir, 'attachments');
              fs.mkdirSync(attachDir, { recursive: true });

              // Sanitize filename
              const safeName = (att.name || 'file').replace(
                /[^a-zA-Z0-9._-]/g,
                '_',
              );
              const filename = `${Date.now()}-${safeName}`;
              const filePath = path.join(attachDir, filename);
              fs.writeFileSync(filePath, buffer);

              const relativePath = `attachments/${filename}`;
              if (contentType.startsWith('video/')) {
                attachmentDescriptions.push(`[Video: ${relativePath}]`);
              } else if (contentType.startsWith('audio/')) {
                attachmentDescriptions.push(`[Audio: ${relativePath}]`);
              } else if (contentType === 'application/pdf') {
                attachmentDescriptions.push(`[PDF: ${relativePath}]`);
              } else {
                attachmentDescriptions.push(`[File: ${relativePath}]`);
              }
            } else {
              // No group registered or unknown type — fall back to placeholder
              if (contentType.startsWith('image/')) {
                attachmentDescriptions.push(
                  `[Image: ${att.name || 'image'}]`,
                );
              } else if (contentType.startsWith('video/')) {
                attachmentDescriptions.push(
                  `[Video: ${att.name || 'video'}]`,
                );
              } else if (contentType.startsWith('audio/')) {
                attachmentDescriptions.push(
                  `[Audio: ${att.name || 'audio'}]`,
                );
              } else {
                attachmentDescriptions.push(`[File: ${att.name || 'file'}]`);
              }
            }
          } catch (err) {
            logger.warn(
              { attName: att.name, err },
              'Failed to download Discord attachment',
            );
            // Fall back to placeholder on download error
            if (contentType.startsWith('image/')) {
              attachmentDescriptions.push(`[Image: ${att.name || 'image'}]`);
            } else if (contentType.startsWith('video/')) {
              attachmentDescriptions.push(`[Video: ${att.name || 'video'}]`);
            } else if (contentType.startsWith('audio/')) {
              attachmentDescriptions.push(`[Audio: ${att.name || 'audio'}]`);
            } else {
              attachmentDescriptions.push(`[File: ${att.name || 'file'}]`);
            }
          }
        }

        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
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
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Only deliver full message for registered groups
      if (!group) {
        logger.debug(
          { chatJid, chatName },
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
        { chatJid, chatName, sender: senderName },
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          { username: readyClient.user.tag, id: readyClient.user.id },
          'Discord bot connected',
        );
        console.log(`\n  Discord bot: ${readyClient.user.tag}`);
        console.log(
          `  Use /chatid command or check channel IDs in Discord settings\n`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
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
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client || !isTyping) return;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (channel && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Discord typing indicator');
    }
  }
}

registerChannel('discord', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN']);
  const token =
    process.env.DISCORD_BOT_TOKEN || envVars.DISCORD_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Discord: DISCORD_BOT_TOKEN not set');
    return null;
  }
  return new DiscordChannel(token, opts);
});
