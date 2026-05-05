require('dotenv').config();
const fs = require('fs');

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

// 📂 DATABASE
const DB_FILE = "./data.json";
let db = {};

if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ⚙️ CONFIG
function getConfig(guildId) {
  if (!db[guildId]) {
    db[guildId] = {
      whitelist: [],
      logChannel: null,
      limits: {
        CHANNEL_DELETE: 3,
        ROLE_DELETE: 3,
        ROLE_CREATE: 4,
        BAN: 3,
        KICK: 3,
        WEBHOOK: 3
      }
    };
    saveDB();
  }
  return db[guildId];
}

// 🧠 TRACK
const tracker = new Map();
const WINDOW = 5000;

function track(userId, action) {
  const now = Date.now();

  if (!tracker.has(userId)) tracker.set(userId, {});
  const data = tracker.get(userId);

  if (!data[action]) data[action] = [];

  data[action].push(now);
  data[action] = data[action].filter(t => now - t < WINDOW);

  return data[action].length;
}

// 🔐 SAFE CHECK
function isSafe(userId, guild) {
  const config = getConfig(guild.id);
  return userId === guild.ownerId || config.whitelist.includes(userId);
}

// 📜 LOG
async function log(guild, msg) {
  const config = getConfig(guild.id);
  let ch = guild.channels.cache.get(config.logChannel);

  if (!ch) {
    ch = guild.channels.cache.find(c => c.name === "security-logs");

    if (!ch) {
      ch = await guild.channels.create({ name: "security-logs" }).catch(() => null);
    }

    if (ch) {
      config.logChannel = ch.id;
      saveDB();
    }
  }

  if (ch) ch.send(`📜 ${msg}`).catch(() => {});
  console.log(msg);
}

// 🔍 EXECUTOR
async function getExecutor(guild, type) {
  await new Promise(r => setTimeout(r, 1200));
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  return logs?.entries.first()?.executor || null;
}

// 🚨 PUNISH
async function punish(guild, user, reason) {
  if (!user) return;
  if (isSafe(user.id, guild)) return;
  if (user.bot) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return;

  try {
    await member.roles.set([]);
    await member.ban({ reason });
    await log(guild, `🚨 ${user.tag} → ${reason}`);
  } catch {}
}

// 🔒 LOCKDOWN
async function lockdown(guild) {
  guild.channels.cache.forEach(async ch => {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false
      });
    } catch {}
  });

  await log(guild, "🔒 Lockdown enabled");
}

// 🔓 UNLOCK
async function unlock(guild) {
  guild.channels.cache.forEach(async ch => {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: true
      });
    } catch {}
  });

  await log(guild, "🔓 Lockdown removed");
}

// ♻️ RESTORE
async function restore(channel) {
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
  console.log(`🔥 PRO bot ready: ${client.user.tag}`);
});

// 🚨 EVENTS

client.on('channelDelete', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.ChannelDelete);
  if (!user) return;

  const config = getConfig(channel.guild.id);
  const count = track(user.id, "CHANNEL_DELETE");

  if (count >= config.limits.CHANNEL_DELETE) {
    await punish(channel.guild, user, "Channel nuke");
    await lockdown(channel.guild);
  }

  await restore(channel);
});

client.on('roleDelete', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleDelete);
  if (!user) return;

  const config = getConfig(role.guild.id);
  const count = track(user.id, "ROLE_DELETE");

  if (count >= config.limits.ROLE_DELETE) {
    await punish(role.guild, user, "Role delete nuke");
  }
});

client.on('roleCreate', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleCreate);
  if (!user) return;

  const config = getConfig(role.guild.id);
  const count = track(user.id, "ROLE_CREATE");

  if (count >= config.limits.ROLE_CREATE) {
    await punish(role.guild, user, "Role spam");
  }
});

client.on('guildBanAdd', async (ban) => {
  const user = await getExecutor(ban.guild, AuditLogEvent.MemberBanAdd);
  if (!user) return;

  const config = getConfig(ban.guild.id);
  const count = track(user.id, "BAN");

  if (count >= config.limits.BAN) {
    await punish(ban.guild, user, "Mass ban");
  }
});

client.on('guildMemberRemove', async (member) => {
  const user = await getExecutor(member.guild, AuditLogEvent.MemberKick);
  if (!user) return;

  const config = getConfig(member.guild.id);
  const count = track(user.id, "KICK");

  if (count >= config.limits.KICK) {
    await punish(member.guild, user, "Mass kick");
  }
});

client.on('webhookUpdate', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.WebhookCreate);
  if (!user) return;

  const config = getConfig(channel.guild.id);
  const count = track(user.id, "WEBHOOK");

  if (count >= config.limits.WEBHOOK) {
    await punish(channel.guild, user, "Webhook abuse");
  }
});

// 💬 COMMANDS

client.on('messageCreate', async (msg) => {
  if (!msg.guild) return;
  if (!msg.member.permissions.has("Administrator")) return;

  const config = getConfig(msg.guild.id);

  // ✅ FIXED SETUP (auto create channel)
  if (msg.content === "!setup") {
    let ch = msg.guild.channels.cache.find(c => c.name === "security-logs");

    if (!ch) {
      ch = await msg.guild.channels.create({
        name: "security-logs"
      }).catch(() => null);
    }

    if (!ch) return msg.reply("❌ Failed to create log channel");

    config.logChannel = ch.id;
    saveDB();

    msg.reply("✅ Security log channel created & set");
  }

  if (msg.content.startsWith("!whitelist add")) {
    const id = msg.mentions.users.first()?.id;
    if (!id) return msg.reply("Mention a user");

    config.whitelist.push(id);
    saveDB();

    msg.reply("✅ Added to whitelist");
  }

  if (msg.content === "!lockdown") {
    await lockdown(msg.guild);
    msg.reply("🔒 Locked");
  }

  if (msg.content === "!unlock") {
    await unlock(msg.guild);
    msg.reply("🔓 Unlocked");
  }

  if (msg.content === "!status") {
    msg.reply("🛡️ Anti-nuke PRO active");
  }
});

client.login(process.env.TOKEN);
