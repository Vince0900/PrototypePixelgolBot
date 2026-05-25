import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const LEGACY_DATA_FOLDER = path.join(__dirname, "..", "bot_data");
const LOG_FILES = [
  path.join(DATA_FOLDER, "inactivity_logs.json"),
  path.join(LEGACY_DATA_FOLDER, "inactivity_logs.json"),
];
const CONFIG_FILE = path.join(DATA_FOLDER, "inactivity_config.json");
const DEFAULT_TIMER_ROLE_WHITELIST = [
  "1493155148619583489",
  "1459630459939061862",
  "1462951377809444917",
];

async function ensureFolderForFile(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
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
  await ensureFolderForFile(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

async function getConfig() {
  const config = await loadJson(CONFIG_FILE, {});
  const whitelist = Array.isArray(config.timerRoleWhitelist) && config.timerRoleWhitelist.length > 0
    ? config.timerRoleWhitelist
    : DEFAULT_TIMER_ROLE_WHITELIST;

  return {
    ...config,
    timerRoleWhitelist: whitelist,
  };
}

function hasWhitelistedRole(interaction, roleIds) {
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

async function removeUserLogs(userId) {
  let removed = null;
  let touchedAnyFile = false;

  for (const logFile of LOG_FILES) {
    const logs = await loadJson(logFile, {});
    const userLog = logs[userId];

    if (userLog) {
      removed = removed || userLog;
      delete logs[userId];
      await saveJson(logFile, logs);
      touchedAnyFile = true;
    }
  }

  return { removed, touchedAnyFile };
}

const command = {
  data: new SlashCommandBuilder()
    .setName("inattivita_clear")
    .setDescription("Rimuovi le informazioni dei log inattività di un utente")
    .addUserOption((option) =>
      option
        .setName("utente")
        .setDescription("Utente a cui azzerare le informazioni dei log")
        .setRequired(true),
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const config = await getConfig();
    if (!hasWhitelistedRole(interaction, config.timerRoleWhitelist)) {
      await interaction.editReply("Non puoi usare questo comando: il tuo ruolo non è nella whitelist inattività.");
      return;
    }

    const user = interaction.options.getUser("utente", true);
    const { removed, touchedAnyFile } = await removeUserLogs(user.id);

    if (!removed && !touchedAnyFile) {
      await interaction.editReply({
        content: `${user} non ha nessuna informazione nei log inattività da rimuovere.`,
      });
      return;
    }

    const removedTotal = removed?.totalRequests || removed?.requests?.length || 0;
    const removedAccepted = removed?.acceptedRequests || 0;
    const removedRejected = removed?.rejectedRequests || 0;

    const embed = new EmbedBuilder()
      .setTitle("Informazioni log rimosse")
      .setColor(0x57f287)
      .setDescription(`${user} ora non ha più statistiche salvate nei log inattività.`)
      .addFields(
        { name: "Richieste totali precedenti rimosse", value: String(removedTotal), inline: true },
        { name: "Accettate precedenti rimosse", value: String(removedAccepted), inline: true },
        { name: "Rifiutate precedenti rimosse", value: String(removedRejected), inline: true },
      )
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
  },
};

export const data = command.data;
export const execute = command.execute;
export const run = command.execute;
export const callback = command.execute;
export default command;
