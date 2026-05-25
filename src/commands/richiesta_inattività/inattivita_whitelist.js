import fs from "node:fs/promises";
import path from "node:path";
import { EmbedBuilder, SlashCommandBuilder } from "discord.js";

const DATA_FOLDER = path.join(process.cwd(), "bot_data");
const CONFIG_FILE = path.join(DATA_FOLDER, "inactivity_config.json");
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

function formatRoleList(roleIds) {
  return roleIds.length > 0
    ? roleIds.map((roleId) => `<@&${roleId}>`).join("\n")
    : "Nessun ruolo in whitelist.";
}

export const data = new SlashCommandBuilder()
  .setName("inattivita_whitelist")
  .setDescription("Gestisci la whitelist dei ruoli per il timer inattività")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("aggiungi")
      .setDescription("Aggiungi un ruolo alla whitelist")
      .addRoleOption((option) =>
        option
          .setName("ruolo")
          .setDescription("Ruolo da aggiungere")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("rimuovi")
      .setDescription("Rimuovi un ruolo dalla whitelist")
      .addRoleOption((option) =>
        option
          .setName("ruolo")
          .setDescription("Ruolo da rimuovere")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("lista")
      .setDescription("Mostra i ruoli in whitelist"),
  );

export const name = "inattivita_whitelist";
export const description = "Gestisci la whitelist dei ruoli per il timer inattività";

export async function execute(interaction) {
  await interaction.deferReply({ ephemeral: true });

  const config = await getConfig();
  const whitelist = [...config.timerRoleWhitelist];

  if (!hasWhitelistedRole(interaction, whitelist)) {
    await interaction.editReply("Non puoi usare questo comando: il tuo ruolo non è nella whitelist del timer inattività.");
    return;
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === "lista") {
    const embed = new EmbedBuilder()
      .setTitle("Whitelist timer inattività")
      .setColor(0x3498db)
      .setDescription(formatRoleList(whitelist))
      .setTimestamp(new Date());

    await interaction.editReply({ embeds: [embed] });
    return;
  }

  const role = interaction.options.getRole("ruolo", true);

  if (subcommand === "aggiungi") {
    if (!whitelist.includes(role.id)) {
      whitelist.push(role.id);
    }

    await saveJson(CONFIG_FILE, {
      ...config,
      timerRoleWhitelist: whitelist,
      whitelistUpdatedAt: new Date().toISOString(),
      whitelistUpdatedBy: interaction.user.id,
    });

    await interaction.editReply(`Ruolo ${role} aggiunto alla whitelist del timer inattività.`);
    return;
  }

  const nextWhitelist = whitelist.filter((roleId) => roleId !== role.id);

  if (nextWhitelist.length === 0) {
    await interaction.editReply("Non puoi rimuovere questo ruolo: la whitelist non può restare vuota.");
    return;
  }

  await saveJson(CONFIG_FILE, {
    ...config,
    timerRoleWhitelist: nextWhitelist,
    whitelistUpdatedAt: new Date().toISOString(),
    whitelistUpdatedBy: interaction.user.id,
  });

  await interaction.editReply(`Ruolo ${role} rimosso dalla whitelist del timer inattività.`);
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
