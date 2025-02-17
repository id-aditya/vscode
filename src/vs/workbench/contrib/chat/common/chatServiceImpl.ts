/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DeferredPromise } from 'vs/base/common/async';
import { CancellationToken, CancellationTokenSource } from 'vs/base/common/cancellation';
import { toErrorMessage } from 'vs/base/common/errorMessage';
import { ErrorNoTelemetry } from 'vs/base/common/errors';
import { Emitter, Event } from 'vs/base/common/event';
import { MarkdownString } from 'vs/base/common/htmlContent';
import { Iterable } from 'vs/base/common/iterator';
import { Disposable, DisposableMap, IDisposable } from 'vs/base/common/lifecycle';
import { revive } from 'vs/base/common/marshalling';
import { StopWatch } from 'vs/base/common/stopwatch';
import { URI, UriComponents } from 'vs/base/common/uri';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { ILogService } from 'vs/platform/log/common/log';
import { Progress } from 'vs/platform/progress/common/progress';
import { IStorageService, StorageScope, StorageTarget } from 'vs/platform/storage/common/storage';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { ChatAgentLocation, IChatAgent, IChatAgentCommand, IChatAgentData, IChatAgentRequest, IChatAgentResult, IChatAgentService } from 'vs/workbench/contrib/chat/common/chatAgents';
import { CONTEXT_VOTE_UP_ENABLED } from 'vs/workbench/contrib/chat/common/chatContextKeys';
import { ChatModel, ChatRequestModel, ChatRequestRemovalReason, ChatWelcomeMessageModel, IChatModel, IChatRequestModel, IChatRequestVariableData, IChatResponseModel, IExportableChatData, ISerializableChatData, ISerializableChatsData, getHistoryEntriesFromModel, updateRanges } from 'vs/workbench/contrib/chat/common/chatModel';
import { ChatRequestAgentPart, ChatRequestAgentSubcommandPart, ChatRequestSlashCommandPart, IParsedChatRequest, chatAgentLeader, chatSubcommandLeader, getPromptText } from 'vs/workbench/contrib/chat/common/chatParserTypes';
import { ChatRequestParser } from 'vs/workbench/contrib/chat/common/chatRequestParser';
import { IChatCompleteResponse, IChatDetail, IChatFollowup, IChatProgress, IChatSendRequestData, IChatSendRequestOptions, IChatSendRequestResponseState, IChatService, IChatTransferredSessionData, IChatUserActionEvent } from 'vs/workbench/contrib/chat/common/chatService';
import { ChatServiceTelemetry } from 'vs/workbench/contrib/chat/common/chatServiceTelemetry';
import { IChatSlashCommandService } from 'vs/workbench/contrib/chat/common/chatSlashCommands';
import { IChatVariablesService } from 'vs/workbench/contrib/chat/common/chatVariables';
import { ChatMessageRole, IChatMessage } from 'vs/workbench/contrib/chat/common/languageModels';
import { IWorkbenchAssignmentService } from 'vs/workbench/services/assignment/common/assignmentService';
import { IExtensionService } from 'vs/workbench/services/extensions/common/extensions';

const serializedChatKey = 'interactive.sessions';

const globalChatKey = 'chat.workspaceTransfer';
interface IChatTransfer {
	toWorkspace: UriComponents;
	timestampInMilliseconds: number;
	chat: ISerializableChatData;
	inputValue: string;
}
const SESSION_TRANSFER_EXPIRATION_IN_MILLISECONDS = 1000 * 60;

type ChatProviderInvokedEvent = {
	timeToFirstProgress: number | undefined;
	totalTime: number | undefined;
	result: 'success' | 'error' | 'errorWithOutput' | 'cancelled' | 'filtered';
	requestType: 'string' | 'followup' | 'slashCommand';
	chatSessionId: string;
	agent: string;
	agentExtensionId: string | undefined;
	slashCommand: string | undefined;
	location: ChatAgentLocation;
	citations: number;
	numCodeBlocks: number;
};

type ChatProviderInvokedClassification = {
	timeToFirstProgress: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The time in milliseconds from invoking the provider to getting the first data.' };
	totalTime: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The total time it took to run the provider\'s `provideResponseWithProgress`.' };
	result: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'Whether invoking the ChatProvider resulted in an error.' };
	requestType: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The type of request that the user made.' };
	chatSessionId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'A random ID for the session.' };
	agent: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The type of agent used.' };
	agentExtensionId: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The extension that contributed the agent.' };
	slashCommand?: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The type of slashCommand used.' };
	location: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The location at which chat request was made.' };
	citations: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The number of public code citations that were returned with the response.' };
	numCodeBlocks: { classification: 'SystemMetaData'; purpose: 'FeatureInsight'; comment: 'The number of code blocks in the response.' };
	owner: 'roblourens';
	comment: 'Provides insight into the performance of Chat agents.';
};

const maxPersistedSessions = 25;

class CancellableRequest implements IDisposable {
	constructor(
		public readonly cancellationTokenSource: CancellationTokenSource,
		public requestId?: string | undefined
	) { }

	dispose() {
		this.cancellationTokenSource.dispose();
	}

	cancel() {
		this.cancellationTokenSource.cancel();
	}
}

export class ChatService extends Disposable implements IChatService {
	declare _serviceBrand: undefined;

	private readonly _sessionModels = this._register(new DisposableMap<string, ChatModel>());
	private readonly _pendingRequests = this._register(new DisposableMap<string, CancellableRequest>());
	private _persistedSessions: ISerializableChatsData;

	/** Just for empty windows, need to enforce that a chat was deleted, even though other windows still have it */
	private _deletedChatIds = new Set<string>();

	private _transferredSessionData: IChatTransferredSessionData | undefined;
	public get transferredSessionData(): IChatTransferredSessionData | undefined {
		return this._transferredSessionData;
	}

	private readonly _onDidPerformUserAction = this._register(new Emitter<IChatUserActionEvent>());
	public readonly onDidPerformUserAction: Event<IChatUserActionEvent> = this._onDidPerformUserAction.event;

	private readonly _onDidDisposeSession = this._register(new Emitter<{ sessionId: string; reason: 'initializationFailed' | 'cleared' }>());
	public readonly onDidDisposeSession = this._onDidDisposeSession.event;

	private readonly _sessionFollowupCancelTokens = this._register(new DisposableMap<string, CancellationTokenSource>());
	private readonly _chatServiceTelemetry: ChatServiceTelemetry;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ILogService private readonly logService: ILogService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IChatSlashCommandService private readonly chatSlashCommandService: IChatSlashCommandService,
		@IChatVariablesService private readonly chatVariablesService: IChatVariablesService,
		@IChatAgentService private readonly chatAgentService: IChatAgentService,
		@IWorkbenchAssignmentService workbenchAssignmentService: IWorkbenchAssignmentService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService
	) {
		super();

		this._chatServiceTelemetry = this.instantiationService.createInstance(ChatServiceTelemetry);
		const isEmptyWindow = !workspaceContextService.getWorkspace().folders.length;
		const sessionData = storageService.get(serializedChatKey, isEmptyWindow ? StorageScope.APPLICATION : StorageScope.WORKSPACE, '');
		if (sessionData) {
			this._persistedSessions = this.deserializeChats(sessionData);
			const countsForLog = Object.keys(this._persistedSessions).length;
			if (countsForLog > 0) {
				this.trace('constructor', `Restored ${countsForLog} persisted sessions`);
			}
		} else {
			this._persistedSessions = {};
		}

		const transferredData = this.getTransferredSessionData();
		const transferredChat = transferredData?.chat;
		if (transferredChat) {
			this.trace('constructor', `Transferred session ${transferredChat.sessionId}`);
			this._persistedSessions[transferredChat.sessionId] = transferredChat;
			this._transferredSessionData = { sessionId: transferredChat.sessionId, inputValue: transferredData.inputValue };
		}

		this._register(storageService.onWillSaveState(() => this.saveState()));

		const voteUpEnabled = CONTEXT_VOTE_UP_ENABLED.bindTo(contextKeyService);
		workbenchAssignmentService.getTreatment('chatVoteUpEnabled')
			.then(value => voteUpEnabled.set(!!value));
	}

	isEnabled(location: ChatAgentLocation): boolean {
		return this.chatAgentService.getContributedDefaultAgent(location) !== undefined;
	}

	private saveState(): void {
		const liveChats = Array.from(this._sessionModels.values())
			.filter(session => session.initialLocation === ChatAgentLocation.Panel)
			.filter(session => session.getRequests().length > 0);

		const isEmptyWindow = !this.workspaceContextService.getWorkspace().folders.length;
		if (isEmptyWindow) {
			this.syncEmptyWindowChats(liveChats);
		} else {
			let allSessions: (ChatModel | ISerializableChatData)[] = liveChats;
			allSessions = allSessions.concat(
				Object.values(this._persistedSessions)
					.filter(session => !this._sessionModels.has(session.sessionId))
					.filter(session => session.requests.length));
			allSessions.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0));
			allSessions = allSessions.slice(0, maxPersistedSessions);
			if (allSessions.length) {
				this.trace('onWillSaveState', `Persisting ${allSessions.length} sessions`);
			}

			const serialized = JSON.stringify(allSessions);

			if (allSessions.length) {
				this.trace('onWillSaveState', `Persisting ${serialized.length} chars`);
			}

			this.storageService.store(serializedChatKey, serialized, StorageScope.WORKSPACE, StorageTarget.MACHINE);
		}

		this._deletedChatIds.clear();
	}

	private syncEmptyWindowChats(thisWindowChats: ChatModel[]): void {
		// Note- an unavoidable race condition exists here. If there are multiple empty windows open, and the user quits the application, then the focused
		// window may lose active chats, because all windows are reading and writing to storageService at the same time. This can't be fixed without some
		// kind of locking, but in reality, the focused window will likely have run `saveState` at some point, like on a window focus change, and it will
		// generally be fine.
		const sessionData = this.storageService.get(serializedChatKey, StorageScope.APPLICATION, '');

		const originalPersistedSessions = this._persistedSessions;
		let persistedSessions: ISerializableChatsData;
		if (sessionData) {
			persistedSessions = this.deserializeChats(sessionData);
			const countsForLog = Object.keys(persistedSessions).length;
			if (countsForLog > 0) {
				this.trace('constructor', `Restored ${countsForLog} persisted sessions`);
			}
		} else {
			persistedSessions = {};
		}

		this._deletedChatIds.forEach(id => delete persistedSessions[id]);

		// Has the chat in this window been updated, and then closed? Overwrite the old persisted chats.
		Object.values(originalPersistedSessions).forEach(session => {
			const persistedSession = persistedSessions[session.sessionId];
			if (persistedSession && session.requests.length > persistedSession.requests.length) {
				// We will add a 'modified date' at some point, but comparing the number of requests is good enough
				persistedSessions[session.sessionId] = session;
			} else if (!persistedSession && session.isNew) {
				// This session was created in this window, and hasn't been persisted yet
				session.isNew = false;
				persistedSessions[session.sessionId] = session;
			}
		});

		this._persistedSessions = persistedSessions;

		// Add this window's active chat models to the set to persist.
		// Having the same session open in two empty windows at the same time can lead to data loss, this is acceptable
		const allSessions: Record<string, ISerializableChatData | ChatModel> = { ...this._persistedSessions };
		for (const chat of thisWindowChats) {
			allSessions[chat.sessionId] = chat;
		}

		let sessionsList = Object.values(allSessions);
		sessionsList.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0));
		sessionsList = sessionsList.slice(0, maxPersistedSessions);
		const data = JSON.stringify(sessionsList);
		this.storageService.store(serializedChatKey, data, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	notifyUserAction(action: IChatUserActionEvent): void {
		this._chatServiceTelemetry.notifyUserAction(action);
		this._onDidPerformUserAction.fire(action);
	}

	private trace(method: string, message?: string): void {
		if (message) {
			this.logService.trace(`ChatService#${method}: ${message}`);
		} else {
			this.logService.trace(`ChatService#${method}`);
		}
	}

	private error(method: string, message: string): void {
		this.logService.error(`ChatService#${method} ${message}`);
	}

	private deserializeChats(sessionData: string): ISerializableChatsData {
		try {
			const arrayOfSessions: ISerializableChatData[] = revive(JSON.parse(sessionData)); // Revive serialized URIs in session data
			if (!Array.isArray(arrayOfSessions)) {
				throw new Error('Expected array');
			}

			const sessions = arrayOfSessions.reduce<ISerializableChatsData>((acc, session) => {
				// Revive serialized markdown strings in response data
				for (const request of session.requests) {
					if (Array.isArray(request.response)) {
						request.response = request.response.map((response) => {
							if (typeof response === 'string') {
								return new MarkdownString(response);
							}
							return response;
						});
					} else if (typeof request.response === 'string') {
						request.response = [new MarkdownString(request.response)];
					}
				}

				acc[session.sessionId] = session;
				return acc;
			}, {});
			return sessions;
		} catch (err) {
			this.error('deserializeChats', `Malformed session data: ${err}. [${sessionData.substring(0, 20)}${sessionData.length > 20 ? '...' : ''}]`);
			return {};
		}
	}

	private getTransferredSessionData(): IChatTransfer | undefined {
		const data: IChatTransfer[] = this.storageService.getObject(globalChatKey, StorageScope.PROFILE, []);
		const workspaceUri = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (!workspaceUri) {
			return;
		}

		const thisWorkspace = workspaceUri.toString();
		const currentTime = Date.now();
		// Only use transferred data if it was created recently
		const transferred = data.find(item => URI.revive(item.toWorkspace).toString() === thisWorkspace && (currentTime - item.timestampInMilliseconds < SESSION_TRANSFER_EXPIRATION_IN_MILLISECONDS));
		// Keep data that isn't for the current workspace and that hasn't expired yet
		const filtered = data.filter(item => URI.revive(item.toWorkspace).toString() !== thisWorkspace && (currentTime - item.timestampInMilliseconds < SESSION_TRANSFER_EXPIRATION_IN_MILLISECONDS));
		this.storageService.store(globalChatKey, JSON.stringify(filtered), StorageScope.PROFILE, StorageTarget.MACHINE);
		return transferred;
	}

	/**
	 * Returns an array of chat details for all persisted chat sessions that have at least one request.
	 * The array is sorted by creation date in descending order.
	 * Chat sessions that have already been loaded into the chat view are excluded from the result.
	 * Imported chat sessions are also excluded from the result.
	 */
	getHistory(): IChatDetail[] {
		const sessions = Object.values(this._persistedSessions)
			.filter(session => session.requests.length > 0);
		sessions.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0));

		return sessions
			.filter(session => !this._sessionModels.has(session.sessionId))
			.filter(session => !session.isImported)
			.map(item => {
				const title = ChatModel.getDefaultTitle(item.requests);
				return {
					sessionId: item.sessionId,
					title
				};
			});
	}

	removeHistoryEntry(sessionId: string): void {
		this._deletedChatIds.add(sessionId);
		delete this._persistedSessions[sessionId];
		this.saveState();
	}

	clearAllHistoryEntries(): void {
		Object.values(this._persistedSessions).forEach(session => this._deletedChatIds.add(session.sessionId));
		this._persistedSessions = {};
		this.saveState();
	}

	startSession(location: ChatAgentLocation, token: CancellationToken): ChatModel {
		this.trace('startSession');
		return this._startSession(undefined, location, token);
	}

	private _startSession(someSessionHistory: IExportableChatData | ISerializableChatData | undefined, location: ChatAgentLocation, token: CancellationToken): ChatModel {
		const model = this.instantiationService.createInstance(ChatModel, someSessionHistory, location);
		this._sessionModels.set(model.sessionId, model);
		this.initializeSession(model, token);
		return model;
	}

	private async initializeSession(model: ChatModel, token: CancellationToken): Promise<void> {
		try {
			this.trace('initializeSession', `Initialize session ${model.sessionId}`);
			model.startInitialize();

			await this.extensionService.whenInstalledExtensionsRegistered();
			const defaultAgentData = this.chatAgentService.getContributedDefaultAgent(model.initialLocation) ?? this.chatAgentService.getContributedDefaultAgent(ChatAgentLocation.Panel);
			if (!defaultAgentData) {
				throw new ErrorNoTelemetry('No default agent contributed');
			}

			await this.extensionService.activateByEvent(`onChatParticipant:${defaultAgentData.id}`);

			const defaultAgent = this.chatAgentService.getActivatedAgents().find(agent => agent.id === defaultAgentData.id);
			if (!defaultAgent) {
				throw new ErrorNoTelemetry('No default agent registered');
			}
			const welcomeMessage = model.welcomeMessage ? undefined : await defaultAgent.provideWelcomeMessage?.(model.initialLocation, token) ?? undefined;
			const welcomeModel = welcomeMessage && this.instantiationService.createInstance(
				ChatWelcomeMessageModel,
				welcomeMessage.map(item => typeof item === 'string' ? new MarkdownString(item) : item),
				await defaultAgent.provideSampleQuestions?.(model.initialLocation, token) ?? []
			);

			model.initialize(welcomeModel);
		} catch (err) {
			this.trace('startSession', `initializeSession failed: ${err}`);
			model.setInitializationError(err);
			this._sessionModels.deleteAndDispose(model.sessionId);
			this._onDidDisposeSession.fire({ sessionId: model.sessionId, reason: 'initializationFailed' });
		}
	}

	getSession(sessionId: string): IChatModel | undefined {
		return this._sessionModels.get(sessionId);
	}

	getOrRestoreSession(sessionId: string): ChatModel | undefined {
		this.trace('getOrRestoreSession', `sessionId: ${sessionId}`);
		const model = this._sessionModels.get(sessionId);
		if (model) {
			return model;
		}

		const sessionData = revive<ISerializableChatData>(this._persistedSessions[sessionId]);
		if (!sessionData) {
			return undefined;
		}

		if (sessionId === this.transferredSessionData?.sessionId) {
			this._transferredSessionData = undefined;
		}

		return this._startSession(sessionData, sessionData.initialLocation ?? ChatAgentLocation.Panel, CancellationToken.None);
	}

	loadSessionFromContent(data: IExportableChatData | ISerializableChatData): IChatModel | undefined {
		return this._startSession(data, data.initialLocation ?? ChatAgentLocation.Panel, CancellationToken.None);
	}

	async resendRequest(request: IChatRequestModel, options?: IChatSendRequestOptions): Promise<void> {
		const model = this._sessionModels.get(request.session.sessionId);
		if (!model && model !== request.session) {
			throw new Error(`Unknown session: ${request.session.sessionId}`);
		}

		await model.waitForInitialization();

		const cts = this._pendingRequests.get(request.session.sessionId);
		if (cts) {
			this.trace('resendRequest', `Session ${request.session.sessionId} already has a pending request, cancelling...`);
			cts.cancel();
		}

		const location = options?.location ?? model.initialLocation;
		const attempt = options?.attempt ?? 0;
		const enableCommandDetection = !options?.noCommandDetection;
		const defaultAgent = this.chatAgentService.getDefaultAgent(location)!;

		model.removeRequest(request.id, ChatRequestRemovalReason.Resend);

		const resendOptions: IChatSendRequestOptions = {
			...options,
			locationData: request.locationData,
			attachedContext: request.attachedContext,
		};
		await this._sendRequestAsync(model, model.sessionId, request.message, attempt, enableCommandDetection, defaultAgent, location, resendOptions).responseCompletePromise;
	}

	async sendRequest(sessionId: string, request: string, options?: IChatSendRequestOptions): Promise<IChatSendRequestData | undefined> {

		this.trace('sendRequest', `sessionId: ${sessionId}, message: ${request.substring(0, 20)}${request.length > 20 ? '[...]' : ''}}`);
		if (!request.trim()) {
			this.trace('sendRequest', 'Rejected empty message');
			return;
		}

		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();

		if (this._pendingRequests.has(sessionId)) {
			this.trace('sendRequest', `Session ${sessionId} already has a pending request`);
			return;
		}

		const location = options?.location ?? model.initialLocation;
		const attempt = options?.attempt ?? 0;
		const defaultAgent = this.chatAgentService.getDefaultAgent(location)!;

		const parsedRequest = this.parseChatRequest(sessionId, request, location, options);
		const agent = parsedRequest.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart)?.agent ?? defaultAgent;
		const agentSlashCommandPart = parsedRequest.parts.find((r): r is ChatRequestAgentSubcommandPart => r instanceof ChatRequestAgentSubcommandPart);

		// This method is only returning whether the request was accepted - don't block on the actual request
		return {
			...this._sendRequestAsync(model, sessionId, parsedRequest, attempt, !options?.noCommandDetection, defaultAgent, location, options),
			agent,
			slashCommand: agentSlashCommandPart?.command,
		};
	}

	private parseChatRequest(sessionId: string, request: string, location: ChatAgentLocation, options: IChatSendRequestOptions | undefined): IParsedChatRequest {
		let parserContext = options?.parserContext;
		if (options?.agentId) {
			const agent = this.chatAgentService.getAgent(options.agentId);
			if (!agent) {
				throw new Error(`Unknown agent: ${options.agentId}`);
			}
			parserContext = { selectedAgent: agent };
			const commandPart = options.slashCommand ? ` ${chatSubcommandLeader}${options.slashCommand}` : '';
			request = `${chatAgentLeader}${agent.name}${commandPart} ${request}`;
		}

		const parsedRequest = this.instantiationService.createInstance(ChatRequestParser).parseChatRequest(sessionId, request, location, parserContext);
		return parsedRequest;
	}

	private refreshFollowupsCancellationToken(sessionId: string): CancellationToken {
		this._sessionFollowupCancelTokens.get(sessionId)?.cancel();
		const newTokenSource = new CancellationTokenSource();
		this._sessionFollowupCancelTokens.set(sessionId, newTokenSource);

		return newTokenSource.token;
	}

	private _sendRequestAsync(model: ChatModel, sessionId: string, parsedRequest: IParsedChatRequest, attempt: number, enableCommandDetection: boolean, defaultAgent: IChatAgent, location: ChatAgentLocation, options?: IChatSendRequestOptions): IChatSendRequestResponseState {
		const followupsCancelToken = this.refreshFollowupsCancellationToken(sessionId);
		let request: ChatRequestModel;
		const agentPart = 'kind' in parsedRequest ? undefined : parsedRequest.parts.find((r): r is ChatRequestAgentPart => r instanceof ChatRequestAgentPart);
		const agentSlashCommandPart = 'kind' in parsedRequest ? undefined : parsedRequest.parts.find((r): r is ChatRequestAgentSubcommandPart => r instanceof ChatRequestAgentSubcommandPart);
		const commandPart = 'kind' in parsedRequest ? undefined : parsedRequest.parts.find((r): r is ChatRequestSlashCommandPart => r instanceof ChatRequestSlashCommandPart);

		let gotProgress = false;
		const requestType = commandPart ? 'slashCommand' : 'string';

		const responseCreated = new DeferredPromise<IChatResponseModel>();
		let responseCreatedComplete = false;
		function completeResponseCreated(): void {
			if (!responseCreatedComplete && request?.response) {
				responseCreated.complete(request.response);
				responseCreatedComplete = true;
			}
		}

		const source = new CancellationTokenSource();
		const token = source.token;
		const sendRequestInternal = async () => {
			const progressCallback = (progress: IChatProgress) => {
				if (token.isCancellationRequested) {
					return;
				}

				gotProgress = true;

				if (progress.kind === 'markdownContent') {
					this.trace('sendRequest', `Provider returned progress for session ${model.sessionId}, ${progress.content.value.length} chars`);
				} else {
					this.trace('sendRequest', `Provider returned progress: ${JSON.stringify(progress)}`);
				}

				model.acceptResponseProgress(request, progress);
				completeResponseCreated();
			};

			const stopWatch = new StopWatch(false);
			const listener = token.onCancellationRequested(() => {
				this.trace('sendRequest', `Request for session ${model.sessionId} was cancelled`);
				this.telemetryService.publicLog2<ChatProviderInvokedEvent, ChatProviderInvokedClassification>('interactiveSessionProviderInvoked', {
					timeToFirstProgress: undefined,
					// Normally timings happen inside the EH around the actual provider. For cancellation we can measure how long the user waited before cancelling
					totalTime: stopWatch.elapsed(),
					result: 'cancelled',
					requestType,
					agent: agentPart?.agent.id ?? '',
					agentExtensionId: agentPart?.agent.extensionId.value ?? '',
					slashCommand: agentSlashCommandPart ? agentSlashCommandPart.command.name : commandPart?.slashCommand.command,
					chatSessionId: model.sessionId,
					location,
					citations: request?.response?.codeCitations.length ?? 0,
					numCodeBlocks: getCodeBlocks(request.response?.response.toString() ?? '').length
				});

				model.cancelRequest(request);
			});

			try {
				let rawResult: IChatAgentResult | null | undefined;
				let agentOrCommandFollowups: Promise<IChatFollowup[] | undefined> | undefined = undefined;


				if (agentPart || (defaultAgent && !commandPart)) {
					const prepareChatAgentRequest = async (agent: IChatAgentData, command?: IChatAgentCommand, enableCommandDetection?: boolean, chatRequest?: ChatRequestModel) => {
						const initVariableData: IChatRequestVariableData = { variables: [] };
						request = chatRequest ?? model.addRequest(parsedRequest, initVariableData, attempt, agent, command, options?.confirmation, options?.locationData, options?.attachedContext);

						// Variables may have changed if the agent and slash command changed, so resolve them again even if we already had a chatRequest
						const variableData = await this.chatVariablesService.resolveVariables(parsedRequest, request.attachedContext, model, progressCallback, token);
						model.updateRequest(request, variableData);
						const promptTextResult = getPromptText(request.message);
						const updatedVariableData = updateRanges(variableData, promptTextResult.diff); // TODO bit of a hack

						return {
							sessionId,
							requestId: request.id,
							agentId: agent.id,
							message: promptTextResult.message,
							command: command?.name,
							variables: updatedVariableData,
							enableCommandDetection,
							attempt,
							location,
							locationData: request.locationData,
							acceptedConfirmationData: options?.acceptedConfirmationData,
							rejectedConfirmationData: options?.rejectedConfirmationData,
						} satisfies IChatAgentRequest;
					};

					let detectedAgent: IChatAgentData | undefined;
					let detectedCommand: IChatAgentCommand | undefined;
					if (this.configurationService.getValue('chat.experimental.detectParticipant.enabled') !== false && this.chatAgentService.hasChatParticipantDetectionProviders() && !agentPart && !commandPart && enableCommandDetection) {
						// We have no agent or command to scope history with, pass the full history to the participant detection provider
						const defaultAgentHistory = getHistoryEntriesFromModel(model, defaultAgent.id);

						// Prepare the request object that we will send to the participant detection provider
						const chatAgentRequest = await prepareChatAgentRequest(defaultAgent, agentSlashCommandPart?.command, enableCommandDetection);

						const result = await this.chatAgentService.detectAgentOrCommand(chatAgentRequest, defaultAgentHistory, { location }, token);
						if (result) {
							// Update the response in the ChatModel to reflect the detected agent and command
							request.response?.setAgent(result.agent, result.command);
							detectedAgent = result.agent;
							detectedCommand = result.command;
						}
					}

					const agent = (detectedAgent ?? agentPart?.agent ?? defaultAgent)!;
					const command = detectedCommand ?? agentSlashCommandPart?.command;
					await this.extensionService.activateByEvent(`onChatParticipant:${agent.id}`);

					// Recompute history in case the agent or command changed
					const history = getHistoryEntriesFromModel(model, agent.id);
					const requestProps = await prepareChatAgentRequest(agent, command, !detectedAgent && enableCommandDetection, request /* Reuse the request object if we already created it for participant detection */);
					const pendingRequest = this._pendingRequests.get(sessionId);
					if (pendingRequest && !pendingRequest.requestId) {
						pendingRequest.requestId = requestProps.requestId;
					}
					completeResponseCreated();
					const agentResult = await this.chatAgentService.invokeAgent(agent.id, requestProps, progressCallback, history, token);
					rawResult = agentResult;
					agentOrCommandFollowups = this.chatAgentService.getFollowups(agent.id, requestProps, agentResult, history, followupsCancelToken);
				} else if (commandPart && this.chatSlashCommandService.hasCommand(commandPart.slashCommand.command)) {
					request = model.addRequest(parsedRequest, { variables: [] }, attempt);
					completeResponseCreated();
					// contributed slash commands
					// TODO: spell this out in the UI
					const history: IChatMessage[] = [];
					for (const request of model.getRequests()) {
						if (!request.response) {
							continue;
						}
						history.push({ role: ChatMessageRole.User, content: { type: 'text', value: request.message.text } });
						history.push({ role: ChatMessageRole.Assistant, content: { type: 'text', value: request.response.response.toString() } });
					}
					const message = parsedRequest.text;
					const commandResult = await this.chatSlashCommandService.executeCommand(commandPart.slashCommand.command, message.substring(commandPart.slashCommand.command.length + 1).trimStart(), new Progress<IChatProgress>(p => {
						progressCallback(p);
					}), history, location, token);
					agentOrCommandFollowups = Promise.resolve(commandResult?.followUp);
					rawResult = {};

				} else {
					throw new Error(`Cannot handle request`);
				}

				if (token.isCancellationRequested) {
					return;
				} else {
					if (!rawResult) {
						this.trace('sendRequest', `Provider returned no response for session ${model.sessionId}`);
						rawResult = { errorDetails: { message: localize('emptyResponse', "Provider returned null response") } };
					}

					const result = rawResult.errorDetails?.responseIsFiltered ? 'filtered' :
						rawResult.errorDetails && gotProgress ? 'errorWithOutput' :
							rawResult.errorDetails ? 'error' :
								'success';
					const commandForTelemetry = agentSlashCommandPart ? agentSlashCommandPart.command.name : commandPart?.slashCommand.command;
					this.telemetryService.publicLog2<ChatProviderInvokedEvent, ChatProviderInvokedClassification>('interactiveSessionProviderInvoked', {
						timeToFirstProgress: rawResult.timings?.firstProgress,
						totalTime: rawResult.timings?.totalElapsed,
						result,
						requestType,
						agent: agentPart?.agent.id ?? '',
						agentExtensionId: agentPart?.agent.extensionId.value ?? '',
						slashCommand: commandForTelemetry,
						chatSessionId: model.sessionId,
						location,
						citations: request.response?.codeCitations.length ?? 0,
						numCodeBlocks: getCodeBlocks(request.response?.response.toString() ?? '').length
					});
					model.setResponse(request, rawResult);
					completeResponseCreated();
					this.trace('sendRequest', `Provider returned response for session ${model.sessionId}`);

					model.completeResponse(request);
					if (agentOrCommandFollowups) {
						agentOrCommandFollowups.then(followups => {
							model.setFollowups(request, followups);
							this._chatServiceTelemetry.retrievedFollowups(agentPart?.agent.id ?? '', commandForTelemetry, followups?.length ?? 0);
						});
					}
				}
			} catch (err) {
				const result = 'error';
				this.telemetryService.publicLog2<ChatProviderInvokedEvent, ChatProviderInvokedClassification>('interactiveSessionProviderInvoked', {
					timeToFirstProgress: undefined,
					totalTime: undefined,
					result,
					requestType,
					agent: agentPart?.agent.id ?? '',
					agentExtensionId: agentPart?.agent.extensionId.value ?? '',
					slashCommand: agentSlashCommandPart ? agentSlashCommandPart.command.name : commandPart?.slashCommand.command,
					chatSessionId: model.sessionId,
					location,
					citations: 0,
					numCodeBlocks: 0
				});
				this.logService.error(`Error while handling chat request: ${toErrorMessage(err, true)}`);
				if (request) {
					const rawResult: IChatAgentResult = { errorDetails: { message: err.message } };
					model.setResponse(request, rawResult);
					completeResponseCreated();
					model.completeResponse(request);
				}
			} finally {
				listener.dispose();
			}
		};
		const rawResponsePromise = sendRequestInternal();
		this._pendingRequests.set(model.sessionId, new CancellableRequest(source));
		rawResponsePromise.finally(() => {
			this._pendingRequests.deleteAndDispose(model.sessionId);
		});
		return {
			responseCreatedPromise: responseCreated.p,
			responseCompletePromise: rawResponsePromise,
		};
	}

	async removeRequest(sessionId: string, requestId: string): Promise<void> {
		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();

		const pendingRequest = this._pendingRequests.get(sessionId);
		if (pendingRequest?.requestId === requestId) {
			pendingRequest.cancel();
			this._pendingRequests.deleteAndDispose(sessionId);
		}

		model.removeRequest(requestId);
	}

	async adoptRequest(sessionId: string, request: IChatRequestModel) {
		if (!(request instanceof ChatRequestModel)) {
			throw new TypeError('Can only adopt requests of type ChatRequestModel');
		}
		const target = this._sessionModels.get(sessionId);
		if (!target) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await target.waitForInitialization();

		const oldOwner = request.session;
		target.adoptRequest(request);

		if (request.response && !request.response.isComplete) {
			const cts = this._pendingRequests.deleteAndLeak(oldOwner.sessionId);
			if (cts) {
				cts.requestId = request.id;
				this._pendingRequests.set(target.sessionId, cts);
			}
		}
	}

	async addCompleteRequest(sessionId: string, message: IParsedChatRequest | string, variableData: IChatRequestVariableData | undefined, attempt: number | undefined, response: IChatCompleteResponse): Promise<void> {
		this.trace('addCompleteRequest', `message: ${message}`);

		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		await model.waitForInitialization();
		const parsedRequest = typeof message === 'string' ?
			this.instantiationService.createInstance(ChatRequestParser).parseChatRequest(sessionId, message) :
			message;
		const request = model.addRequest(parsedRequest, variableData || { variables: [] }, attempt ?? 0);
		if (typeof response.message === 'string') {
			// TODO is this possible?
			model.acceptResponseProgress(request, { content: new MarkdownString(response.message), kind: 'markdownContent' });
		} else {
			for (const part of response.message) {
				model.acceptResponseProgress(request, part, true);
			}
		}
		model.setResponse(request, response.result || {});
		if (response.followups !== undefined) {
			model.setFollowups(request, response.followups);
		}
		model.completeResponse(request);
	}

	cancelCurrentRequestForSession(sessionId: string): void {
		this.trace('cancelCurrentRequestForSession', `sessionId: ${sessionId}`);
		this._pendingRequests.get(sessionId)?.cancel();
		this._pendingRequests.deleteAndDispose(sessionId);
	}

	clearSession(sessionId: string): void {
		this.trace('clearSession', `sessionId: ${sessionId}`);
		const model = this._sessionModels.get(sessionId);
		if (!model) {
			throw new Error(`Unknown session: ${sessionId}`);
		}

		if (model.initialLocation === ChatAgentLocation.Panel) {
			// Turn all the real objects into actual JSON, otherwise, calling 'revive' may fail when it tries to
			// assign values to properties that are getters- microsoft/vscode-copilot-release#1233
			const sessionData: ISerializableChatData = JSON.parse(JSON.stringify(model));
			sessionData.isNew = true;
			this._persistedSessions[sessionId] = sessionData;
		}

		this._sessionModels.deleteAndDispose(sessionId);
		this._pendingRequests.get(sessionId)?.cancel();
		this._pendingRequests.deleteAndDispose(sessionId);
		this._onDidDisposeSession.fire({ sessionId, reason: 'cleared' });
	}

	public hasSessions(): boolean {
		return !!Object.values(this._persistedSessions);
	}

	transferChatSession(transferredSessionData: IChatTransferredSessionData, toWorkspace: URI): void {
		const model = Iterable.find(this._sessionModels.values(), model => model.sessionId === transferredSessionData.sessionId);
		if (!model) {
			throw new Error(`Failed to transfer session. Unknown session ID: ${transferredSessionData.sessionId}`);
		}

		const existingRaw: IChatTransfer[] = this.storageService.getObject(globalChatKey, StorageScope.PROFILE, []);
		existingRaw.push({
			chat: model.toJSON(),
			timestampInMilliseconds: Date.now(),
			toWorkspace: toWorkspace,
			inputValue: transferredSessionData.inputValue,
		});

		this.storageService.store(globalChatKey, JSON.stringify(existingRaw), StorageScope.PROFILE, StorageTarget.MACHINE);
		this.trace('transferChatSession', `Transferred session ${model.sessionId} to workspace ${toWorkspace.toString()}`);
	}
}

function getCodeBlocks(text: string): string[] {
	const lines = text.split('\n');
	const codeBlockLanguages: string[] = [];

	let codeBlockState: undefined | { readonly delimiter: string; readonly languageId: string };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (codeBlockState) {
			if (new RegExp(`^\\s*${codeBlockState.delimiter}\\s*$`).test(line)) {
				codeBlockLanguages.push(codeBlockState.languageId);
				codeBlockState = undefined;
			}
		} else {
			const match = line.match(/^(\s*)(`{3,}|~{3,})(\w*)/);
			if (match) {
				codeBlockState = { delimiter: match[2], languageId: match[3] };
			}
		}
	}
	return codeBlockLanguages;
}
