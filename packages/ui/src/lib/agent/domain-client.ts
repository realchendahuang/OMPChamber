/**
 * DomainClient — the OMPChamber HTTP client surface the UI consumes.
 *
 * Implements the `AgentClient` contract from
 * `@ompchamber/agent-protocol/domain-types` on top of `runtimeFetch`, so the
 * UI never imports the OMP SDK. The server adapter (OMP engine) exposes
 * the same OMP-shaped endpoints; this client is a thin, dependency-free
 * replacement for the generated SDK client with identical result semantics:
 *
 *   - non-2xx responses return `{ error, response }` (error = parsed body)
 *   - 2xx responses return `{ data, response }`
 *   - network failures return `{ error, response: undefined }`
 *   - `global.event` returns an SSE async-iterator stream
 *
 * Directory scoping follows the SDK convention: GET/HEAD requests carry the
 * directory as a query parameter, other methods as `x-opencode-directory`
 * header (the server adapter reads either).
 */

import type {
  AgentListResult,
  AuthSetOptions,
  AuthSetResult,
  CommandListResult,
  Config,
  ConfigGetResult,
  ConfigProvidersResult,
  ConfigUpdateResult,
  ExperimentalSessionListOptions,
  FileListOptions,
  FileListResult,
  FileReadOptions,
  FileReadResult,
  FindFilesOptions,
  FindFilesResult,
  GlobalEventOptions,
  GlobalEventResult,
  GlobalHealthResult,
  GlobalVersionResult,
  LspStatusResult,
  McpStatusResult,
  MoveSessionOptions,
  MoveSessionResult,
  AgentClient,
  PathGetResult,
  PermissionListOptions,
  PermissionListResult,
  PermissionReplyOptions,
  PermissionReplyResult,
  ProjectCurrentResult,
  ProjectListResult,
  PromptAsyncOptions,
  ProviderAuthOptions,
  ProviderAuthResult,
  ProviderListOptions,
  ProviderListResult,
  ProviderOauthAuthorizeOptions,
  ProviderOauthAuthorizeResult,
  ProviderOauthCallbackOptions,
  ProviderOauthCallbackRequestOptions,
  ProviderOauthCallbackResult,
  QuestionListOptions,
  QuestionListResult,
  QuestionRejectOptions,
  QuestionRejectResult,
  QuestionReplyOptions,
  QuestionReplyResult,
  SdkResult,
  Session,
  SessionAbortOptions,
  SessionAbortResult,
  SessionBranchOptions,
  SessionBranchResult,
  SessionCommandOptions,
  SessionCompactOptions,
  SessionCompactResult,
  SessionCreateOptions,
  SessionDeleteOptions,
  SessionDeleteResult,
  SessionForkOptions,
  SessionForkResult,
  SessionGetOptions,
  SessionListOptions,
  SessionListResult,
  SessionMessagesOptions,
  SessionMessagesResult,
  SessionPromptOptions,
  SessionPromptResult,
  SessionRevertOptions,
  SessionRevertResult,
  SessionShellOptions,
  SessionShareOptions,
  SessionShellResult,
  SessionStatusOptions,
  SessionStatusResult,
  SessionSummarizeOptions,
  SessionSummarizeResult,
  SessionTodoOptions,
  SessionTodoResult,
  SessionUnrevertOptions,
  SessionUnrevertResult,
  SessionUpdateBody,
  SessionUpdateOptions,
  SkillListResult,
  ToolIdsOptions,
  ToolIdsResult,
  V2SessionPermissionCreateOptions,
  V2SessionPermissionCreateResult,
  V2SessionPermissionGetOptions,
  V2SessionPermissionGetResult,
  VcsGetResult,
} from "@ompchamber/agent-protocol/domain-types";
import { runtimeFetch } from "@/lib/runtime-fetch";

const PATH_PARAM_RE = /\{([^{}]+)\}/g;

type RequestOptions = {
  method: string;
  path: string;
  pathParams?: Record<string, string | number | undefined>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  throwOnError?: boolean;
};

const buildPath = (path: string, params: Record<string, string | number | undefined>): string => {
  return path.replace(PATH_PARAM_RE, (match, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      return match;
    }
    return encodeURIComponent(String(value));
  });
};

const buildQueryString = (query?: Record<string, string | number | boolean | undefined>): string => {
  if (!query) return "";
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : "";
};

const parseJsonBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

export class DomainClient implements AgentClient {
  private baseUrl: string;
  private directory: string | undefined;
  private fetchImpl: typeof runtimeFetch;

  constructor(config: { baseUrl: string; directory?: string; fetch?: typeof runtimeFetch }) {
    this.baseUrl = config.baseUrl.endsWith("/") ? config.baseUrl.slice(0, -1) : config.baseUrl;
    this.directory = config.directory;
    this.fetchImpl = config.fetch ?? runtimeFetch;
  }

  private async request<T>(options: RequestOptions): Promise<SdkResult<T>> {
    const url = `${this.baseUrl}${buildPath(options.path, options.pathParams ?? {})}${buildQueryString(options.query)}`;
    const headers = new Headers(options.headers);
    if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    // Directory scoping follows the SDK convention: the directory is always a
    // query parameter (the SDK's buildClientParams maps it to `in: query` for
    // every method). The server adapter reads it from the query string.
    if (this.directory) {
      const separator = url.includes("?") ? "&" : "?";
      const finalUrl = `${url}${separator}directory=${encodeURIComponent(this.directory)}`;
      return this.execute<T>(finalUrl, options, headers);
    }
    return this.execute<T>(url, options, headers);
  }

  private async execute<T>(
    url: string,
    options: RequestOptions,
    headers: Headers,
  ): Promise<SdkResult<T>> {
    try {
      const response = await this.fetchImpl(url, {
        method: options.method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: options.signal,
      });
      if (!response.ok) {
        const error = await parseJsonBody(response);
        if (options.throwOnError) {
          const message =
            typeof error === "object" && error !== null && "message" in error
              ? String((error as { message?: unknown }).message ?? "")
              : typeof error === "string"
                ? error
                : "";
          throw new Error(message || `Request failed (${response.status})`);
        }
        return { error, response };
      }
      const data = (await parseJsonBody(response)) as T;
      return { data, response };
    } catch (error) {
      if (options.throwOnError) throw error;
      return { error, response: undefined };
    }
  }

  private async sseRequest(options: RequestOptions): Promise<GlobalEventResult> {
    const url = `${this.baseUrl}${buildPath(options.path, {})}${buildQueryString(options.query)}`;
    const headers = new Headers(options.headers);
    if (this.directory) {
      const separator = url.includes("?") ? "&" : "?";
      const finalUrl = `${url}${separator}directory=${encodeURIComponent(this.directory)}`;
      return this.createSseStream(finalUrl, options, headers);
    }
    return this.createSseStream(url, options, headers);
  }

  private createSseStream(
    url: string,
    options: RequestOptions,
    headers: Headers,
  ): GlobalEventResult {
    const signal = options.signal ?? new AbortController().signal;
    const onSseEvent = (options as GlobalEventOptions).onSseEvent;
    const onSseError = (options as GlobalEventOptions).onSseError;

    const stream = (async function* () {
      let lastEventId: string | undefined;
      while (true) {
        if (signal.aborted) break;
        const requestHeaders = new Headers(headers);
        if (lastEventId) {
          requestHeaders.set("Last-Event-ID", lastEventId);
        }
        try {
          const response = await runtimeFetch(url, {
            method: "GET",
            headers: requestHeaders,
            signal,
          });
          if (!response.ok) {
            throw new Error(`SSE failed: ${response.status} ${response.statusText}`);
          }
          if (!response.body) {
            throw new Error("No body in SSE response");
          }
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          let buffer = "";
          const abortHandler = () => {
            try {
              reader.cancel();
            } catch {
              // noop
            }
          };
          signal.addEventListener("abort", abortHandler);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              buffer += value;
              buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
              const chunks = buffer.split("\n\n");
              buffer = chunks.pop() ?? "";
              for (const chunk of chunks) {
                const lines = chunk.split("\n");
                const dataLines: string[] = [];
                let eventName: string | undefined;
                for (const line of lines) {
                  if (line.startsWith("data:")) {
                    dataLines.push(line.replace(/^data:\s*/, ""));
                  } else if (line.startsWith("event:")) {
                    eventName = line.replace(/^event:\s*/, "");
                  } else if (line.startsWith("id:")) {
                    lastEventId = line.replace(/^id:\s*/, "");
                  }
                }
                let data: unknown;
                if (dataLines.length) {
                  const rawData = dataLines.join("\n");
                  try {
                    data = JSON.parse(rawData);
                  } catch {
                    data = rawData;
                  }
                }
                onSseEvent?.({
                  data,
                  event: eventName,
                  id: lastEventId,
                });
                if (dataLines.length) {
                  yield data;
                }
              }
            }
          } finally {
            signal.removeEventListener("abort", abortHandler);
            reader.releaseLock();
          }
          break; // normal completion
        } catch (error) {
          onSseError?.(error);
          if (signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    })();

    return { stream };
  }

  // -------------------------------------------------------------------------
  // session
  // -------------------------------------------------------------------------

  session = {
    list: (options?: SessionListOptions): Promise<SdkResult<SessionListResult>> =>
      this.request<SessionListResult>({
        method: "GET",
        path: "/session",
        query: {
          directory: options?.directory,
          archived: options?.archived,
          roots: options?.roots,
          limit: options?.limit,
          cursor: options?.cursor,
        },
      }),
    create: (options?: SessionCreateOptions): Promise<SdkResult<Session>> =>
      this.request<Session>({
        method: "POST",
        path: "/session",
        query: { directory: options?.directory },
        body: {
          parentID: options?.parentID,
          title: options?.title,
          metadata: options?.metadata,
        },
      }),
    get: (options: SessionGetOptions): Promise<SdkResult<Session>> =>
      this.request<Session>({
        method: "GET",
        path: "/session/{sessionID}",
        query: { directory: options.directory },
        body: undefined,
        pathParams: { sessionID: options.sessionID },
      }),
    delete: (options: SessionDeleteOptions): Promise<SdkResult<SessionDeleteResult>> =>
      this.request<SessionDeleteResult>({
        method: "DELETE",
        path: "/session/{sessionID}",
        query: { directory: options.directory },
        body: undefined,
        pathParams: { sessionID: options.sessionID },
      }),
    update: (options: SessionUpdateOptions & SessionUpdateBody): Promise<SdkResult<Session>> =>
      this.request<Session>({
        method: "PATCH",
        path: "/session/{sessionID}",
        query: { directory: options.directory },
        body: {
          title: options.title,
          metadata: options.metadata,
          time: options.time,
        },
        pathParams: { sessionID: options.sessionID },
      }),
    messages: (options: SessionMessagesOptions): Promise<SdkResult<SessionMessagesResult>> =>
      this.request<SessionMessagesResult>({
        method: "GET",
        path: "/session/{sessionID}/message",
        query: { directory: options.directory, limit: options.limit },
        body: undefined,
        pathParams: { sessionID: options.sessionID },
      }),
    todo: (options: SessionTodoOptions): Promise<SdkResult<SessionTodoResult>> =>
      this.request<SessionTodoResult>({
        method: "GET",
        path: "/session/{sessionID}/todo",
        query: { directory: options.directory },
        body: undefined,
        pathParams: { sessionID: options.sessionID },
      }),
    status: (options?: SessionStatusOptions): Promise<SdkResult<SessionStatusResult>> =>
      this.request<SessionStatusResult>({
        method: "GET",
        path: "/session/status",
        query: { directory: options?.directory },
      }),
    promptAsync: (options: PromptAsyncOptions): Promise<SdkResult<unknown> & { response?: Response }> =>
      this.request<unknown>({
        method: "POST",
        path: "/session/{sessionID}/prompt_async",
        query: { directory: options.directory },
        body: {
          messageID: options.messageID,
          model: options.model,
          agent: options.agent,
          variant: options.variant,
          delivery: options.delivery,
          format: options.format,
          parts: options.parts,
        },
        pathParams: { sessionID: options.sessionID },
      }) as Promise<SdkResult<unknown> & { response?: Response }>,
    prompt: (options: SessionPromptOptions): Promise<SdkResult<SessionPromptResult>> =>
      this.request<SessionPromptResult>({
        method: "POST",
        path: "/session/{sessionID}/message",
        query: { directory: options.directory },
        body: {
          messageID: options.messageID,
          model: options.model,
          agent: options.agent,
          variant: options.variant,
          parts: options.parts,
        },
        pathParams: { sessionID: options.sessionID },
      }),
    command: (options: SessionCommandOptions): Promise<SdkResult<unknown>> =>
      this.request<unknown>({
        method: "POST",
        path: "/session/{sessionID}/command",
        query: { directory: options.directory },
        body: {
          messageID: options.messageID,
          agent: options.agent,
          model: options.model,
          arguments: options.arguments,
          command: options.command,
          variant: options.variant,
          parts: options.parts,
        },
        pathParams: { sessionID: options.sessionID },
      }),
    shell: (options: SessionShellOptions): Promise<SdkResult<SessionShellResult>> =>
      this.request<SessionShellResult>({
        method: "POST",
        path: "/session/{sessionID}/shell",
        query: { directory: options.directory },
        body: {
          messageID: options.messageID,
          agent: options.agent,
          model: options.model,
          command: options.command,
        },
        pathParams: { sessionID: options.sessionID },
      }),
    abort: (options: SessionAbortOptions, opts?: { throwOnError?: boolean }): Promise<SdkResult<SessionAbortResult>> =>
      this.request<SessionAbortResult>({
        method: "POST",
        path: "/session/{sessionID}/abort",
        query: { directory: options.directory },
        pathParams: { sessionID: options.sessionID },
        throwOnError: opts?.throwOnError,
      }),
    revert: (options: SessionRevertOptions): Promise<SdkResult<SessionRevertResult>> =>
      this.request<SessionRevertResult>({
        method: "POST",
        path: "/session/{sessionID}/revert",
        query: { directory: options.directory },
        body: { messageID: options.messageID, partID: options.partID },
        pathParams: { sessionID: options.sessionID },
      }),
    unrevert: (options: SessionUnrevertOptions): Promise<SdkResult<SessionUnrevertResult>> =>
      this.request<SessionUnrevertResult>({
        method: "POST",
        path: "/session/{sessionID}/unrevert",
        query: { directory: options.directory },
        pathParams: { sessionID: options.sessionID },
      }),
    summarize: (options: SessionSummarizeOptions): Promise<SdkResult<SessionSummarizeResult>> =>
      this.request<SessionSummarizeResult>({
        method: "POST",
        path: "/session/{sessionID}/summarize",
        query: { directory: options.directory },
        body: { providerID: options.providerID, modelID: options.modelID },
        pathParams: { sessionID: options.sessionID },
      }),
    fork: (options: SessionForkOptions): Promise<SdkResult<SessionForkResult>> =>
      this.request<SessionForkResult>({
        method: "POST",
        path: "/session/{sessionID}/fork",
        query: { directory: options.directory },
        body: { messageID: options.messageID },
        pathParams: { sessionID: options.sessionID },
      }),
    compact: (options: SessionCompactOptions): Promise<SdkResult<SessionCompactResult>> =>
      this.request<SessionCompactResult>({
        method: "POST",
        path: "/session/{sessionID}/compact",
        query: { directory: options.directory },
        body: { customInstructions: options.customInstructions },
        pathParams: { sessionID: options.sessionID },
      }),
    branch: (options: SessionBranchOptions): Promise<SdkResult<SessionBranchResult>> =>
      this.request<SessionBranchResult>({
        method: "POST",
        path: "/session/{sessionID}/branch",
        query: { directory: options.directory },
        pathParams: { sessionID: options.sessionID },
      }),
    share: (options: SessionShareOptions): Promise<SdkResult<Session>> =>
      this.request<Session>({
        method: "POST",
        path: "/session/{sessionID}/share",
        query: { directory: options.directory },
        pathParams: { sessionID: options.sessionID },
      }),
    unshare: (options: SessionShareOptions): Promise<SdkResult<Session>> =>
      this.request<Session>({
        method: "DELETE",
        path: "/session/{sessionID}/share",
        query: { directory: options.directory },
        pathParams: { sessionID: options.sessionID },
      }),
  };

  // -------------------------------------------------------------------------
  // global
  // -------------------------------------------------------------------------

  global = {
    config: {
      get: (): Promise<SdkResult<ConfigGetResult>> =>
        this.request<ConfigGetResult>({ method: "GET", path: "/global/config" }),
    },
    event: (options?: GlobalEventOptions): Promise<GlobalEventResult> =>
      this.sseRequest({ method: "GET", path: "/global/event", ...options }),
    health: (): Promise<SdkResult<GlobalHealthResult>> =>
      this.request<GlobalHealthResult>({ method: "GET", path: "/global/health" }),
    version: (): Promise<SdkResult<GlobalVersionResult>> =>
      this.request<GlobalVersionResult>({ method: "GET", path: "/global/version" }),
  };

  // -------------------------------------------------------------------------
  // config
  // -------------------------------------------------------------------------

  config = {
    get: (options?: { directory?: string }): Promise<SdkResult<ConfigGetResult>> =>
      this.request<ConfigGetResult>({
        method: "GET",
        path: "/config",
        query: { directory: options?.directory },
      }),
    update: (options: { config: Config }): Promise<SdkResult<ConfigUpdateResult>> =>
      this.request<ConfigUpdateResult>({
        method: "PATCH",
        path: "/config",
        body: { config: options.config },
      }),
    providers: (options?: { directory?: string }): Promise<SdkResult<ConfigProvidersResult>> =>
      this.request<ConfigProvidersResult>({
        method: "GET",
        path: "/config/providers",
        query: { directory: options?.directory },
      }),
  };

  // -------------------------------------------------------------------------
  // path / project / command / mcp / lsp / vcs
  // -------------------------------------------------------------------------

  path = {
    get: (options?: { directory?: string }): Promise<SdkResult<PathGetResult>> =>
      this.request<PathGetResult>({
        method: "GET",
        path: "/path",
        query: { directory: options?.directory },
      }),
  };

  project = {
    list: (): Promise<SdkResult<ProjectListResult>> =>
      this.request<ProjectListResult>({ method: "GET", path: "/project" }),
    current: (options?: { directory?: string }): Promise<SdkResult<ProjectCurrentResult>> =>
      this.request<ProjectCurrentResult>({
        method: "GET",
        path: "/project/current",
        query: { directory: options?.directory },
      }),
  };

  command = {
    list: (options?: { directory?: string }): Promise<SdkResult<CommandListResult>> =>
      this.request<CommandListResult>({
        method: "GET",
        path: "/command",
        query: { directory: options?.directory },
      }),
  };

  mcp = {
    status: (options?: { directory?: string }): Promise<SdkResult<McpStatusResult>> =>
      this.request<McpStatusResult>({
        method: "GET",
        path: "/mcp",
        query: { directory: options?.directory },
      }),
    connect: (options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>> =>
      this.request<unknown>({
        method: "POST",
        path: "/mcp/{name}/connect",
        query: { directory: options.directory },
        pathParams: { name: options.name },
        throwOnError: opts?.throwOnError,
      }),
    disconnect: (options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>> =>
      this.request<unknown>({
        method: "POST",
        path: "/mcp/{name}/disconnect",
        query: { directory: options.directory },
        pathParams: { name: options.name },
        throwOnError: opts?.throwOnError,
      }),
    auth: {
      start: (options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<{ authorizationUrl?: string }>> =>
        this.request<{ authorizationUrl?: string }>({
          method: "POST",
          path: "/mcp/{name}/auth",
          query: { directory: options.directory },
          pathParams: { name: options.name },
          throwOnError: opts?.throwOnError,
        }),
      authenticate: (options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>> =>
        this.request<unknown>({
          method: "POST",
          path: "/mcp/{name}/auth/authenticate",
          query: { directory: options.directory },
          pathParams: { name: options.name },
          throwOnError: opts?.throwOnError,
        }),
      callback: (options: { name: string; code: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>> =>
        this.request<unknown>({
          method: "POST",
          path: "/mcp/{name}/auth/callback",
          query: { directory: options.directory },
          body: { code: options.code },
          pathParams: { name: options.name },
          throwOnError: opts?.throwOnError,
        }),
      remove: (options: { name: string; directory?: string }, opts?: { throwOnError?: boolean }): Promise<SdkResult<unknown>> =>
        this.request<unknown>({
          method: "DELETE",
          path: "/mcp/{name}/auth",
          query: { directory: options.directory },
          pathParams: { name: options.name },
          throwOnError: opts?.throwOnError,
        }),
    },
  };

  lsp = {
    status: (options?: { directory?: string }): Promise<SdkResult<LspStatusResult>> =>
      this.request<LspStatusResult>({
        method: "GET",
        path: "/lsp",
        query: { directory: options?.directory },
      }),
  };

  vcs = {
    get: (options?: { directory?: string }): Promise<SdkResult<VcsGetResult>> =>
      this.request<VcsGetResult>({
        method: "GET",
        path: "/vcs",
        query: { directory: options?.directory },
      }),
  };

  // -------------------------------------------------------------------------
  // question / permission
  // -------------------------------------------------------------------------

  question = {
    list: (options?: QuestionListOptions): Promise<SdkResult<QuestionListResult>> =>
      this.request<QuestionListResult>({
        method: "GET",
        path: "/question",
        query: { directory: options?.directory },
      }),
    reply: (options: QuestionReplyOptions): Promise<SdkResult<QuestionReplyResult>> =>
      this.request<QuestionReplyResult>({
        method: "POST",
        path: "/question/{requestID}/reply",
        query: { directory: options.directory },
        body: { answers: options.answers },
        pathParams: { requestID: options.requestID },
      }),
    reject: (options: QuestionRejectOptions): Promise<SdkResult<QuestionRejectResult>> =>
      this.request<QuestionRejectResult>({
        method: "POST",
        path: "/question/{requestID}/reject",
        query: { directory: options.directory },
        pathParams: { requestID: options.requestID },
      }),
  };

  permission = {
    list: (options?: PermissionListOptions): Promise<SdkResult<PermissionListResult>> =>
      this.request<PermissionListResult>({
        method: "GET",
        path: "/permission",
        query: { directory: options?.directory },
      }),
    reply: (options: PermissionReplyOptions): Promise<SdkResult<PermissionReplyResult>> =>
      this.request<PermissionReplyResult>({
        method: "POST",
        path: "/permission/{requestID}/reply",
        query: { directory: options.directory },
        body: { reply: options.reply, message: options.message },
        pathParams: { requestID: options.requestID },
      }),
  };

  // -------------------------------------------------------------------------
  // app / file / tool / find
  // -------------------------------------------------------------------------

  app = {
    agents: (options?: { directory?: string }): Promise<SdkResult<AgentListResult>> =>
      this.request<AgentListResult>({
        method: "GET",
        path: "/agent",
        query: { directory: options?.directory },
      }),
    skills: (options?: { directory?: string }): Promise<SdkResult<SkillListResult>> =>
      this.request<SkillListResult>({
        method: "GET",
        path: "/skill",
        query: { directory: options?.directory },
      }),
  };

  file = {
    read: (options: FileReadOptions): Promise<SdkResult<FileReadResult>> =>
      this.request<FileReadResult>({
        method: "GET",
        path: "/file/content",
        query: { directory: options.directory, path: options.path },
      }),
    list: (options: FileListOptions): Promise<SdkResult<FileListResult>> =>
      this.request<FileListResult>({
        method: "GET",
        path: "/file",
        query: { directory: options.directory, path: options.path },
      }),
  };

  tool = {
    ids: (options?: ToolIdsOptions): Promise<SdkResult<ToolIdsResult>> =>
      this.request<ToolIdsResult>({
        method: "GET",
        path: "/experimental/tool/ids",
        query: { directory: options?.directory },
      }),
  };

  find = {
    files: (options: FindFilesOptions): Promise<SdkResult<FindFilesResult>> =>
      this.request<FindFilesResult>({
        method: "GET",
        path: "/find/file",
        query: {
          query: options.query,
          limit: options.limit,
          dirs: options.dirs,
          type: options.type,
        },
      }),
  };

  // -------------------------------------------------------------------------
  // provider / auth
  // -------------------------------------------------------------------------

  provider = {
    list: (options?: ProviderListOptions): Promise<SdkResult<ProviderListResult>> =>
      this.request<ProviderListResult>({
        method: "GET",
        path: "/provider",
        query: { directory: options?.directory },
      }),
    auth: (options?: ProviderAuthOptions): Promise<SdkResult<ProviderAuthResult>> =>
      this.request<ProviderAuthResult>({
        method: "GET",
        path: "/provider/auth",
        query: { directory: options?.directory },
      }),
    oauth: {
      authorize: (options: ProviderOauthAuthorizeOptions): Promise<SdkResult<ProviderOauthAuthorizeResult>> =>
        this.request<ProviderOauthAuthorizeResult>({
          method: "POST",
          path: "/provider/{providerID}/oauth/authorize",
          body: { method: options.method, inputs: options.inputs },
          pathParams: { providerID: options.providerID },
        }),
      callback: (
        options: ProviderOauthCallbackOptions,
        requestOptions?: ProviderOauthCallbackRequestOptions,
      ): Promise<SdkResult<ProviderOauthCallbackResult>> =>
        this.request<ProviderOauthCallbackResult>({
          method: "POST",
          path: "/provider/{providerID}/oauth/callback",
          body: { method: options.method, code: options.code },
          pathParams: { providerID: options.providerID },
          signal: requestOptions?.signal,
        }),
    },
  };

  auth = {
    set: (options: AuthSetOptions): Promise<SdkResult<AuthSetResult>> =>
      this.request<AuthSetResult>({
        method: "PUT",
        path: "/auth/{providerID}",
        body: options.auth,
        pathParams: { providerID: options.providerID },
      }),
  };

  // -------------------------------------------------------------------------
  // v2 / experimental
  // -------------------------------------------------------------------------

  v2 = {
    session: {
      permission: {
        create: (options: V2SessionPermissionCreateOptions): Promise<SdkResult<{ data: V2SessionPermissionCreateResult }>> =>
          this.request<{ data: V2SessionPermissionCreateResult }>({
            method: "POST",
            path: "/api/session/{sessionID}/permission",
            body: {
              id: options.id,
              action: options.action,
              resources: options.resources,
              save: options.save,
              metadata: options.metadata,
              source: options.source,
              agent: options.agent,
            },
            pathParams: { sessionID: options.sessionID },
          }),
        get: (options: V2SessionPermissionGetOptions): Promise<SdkResult<{ data: V2SessionPermissionGetResult }>> =>
          this.request<{ data: V2SessionPermissionGetResult }>({
            method: "GET",
            path: "/api/session/{sessionID}/permission/{requestID}",
            pathParams: { sessionID: options.sessionID, requestID: options.requestID },
          }),
      },
    },
  };

  experimental = {
    controlPlane: {
      moveSession: (options: MoveSessionOptions): Promise<SdkResult<MoveSessionResult>> =>
        this.request<MoveSessionResult>({
          method: "POST",
          path: "/experimental/control-plane/move-session",
          body: {
            sessionID: options.sessionID,
            destination: options.destination,
            moveChanges: options.moveChanges,
          },
        }),
    },
    session: {
      list: (options?: ExperimentalSessionListOptions): Promise<SdkResult<SessionListResult>> =>
        this.request<SessionListResult>({
          method: "GET",
          path: "/experimental/session",
          query: {
            directory: options?.directory,
            archived: options?.archived,
            roots: options?.roots,
            limit: options?.limit,
            cursor: options?.cursor,
          },
        }),
    },
  };
}

export const createDomainClient = (config: {
  baseUrl: string;
  directory?: string;
  fetch?: typeof runtimeFetch;
}): AgentClient => new DomainClient(config);
