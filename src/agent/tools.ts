/** Tool surface exposed to the discovery agent. One tool call per turn. */
import type { ToolDef } from './llm.js';

const stepMeta = {
  intent: { type: 'string', description: 'Why you are doing this step, in one plain sentence (recorded into the capability).' },
  expectation: { type: 'string', description: 'What you expect to be true on screen immediately after this action (used to synthesise a checkpoint).' },
};

export const TOOLS: ToolDef[] = [
  {
    name: 'navigate',
    description: 'Navigate directly to a URL within the target application.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, ...stepMeta },
      required: ['url', 'intent'],
    },
  },
  {
    name: 'click',
    description: 'Click an interactive element identified by its ref from the latest observation.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'e.g. "e4"' }, ...stepMeta },
      required: ['ref', 'intent'],
    },
  },
  {
    name: 'type',
    description: 'Type text into a field identified by ref. Set is_secret for credentials so the value is redacted everywhere.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        text: { type: 'string' },
        press_enter: { type: 'boolean', default: false },
        is_secret: { type: 'boolean', default: false },
        ...stepMeta,
      },
      required: ['ref', 'text', 'intent'],
    },
  },
  {
    name: 'select',
    description: 'Choose an option (by visible label) in a <select> identified by ref.',
    input_schema: {
      type: 'object',
      properties: { ref: { type: 'string' }, value: { type: 'string' }, ...stepMeta },
      required: ['ref', 'value', 'intent'],
    },
  },
  {
    name: 'press_key',
    description: 'Press a keyboard key (e.g. "Enter", "Tab").',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, ...stepMeta },
      required: ['key', 'intent'],
    },
  },
  {
    name: 'acknowledge_dialog',
    description: 'Accept or dismiss a native browser dialog that is currently open.',
    input_schema: {
      type: 'object',
      properties: { accept: { type: 'boolean' }, intent: stepMeta.intent },
      required: ['accept', 'intent'],
    },
  },
  {
    name: 'extract',
    description: 'Read a value from an element (identified by ref) and record it as a typed output of this capability.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        output_name: { type: 'string', description: 'snake_case name for this output, e.g. "savings_balance"' },
        output_type: { type: 'string', enum: ['string', 'number', 'money', 'boolean', 'date'] },
        attribute: { type: 'string', enum: ['text', 'innerText', 'value', 'href'], default: 'text' },
        transform: { type: 'string', enum: ['none', 'trim', 'toNumber', 'moneyToCents', 'regex'], default: 'trim' },
        intent: stepMeta.intent,
      },
      required: ['ref', 'output_name', 'output_type', 'intent'],
    },
  },
  {
    name: 'escalate',
    description: 'Hand control to a human operator because you are stuck or a step is unsafe to take autonomously. Use only when genuinely blocked.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        question: { type: 'string', description: 'What you need the human to do or decide.' },
      },
      required: ['reason', 'question'],
    },
  },
  {
    name: 'finish',
    description: 'End the run. status="success" only if the goal is fully achieved and any required outputs have been extracted.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['success', 'stuck'] },
        summary: { type: 'string' },
      },
      required: ['status', 'summary'],
    },
  },
];
