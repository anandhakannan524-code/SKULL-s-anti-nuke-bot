require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent
} = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// 🔐 CONFIG
const CONFIG = {
  WHITELIST: ["1365339016446345240"],

  LIMITS: {
    CHANNEL_DELETE: 3,
    ROLE_DELETE: 3,
    ROLE_CREATE: 4,
    BAN: 3,
    KICK: 3,
    WEBHOOK: 3
  },

  WINDOW: 5000,
  LOG_CHANNEL: "security-logs",
  LOCKDOWN: true,
  RESTORE: true
};

const tracker = new Map();

// 🧠 TRACK ACTIONS
function track(userId, action) {
  const now = Date.now();

  if (!tracker.has(userId)) tracker.set(userId, {});
  const data = tracker.get(userId);

  if (!data[action]) data[action] = [];

  data[action].push(now);
  data[action] = data[action].filter(t => now - t < CONFIG.WINDOW);

  return data[action].length;
}

// 📜 LOG
async function log(guild, msg) {
  const ch = guild.channels.cache.find(c => c.name === CONFIG.LOG_CHANNEL);
  if (ch) ch.send(`📜 ${msg}`).catch(() => {});
  console.log(msg);
}

// 🔍 GET EXECUTOR
async function getExecutor(guild, type) {
  await new Promise(r => setTimeout(r, 1200));
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  if (!logs) return null;
  return logs.entries.first()?.executor || null;
}

// 🚨 PUNISH
async function punish(guild, user, reason) {
  if (!user) return;
  if (CONFIG.WHITELIST.includes(user.id)) return;
  if (user.id === guild.ownerId) return;
  if (user.bot) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    await member.roles.set([]);
    await member.ban({ reason });
    await log(guild, `🚨 ${user.tag} punished → ${reason}`);
  } catch (e) {
    await log(guild, `❌ Failed to punish ${user.tag}`);
  }
}

// 🔒 LOCKDOWN
async function lockdown(guild) {
  if (!CONFIG.LOCKDOWN) return;

  guild.channels.cache.forEach(async (ch) => {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false
      });
    } catch {}
  });

  await log(guild, "🔒 Server locked down");
}

// 🔓 UNLOCK
async function unlock(guild) {
  guild.channels.cache.forEach(async (ch) => {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: true
      });
    } catch {}
  });

  await log(guild, "🔓 Server unlocked");
}

// ♻️ RESTORE CHANNEL
async function restore(channel) {
  if (!CONFIG.RESTORE) return;

  try {
    await channel.guild.channels.create({
      name: channel.name,
      type: channel.type,
      parent: channel.parentId || null
    });

    await log(channel.guild, `♻️ Restored ${channel.name}`);
  } catch {}
}

// 🟢 READY
client.once('ready', () => {
  console.log(`🔥 Bot online as ${client.user.tag}`);
});

// 🚨 EVENTS

client.on('channelDelete', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.ChannelDelete);
  if (!user) return;

  const count = track(user.id, "CHANNEL_DELETE");

  if (count >= CONFIG.LIMITS.CHANNEL_DELETE) {
    await punish(channel.guild, user, "Channel nuke");
    await lockdown(channel.guild);
  }

  await restore(channel);
});

client.on('roleDelete', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleDelete);
  if (!user) return;

  const count = track(user.id, "ROLE_DELETE");

  if (count >= CONFIG.LIMITS.ROLE_DELETE) {
    await punish(role.guild, user, "Role delete nuke");
  }
});

client.on('roleCreate', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleCreate);
  if (!user) return;

  const count = track(user.id, "ROLE_CREATE");

  if (count >= CONFIG.LIMITS.ROLE_CREATE) {
    await punish(role.guild, user, "Role spam");
  }
});

client.on('guildBanAdd', async (ban) => {
  const user = await getExecutor(ban.guild, AuditLogEvent.MemberBanAdd);
  if (!user) return;

  const count = track(user.id, "BAN");

  if (count >= CONFIG.LIMITS.BAN) {
    await punish(ban.guild, user, "Mass ban");
  }
});

client.on('guildMemberRemove', async (member) => {
  const user = await getExecutor(member.guild, AuditLogEvent.MemberKick);
  if (!user) return;

  const count = track(user.id, "KICK");

  if (count >= CONFIG.LIMITS.KICK) {
    await punish(member.guild, user, "Mass kick");
  }
});

client.on('webhookUpdate', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.WebhookCreate);
  if (!user) return;

  const count = track(user.id, "WEBHOOK");

  if (count >= CONFIG.LIMITS.WEBHOOK) {
    await punish(channel.guild, user, "Webhook abuse");
  }
});

// 💬 COMMANDS

client.on('messageCreate', async (msg) => {
  if (!msg.guild) return;
  if (!CONFIG.WHITELIST.includes(msg.author.id)) return;

  if (msg.content === "!lockdown") {
    await lockdown(msg.guild);
    msg.reply("🔒 Locked");
  }

  if (msg.content === "!unlock") {
    await unlock(msg.guild);
    msg.reply("🔓 Unlocked");
  }

  if (msg.content === "!status") {
    msg.reply("🛡️ Anti-nuke system active");
  }
});

client.login(process.env.TOKEN);
