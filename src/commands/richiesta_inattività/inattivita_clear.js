import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FOLDER = path.join(__dirname, "..", "bot_data");
const LOG_FILE = path.join(DATA_FOLDER, "inactivity_logs.json");

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallback;
    }
    throw error;
  }
}

async function saveJson(filePath, data) {
  await fs.mkdir(DATA_FOLDER, { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

const command = {
  data: new SlashCommandBuilder()
    .setName("inattivita_clear")
    .setDescription("Rimuovi le informazioni dei log inattività di un utente")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addUserOption((option) =>
      option
        .setName("utente")
        .setDescription("Utente a cui azzerare le informazioni dei log")
        .setRequired(true),
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const user = interaction.options.getUser("utente", true);
    const logs = await loadJson(LOG_FILE, {});
    const oldLog = logs[user.id];

    if (!oldLog) {
      await interaction.editReply({
        content: `${user} non ha nessun log di inattività da rimuovere.`,
      });
      return;
    }

    const removedTotal = oldLog.totalRequests || oldLog.requests?.length || 0;
    const removedAccepted = oldLog.acceptedRequests || 0;
    const removedRejected = oldLog.rejectedRequests || 0;

    delete logs[user.id];
    await saveJson(LOG_FILE, logs);

    const embed = new EmbedBuilder()
      .setTitle("Informazioni log rimosse")
      .setColor(0x57f287)
      .setDescription(`${user} ora non ha più statistiche salvate nei log inattività.`)
      .addFields(
        { name: "totalRequests rimossi", value: String(removedTotal), inline: true },
        { name: "acceptedRequests rimossi", value: String(removedAccepted), inline: true },
        { name: "rejectedRequests rimossi", value: String(removedRejected), inline: true },
      )
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
  },
};

export const data = command.data;
export const execute = command.execute;
export default command;

