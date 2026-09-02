/**
 * @squish/sdk
 *
 * Dependency-free TypeScript client for squish-memory over MCP streamable
 * HTTP. Works against a local `squish-mcp --http` instance and cloud
 * deployments. Auth, sessions, timeouts, retries, and error normalization
 * live in one request path (SquishClient#send).
 */

export { SquishClient, SDK_VERSION, DEFAULT_BASE_URL } from './client.js';

export {
  SquishError,
  SquishTransportError,
  SquishHttpError,
  SquishRpcError,
  SquishToolError,
} from './errors.js';

export type {
  ClientInfo,
  SquishClientOptions,
  FetchLike,
  ToolInfo,
  CallToolResponse,
  ToolResult,
  MemoryType,
  RememberInput,
  RememberResult,
  RecallInput,
  RecallAssessment,
  RecalledMemory,
  RecallResult,
  ForgetInput,
  LinkInput,
  ContextInput,
  StatsAction,
  StatsInput,
  InspectInput,
  SkillAction,
  SkillStep,
  SkillInput,
  LoadoutAction,
  LoadoutInput,
  ExtractInput,
  FeedbackInput,
  PlacesInput,
  SessionSource,
  SessionsInput,
  TierInput,
  DedupAction,
  DedupInput,
  MaintenanceInput,
} from './types.js';
