import { randomUUID } from 'node:crypto';
import type { AdapterOutput } from '../types.ts';
import { type NormalizerContext, truncateResultText } from '../context.ts';
import { toolKind, toolTitle, truncateInput } from '../../tools.ts';
import type { Frame } from './process.ts';

export function displayTool(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const names: Record<string, string> = {
    bash: 'Bash',
    read: 'Read',
    write: 'Write',
    edit: 'Edit',
    grep: 'Grep',
    glob: 'Glob',
    task: 'Task',
    todo: 'TodoWrite',
    web_search: 'WebSearch',
  };
  return { name: names[name] ?? name, input: { ...input, ...(typeof input.path === 'string' ? { file_path: input.path } : {}) } };
}

export class OmpNormalizer {
  private prefix = randomUUID();
  private current = '';
  private tools = new Set<string>();
  private ctx: NormalizerContext;
  private output: (o: AdapterOutput) => void;
  constructor(ctx: NormalizerContext, output: (o: AdapterOutput) => void) {
    this.ctx = ctx;
    this.output = output;
  }
  private id(messageId: string, index: number): string {
    return `omp:${this.prefix}:${messageId}:${index}`;
  }
  toolId(id: string): string {
    return `omp:${this.prefix}:tool:${id}`;
  }
  accept(f: Frame): void {
    if (f.type === 'message_start') this.current = String(f.messageId ?? randomUUID());
    if (f.type === 'message_update' && f.message?.role === 'assistant') {
      const event = f.assistantMessageEvent ?? {};
      const messageId = String(f.messageId ?? this.current);
      if ((event.type === 'text_delta' || event.type === 'thinking_delta') && typeof event.delta === 'string')
        this.output({
          kind: 'delta',
          delta: {
            type: event.type === 'text_delta' ? 'assistant.text.delta' : 'reasoning.delta',
            itemId: this.id(messageId, event.contentIndex ?? 0),
            text: event.delta,
          },
        });
    }
    if (f.type === 'message_end' && f.message?.role === 'assistant') {
      const message = f.message;
      const id = String(f.messageId ?? this.current);
      for (const [i, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (block.type === 'text' && typeof block.text === 'string')
          this.output({
            kind: 'event',
            event: {
              type: 'assistant.text',
              itemId: this.id(id, i),
              text: block.text,
            },
          });
        else if (block.type === 'thinking' && typeof block.thinking === 'string')
          this.output({
            kind: 'event',
            event: {
              type: 'reasoning',
              itemId: this.id(id, i),
              text: block.thinking,
            },
          });
      }
      const usage = message.usage;
      if (usage && typeof usage.input === 'number')
        this.output({
          kind: 'context',
          contextTokens: usage.input + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0),
        });
    }
    if (f.type === 'tool_execution_start') {
      const id = String(f.toolCallId);
      if (this.tools.has(id)) return;
      this.tools.add(id);
      const input = f.args && typeof f.args === 'object' && !Array.isArray(f.args) ? f.args : {};
      const name = String(f.toolName ?? 'tool');
      const display = displayTool(name, input);
      this.output({
        kind: 'event',
        event: {
          type: 'tool.call',
          itemId: this.toolId(id),
          name,
          kind: toolKind(display.name),
          title: toolTitle(display.name, display.input, this.ctx.cwd),
          input: truncateInput(input),
        },
      });
    }
    if (f.type === 'tool_execution_update' || f.type === 'tool_execution_end') {
      const result = f.result ?? f.partialResult ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .filter((c: Frame) => c.type === 'text')
        .map((c: Frame) => String(c.text ?? ''))
        .join('\n');
      const itemId = this.toolId(String(f.toolCallId));
      if (f.type === 'tool_execution_update') return;
      const images = content
        .filter((c: Frame) => c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string')
        .flatMap((c: Frame) => {
          try {
            return [this.ctx.saveImage(c.data, c.mimeType, itemId)];
          } catch {
            return [];
          }
        });
      this.output({
        kind: 'event',
        event: {
          type: 'tool.result',
          itemId,
          ok: !f.isError && !result.isError,
          ...truncateResultText(text, itemId, this.ctx),
          images,
        },
      });
    }
  }
}
