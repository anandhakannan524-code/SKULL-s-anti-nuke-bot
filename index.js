require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  AuditLogEvent,
  PermissionsBitField
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
   📂 SIMPLE JSON DB
========================= */
const DB_FILE = "./data.json";
let db = {};
if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE));

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
      },
      raid: {
        JOIN_LIMIT: 3,          // easier to trigger for testing
        WINDOW_MS: 10000,       // 10s window
        RAID_MODE_MS: 3 * 60 * 1000,
        NEW_ACCOUNT_MS: 6 * 60 * 60 * 1000, // 6 hours
        KICK_NEW: true,
        KICK_BOTS: true,
        LOCKDOWN_ON_RAID: true
      }
    };
    saveDB();
  }
  return db[guildId];
}

/* =========================
   📜 LOG
========================= */
async function log(guild, msg) {
  const cfg = getConfig(guild.id);
  let ch = guild.channels.cache.get(cfg.logChannel);

  if (!ch) {
    ch = guild.channels.cache.find(c => c.name === "security-logs");
    if (!ch) {
      ch = await guild.channels.create({ name: "security-logs" }).catch(() => null);
    }
    if (ch) {
      cfg.logChannel = ch.id;
      saveDB();
    }
  }

  if (ch) ch.send(`📜 ${msg}`).catch(() => {});
  console.log(`[${guild.name}] ${msg}`);
}

/* =========================
   🔐 SAFETY
========================= */
function isSafe(userId, guild) {
  const cfg = getConfig(guild.id);
  return userId === guild.ownerId || cfg.whitelist.includes(userId);
}

/* =========================
   🔒 LOCKDOWN / UNLOCK
========================= */
async function lockdown(guild) {
  for (const ch of guild.channels.cache.values()) {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: false
      });
    } catch {}
  }
  await log(guild, "🔒 Lockdown enabled");
}

async function unlock(guild) {
  for (const ch of guild.channels.cache.values()) {
    try {
      await ch.permissionOverwrites.edit(guild.roles.everyone, {
        SendMessages: true
      });
    } catch {}
  }
  await log(guild, "🔓 Lockdown removed");
}

/* =========================
   🚨 ANTI-NUKE (basic)
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

async function getExecutor(guild, type) {
  await new Promise(r => setTimeout(r, 1200));
  const logs = await guild.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  return logs?.entries.first()?.executor || null;
}

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

client.on('channelDelete', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.ChannelDelete);
  if (!user) return;

  const cfg = getConfig(channel.guild.id);
  const count = track(user.id, "CHANNEL_DELETE");

  if (count >= cfg.limits.CHANNEL_DELETE) {
    await punish(channel.guild, user, "Channel nuke");
    await lockdown(channel.guild);
  }
});

/* =========================
   🚨 ANTI-RAID
========================= */
const joinTracker = new Map();
const raidState = new Map();

function pushJoin(guildId, windowMs) {
  const now = Date.now();
  if (!joinTracker.has(guildId)) joinTracker.set(guildId, []);

  let arr = joinTracker.get(guildId);
  arr.push(now);
  arr = arr.filter(t => now - t < windowMs);
  joinTracker.set(guildId, arr);

  return arr.length;
}

function isRaidActive(guildId) {
  const st = raidState.get(guildId);
  return st && Date.now() < st.until;
}

function startRaid(guild, duration) {
  raidState.set(guild.id, { until: Date.now() + duration });
}

client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
  const cfg = getConfig(guild.id);
  const R = cfg.raid;

  const count = pushJoin(guild.id, R.WINDOW_MS);

  // Bot join
  if (R.KICK_BOTS && member.user.bot) {
    await member.kick("Bot raid protection").catch(() => {});
    await log(guild, `🤖 Bot kicked: ${member.user.tag}`);
    return;
  }

  // New account
  const age = Date.now() - member.user.createdTimestamp;
  if (R.KICK_NEW && age < R.NEW_ACCOUNT_MS) {
    await member.kick("New account").catch(() => {});
    await log(guild, `🚫 New account kicked: ${member.user.tag}`);
    return;
  }

  // Already in raid
  if (isRaidActive(guild.id)) {
    await log(guild, `⚠️ Join during raid: ${member.user.tag}`);
    return;
  }

  // Trigger raid
  if (count >= R.JOIN_LIMIT) {
    startRaid(guild, R.RAID_MODE_MS);
    await log(guild, `🚨 RAID DETECTED (${count} joins)`);

    if (R.LOCKDOWN_ON_RAID) {
      await lockdown(guild);
    }
  }
});

/* =========================
   💬 COMMANDS (ADMIN)
========================= */
client.on('messageCreate', async (msg) => {
  if (!msg.guild) return;
  if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

  const cfg = getConfig(msg.guild.id);

  if (msg.content === "!setup") {
    let ch = msg.guild.channels.cache.find(c => c.name === "security-logs");
    if (!ch) {
      ch = await msg.guild.channels.create({ name: "security-logs" }).catch(() => null);
    }
    if (!ch) return msg.reply("❌ Failed");

    cfg.logChannel = ch.id;
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
    msg.reply("🛡️ Protection active");
  }
});

client.once('ready', () => {
  console.log(`🔥 Bot ready: ${client.user.tag}`);
});

client.login(process.env.TOKEN);
