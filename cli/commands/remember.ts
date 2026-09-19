/**
 * Remember Command - Store a memory
 * Auto-detects: learning vs note vs memory based on content patterns
 * 
 * Usage: squish remember "content" [--type observation] [--place sandbox] [--tags foo,bar] [--project /path]
 */

import { Command } from 'commander';
import { client } from '../program.js';
import { detectMemorySignals } from '../../core/memory/trigger-detector.js';
import { pinMemory, unpinMemory } from '../../core/security/governance.js';
import { remediationFor } from '../errors.js';
import { colors } from '../colors.js';

export function registerRememberCommand(program: Command) {
  program
    .command('remember <content>')
    .description('Store a memory (auto-detects learning/note/memory type)')
    .option('-t, --type <type>', 'Memory type (observation, fact, decision, context, preference)', 'observation')
    .option('-T, --tags <tags>', 'Comma-separated tags')
    .option('-p, --project <project>', 'Project path (global if omitted)')
    .option('-s, --source <source>', 'Source (cli, voice, chat, document)', 'cli')
    .option('-r, --reasoning <reasoning>', 'Why this memory is important')
    .option('-c, --context <context>', 'What triggered this memory')
    .option('-e, --examples <examples>', 'When to apply this knowledge')
    .option('-x, --exceptions <exceptions>', 'When NOT to apply this')
    .option('--place <place>', 'Place to assign (inbox, ref, wip, sandbox, board, sparks, archive)')
    .option('--pin', 'Pin memory to prevent pruning', false)
    .option('--unpin', 'Unpin memory', false)
    .option('--route <route>', 'Routing: auto, memory, learning, note', 'auto')
    .option('--learning-type <type>', 'Learning type if routing to learning: success, failure, fix, insight')
    .option('--json', 'Emit machine-readable output', false)
    .action(async (content: string, options: any) => {
      const previousQuiet = process.env.SQUISH_QUIET;
      if (options.json) {
        process.env.SQUISH_QUIET = '1';
      }
      try {
        const signals = detectMemorySignals(content);
        
        const tags = options.tags ? options.tags.split(',').map((t: string) => t.trim()) : [];
        
        // Auto-detect routing based on content patterns
        let routing = options.route;
        let routingReason = "";
        
        if (routing === "auto") {
          const hasLessonPattern = /(\bfailed\s+because\b|\blesson\s+learned\b|\bnext\s+time\b|\broot\s+cause\b|\bsuccess\b.*\bbecause\b|\bi\s+learned\b|\binsight\b)/i.test(content);
          const hasLearningType = /(\bsuccess\b|\bfailure\b|\bfix\b|\binsight\b)/i.test(content);
          const hasHackPattern = /(\bHACK\b|\bworkaround\b|\btemporary\s+fix\b|\bFIXME\b|\bXXX\b)/i.test(content);
          
          if (hasLessonPattern || hasLearningType || hasHackPattern) {
            routing = "learning";
            routingReason = "Auto-detected as learning";
          } else if (signals.suggestedType === 'task') {
            routing = "memory";
            routingReason = "Detected as task";
          } else if (/\b(note|note\s+that|log)\b/i.test(content)) {
            routing = "note";
            routingReason = "Auto-detected as note";
          } else {
            routing = "memory";
            routingReason = "Default to memory";
          }
        }
        
        let result: any;
        
        if (routing === "learning") {
          // Handle learning routing - import dynamically to avoid issues
          const { createLearning } = await import('../../core/ingestion/learnings.js');
          let learningType = options.learningType;
          if (!learningType) {
            if (/(\bsuccess\b|\bworked\b|\bfinished\b)/i.test(content)) learningType = "success";
            else if (/(\bfailed\b|\berror\b|\bbroke\b)/i.test(content)) learningType = "failure";
            else if (/(\bfix\b|\bworkaround\b|\bsolved\b)/i.test(content)) learningType = "fix";
            else learningType = "insight";
          }
          result = await createLearning({
            type: learningType,
            content,
            project: options.project,
            autoLink: true
          });
        } else {
          // Store as memory via SDK
          result = await client.remember(content, {
            project: options.project,
            tags,
            type: options.type || signals.suggestedType,
            metadata: {
              source: options.source,
              reasoning: options.reasoning,
              memoryContext: options.context,
              examples: options.examples,
              exceptions: options.exceptions,
            },
          });
          
          if (options.pin) {
            await pinMemory(result.id);
          } else if (options.unpin) {
            await unpinMemory(result.id);
          }

          // Auto-update knowledge graph (fire-and-forget)
          try {
            const { addMemoryToGraph } = await import('../../core/graph/graph-builder.js');
            const graphResult = await addMemoryToGraph(result.id);
            if (graphResult && graphResult.entitiesCreated > 0) {
              if (!options.json) {
                console.error(colors.dim(`[Graph] Added ${graphResult.entitiesCreated} entities, ${graphResult.relationsCreated} relations`));
              }
            }
          } catch (e: any) {
            // Ignore graph errors - don't fail the remember command
          }

          // Auto-assign to place if specified
          if (options.place) {
            try {
              const { manualAssignMemory } = await import('../../core/places/memory-places.js');
              const { getProjectByPath } = await import('../../core/projects.js');
              const project = await getProjectByPath(options.project);
              if (project) {
                await manualAssignMemory({
                  memoryId: result.id,
                  projectId: project.id,
                  placeType: options.place as any,
                });
                if (!options.json) {
                  console.error(colors.dim(`[Places] Assigned to ${options.place}`));
                }
              }
            } catch (e: any) {
              if (!options.json) {
                console.error(colors.yellow(`[Places] Failed to assign: ${e.message}`));
              }
            }
          }
        }

        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            id: result.id,
            routing,
            type: routing === "learning" ? result.type : result.type,
            place: options.place || null,
            priority: signals.priority,
            confidence: signals.confidence,
            reason: routingReason
          }, null, 2));
        } else {
          console.log(`${colors.green('OK')} Stored ${colors.bold(routing)} memory ${colors.dim(result.id)}`);
          if (options.place) {
            console.log(`  Place:   ${colors.dim(options.place)}`);
          }
          console.log(`  Type:    ${result.type || 'unknown'}`);
          console.log(`  Route:   ${routing} (${routingReason})`);
        }
      } catch (error: any) {
        const remediation = remediationFor(error);
        const payload = {
          ok: false,
          error: error.message,
          command: 'remember',
          remediation,
        };
        console.error(options.json ? JSON.stringify(payload) : `${colors.red('Error')}: ${error.message}\nHint: ${remediation}`);
        process.exit(1);
      } finally {
        if (options.json) {
          if (previousQuiet === undefined) {
            delete process.env.SQUISH_QUIET;
          } else {
            process.env.SQUISH_QUIET = previousQuiet;
          }
        }
      }
    });
}
