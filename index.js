require('dotenv').config();
const fs = require('fs');
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
      }
    };
    saveDB();
  }
  return db[guildId];
}

/* =========================
   🧠 TRACK (per-user action)
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
  const cfg = getConfig(guild.id);
  return userId === guild.ownerId || cfg.whitelist.includes(userId);
}

/* =========================
   📜 LOG (auto create/set)
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
   🔍 AUDIT LOG (with delay)
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
    await member.roles.set([]); // strip roles
    await member.ban({ reason });
    await log(guild, `🚨 ${user.tag} → ${reason}`);
  } catch (e) {
    await log(guild, `❌ Punish failed for ${user.tag}: ${e.message}`);
  }
}

/* =========================
   🔒 LOCKDOWN / 🔓 UNLOCK
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
   ♻️ FULL CHANNEL RESTORE
   (name, type, parent, topic,
    nsfw, rateLimit, perms)
========================= */
function serializeOverwrites(channel) {
  return channel.permissionOverwrites.cache.map(ow => ({
    id: ow.id,
    allow: ow.allow.bitfield.toString(),
    deny: ow.deny.bitfield.toString(),
    type: ow.type
  }));
}

async function restoreChannel(channel) {
  try {
    const overwrites = serializeOverwrites(channel);

    const created = await channel.guild.channels.create({
      name: channel.name,
      type: channel.type,
      parent: channel.parentId || null,
      topic: channel.topic || undefined,
      nsfw: channel.nsfw || false,
      rateLimitPerUser: channel.rateLimitPerUser || 0,
      permissionOverwrites: overwrites.map(ow => ({
        id: ow.id,
        allow: new PermissionsBitField(BigInt(ow.allow)),
        deny: new PermissionsBitField(BigInt(ow.deny)),
        type: ow.type
      }))
    });

    await log(channel.guild, `♻️ Restored channel: ${created.name}`);
  } catch (e) {
    await log(channel.guild, `❌ Restore failed: ${e.message}`);
  }
}

/* =========================
   🚨 ANTI-NUKE EVENTS
========================= */
client.on('channelDelete', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.ChannelDelete);
  if (!user) return;

  const cfg = getConfig(channel.guild.id);
  const count = track(user.id, "CHANNEL_DELETE");

  if (count >= cfg.limits.CHANNEL_DELETE) {
    await punish(channel.guild, user, "Channel nuke");
    await lockdown(channel.guild);
  }

  await restoreChannel(channel);
});

client.on('roleDelete', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleDelete);
  if (!user) return;

  const cfg = getConfig(role.guild.id);
  const count = track(user.id, "ROLE_DELETE");

  if (count >= cfg.limits.ROLE_DELETE) {
    await punish(role.guild, user, "Role delete nuke");
  }
});

client.on('roleCreate', async (role) => {
  const user = await getExecutor(role.guild, AuditLogEvent.RoleCreate);
  if (!user) return;

  const cfg = getConfig(role.guild.id);
  const count = track(user.id, "ROLE_CREATE");

  if (count >= cfg.limits.ROLE_CREATE) {
    await punish(role.guild, user, "Role spam");
  }
});

client.on('guildBanAdd', async (ban) => {
  const user = await getExecutor(ban.guild, AuditLogEvent.MemberBanAdd);
  if (!user) return;

  const cfg = getConfig(ban.guild.id);
  const count = track(user.id, "BAN");

  if (count >= cfg.limits.BAN) {
    await punish(ban.guild, user, "Mass ban");
  }
});

client.on('guildMemberRemove', async (member) => {
  const user = await getExecutor(member.guild, AuditLogEvent.MemberKick);
  if (!user) return;

  const cfg = getConfig(member.guild.id);
  const count = track(user.id, "KICK");

  if (count >= cfg.limits.KICK) {
    await punish(member.guild, user, "Mass kick");
  }
});

client.on('webhookUpdate', async (channel) => {
  const user = await getExecutor(channel.guild, AuditLogEvent.WebhookCreate);
  if (!user) return;

  const cfg = getConfig(channel.guild.id);
  const count = track(user.id, "WEBHOOK");

  if (count >= cfg.limits.WEBHOOK) {
    await punish(channel.guild, user, "Webhook abuse");
  }
});

/* =========================
   🚨 ULTRA ANTI-RAID
========================= */
const joinTracker = new Map(); // guildId -> timestamps[]
const recentJoins = new Map(); // guildId -> [{userId, ts}]
const raidState = new Map();   // guildId -> {until}

function pushJoin(guildId, userId, windowMs) {
  const now = Date.now();

  if (!joinTracker.has(guildId)) joinTracker.set(guildId, []);
  if (!recentJoins.has(guildId)) recentJoins.set(guildId, []);

  let arr = joinTracker.get(guildId);
  arr.push(now);
  arr = arr.filter(t => now - t < windowMs);
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

function startRaid(guild, durationMs) {
  raidState.set(guild.id, { until: Date.now() + durationMs });
}

async function ensureQuarantineRole(guild, roleName) {
  let role = guild.roles.cache.find(r => r.name === roleName);
  if (!role) {
    role = await guild.roles.create({ name: roleName }).catch(() => null);
  }
  return role;
}

async function cleanupRecentJoiners(guild, lookbackMs) {
  const list = recentJoins.get(guild.id) || [];
  const now = Date.now();
  const targets = list.filter(x => now - x.ts < lookbackMs);

  for (const t of targets) {
    const m = await guild.members.fetch(t.userId).catch(() => null);
    if (!m) continue;
    if (m.user.bot) continue;
    if (m.id === guild.ownerId) continue;

    try {
      await m.kick("Raid cleanup");
      await log(guild, `🧹 Kicked recent joiner: ${m.user.tag}`);
    } catch {}
  }
}

client.on("guildMemberAdd", async (member) => {
  const guild = member.guild;
  const cfg = getConfig(guild.id);
  const R = cfg.raid;

  const count = pushJoin(guild.id, member.id, R.WINDOW_MS);

  // 🤖 bot join
  if (R.KICK_BOTS && member.user.bot) {
    await member.kick("Bot raid protection").catch(() => {});
    await log(guild, `🤖 Bot kicked: ${member.user.tag}`);
    return;
  }

  // 🆕 new account
  const age = Date.now() - member.user.createdTimestamp;
  if (R.KICK_NEW && age < R.NEW_ACCOUNT_MS) {
    await member.kick("New account raid protection").catch(() => {});
    await log(guild, `🚫 New account kicked: ${member.user.tag}`);
    return;
  }

  // already in raid → quarantine
  if (isRaidActive(guild.id)) {
    const role = await ensureQuarantineRole(guild, R.QUARANTINE_ROLE_NAME);
    if (role) await member.roles.set([role]).catch(() => {});
    await log(guild, `⚠️ Quarantined during raid: ${member.user.tag}`);
    return;
  }

  // trigger raid
  if (count >= R.JOIN_LIMIT) {
    startRaid(guild, R.RAID_MODE_MS);
    await log(guild, `🚨 RAID DETECTED (${count} joins)`);

    if (R.LOCKDOWN_ON_RAID) {
      await lockdown(guild);
    }

    if (R.CLEANUP_ON_TRIGGER) {
      await cleanupRecentJoiners(guild, R.CLEANUP_LOOKBACK_MS);
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
    if (!ch) return msg.reply("❌ Failed to create log channel");

    cfg.logChannel = ch.id;
    saveDB();
    msg.reply("✅ Security log channel ready");
  }

  if (msg.content.startsWith("!whitelist add")) {
    const id = msg.mentions.users.first()?.id;
    if (!id) return msg.reply("Mention a user");
    if (!cfg.whitelist.includes(id)) cfg.whitelist.push(id);
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

  if (msg.content === "!raid status") {
    const active = isRaidActive(msg.guild.id);
    msg.reply(active ? "🚨 Raid mode ACTIVE" : "🟢 No raid");
  }

  if (msg.content === "!raid off") {
    raidState.set(msg.guild.id, { until: 0 });
    await unlock(msg.guild);
    msg.reply("🟢 Raid mode disabled & server unlocked");
  }

  if (msg.content === "!status") {
    msg.reply("🛡️ Ultimate protection active");
  }
});

client.once('ready', () => {
  console.log(`🔥 Ultimate bot ready: ${client.user.tag}`);
});

client.login(process.env.TOKEN);
