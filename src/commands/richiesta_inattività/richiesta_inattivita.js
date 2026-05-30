import fs from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const VOTE_CHANNEL_ID = "1508376281220382842";
const ACCEPTED_CHANNEL_ID = "1470700465175003209";
const ARCHIVE_CHANNEL_ID = "1509504479563747328";
const ACCEPTED_ROLE_ID = "1491889075526041630";

// 4 ore = 14400000 millisecondi.
const DEFAULT_VOTE_DURATION_MS = 14400000;

const CHECK_EMOJI = "✅";
const CROSS_EMOJI = "❌";

// Non devi creare questa cartella a mano: viene creata automaticamente.
const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const LOG_FILE = path.join(DATA_FOLDER, "inactivity_logs.json");
const PENDING_FILE = path.join(DATA_FOLDER, "pending_inactivity_requests.json");
const ACTIVE_FILE = path.join(DATA_FOLDER, "active_inactivity_ranges.json");
const CONFIG_FILE = path.join(DATA_FOLDER, "inactivity_config.json");
const scheduledFinalizers = new Map();
const scheduledRangeTimers = new Map();
const MAX_TIMEOUT_MS = 2_147_000_000;
const INACTIVITY_TIME_ZONE = "Europe/Rome";

async function ensureDataFolder() {
  await fs.mkdir(DATA_FOLDER, { recursive: true });
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function saveJson(filePath, data) {
  await ensureDataFolder();
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function getInactivityConfig() {
  const config = await loadJson(CONFIG_FILE, {});
  const voteDurationMs = Number(config.voteDurationMs);

  return {
    voteDurationMs: Number.isFinite(voteDurationMs) && voteDurationMs > 0
      ? voteDurationMs
      : DEFAULT_VOTE_DURATION_MS,
  };
}
async function getUserLogSummary(userId) {
  const logs = await loadJson(LOG_FILE, {});
  const userLog = logs[userId] || {};

  return {
    total: userLog.totalRequests || 0,
    accepted: userLog.acceptedRequests || 0,
    rejected: userLog.rejectedRequests || 0,
  };
}

async function addLogEntry(userId, entry) {
  const logs = await loadJson(LOG_FILE, {});

  if (!logs[userId]) {
    logs[userId] = {
      totalRequests: 0,
      acceptedRequests: 0,
      rejectedRequests: 0,
      requests: [],
    };
  }

  logs[userId].totalRequests += 1;

  if (entry.status === "accepted") {
    logs[userId].acceptedRequests += 1;
  } else {
    logs[userId].rejectedRequests += 1;
  }

  logs[userId].requests.push(entry);
  await saveJson(LOG_FILE, logs);
}

async function savePendingRequest(messageId, request) {
  const pendingRequests = await loadJson(PENDING_FILE, {});
  pendingRequests[messageId] = request;
  await saveJson(PENDING_FILE, pendingRequests);
}

async function removePendingRequest(messageId) {
  const pendingRequests = await loadJson(PENDING_FILE, {});
  delete pendingRequests[messageId];
  await saveJson(PENDING_FILE, pendingRequests);
}

async function saveActiveRange(key, activeRange) {
  const activeRanges = await loadJson(ACTIVE_FILE, {});
  activeRanges[key] = activeRange;
  await saveJson(ACTIVE_FILE, activeRanges);
}

async function removeActiveRange(key) {
  const activeRanges = await loadJson(ACTIVE_FILE, {});
  delete activeRanges[key];
  await saveJson(ACTIVE_FILE, activeRanges);
}

function discordTimestamp(dateMs, style = "F") {
  return `<t:${Math.floor(dateMs / 1000)}:${style}>`;
}

function getTimeZoneOffsetMs(timeZone, timestamp) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value]),
  );

  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );

  return asUTC - timestamp;
}

function makeItalianTimestamp(year, month, day, hour, minute) {
  const localAsUTC = Date.UTC(year, month - 1, day, hour, minute, 0);
  let offset = getTimeZoneOffsetMs(INACTIVITY_TIME_ZONE, localAsUTC);
  let timestamp = localAsUTC - offset;

  // Second pass handles daylight saving offset changes more safely.
  offset = getTimeZoneOffsetMs(INACTIVITY_TIME_ZONE, timestamp);
  timestamp = localAsUTC - offset;

  return timestamp;
}

function parseDiscordTime(input) {
  const value = input
    .trim()
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ");

  // Formato italiano: 28/05/2026 oppure 28/05/2026 18:30
  const italianDateMatch = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2})[:.](\d{2}))?$/);
  if (italianDateMatch) {
    const [, day, month, year, hour = "0", minute = "0"] = italianDateMatch;
    const timestamp = makeItalianTimestamp(Number(year), Number(month), Number(day), Number(hour), Number(minute));
    const check = new Date(timestamp);

    if (!Number.isNaN(timestamp) && Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31 && Number(hour) >= 0 && Number(hour) <= 23 && Number(minute) >= 0 && Number(minute) <= 59 && check instanceof Date) {
      return timestamp;
    }
  }

  // Formato ISO semplice: 2026-05-28 oppure 2026-05-28 18:30
  const isoDateMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2})[:.](\d{2}))?$/);
  if (isoDateMatch) {
    const [, year, month, day, hour = "0", minute = "0"] = isoDateMatch;
    const timestamp = makeItalianTimestamp(Number(year), Number(month), Number(day), Number(hour), Number(minute));
    const check = new Date(timestamp);

    if (!Number.isNaN(timestamp) && Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= 31 && Number(hour) >= 0 && Number(hour) <= 23 && Number(minute) >= 0 && Number(minute) <= 59 && check instanceof Date) {
      return timestamp;
    }
  }

  throw new Error("Formato data non valido");
}async function createVoteEmbed(request) {
  const summary = await getUserLogSummary(request.userId);

  return new EmbedBuilder()
    .setTitle("Richiesta di inattività")
    .setColor(0xf2c94c)
    .addFields(
      { name: "IGN", value: request.ign, inline: false },
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
      { name: "Richiesta inviata", value: discordTimestamp(request.requestedAt), inline: true },
      { name: "Scadenza votazione", value: discordTimestamp(request.expiresAt, "R"), inline: true },
      {
        name: "Log utente",
        value: [
          `Richieste totali precedenti: ${summary.total}`,
          `Accettate precedenti: ${summary.accepted}`,
          `Rifiutate precedenti: ${summary.rejected}`,
        ].join("\n"),
        inline: false,
      },
    )
    .setFooter({ text: `ID utente: ${request.userId}` });
}

function createAcceptedEmbed(request) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .addFields(
      { name: "IGN", value: request.ign, inline: false },
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

function createArchiveEmbed(request, status) {
  return new EmbedBuilder()
    .setColor(status === "finita" ? 0xf2c94c : status === "in corso" ? 0x2ecc71 : 0x99aab5)
    .addFields(
      { name: "IGN", value: request.ign, inline: false },
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
      { name: "STATUS", value: status, inline: false },
    )
    .setTimestamp(new Date());
}
function createAcceptedDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Richiesta di inattività accettata")
    .setDescription("La tua richiesta di inattività è stata accettata.")
    .setColor(0x2ecc71)
    .addFields(
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}
function createRejectedDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Richiesta di inattività non accettata")
    .setDescription("La tua richiesta di inattività non è stata accettata. Puoi riprovare inviando una nuova richiesta.")
    .setColor(0xe74c3c)
    .addFields(
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

function createTieDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Richiesta di inattività in parità")
    .setDescription("I voti sono arrivati alla pari, quindi ti chiediamo di richiedere nuovamente l'inattività.")
    .setColor(0xf2c94c)
    .addFields(
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}
function createInactivityStartedDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Inattività iniziata")
    .setDescription("La tua inattività è iniziata e il ruolo inattività ti è stato assegnato.")
    .setColor(0x2ecc71)
    .addFields(
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

function createInactivityEndedDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Inattività terminata")
    .setDescription("La tua inattività è terminata e il ruolo inattività ti è stato rimosso.")
    .setColor(0xf2c94c)
    .addFields(
      { name: "DURATA DELL'INATTIVITÀ", value: request.duration, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

function safeSetTimeout(callback, delay) {
  if (delay <= MAX_TIMEOUT_MS) {
    return setTimeout(callback, Math.max(0, delay));
  }

  return setTimeout(() => {
    safeSetTimeout(callback, delay - MAX_TIMEOUT_MS);
  }, MAX_TIMEOUT_MS);
}

async function updateStatusMessages(client, activeRange, status) {
  if (activeRange.acceptedChannelId && activeRange.acceptedMessageId && status !== "finita") {
    try {
      const acceptedChannel = await client.channels.fetch(activeRange.acceptedChannelId);
      const acceptedMessage = await acceptedChannel.messages.fetch(activeRange.acceptedMessageId);
      await acceptedMessage.edit({ embeds: [createArchiveEmbed(activeRange.request, status)] });
    } catch (error) {
      console.warn(`Impossibile aggiornare status messaggio inattività accettata ${activeRange.acceptedMessageId}: ${error.message}`);
    }
  }

  if (activeRange.archiveChannelId && activeRange.archiveMessageId) {
    try {
      const archiveChannel = await client.channels.fetch(activeRange.archiveChannelId);
      const archiveMessage = await archiveChannel.messages.fetch(activeRange.archiveMessageId);
      await archiveMessage.edit({ embeds: [createArchiveEmbed(activeRange.request, status)] });
    } catch (error) {
      console.warn(`Impossibile aggiornare status archivio inattività ${activeRange.archiveMessageId}: ${error.message}`);
    }
  }
}
async function addInactivityRole(client, key, activeRange) {
  await updateStatusMessages(client, activeRange, "in corso");
  const guild = client.guilds.cache.get(activeRange.guildId) || await client.guilds.fetch(activeRange.guildId);
  const member = await guild.members.fetch(activeRange.request.userId);
  const alreadyHadRole = member.roles.cache.has(ACCEPTED_ROLE_ID);

  if (!alreadyHadRole) {
    await member.roles.add(ACCEPTED_ROLE_ID, "Inizio periodo inattività approvato");
  }

  const updatedRange = {
    ...activeRange,
    roleAssigned: true,
    roleAssignedAt: activeRange.roleAssignedAt || new Date().toISOString(),
  };
  await saveActiveRange(key, updatedRange);

  if (!activeRange.roleAssigned) {
    try {
      await member.send({ embeds: [createInactivityStartedDmEmbed(activeRange.request)] });
    } catch (error) {
      console.warn(`Impossibile mandare DM inizio inattività a ${activeRange.request.userId}: ${error.message}`);
    }
  }
}
async function removeInactivityRole(client, key, activeRange) {
  try {
    await updateStatusMessages(client, activeRange, "finita");
    if (activeRange.acceptedChannelId && activeRange.acceptedMessageId) {
      try {
        const acceptedChannel = await client.channels.fetch(activeRange.acceptedChannelId);
        const acceptedMessage = await acceptedChannel.messages.fetch(activeRange.acceptedMessageId);
        await acceptedMessage.delete();
      } catch (error) {
        console.warn(`Impossibile eliminare il messaggio inattività accettata ${activeRange.acceptedMessageId}: ${error.message}`);
      }
    }

    const guild = client.guilds.cache.get(activeRange.guildId) || await client.guilds.fetch(activeRange.guildId);
    const member = await guild.members.fetch(activeRange.request.userId);

    if (member.roles.cache.has(ACCEPTED_ROLE_ID)) {
      await member.roles.remove(ACCEPTED_ROLE_ID, "Fine periodo inattività approvato");
    }

    try {
      await member.send({ embeds: [createInactivityEndedDmEmbed(activeRange.request)] });
    } catch (error) {
      console.warn(`Impossibile mandare DM fine inattività a ${activeRange.request.userId}: ${error.message}`);
    }
  } finally {
    await removeActiveRange(key);
    const timers = scheduledRangeTimers.get(key);
    if (timers?.startTimeout) clearTimeout(timers.startTimeout);
    if (timers?.endTimeout) clearTimeout(timers.endTimeout);
    scheduledRangeTimers.delete(key);
  }
}
function scheduleActiveRange(client, key, activeRange) {
  if (scheduledRangeTimers.has(key)) return;

  const now = Date.now();

  if (activeRange.endAt <= now) {
    const endTimeout = safeSetTimeout(() => {
      removeInactivityRole(client, key, activeRange).catch((error) => {
        console.error("Errore rimozione ruolo inattività:", error);
      });
    }, 0);

    scheduledRangeTimers.set(key, { startTimeout: null, endTimeout });
    return;
  }

  let startTimeout = null;

  if (activeRange.startAt <= now && activeRange.endAt > now) {
    startTimeout = safeSetTimeout(() => {
      addInactivityRole(client, key, activeRange).catch((error) => {
        console.error("Errore assegnazione ruolo inattività:", error);
      });
    }, 0);
  } else if (activeRange.startAt > now) {
    startTimeout = safeSetTimeout(() => {
      addInactivityRole(client, key, activeRange).catch((error) => {
        console.error("Errore assegnazione ruolo inattività:", error);
      });
    }, activeRange.startAt - now);
  }

  const endTimeout = safeSetTimeout(() => {
    removeInactivityRole(client, key, activeRange).catch((error) => {
      console.error("Errore rimozione ruolo inattività:", error);
    });
  }, activeRange.endAt - now);

  scheduledRangeTimers.set(key, { startTimeout, endTimeout });
}
async function countReaction(message, emoji) {
  const freshMessage = await message.channel.messages.fetch(message.id);
  const reaction = freshMessage.reactions.cache.get(emoji);
  if (!reaction) return 0;
  return Math.max(0, reaction.count - 1);
}

async function finalizeRequest(client, messageId, request) {
  try {
    const voteChannel = await client.channels.fetch(VOTE_CHANNEL_ID);
    const voteMessage = await voteChannel.messages.fetch(messageId);
    const checkVotes = await countReaction(voteMessage, CHECK_EMOJI);
    const crossVotes = await countReaction(voteMessage, CROSS_EMOJI);
    const accepted = checkVotes > crossVotes;
    const tied = checkVotes === crossVotes;

    await addLogEntry(request.userId, {
      status: accepted ? "accepted" : tied ? "tied" : "rejected",
      requestedAt: new Date(request.requestedAt).toISOString(),
      finalizedAt: new Date().toISOString(),
      duration: request.duration,
      reason: request.reason,
      voteMessageId: messageId,
      checkVotes,
      crossVotes,
    });

    if (accepted) {
      const acceptedChannel = await client.channels.fetch(ACCEPTED_CHANNEL_ID);
      const acceptedStatus = request.startAt <= Date.now() && request.endAt > Date.now()
        ? "in corso"
        : "ancora non in corso";
      const acceptedMessage = await acceptedChannel.send({ embeds: [createArchiveEmbed(request, acceptedStatus)] });
      const archiveStatus = request.startAt <= Date.now() && request.endAt > Date.now()
        ? "in corso"
        : "ancora non in corso";
      const archiveChannel = await client.channels.fetch(ARCHIVE_CHANNEL_ID);
      const archiveMessage = await archiveChannel.send({ embeds: [createArchiveEmbed(request, archiveStatus)] });

      try {
        const guild = voteMessage.guild;
        const member = await guild.members.fetch(request.userId);
        await member.send({ embeds: [createAcceptedDmEmbed(request)] });
      } catch (error) {
        console.warn(`Impossibile mandare DM o assegnare ruolo a ${request.userId}: ${error.message}`);
      }

      const activeRange = {
        guildId: voteMessage.guild.id,
        acceptedChannelId: ACCEPTED_CHANNEL_ID,
        acceptedMessageId: acceptedMessage.id,
        archiveChannelId: ARCHIVE_CHANNEL_ID,
        archiveMessageId: archiveMessage.id,
        request,
        startAt: request.startAt,
        endAt: request.endAt,
        roleAssigned: false,
      };
      await saveActiveRange(messageId, activeRange);

      if (activeRange.startAt <= Date.now() && activeRange.endAt > Date.now()) {
        await addInactivityRole(client, messageId, activeRange);
        scheduleActiveRange(client, messageId, { ...activeRange, roleAssigned: true });
      } else {
        scheduleActiveRange(client, messageId, activeRange);
      }

      await voteMessage.reply(`Richiesta accettata con ${checkVotes} ${CHECK_EMOJI} contro ${crossVotes} ${CROSS_EMOJI}.`);
      return;
    }

    try {
      const user = await client.users.fetch(request.userId);
      await user.send({ embeds: [tied ? createTieDmEmbed(request) : createRejectedDmEmbed(request)] });
    } catch (error) {
      console.warn(`Impossibile mandare DM a ${request.userId}: ${error.message}`);
    }

    await voteMessage.reply(
      tied
        ? `Richiesta chiusa in parità con ${checkVotes} ${CHECK_EMOJI} e ${crossVotes} ${CROSS_EMOJI}.`
        : `Richiesta rifiutata con ${checkVotes} ${CHECK_EMOJI} contro ${crossVotes} ${CROSS_EMOJI}.`
    );
  } finally {
    await removePendingRequest(messageId);
    scheduledFinalizers.delete(messageId);
  }
}
function scheduleFinalizer(client, messageId, request) {
  if (scheduledFinalizers.has(messageId)) return;

  const delay = Math.max(0, request.expiresAt - Date.now());
  const timeout = setTimeout(() => {
    finalizeRequest(client, messageId, request).catch((error) => {
      console.error("Errore durante la chiusura della richiesta inattività:", error);
    });
  }, delay);

  scheduledFinalizers.set(messageId, timeout);
}

export async function resumePendingInactivityRequests(client) {
  const pendingRequests = await loadJson(PENDING_FILE, {});

  for (const [messageId, request] of Object.entries(pendingRequests)) {
    scheduleFinalizer(client, messageId, request);
  }

  const activeRanges = await loadJson(ACTIVE_FILE, {});
  for (const [key, activeRange] of Object.entries(activeRanges)) {
    if (activeRange.endAt <= Date.now()) {
      await removeInactivityRole(client, key, activeRange).catch((error) => {
        console.error("Errore recupero fine inattività:", error);
      });
    } else {
      scheduleActiveRange(client, key, activeRange);
    }
  }
}

export const data = new SlashCommandBuilder()
  .setName("richiesta_inattivita")
  .setDescription("Richiedi Inattività dal moderare il server o inattività generale")
  .addStringOption((option) =>
    option
      .setName("inizio")
      .setDescription("Data scelta dall utente, es. 28/05/2026 oppure 2026-05-28 18:30")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("fine")
      .setDescription("Data scelta dall utente, es. 30/05/2026 oppure 2026-05-30 18:30")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("motivo")
      .setDescription("Il motivo della tua inattività")
      .setRequired(true),
  );

export const name = "richiesta_inattivita";
export const description = "Richiedi Inattività dal moderare il server o inattività generale";

export async function execute(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ ephemeral: true });
  }

  try {
    const startInput = interaction.options.getString("inizio", true);
    const endInput = interaction.options.getString("fine", true);
    const reason = interaction.options.getString("motivo", true);
    const ign = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    const requestedAt = Date.now();
    const inactivityConfig = await getInactivityConfig();
    const expiresAt = requestedAt + inactivityConfig.voteDurationMs;
    const startAt = parseDiscordTime(startInput);
    const endAt = parseDiscordTime(endInput);

    if (endAt <= startAt) {
      await interaction.editReply("La data di fine deve essere dopo la data di inizio.");
      return;
    }

    const request = {
      userId: interaction.user.id,
      username: interaction.user.tag,
      ign,
      duration: `${startInput} al ${endInput}`,
      startAt,
      endAt,
      reason,
      requestedAt,
      expiresAt,
    };

    const voteChannel = await interaction.client.channels.fetch(VOTE_CHANNEL_ID);

    if (!voteChannel || !voteChannel.isTextBased()) {
      await interaction.editReply("Non riesco a trovare il canale votazione. Controlla che l'ID sia corretto.");
      return;
    }

    const voteMessage = await voteChannel.send({ embeds: [await createVoteEmbed(request)] });
    await voteMessage.react(CHECK_EMOJI);
    await voteMessage.react(CROSS_EMOJI);

    await savePendingRequest(voteMessage.id, request);
    scheduleFinalizer(interaction.client, voteMessage.id, request);

    await interaction.editReply(`Grazie, la tua richiesta è stata mandata in revisione dallo staff, riceverai una risposta tra ${discordTimestamp(expiresAt, "R")}.`);
  } catch (error) {
    console.error("Errore comando richiesta_inattivita:", error);

    const message = error.message === "Formato data non valido"
      ? "Formato data non valido. Inserisci una data reale scelta da te. Esempi: `28/05/2026`, `28/05/2026 18:30`, `2026-05-28`, `2026-05-28 18:30`."
      : "Il comando ha avuto un errore interno. Guarda il terminale/log del bot per vedere il motivo preciso.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
}

export const run = execute;
export const callback = execute;

export default {
  data,
  name,
  description,
  execute,
  run,
  callback,
  resumePendingInactivityRequests,
};

















