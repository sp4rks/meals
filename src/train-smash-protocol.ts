import { validateSmashInput, validateSmashRecipe, type SmashRecipe } from './train-smash.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_BROWSER_MESSAGE_BYTES = 16 * 1024;
export const MAX_INTERNAL_MESSAGE_BYTES = 96 * 1024;
export const MAX_REVISION_COUNT = 10;
export const MAX_REVISION_LENGTH = 1000;

export type SmashInput = ReturnType<typeof validateSmashInput>;
export type StoredSmashInput = SmashInput & { revisions?: string[] };

export type BrowserCommand =
  | { v: 1; type: 'generate'; requestId: string; input: SmashInput }
  | { v: 1; type: 'subscribe'; runId: string; afterSequence: number }
  | { v: 1; type: 'cancel'; runId: string }
  | { v: 1; type: 'revise'; requestId: string; draftId: string; instruction: string };

export type OriginCommand =
  | { v: 1; type: 'generate'; requestId: string; input: StoredSmashInput }
  | { v: 1; type: 'revise'; requestId: string; input: StoredSmashInput; parentId: string; previousRecipe: SmashRecipe; revisions: string[] }
  | { v: 1; type: 'subscribe'; runId: string; afterSequence: number }
  | { v: 1; type: 'cancel'; runId: string };

export type OriginStatus = 'accepted' | 'running' | 'validating' | 'completed' | 'cancelled' | 'failed';
export type BrowserStatus = OriginStatus | 'saving';

export type OriginSnapshot = {
  v: 1;
  type: 'snapshot';
  runId: string;
  requestId: string;
  sequence: number;
  status: OriginStatus;
  createdAt: string;
  updatedAt: string;
  input: StoredSmashInput;
  recipe?: SmashRecipe;
  parentId?: string;
  errorCode?: PublicErrorCode;
};

export type ErrorEnvelope = {
  v: 1;
  type: 'error';
  code: PublicErrorCode;
  message: string;
  requestId?: string;
};

export type PublicErrorCode =
  | 'busy'
  | 'forbidden'
  | 'request_conflict'
  | 'not_found'
  | 'expired'
  | 'cancelled'
  | 'timeout'
  | 'interrupted'
  | 'agent_unavailable'
  | 'invalid_recipe'
  | 'save_failed';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const statuses = new Set<OriginStatus>(['accepted', 'running', 'validating', 'completed', 'cancelled', 'failed']);
const errorCodes = new Set<PublicErrorCode>(['busy', 'forbidden', 'request_conflict', 'not_found', 'expired', 'cancelled', 'timeout', 'interrupted', 'agent_unavailable', 'invalid_recipe', 'save_failed']);

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));
const validDate = (value: unknown) => typeof value === 'string' && value.length <= 80 && Number.isFinite(Date.parse(value));

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export const validateRevisionHistory = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > MAX_REVISION_COUNT || value.some((item) => typeof item !== 'string' || item.trim().length === 0 || item.length > MAX_REVISION_LENGTH)) {
    throw new Error('Too many revisions. Start a new ingredient request.');
  }
  return value.map((item) => item.trim());
};

export const validateStoredSmashInput = (value: unknown): StoredSmashInput => {
  if (!record(value)) throw new Error('Invalid recipe input.');
  const input = validateSmashInput(value);
  if (!Object.prototype.hasOwnProperty.call(value, 'revisions')) return input;
  const revisions = validateRevisionHistory(value.revisions);
  return revisions.length ? { ...input, revisions } : input;
};

export const parseBrowserCommand = (value: unknown): BrowserCommand => {
  if (!record(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== 'string') throw new Error('Invalid Train Smash command.');
  if (value.type === 'generate') {
    if (!exactKeys(value, ['v', 'type', 'requestId', 'input']) || !isUuid(value.requestId)) throw new Error('Invalid Train Smash command.');
    return { v: 1, type: 'generate', requestId: value.requestId, input: validateSmashInput(value.input) };
  }
  if (value.type === 'subscribe') {
    if (!exactKeys(value, ['v', 'type', 'runId', 'afterSequence']) || !isUuid(value.runId) || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) throw new Error('Invalid Train Smash command.');
    return { v: 1, type: 'subscribe', runId: value.runId, afterSequence: value.afterSequence };
  }
  if (value.type === 'cancel') {
    if (!exactKeys(value, ['v', 'type', 'runId']) || !isUuid(value.runId)) throw new Error('Invalid Train Smash command.');
    return { v: 1, type: 'cancel', runId: value.runId };
  }
  if (value.type === 'revise') {
    if (!exactKeys(value, ['v', 'type', 'requestId', 'draftId', 'instruction']) || !isUuid(value.requestId) || !isUuid(value.draftId) || typeof value.instruction !== 'string' || value.instruction.trim().length === 0 || value.instruction.length > MAX_REVISION_LENGTH) throw new Error('Invalid revision request.');
    return { v: 1, type: 'revise', requestId: value.requestId, draftId: value.draftId, instruction: value.instruction.trim() };
  }
  throw new Error('Invalid Train Smash command.');
};

export const parseOriginCommand = (value: unknown): OriginCommand => {
  if (!record(value) || value.v !== PROTOCOL_VERSION || typeof value.type !== 'string') throw new Error('Invalid Train Smash command.');
  if (value.type === 'generate') {
    if (!exactKeys(value, ['v', 'type', 'requestId', 'input']) || !isUuid(value.requestId)) throw new Error('Invalid Train Smash command.');
    return { v: 1, type: 'generate', requestId: value.requestId, input: validateStoredSmashInput(value.input) };
  }
  if (value.type === 'revise') {
    if (!exactKeys(value, ['v', 'type', 'requestId', 'input', 'parentId', 'previousRecipe', 'revisions']) || !isUuid(value.requestId) || !isUuid(value.parentId) || !record(value.previousRecipe)) throw new Error('Invalid revision request.');
    return { v: 1, type: 'revise', requestId: value.requestId, input: validateStoredSmashInput(value.input), parentId: value.parentId, previousRecipe: validateSmashRecipe(value.previousRecipe), revisions: validateRevisionHistory(value.revisions) };
  }
  if (value.type === 'subscribe') {
    if (!exactKeys(value, ['v', 'type', 'runId', 'afterSequence']) || !isUuid(value.runId) || !Number.isSafeInteger(value.afterSequence) || value.afterSequence < 0) throw new Error('Invalid Train Smash command.');
    return { v: 1, type: 'subscribe', runId: value.runId, afterSequence: value.afterSequence };
  }
  if (value.type === 'cancel') {
    if (!exactKeys(value, ['v', 'type', 'runId']) || !isUuid(value.runId)) throw new Error('Invalid Train Smash command.');
    return { v: 1, type: 'cancel', runId: value.runId };
  }
  throw new Error('Invalid Train Smash command.');
};

export const parseSnapshot = (value: unknown): OriginSnapshot => {
  if (!record(value) || !exactKeys(value, ['v', 'type', 'runId', 'requestId', 'sequence', 'status', 'createdAt', 'updatedAt', 'input', 'recipe', 'parentId', 'errorCode']) || value.v !== 1 || value.type !== 'snapshot' || !isUuid(value.runId) || !isUuid(value.requestId) || !Number.isSafeInteger(value.sequence) || value.sequence < 0 || typeof value.status !== 'string' || !statuses.has(value.status as OriginStatus) || !validDate(value.createdAt) || !validDate(value.updatedAt)) throw new Error('Invalid Train Smash snapshot.');
  const snapshot: OriginSnapshot = { v: 1, type: 'snapshot', runId: value.runId, requestId: value.requestId, sequence: value.sequence, status: value.status as OriginStatus, createdAt: value.createdAt, updatedAt: value.updatedAt, input: validateStoredSmashInput(value.input) };
  if (value.parentId !== undefined) {
    if (!isUuid(value.parentId)) throw new Error('Invalid Train Smash snapshot.');
    snapshot.parentId = value.parentId;
  }
  if (value.recipe !== undefined) snapshot.recipe = validateSmashRecipe(value.recipe);
  if (snapshot.status === 'completed' && !snapshot.recipe) throw new Error('Invalid Train Smash snapshot.');
  if (value.errorCode !== undefined) {
    if (typeof value.errorCode !== 'string' || !errorCodes.has(value.errorCode as PublicErrorCode)) throw new Error('Invalid Train Smash snapshot.');
    snapshot.errorCode = value.errorCode as PublicErrorCode;
  }
  return snapshot;
};

export const parseErrorEnvelope = (value: unknown): ErrorEnvelope => {
  if (!record(value) || !exactKeys(value, ['v', 'type', 'code', 'message', 'requestId']) || value.v !== 1 || value.type !== 'error' || typeof value.code !== 'string' || !errorCodes.has(value.code as PublicErrorCode) || value.message !== publicMessage(value.code as PublicErrorCode) || (value.requestId !== undefined && !isUuid(value.requestId))) throw new Error('Invalid Train Smash error.');
  return { v: 1, type: 'error', code: value.code as PublicErrorCode, message: value.message as string, ...(value.requestId === undefined ? {} : { requestId: value.requestId as string }) };
};

export const parseOriginMessage = (value: unknown): OriginSnapshot | ErrorEnvelope => record(value) && value.type === 'error' ? parseErrorEnvelope(value) : parseSnapshot(value);

export const publicMessage = (code: PublicErrorCode) => ({
  busy: 'Another recipe is cooking up. Try again in a moment.',
  forbidden: 'You cannot use this Train Smash run.',
  request_conflict: 'That request ID was already used for different ingredients.',
  not_found: 'That Train Smash run is no longer available.',
  expired: 'That Train Smash run has expired. Start another one.',
  cancelled: 'Train Smash was cancelled.',
  timeout: 'The recipe agent took too long. Your ingredients are still here — try again.',
  interrupted: 'The recipe agent restarted before it finished. Your ingredients are still here — try again.',
  agent_unavailable: 'The recipe agent is unavailable. Please try again shortly.',
  invalid_recipe: 'The recipe agent returned an incomplete recipe. Please try again.',
  save_failed: 'The recipe is ready, but it could not be saved yet. Try again.'
}[code]);
