import fs from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const CONFIG_FILE = path.join(DATA_FOLDER, "inactivity_config.json");
const DEFAULT_VOTE_DURATION_MS = 14400000;
const DEFAULT_TIMER_ROLE_WHITELIST = [
  "1493155148619583489",
  "1459630459939061862",
  "1462951377809444917",
];

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

function getInactivityConfigKey(guildId) {
  return `guild:${guildId}:inactivity:config`;
}

async function getConfig(interaction = null) {
  let config = {};

  if (interaction?.client?.db && interaction.guildId) {
    try {
      const dbConfig = await interaction.client.db.get(getInactivityConfigKey(interaction.guildId), null);
      if (dbConfig && typeof dbConfig === "object") {
        config = dbConfig;
      }
    } catch (error) {
      console.warn(`Impossibile leggere inactivity_config dal database: ${error.message}`);
    }
  }

  if (!config.voteDurationMs && !config.timerRoleWhitelist) {
    config = await loadJson(CONFIG_FILE, config);
  }

  const whitelist = Array.isArray(config.timerRoleWhitelist) && config.timerRoleWhitelist.length > 0
    ? config.timerRoleWhitelist
    : DEFAULT_TIMER_ROLE_WHITELIST;

  return {
    ...config,
    voteDurationMs: Number(config.voteDurationMs) || DEFAULT_VOTE_DURATION_MS,
    timerRoleWhitelist: whitelist,
  };
}

async function saveConfig(interaction, config) {
  await saveJson(CONFIG_FILE, config);

  if (interaction?.client?.db && interaction.guildId) {
    try {
      await interaction.client.db.set(getInactivityConfigKey(interaction.guildId), config);
      return true;
    } catch (error) {
      console.warn(`Impossibile salvare inactivity_config nel database: ${error.message}`);
    }
  }

  return false;
}function hasWhitelistedRole(interaction, roleIds) {
  const memberRoles = interaction.member?.roles;
  if (!memberRoles) return false;

  if (memberRoles.cache) {
    return roleIds.some((roleId) => memberRoles.cache.has(roleId));
  }

  if (Array.isArray(memberRoles)) {
    return roleIds.some((roleId) => memberRoles.includes(roleId));
  }

  return false;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds) parts.push(`${seconds}s`);

  return parts.length ? parts.join(" ") : "0s";
}

function buildDurationMs(interaction) {
  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "secondi") {
    return interaction.options.getInteger("secondi", true) * 1000;
  }

  if (subcommand === "minuti") {
    const minutes = interaction.options.getInteger("minuti", true);
    const seconds = interaction.options.getInteger("secondi") || 0;
    return ((minutes * 60) + seconds) * 1000;
  }

  const hours = interaction.options.getInteger("ore", true);
  const minutes = interaction.options.getInteger("minuti") || 0;
  const seconds = interaction.options.getInteger("secondi") || 0;
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

export const data = new SlashCommandBuilder()
  .setName("inattivita_timer")
  .setDescription("Modifica il timer delle richieste di inattività")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("secondi")
      .setDescription("Imposta il timer usando solo i secondi")
      .addIntegerOption((option) =>
        option
          .setName("secondi")
          .setDescription("Numero di secondi")
          .setMinValue(1)
          .setMaxValue(2592000)
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("minuti")
      .setDescription("Imposta il timer usando minuti e secondi")
      .addIntegerOption((option) =>
        option
          .setName("minuti")
          .setDescription("Numero di minuti")
          .setMinValue(1)
          .setMaxValue(43200)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("secondi")
          .setDescription("Secondi aggiuntivi")
          .setMinValue(0)
          .setMaxValue(59)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("ore")
      .setDescription("Imposta il timer usando ore, minuti e secondi")
      .addIntegerOption((option) =>
        option
          .setName("ore")
          .setDescription("Numero di ore")
          .setMinValue(1)
          .setMaxValue(720)
          .setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("minuti")
          .setDescription("Minuti aggiuntivi")
          .setMinValue(0)
          .setMaxValue(59)
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName("secondi")
          .setDescription("Secondi aggiuntivi")
          .setMinValue(0)
          .setMaxValue(59)
          .setRequired(false),
      ),
  );

export const name = "inattivita_timer";
export const description = "Modifica il timer delle richieste di inattività";

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const config = await getConfig(interaction);

  if (!hasWhitelistedRole(interaction, config.timerRoleWhitelist)) {
    await interaction.editReply("Non puoi usare questo comando: il tuo ruolo non è nella whitelist del timer inattività.");
    return;
  }

  const voteDurationMs = buildDurationMs(interaction);
  const oldDurationMs = config.voteDurationMs;

  const newConfig = {
    ...config,
    voteDurationMs,
    timerRoleWhitelist: config.timerRoleWhitelist,
    updatedAt: new Date().toISOString(),
    updatedBy: interaction.user.id,
  };

  await saveConfig(interaction, newConfig);

  const embed = new EmbedBuilder()
    .setTitle("Timer inattività aggiornato")
    .setColor(0x57f287)
    .setDescription(`Le nuove richieste useranno un timer di **${formatDuration(voteDurationMs)}**.`)
    .addFields(
      { name: "Prima", value: formatDuration(oldDurationMs), inline: true },
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

