import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VOTE_CHANNEL_ID = "1508376281220382842";
const ACCEPTED_CHANNEL_ID = "1470700465175003209";

// 4 ore = 14400000 millisecondi.
const VOTE_DURATION_MS = 60000;

const CHECK_EMOJI = "✅";
const CROSS_EMOJI = "❌";

// Non devi creare questa cartella a mano: viene creata automaticamente.
const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const LOG_FILE = path.join(DATA_FOLDER, "inactivity_logs.json");

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

function discordTimestamp(dateMs, style = "F") {
  return `<t:${Math.floor(dateMs / 1000)}:${style}>`;
}

async function createVoteEmbed(request) {
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
    .setTitle("Inattività accettata")
    .setColor(0x2ecc71)
    .addFields(
      { name: "IGN", value: request.ign, inline: false },
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

async function countReaction(message, emoji) {
  const freshMessage = await message.channel.messages.fetch(message.id);
  const reaction = freshMessage.reactions.cache.get(emoji);
  if (!reaction) return 0;
  return Math.max(0, reaction.count - 1);
}

async function finalizeRequest(client, voteMessage, request) {
  const checkVotes = await countReaction(voteMessage, CHECK_EMOJI);
  const crossVotes = await countReaction(voteMessage, CROSS_EMOJI);
  const accepted = checkVotes > crossVotes;

  await addLogEntry(request.userId, {
    status: accepted ? "accepted" : "rejected",
    requestedAt: new Date(request.requestedAt).toISOString(),
    finalizedAt: new Date().toISOString(),
    duration: request.duration,
    reason: request.reason,
    voteMessageId: voteMessage.id,
    checkVotes,
    crossVotes,
  });

  if (accepted) {
    const acceptedChannel = await client.channels.fetch(ACCEPTED_CHANNEL_ID);
    await acceptedChannel.send({ embeds: [createAcceptedEmbed(request)] });
    await voteMessage.reply(`Richiesta accettata con ${checkVotes} ${CHECK_EMOJI} contro ${crossVotes} ${CROSS_EMOJI}.`);
    return;
  }

  try {
    const user = await client.users.fetch(request.userId);
    await user.send({ embeds: [createRejectedDmEmbed(request)] });
  } catch (error) {
    console.warn(`Impossibile mandare DM a ${request.userId}: ${error.message}`);
  }

  await voteMessage.reply(`Richiesta rifiutata con ${checkVotes} ${CHECK_EMOJI} contro ${crossVotes} ${CROSS_EMOJI}.`);
}

export const data = new SlashCommandBuilder()
  .setName("richiesta_inattivita")
  .setDescription("Richiedi Inattività dal moderare il server o inattività generale")
  .addStringOption((option) =>
    option
      .setName("durata")
      .setDescription("Quanto durerà la tua inattività")
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
    const duration = interaction.options.getString("durata", true);
    const reason = interaction.options.getString("motivo", true);
    const ign = interaction.member?.displayName || interaction.user.globalName || interaction.user.username;
    const requestedAt = Date.now();
    const expiresAt = requestedAt + VOTE_DURATION_MS;

    const request = {
      userId: interaction.user.id,
      username: interaction.user.tag,
      ign,
      duration,
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

    setTimeout(() => {
      finalizeRequest(interaction.client, voteMessage, request).catch((error) => {
        console.error("Errore durante la chiusura della richiesta inattività:", error);
      });
    }, VOTE_DURATION_MS);

    await interaction.editReply("La tua richiesta di inattività è stata inviata alla votazione.");
  } catch (error) {
    console.error("Errore comando richiesta_inattivita:", error);

    const message = "Il comando ha avuto un errore interno. Guarda il terminale/log del bot per vedere il motivo preciso.";
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
}

// Alias per handler diversi.
export const run = execute;
export const callback = execute;

export default {
  data,
  name,
  description,
  execute,
  run,
  callback,
};
