import fs from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const CONFIG_FILE = path.join(DATA_FOLDER, "inactivity_config.json");
const DEFAULT_VOTE_DURATION_MS = 14400000;

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

function formatDuration(ms) {
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days) parts.push(`${days}g`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);

  return parts.length ? parts.join(" ") : "meno di 1 minuto";
}

export const data = new SlashCommandBuilder()
  .setName("inattivita_timer")
  .setDescription("Modifica il timer delle richieste di inattività")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addIntegerOption((option) =>
    option
      .setName("ore")
      .setDescription("Numero di ore del timer")
      .setMinValue(0)
      .setMaxValue(720)
      .setRequired(true),
  )
  .addIntegerOption((option) =>
    option
      .setName("minuti")
      .setDescription("Minuti aggiuntivi del timer")
      .setMinValue(0)
      .setMaxValue(59)
      .setRequired(false),
  );

export const name = "inattivita_timer";
export const description = "Modifica il timer delle richieste di inattività";

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const hours = interaction.options.getInteger("ore", true);
  const minutes = interaction.options.getInteger("minuti") || 0;
  const voteDurationMs = (hours * 60 + minutes) * 60 * 1000;

  if (voteDurationMs <= 0) {
    await interaction.editReply("Il timer deve essere maggiore di 0 minuti.");
    return;
  }

  const oldConfig = await loadJson(CONFIG_FILE, { voteDurationMs: DEFAULT_VOTE_DURATION_MS });
  const newConfig = {
    ...oldConfig,
    voteDurationMs,
    updatedAt: new Date().toISOString(),
    updatedBy: interaction.user.id,
  };

  await saveJson(CONFIG_FILE, newConfig);

  const embed = new EmbedBuilder()
    .setTitle("Timer inattività aggiornato")
    .setColor(0x57f287)
    .setDescription(`Le nuove richieste useranno un timer di **${formatDuration(voteDurationMs)}**.`)
    .addFields(
      { name: "Prima", value: formatDuration(Number(oldConfig.voteDurationMs) || DEFAULT_VOTE_DURATION_MS), inline: true },
      { name: "Ora", value: formatDuration(voteDurationMs), inline: true },
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
