import { Events } from "discord.js";
import { logger, startupLog } from "../utils/logger.js";
import config from "../config/application.js";
import { reconcileReactionRoleMessages } from "../services/reactionRoleService.js";

export default {
  name: Events.ClientReady,
  once: true,

  async execute(client) {
    try {
      client.user.setPresence(config.bot.presence);

      startupLog(`Ready! Logged in as ${client.user.tag}`);
      startupLog(`Serving ${client.guilds.cache.size} guild(s)`);
      startupLog(`Loaded ${client.commands.size} commands`);

      const reconciliationSummary = await reconcileReactionRoleMessages(client);
      startupLog(
        `Reaction role reconciliation: scanned ${reconciliationSummary.scannedMessages}, removed ${reconciliationSummary.removedMessages}, errors ${reconciliationSummary.errors}`
      );

      try {
        const { resumePendingInactivityRequests } = await import("../commands/richiesta_inattività/richiesta_inattivita.js");
        await resumePendingInactivityRequests(client);
        startupLog("Inactivity request timers restored");
      } catch (error) {
        logger.error("Error restoring inactivity request timers:", error);
      }
    } catch (error) {
      logger.error("Error in ready event:", error);
    }
  },
};
