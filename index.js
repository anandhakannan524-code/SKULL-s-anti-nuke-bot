require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  ChannelType,
  PermissionsBitField
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// 🔐 CONFIG
const CONFIG = {
  WHITELIST: ["1365339016446345240"], // your ID
  LIMITS: {
    CHANNEL_DELETE: 2,
    ROLE_DELETE: 2,
    ROLE_CREATE: 3,
    BAN: 2,
    KICK: 2,
    WEBHOOK: 2
  },
  WINDOW_MS: 5000,
  LOG_CHANNEL_NAME: "security-logs",
  ENABLE_LOCKDOWN: true,
  ENABLE_RESTORE: true
};

// 🧠 in-memory trackers
const actionMap = new Map();

// 📜 util
function track(userId, action) {
  const now = Date.now();
  if (!actionMap.has(userId)) actionMap.set(userId, {});
  const user = actionMap.get(userId);
  if (!user[action]) user[action] = [];
  user[action].push(now);
  user[action] = user[action].filter(t => now - t < CONFIG.WINDOW_MS);
  return user[action].length;
}

async function getExecutor(guild, type) {
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  if (!logs) return null;
  const entry = logs.entries.first();
  if (!entry) return null;
  return entry.executor;
}

function isWhitelisted(userId, guild) {
  if (CONFIG.WHITELIST.includes(userId)) return true;
  if (userId === guild.ownerId) return true;
  return false;
}

async function log(guild, msg) {
  const ch = guild.channels.cache.find(c => c.name === CONFIG.LOG_CHANNEL_NAME);
  if (ch) ch.send(`📜 ${msg}`).catch(() => {});
  console.log(msg);
}

async function punish(guild, user, reason) {
  if (!user) return;
  if (isWhitelisted(user.id, guild)) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    await member.roles.set([]);
    await member.ban({ reason });
    await log(guild, `🚨 ${user.tag} punished → ${reason}`);
  } catch (e) {
    await log(guild, `❌ Failed to punish ${user.tag}: ${e.message}`);
  }
}

async function lockdown(guild) {
  if (!CONFIG.ENABLE_LOCKDOWN) return;
  for (const ch of guild.channels.cache.values()) {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false
      });
    } catch {}
  }
  await log(guild, "🔒 Lockdown activated");
}

// ♻️ basic restore (recreate channel)
async function restoreChannel(channel) {
  if (!CONFIG.ENABLE_RESTORE) return;
  try {
    await channel.guild.channels.create({
      name: channel.name,
      type: channel.type,
      parent: channel.parentId || null
    });
    await log(channel.guild, `♻️ Restored channel: ${channel.name}`);
  } catch {}
}

// 🟢 READY
client.once('ready', () => {
  console.log(`🔥 Ready as ${client.user.tag}`);
});

// 🚨 CHANNEL DELETE
client.on('channelDelete', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.ChannelDelete);
  if (!user) return;

  const count = track(user.id, "CHANNEL_DELETE");
  if (count >= CONFIG.LIMITS.CHANNEL_DELETE) {
    await punish(channel.guild, user, "Channel nuke");
    await lockdown(channel.guild);
  }

  await restoreChannel(channel);
});

// 🚨 ROLE DELETE
client.on('roleDelete', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleDelete);
  if (!user) return;

  const count = track(user.id, "ROLE_DELETE");
  if (count >= CONFIG.LIMITS.ROLE_DELETE) {
    await punish(role.guild, user, "Role delete nuke");
  }
});

// 🚨 ROLE CREATE
client.on('roleCreate', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleCreate);
  if (!user) return;

  const count = track(user.id, "ROLE_CREATE");
  if (count >= CONFIG.LIMITS.ROLE_CREATE) {
    await punish(role.guild, user, "Role spam");
  }
});

// 🚨 BAN
client.on('guildBanAdd', async (ban) => {
  const user = await getExecutor(ban.guild, AuditLogEvent.MemberBanAdd);
  if (!user) return;

  const count = track(user.id, "BAN");
  if (count >= CONFIG.LIMITS.BAN) {
    await punish(ban.guild, user, "Mass ban");
  }
});

// 🚨 KICK
client.on('guildMemberRemove', async (member) => {
  const user = await getExecutor(member.guild, AuditLogEvent.MemberKick);
  if (!user) return;

  const count = track(user.id, "KICK");
  if (count >= CONFIG.LIMITS.KICK) {
    await punish(member.guild, user, "Mass kick");
  }
});

// 🚨 WEBHOOK
client.on('webhookUpdate', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.WebhookCreate);
  if (!user) return;

  const count = track(user.id, "WEBHOOK");
  if (count >= CONFIG.LIMITS.WEBHOOK) {
    await punish(channel.guild, user, "Webhook abuse");
  }
});

client.login(process.env.TOKEN);
