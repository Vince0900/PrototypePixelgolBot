import fs from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const VOTE_CHANNEL_ID = "1508376281220382842";
const ACCEPTED_CHANNEL_ID = "1470700465175003209";
const ACCEPTED_ROLE_ID = "1491889075526041630";

const DEFAULT_VOTE_DURATION_MS = 14400000;
const CHECK_EMOJI = "✅";
const CROSS_EMOJI = "❌";

const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const LOG_FILE = path.join(DATA_FOLDER, "inactivity_logs.json");
const PENDING_FILE = path.join(DATA_FOLDER, "pending_inactivity_requests.json");
const ACTIVE_FILE = path.join(DATA_FOLDER, "active_inactivity_requests.json");
const CONFIG_FILE = path.join(DATA_FOLDER, "inactivity_config.json");
const scheduledFinalizers = new Map();
const scheduledEndTimers = new Map();

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
      tiedRequests: 0,
      requests: [],
    };
  }

  logs[userId].totalRequests += 1;

  if (entry.status === "accepted") {
    logs[userId].acceptedRequests += 1;
  } else if (entry.status === "tied") {
    logs[userId].tiedRequests = (logs[userId].tiedRequests || 0) + 1;
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

async function saveActiveRequest(key, activeRequest) {
  const activeRequests = await loadJson(ACTIVE_FILE, {});
  activeRequests[key] = activeRequest;
  await saveJson(ACTIVE_FILE, activeRequests);
}

async function removeActiveRequest(key) {
  const activeRequests = await loadJson(ACTIVE_FILE, {});
  delete activeRequests[key];
  await saveJson(ACTIVE_FILE, activeRequests);
}

function discordTimestamp(dateMs, style = "F") {
  return `<t:${Math.floor(dateMs / 1000)}:${style}>`;
}

function parsePreciseTime(input, minTime = Date.now()) {
  const value = input.trim();
  const timestampMatch = value.match(/<t:(\d{10,13})(?::[tTdDfFR])?>|(?:^|\s)t:(\d{10,13})(?:\s|$)/);

  if (timestampMatch) {
    const raw = timestampMatch[1] || timestampMatch[2];
    const timestamp = Number(raw.length === 13 ? raw : `${raw}000`);
    if (timestamp > minTime) return timestamp;
  }

  const tokenRegex = /(\d+)\s*(secondi|secondo|sec|s|minuti|minuto|min|m|ore|ora|h|giorni|giorno|g|d)/gi;
  let totalMs = 0;
  let match;

  while ((match = tokenRegex.exec(value)) !== null) {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();

    if (["secondi", "secondo", "sec", "s"].includes(unit)) totalMs += amount * 1000;
    else if (["minuti", "minuto", "min", "m"].includes(unit)) totalMs += amount * 60 * 1000;
    else if (["ore", "ora", "h"].includes(unit)) totalMs += amount * 60 * 60 * 1000;
    else if (["giorni", "giorno", "g", "d"].includes(unit)) totalMs += amount * 24 * 60 * 60 * 1000;
  }

  if (totalMs > 0) return minTime + totalMs;

  const normalizedDate = value.replace(" ", "T");
  const parsedDate = Date.parse(normalizedDate);
  if (!Number.isNaN(parsedDate) && parsedDate > minTime) {
    return parsedDate;
  }

  throw new Error("Formato durata non valido");
}

async function createVoteEmbed(request) {
  const summary = await getUserLogSummary(request.userId);

  return new EmbedBuilder()
    .setTitle("Richiesta di inattività")
    .setColor(0xf2c94c)
    .addFields(
      { name: "IGN", value: request.ign, inline: false },
      { name: "DURATA DELL'INATTIVITÀ", value: `${discordTimestamp(request.inactivityStartsAt)} al ${discordTimestamp(request.inactivityEndsAt)}`, inline: false },
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

function createAcceptedEmbed(request, color = 0x2ecc71) {
  return new EmbedBuilder()
    .setColor(color)
    .addFields(
      { name: "IGN", value: request.ign, inline: false },
      { name: "DURATA DELL'INATTIVITÀ", value: `${discordTimestamp(request.inactivityStartsAt)} al ${discordTimestamp(request.inactivityEndsAt)}`, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

function createAcceptedDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Richiesta di inattività accettata")
    .setDescription(`La tua richiesta di inattività è stata accettata. La pausa finirà ${discordTimestamp(request.inactivityEndsAt, "R")}.`)
    .setColor(0x2ecc71)
    .addFields(
      { name: "DURATA", value: `${discordTimestamp(request.inactivityStartsAt)} al ${discordTimestamp(request.inactivityEndsAt)}`, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

function createInactivityEndedDmEmbed(request) {
  return new EmbedBuilder()
    .setTitle("Pausa finita")
    .setDescription("La tua pausa/inattività è finita. Il ruolo inattività è stato rimosso.")
    .setColor(0xf2c94c)
    .addFields(
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
      { name: "DURATA RICHIESTA", value: `${discordTimestamp(request.inactivityStartsAt)} al ${discordTimestamp(request.inactivityEndsAt)}`, inline: false },
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
      { name: "DURATA RICHIESTA", value: `${discordTimestamp(request.inactivityStartsAt)} al ${discordTimestamp(request.inactivityEndsAt)}`, inline: false },
      { name: "MOTIVO", value: request.reason, inline: false },
    )
    .setTimestamp(new Date());
}

async function countReaction(message, emoji) {
  const freshMessage = await message.channel.messages.fetch(message.id);
  const reaction = freshMessage.reactions.cache.get(emoji);
  if (!reaction) return 0;
  return Math.max(0, reaction.count - 1);
}

async function finishAcceptedInactivity(client, key, activeRequest) {
  try {
    const channel = await client.channels.fetch(activeRequest.acceptedChannelId);
    const message = await channel.messages.fetch(activeRequest.acceptedMessageId);
    await message.edit({ embeds: [createAcceptedEmbed(activeRequest.request, 0xf2c94c)] });

    try {
      const guild = message.guild;
      const member = await guild.members.fetch(activeRequest.request.userId);
      await member.roles.remove(ACCEPTED_ROLE_ID);
      await member.send({ embeds: [createInactivityEndedDmEmbed(activeRequest.request)] });
    } catch (error) {
      console.warn(`Impossibile rimuovere ruolo o mandare DM a ${activeRequest.request.userId}: ${error.message}`);
    }
  } finally {
    await removeActiveRequest(key);
    scheduledEndTimers.delete(key);
  }
}

function scheduleAcceptedInactivityEnd(client, key, activeRequest) {
  if (scheduledEndTimers.has(key)) return;

  const delay = Math.max(0, activeRequest.request.inactivityEndsAt - Date.now());
  const timeout = setTimeout(() => {
    finishAcceptedInactivity(client, key, activeRequest).catch((error) => {
      console.error("Errore durante la fine dell'inattività:", error);
    });
  }, delay);

  scheduledEndTimers.set(key, timeout);
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
      inactivityStartsAt: new Date(request.inactivityStartsAt).toISOString(),
      inactivityEndsAt: new Date(request.inactivityEndsAt).toISOString(),
      reason: request.reason,
      voteMessageId: messageId,
      checkVotes,
      crossVotes,
    });

    if (accepted) {
      const acceptedChannel = await client.channels.fetch(ACCEPTED_CHANNEL_ID);
      const acceptedMessage = await acceptedChannel.send({ embeds: [createAcceptedEmbed(request)] });

      try {
        const guild = voteMessage.guild;
        const member = await guild.members.fetch(request.userId);
        await member.roles.add(ACCEPTED_ROLE_ID);
        await member.send({ embeds: [createAcceptedDmEmbed(request)] });
      } catch (error) {
        console.warn(`Impossibile mandare DM o assegnare ruolo a ${request.userId}: ${error.message}`);
      }

      const activeKey = acceptedMessage.id;
      const activeRequest = {
        acceptedChannelId: ACCEPTED_CHANNEL_ID,
        acceptedMessageId: acceptedMessage.id,
        request,
      };
      await saveActiveRequest(activeKey, activeRequest);
      scheduleAcceptedInactivityEnd(client, activeKey, activeRequest);

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

  const activeRequests = await loadJson(ACTIVE_FILE, {});
  for (const [key, activeRequest] of Object.entries(activeRequests)) {
    scheduleAcceptedInactivityEnd(client, key, activeRequest);
  }
}

export const data = new SlashCommandBuilder()
  .setName("richiesta_inattivita")
  .setDescription("Richiedi Inattività dal moderare il server o inattività generale")
  .addStringOption((option) =>
    option
      .setName("inizio")
      .setDescription("Giorno/ora di inizio: <t:...>, domani, o 2026-05-30 18:00")
      .setRequired(true),
  )
  .addStringOption((option) =>
    option
      .setName("fine")
      .setDescription("Giorno/ora di fine: <t:...>, 3g, o 2026-06-02 18:00")
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
    const inactivityStartsAt = parsePreciseTime(startInput, requestedAt - 60_000);
    const inactivityEndsAt = parsePreciseTime(endInput, inactivityStartsAt);

    if (inactivityEndsAt <= inactivityStartsAt) {
      throw new Error("Fine inattività non valida");
    }

    const request = {
      userId: interaction.user.id,
      username: interaction.user.tag,
      ign,
      startInput,
      endInput,
      reason,
      requestedAt,
      expiresAt,
      inactivityEndsAt,
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

    const message = error.message === "Formato durata non valido" || error.message === "Fine inattività non valida"
      ? "Date non valide. Usa `inizio` e `fine` con tempi precisi, ad esempio `<t:1770000000:F>`, `2026-05-30 18:00`, oppure una durata relativa come `3g` per la fine."
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

