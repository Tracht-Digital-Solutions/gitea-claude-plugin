import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { GiteaError } from '../gitea/errors.js';
import type { ConfirmRequest } from '../tools/types.js';
import { log } from '../util/log.js';

/** The protocol-level server behind McpServer (needed for capabilities and elicitation). */
type LowLevelServer = McpServer['server'];

/**
 * Obtains an informed confirmation for a consequential action.
 *
 * 1. If the client supports MCP elicitation, the user answers directly in the client UI.
 *    Declining yields CANCELLED.
 * 2. Otherwise (or if elicitation fails) the call must carry `confirm` equal to the exact target,
 *    which the model may only send after the user agreed; without it CONFIRMATION_REQUIRED is
 *    returned and nothing is changed.
 */
export async function confirmWithUser(
  server: LowLevelServer,
  req: ConfirmRequest,
  provided: string | undefined,
): Promise<void> {
  if (server.getClientCapabilities()?.elicitation) {
    const answer = await askViaElicitation(server, req);
    if (answer === 'accepted') return;
    if (answer === 'declined') {
      throw new GiteaError('CANCELLED', `The user did not confirm: ${req.action}`, {
        hint: 'The operation was not performed. Do not retry unless the user asks for it again.',
      });
    }
  }
  if (provided !== undefined && provided === req.target) return;
  const mismatch = provided !== undefined ? ' The supplied confirm value did not match.' : '';
  throw new GiteaError('CONFIRMATION_REQUIRED', `Confirmation required: ${req.action}`, {
    details: { confirm: req.target },
    hint: `Nothing was changed. Explain this consequence to the user and ask for explicit confirmation. Only if the user explicitly agrees, call the tool again with confirm: "${req.target}".${mismatch}`,
  });
}

async function askViaElicitation(
  server: LowLevelServer,
  req: ConfirmRequest,
): Promise<'accepted' | 'declined' | 'unavailable'> {
  try {
    const result = await server.elicitInput({
      mode: 'form',
      message: `Confirmation required\n\n${req.action}\n\nTarget: ${req.target}`,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: { type: 'boolean', title: 'Proceed?', description: `Confirm: ${req.target}` },
        },
        required: ['confirm'],
      },
    });
    return result.action === 'accept' && result.content?.confirm === true ? 'accepted' : 'declined';
  } catch (err) {
    log.debug(`elicitation failed, falling back to the confirm token: ${String(err)}`);
    return 'unavailable';
  }
}
