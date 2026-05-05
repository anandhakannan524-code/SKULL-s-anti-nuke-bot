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

/* =========================
   📂 DATABASE
========================= */
const DB_FILE = "./data.json";
let db = {};

if (fs.existsSync(DB_FILE)) {
  db = JSON.parse(fs.readFileSync(DB_FILE));
}

function saveDB() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

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

/* =========================
   🚨 ULTRA RAID CONFIG
========================= */
const RAID = {
  JOIN_LIMIT: 7,
  WINDOW_MS: 7000,
  RAID_MODE_MS: 5 * 60 * 1000,
  NEW_ACCOUNT_MS: 24 * 60 * 60 * 1000,
  KICK_NEW: true,
  KICK_BOTS: true,
  CLEANUP_ON_TRIGGER: true,
  CLEANUP_LOOKBACK_MS: 60 * 1000,
  QUARANTINE_ROLE_NAME: "Quarantine",
  LOCKDOWN_ON_RAID: true
};

/* =========================
   🧠 TRACK SYSTEM
========================= */
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

/* =========================
   🔐 SAFETY
========================= */
function isSafe(userId, guild) {
  const config = getConfig(guild.id);
  return userId === guild.ownerId || config.whitelist.includes(userId);
}

/* =========================
   📜 LOG
========================= */
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

/* =========================
   🔍 AUDIT LOG
========================= */
async function getExecutor(guild, type) {
  await new Promise(r => setTimeout(r, 1200));
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  return logs?.entries.first()?.executor || null;
}

/* =========================
   🚨 PUNISH
========================= */
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

/* =========================
   🔒 LOCKDOWN
========================= */
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

/* =========================
   ♻️ RESTORE CHANNEL
========================= */
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

/* =========================
   🚨 ANTI-NUKE EVENTS
========================= */

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

/* =========================
   🚨 ULTRA ANTI-RAID
========================= */

const joinTracker = new Map();
const recentJoins = new Map();
const raidState = new Map();

function pushJoin(guildId, userId) {
  const now = Date.now();

  if (!joinTracker.has(guildId)) joinTracker.set(guildId, []);
  if (!recentJoins.has(guildId)) recentJoins.set(guildId, []);

  let arr = joinTracker.get(guildId);
  arr.push(now);
  arr = arr.filter(t => now - t < RAID.WINDOW_MS);
  joinTracker.set(guildId, arr);

  let r = recentJoins.get(guildId);
  r.push({ userId, ts: now });
  r = r.filter(x => now - x.ts < 2 * 60 * 1000);
  recentJoins.set(guildId, r);

  return arr.length;
}

function isRaidActive(guildId) {
  const st = raidState.get(guildId);
  return st && Date.now() < st.until;
}

function startRaid(guild) {
  raidState.set(guild.id, {
    until: Date.now() + RAID.RAID_MODE_MS
  });
}

async function ensureRole(guild) {
  let role = guild.roles.cache.find(r => r.name === RAID.QUARANTINE_ROLE_NAME);
  if (!role) {
    role = await guild.roles.create({ name: RAID.QUARANTINE_ROLE_NAME }).catch(() => null);
  }
  return role;
}

client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
  const count = pushJoin(guild.id, member.id);

  if (RAID.KICK_BOTS && member.user.bot) {
    await member.kick("Bot raid").catch(() => {});
    return;
  }

  const age = Date.now() - member.user.createdTimestamp;
  if (RAID.KICK_NEW && age < RAID.NEW_ACCOUNT_MS) {
    await member.kick("New account").catch(() => {});
    return;
  }

  if (isRaidActive(guild.id)) {
    const role = await ensureRole(guild);
    if (role) await member.roles.set([role]).catch(() => {});
    return;
  }

  if (count >= RAID.JOIN_LIMIT) {
    startRaid(guild);
    await log(guild, "🚨 RAID DETECTED");

    if (RAID.LOCKDOWN_ON_RAID) {
      await lockdown(guild);
    }
  }
});

/* =========================
   💬 COMMANDS
========================= */

client.on('messageCreate', async (msg) => {
  if (!msg.guild) return;
  if (!msg.member.permissions.has("Administrator")) return;

  const config = getConfig(msg.guild.id);

  if (msg.content === "!setup") {
    let ch = msg.guild.channels.cache.find(c => c.name === "security-logs");

    if (!ch) {
      ch = await msg.guild.channels.create({ name: "security-logs" }).catch(() => null);
    }

    if (!ch) return msg.reply("❌ Failed");

    config.logChannel = ch.id;
    saveDB();

    msg.reply("✅ Logs ready");
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
    msg.reply("🛡️ Ultra protection active");
  }
});

client.login(process.env.TOKEN);
