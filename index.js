require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  PermissionsBitField
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers
  ]
});

// 🔐 WHITELIST (YOUR ID)
const whitelist = ["1365339016446345240"];

// ⚙️ SETTINGS
const LIMITS = {
  CHANNEL_DELETE: 2,
  ROLE_DELETE: 2,
  ROLE_CREATE: 3,
  BAN: 2,
  KICK: 2
};

const TIME = 5000; // 5 sec
const logsMap = new Map();

// 🧠 TRACK SYSTEM
function track(userId, action) {
  const now = Date.now();

  if (!logsMap.has(userId)) logsMap.set(userId, {});
  const userLogs = logsMap.get(userId);

  if (!userLogs[action]) userLogs[action] = [];

  userLogs[action].push(now);
  userLogs[action] = userLogs[action].filter(t => now - t < TIME);

  return userLogs[action].length;
}

// 🚨 PUNISH SYSTEM
async function punish(guild, user, reason) {
  if (whitelist.includes(user.id)) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  if (member.id === guild.ownerId) return;

  try {
    await member.roles.set([]);
    await member.ban({ reason });

    console.log(`🚨 ${user.tag} punished: ${reason}`);
  } catch (err) {
    console.log("❌ Punish failed:", err.message);
  }
}

// 🔒 LOCKDOWN MODE
async function lockdown(guild) {
  guild.channels.cache.forEach(async (ch) => {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false
      });
    } catch {}
  });
  console.log("🔒 Server locked down");
}

// 📢 LOG SYSTEM
function log(msg) {
  console.log(`📜 ${msg}`);
}

client.once('ready', () => {
  console.log(`🔥 Bot ready: ${client.user.tag}`);
});

// 🚨 CHANNEL DELETE
client.on('channelDelete', async (channel) => {
  const logs = await channel.guild.fetchAuditLogs({
    type: AuditLogEvent.ChannelDelete,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const user = entry.executor;
  const count = track(user.id, "CHANNEL_DELETE");

  if (count >= LIMITS.CHANNEL_DELETE) {
    log(`${user.tag} deleting channels`);
    await punish(channel.guild, user, "Channel nuke");
    await lockdown(channel.guild);
  }
});

// 🚨 ROLE DELETE
client.on('roleDelete', async (role) => {
  const logs = await role.guild.fetchAuditLogs({
    type: AuditLogEvent.RoleDelete,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const user = entry.executor;
  const count = track(user.id, "ROLE_DELETE");

  if (count >= LIMITS.ROLE_DELETE) {
    log(`${user.tag} deleting roles`);
    await punish(role.guild, user, "Role delete nuke");
  }
});

// 🚨 ROLE CREATE SPAM
client.on('roleCreate', async (role) => {
  const logs = await role.guild.fetchAuditLogs({
    type: AuditLogEvent.RoleCreate,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const user = entry.executor;
  const count = track(user.id, "ROLE_CREATE");

  if (count >= LIMITS.ROLE_CREATE) {
    log(`${user.tag} creating roles spam`);
    await punish(role.guild, user, "Role spam");
  }
});

// 🚨 BAN PROTECTION
client.on('guildBanAdd', async (ban) => {
  const logs = await ban.guild.fetchAuditLogs({
    type: AuditLogEvent.MemberBanAdd,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const user = entry.executor;
  const count = track(user.id, "BAN");

  if (count >= LIMITS.BAN) {
    log(`${user.tag} mass banning`);
    await punish(ban.guild, user, "Mass ban");
  }
});

// 🚨 KICK PROTECTION
client.on('guildMemberRemove', async (member) => {
  const logs = await member.guild.fetchAuditLogs({
    type: AuditLogEvent.MemberKick,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const user = entry.executor;
  const count = track(user.id, "KICK");

  if (count >= LIMITS.KICK) {
    log(`${user.tag} mass kicking`);
    await punish(member.guild, user, "Mass kick");
  }
});

// 🚨 WEBHOOK PROTECTION
client.on('webhookUpdate', async (channel) => {
  const logs = await channel.guild.fetchAuditLogs({
    type: AuditLogEvent.WebhookCreate,
    limit: 1
  });

  const entry = logs.entries.first();
  if (!entry) return;

  const user = entry.executor;

  if (!whitelist.includes(user.id)) {
    await punish(channel.guild, user, "Webhook abuse");
  }
});

client.login(process.env.TOKEN);
