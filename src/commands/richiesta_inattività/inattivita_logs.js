import fs from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const LOG_FILE = path.join(DATA_FOLDER, "inactivity_logs.json");

function getInactivityLogsKey(guildId) {
  return `guild:${guildId}:inactivity:logs`;
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

async function getAllLogs(client = null, guildId = null) {
  if (client?.db && guildId) {
    try {
      const dbLogs = await client.db.get(getInactivityLogsKey(guildId), null);
      if (dbLogs && typeof dbLogs === "object") {
        return dbLogs;
      }
    } catch (error) {
      console.warn(`Impossibile leggere inactivity_logs dal database: ${error.message}`);
    }
  }

  return loadJson(LOG_FILE, {});
}

function formatRequestList(requests) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return "Nessuna richiesta registrata.";
  }

  return requests
    .slice(-5)
    .reverse()
    .map((request, index) => {
      const status = request.status || "unknown";
      const date = request.finalizedAt || request.requestedAt || null;
      const when = date ? `<t:${Math.floor(new Date(date).getTime() / 1000)}:R>` : "data sconosciuta";
      return `${index + 1}. ${status} - ${when}`;
    })
    .join("\n");
}

export const data = new SlashCommandBuilder()
  .setName("inattivita_logs")
  .setDescription("Guarda i log inattività tuoi o di un altro utente")
  .addUserOption((option) =>
    option
      .setName("utente")
      .setDescription("Utente di cui vuoi vedere i log")
      .setRequired(false),
  );

export const name = "inattivita_logs";
export const description = "Guarda i log inattività tuoi o di un altro utente";

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const user = interaction.options.getUser("utente") || interaction.user;
  const logs = await getAllLogs(interaction.client, interaction.guildId);
  const userLog = logs[user.id] || {
    totalRequests: 0,
    acceptedRequests: 0,
    rejectedRequests: 0,
    requests: [],
  };

  const embed = new EmbedBuilder()
    .setTitle("Log inattività")
    .setColor(0x3498db)
    .setDescription(`${user}`)
    .addFields(
      { name: "Richieste totali", value: String(userLog.totalRequests || 0), inline: true },
      { name: "Accettate", value: String(userLog.acceptedRequests || 0), inline: true },
      { name: "Rifiutate", value: String(userLog.rejectedRequests || 0), inline: true },
      { name: "Ultime richieste", value: formatRequestList(userLog.requests), inline: false },
    )
    .setTimestamp(new Date());

  await interaction.editReply({ embeds: [embed] });
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
};
